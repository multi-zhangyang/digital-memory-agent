import { join } from "node:path";
import { snapshot, changesSince } from "../project-files.js";
import { isWithin } from "../local-directories.js";
import type { Conversation, Run, RunInput } from "@memory/contracts";
import type { Store } from "../store.js";
import { type AgentRuntime, type RuntimeEvent, UserFacingError } from "../harness/runtime.js";
import type { MemoryCaptures } from "../memory/captures.js";
import type { TaskJobs } from "../harness/jobs.js";


const terminal = (run: Run) =>
  ["completed", "failed", "stopped"].includes(run.status);
export class WorkspaceService {
  captures?: MemoryCaptures;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly jobWaits = new Map<string, AbortController>();
  private readonly suspended = new Set<string>();
  private closing = false;
  constructor(
    readonly store: Store,
    private readonly runtime: () => AgentRuntime,
    private readonly jobs: TaskJobs,
  ) {
    for (const run of store.work.list<Run>("run"))
      if (!terminal(run) && !(run.status === "waiting" && run.waitingFor === "jobs" && jobs.hasWork(run.id)))
        store.work.patchRun(
          run.id,
          {
            status: "stopped",
            interventions: run.interventions?.map((i) => ({
              ...i,
              status: i.status === "queued" ? "returned" : i.status,
            })),
            error: "服务重新启动，执行已中断，可重新运行。",
            finishedAt: new Date().toISOString(),
            parts: run.parts.map((part) =>
              part.type === "tool" && part.state === "running"
                ? { ...part, state: "interrupted" }
                : part,
            ),
          },
          "interrupted",
        );
  }
  busy(id?: string) {
    return id ? this.workers.has(id) : this.workers.size > 0;
  }
  requireRun(id: string) {
    const run = this.store.work.get<Run>("run", id);
    if (!run) throw new UserFacingError(404, "NOT_FOUND", "任务不存在");
    return run;
  }
  conversation(id: string): Conversation {
    const row = this.store.conversation(id);
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "任务不存在");
    const runs = this.store.work.list<Run>("run", id);
    const current =
      runs.find(
        (run) => run.status === "running" || run.status === "waiting",
      ) || runs.at(-1);
    return {
      ...row,
      projectId: this.store.harness.association(id).projectId,
      parentId: this.store.harness.association(id).parentId || undefined,
      ...this.store.work.preferences(id),
      running: this.busy(id),
      status: current?.status,
      waitingFor: current?.waitingFor,
    };
  }
  enqueue(conversationId: string, input: RunInput) {
    this.conversation(conversationId);
    const projectId = this.store.harness.association(conversationId).projectId;
    const root = this.store.harness.root(projectId);
    for (const activeId of this.workers.keys())
      if (
        activeId !== conversationId &&
        (() => {
          const activeRoot = this.store.harness.project(
            this.store.harness.association(activeId).projectId,
          ).directory;
          return isWithin(root, activeRoot) || isWithin(activeRoot, root);
        })()
      )
        throw new UserFacingError(
          409,
          "PROJECT_BUSY",
          "此工作目录已有运行中的会话，请等待完成",
        );
    const run = this.store.work.createRun(conversationId, input);
    this.captures?.preempt();
    this.captures?.enqueue(run);
    const row = this.store.conversation(conversationId)!;
    this.store.touchConversation(
      conversationId,
      input.modelId,
      row.title === "新的对话" ? input.text.slice(0, 40) || "整理所附资料" : undefined,
    );
    this.drain(conversationId);
    return this.requireRun(run.id);
  }
  private drain(id: string) {
    if (this.workers.has(id) || this.closing) return;
    const projectRoot = this.store.harness.project(this.store.harness.association(id).projectId).directory;
    for (const activeId of this.workers.keys()) {
      const activeRoot = this.store.harness.project(this.store.harness.association(activeId).projectId).directory;
      if (isWithin(projectRoot, activeRoot) || isWithin(activeRoot, projectRoot)) return;
    }
    const worker = (async () => {
      await Promise.resolve();
      while (!this.closing) {
        const run = this.store.work
          .list<Run>("run", id)
          .find((item) => item.status === "queued" || (item.status === "waiting" && item.waitingFor === "jobs"));
        if (!run) break;
        const resumingJobs = run.waitingFor === "jobs";
        this.store.work.patchRun(
          run.id,
          { status: resumingJobs ? "waiting" : "running", startedAt: run.startedAt || new Date().toISOString(),
            ...(!resumingJobs ? { memoryEpoch: this.store.memories.ledger.epoch } : {}) },
          resumingJobs ? "job-wait-resumed" : "started",
        );
        const projectId = this.store.harness.association(id).projectId;
        const privatePaths = this.store.harness.excludedPaths(projectId);
        let root: string | undefined;
        const checkpoint = join(
          this.store.harness.dataDir,
          "checkpoints",
          run.id,
        );
        let checkpointReady = false;
        let failureText: string | undefined;
        try {
          root = this.store.harness.root(projectId);
          if (!resumingJobs) await snapshot(root, checkpoint, privatePaths);
          checkpointReady = true;
          if (!resumingJobs) {
            await this.runtime().prompt(id, run.modelId, run.goal || run.text,
              (event) => this.receive(run.id, event), { runId: run.id, thinkingLevel: run.thinkingLevel });
          }
          if (!terminal(this.requireRun(run.id)) && this.requireRun(run.id).memoryEpoch !== this.store.memories.ledger.epoch) {
            this.store.work.patchRun(run.id, { error: "记忆已更新，旧上下文已停止；可继续当前对话" }, "memory-invalidated");
            await this.stop(run.id);
          }
          while (!this.closing && !terminal(this.requireRun(run.id)) && this.jobs.hasWork(run.id)) {
            const controller = new AbortController();
            this.jobWaits.set(run.id, controller);
            this.store.work.patchRun(run.id, { status: "waiting", waitingFor: "jobs" }, "job-waiting");
            try { await this.jobs.wait(run.id, controller.signal); }
            finally { this.jobWaits.delete(run.id); }
            if (this.closing || terminal(this.requireRun(run.id))) break;
            const notification = this.jobs.claim(run.id);
            if (notification) await this.runtime().prompt(id, run.modelId, run.goal || run.text,
              (event) => this.receive(run.id, event), { runId: run.id, thinkingLevel: run.thinkingLevel, notification });
          }
          if (!this.suspended.has(run.id)) failureText = this.jobs.problem(run.id);
        } catch (error) {
          if (!this.suspended.has(run.id)) failureText =
            error instanceof UserFacingError
              ? error.message
              : "执行失败，请检查连接后重试";
        } finally {
          if (checkpointReady && root) {
            try {
              this.store.work.patchRun(
                run.id,
                { changes: await changesSince(root, checkpoint, privatePaths) },
                "changes",
              );
            } catch {
              failureText ||= "文件变更扫描未完成，请检查项目文件大小";
              this.store.work.patchRun(
                run.id,
                { error: "文件变更扫描未完成，请检查项目文件大小" },
                "changes-error",
              );
            }
          }
          for (const approval of this.store.harness.approvals(run.id))
            if (approval.status === "pending")
              this.store.harness.save("approval", {
                ...approval,
                status: "denied" as const,
              });
          if (!terminal(this.requireRun(run.id)) && this.requireRun(run.id).memoryEpoch !== this.store.memories.ledger.epoch) {
            this.store.work.patchRun(run.id, { error: "记忆已更新，旧上下文已停止；可继续当前对话" }, "memory-invalidated");
            await this.stop(run.id);
          }
          const latest = this.requireRun(run.id);
          if (!terminal(latest) && !this.suspended.has(run.id))
            this.store.work.patchRun(
              run.id,
              {
                status: failureText ? "failed" : "completed",
                error: failureText || latest.error,
                finishedAt: new Date().toISOString(),
                waitingFor: null,
              },
              failureText ? "failed" : "finished",
            );
          this.store.work.patchRun(
            run.id,
            {
              parts: latest.parts.map((part) =>
                part.type === "tool" && part.state === "running"
                  ? { ...part, state: "interrupted" }
                  : part,
              ),
            },
            "settled",
          );
          this.store.touchConversation(id, run.modelId);
          if (!this.suspended.has(run.id)) this.captures?.settle(this.requireRun(run.id));
        }
      }
    })().finally(() => { this.workers.delete(id); this.captures?.wake(); this.wake(); });
    this.workers.set(id, worker);
  }
  wake() {
    if (this.closing) return;
    const ids = new Set(this.store.work.list<Run>("run")
      .filter((run) => run.status === "queued" || (run.status === "waiting" && run.waitingFor === "jobs"))
      .map((run) => run.conversationId));
    for (const id of ids) this.drain(id);
  }
  private receive(id: string, event: RuntimeEvent) {
    const run = this.requireRun(id);
    if (terminal(run)) return;
    if (run.memoryEpoch !== undefined && run.memoryEpoch !== this.store.memories.ledger.epoch) {
      // The outbox cancellation may arrive after a provider's final tokens. Enforce
      // freshness here as well, before publishing them or marking the task complete.
      this.store.work.patchRun(id, { error: "记忆已更新，旧上下文已停止；可继续当前对话" }, "memory-invalidated");
      void this.stop(id).catch(() => undefined);
      return;
    }
    const parts = run.parts;
    if (event.type === "usage") {
      const u = run.usage;
      this.store.work.patchRun(
        id,
        {
          usage: {
            ...event.usage,
            output: (u?.output || 0) + event.usage.output,
          },
        },
        "usage",
      );
      return;
    }
    if (event.type === "text" || event.type === "reasoning") {
      const last = parts.at(-1);
      if (last?.type === event.type) last.text += event.delta;
      else parts.push({ type: event.type, text: event.delta });
    }
    if (event.type === "notice") {
      const pending = [...parts]
        .reverse()
        .find((p) => p.type === "notice" && p.state === "running");
      if (event.state !== "running" && pending?.type === "notice") {
        pending.text = event.text;
        pending.state = event.state;
      } else parts.push({ ...event });
    }
    if (event.type === "queue") {
      const remaining = {
        steer: event.texts.length,
        followUp: event.followUp.length,
      };
      const interventions = run.interventions
        ?.slice()
        .reverse()
        .map((i) => {
          if (i.status !== "queued") return i;
          const key = i.mode || "steer";
          if (remaining[key] > 0) {
            remaining[key]--;
            return i;
          }
          return { ...i, status: "delivered" as const };
        })
        .reverse();
      this.store.work.patchRun(id, { interventions }, "queue");
      return;
    }
    if (event.type === "tool-update") {
      const part = parts.find(
        (p) => p.type === "tool" && p.toolCallId === event.id,
      );
      if (part?.type === "tool") part.output = event.output;
    }
    if (event.type === "tool-start")
      parts.push({
        type: "tool",
        toolCallId: event.id,
        name: event.name,
        input: event.input,
        state: "running",
        startedAt: new Date().toISOString(),
        parentToolCallId: event.parentToolCallId,
      });
    if (event.type === "tool-end") {
      const part = parts.find(
        (part) => part.type === "tool" && part.toolCallId === event.id,
      );
      if (part?.type === "tool") {
        part.finishedAt = new Date().toISOString();
        part.state = event.error ? "error" : "complete";
        part.output = event.output;
        if (event.error)
          part.errorText =
            typeof event.output === "string" ? event.output : "工具执行失败";
      }
    }
    this.store.work.patchRun(id, { parts }, event.type, event);
  }
  async stop(id: string) {
    const run = this.requireRun(id);
    if (terminal(run)) return;
    this.store.work.patchRun(
      id,
      {
        status: "stopped",
        waitingFor: null,
        finishedAt: new Date().toISOString(),
        parts: run.parts.map((part) =>
          part.type === "tool" && part.state === "running"
            ? { ...part, state: "interrupted" }
            : part,
        ),
      },
      "stopped",
    );
    this.jobWaits.get(id)?.abort();
    this.jobs.cancel(id);
    if (run.status !== "queued")
      await this.runtime().cancel(run.conversationId);
    this.captures?.settle(this.requireRun(id));
  }
  async invalidateMemory(epoch = this.store.memories.ledger.epoch) {
    for (const run of this.store.work.list<Run>("run")) if ((run.status === "running" || run.status === "waiting") && (run.memoryEpoch ?? 0) < epoch) {
      this.store.work.patchRun(run.id, { error: "记忆已更新，旧上下文已停止；可继续当前对话" }, "memory-invalidated");
      await this.stop(run.id);
    }
  }
  async close() {
    this.closing = true;
    for (const run of this.store.work.list<Run>("run")) {
      if (terminal(run)) continue;
      if (run.status === "waiting" && run.waitingFor === "jobs") {
        this.suspended.add(run.id);
        this.jobWaits.get(run.id)?.abort();
      } else await this.stop(run.id);
    }
    await Promise.allSettled(this.workers.values());
  }
}
