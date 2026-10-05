import { join } from "node:path";
import { existsSync } from "node:fs";
import { snapshot, changesSince } from "../project-files.js";
import { isWithin } from "../local-directories.js";
import { applyPartEvent, isPartEventType } from "@memory/contracts/execution";
import type { AgentApproval, Conversation, Run, RunInput } from "@memory/contracts";
import type { Store } from "../store.js";
import { type AgentRuntime, type RuntimeEvent, UserFacingError } from "../harness/runtime.js";
import type { MemoryCaptures } from "../memory/captures.js";
import type { TaskJobs } from "../harness/jobs.js";
import { executionConfiguration, recoveryState } from "./run-recovery.js";


const terminal = (run: Run) =>
  ["completed", "failed", "stopped"].includes(run.status);
export class WorkspaceService {
  captures?: MemoryCaptures;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly jobWaits = new Map<string, AbortController>();
  private readonly suspended = new Set<string>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly resolvingApprovals = new Map<string, Promise<void>>();
  private readonly approvalTimer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(
    readonly store: Store,
    private readonly runtime: () => AgentRuntime,
    private readonly jobs: TaskJobs,
  ) {
    for (const run of store.work.list<Run>("run")) {
      if (terminal(run)) continue;
      if (run.stopRequestedAt) {
        store.work.patchRun(run.id, { status: "stopped", waitingFor: null, finishedAt: new Date().toISOString(),
          parts: run.parts.map((part) => part.type === "tool" && ["input", "running"].includes(part.state) ? { ...part, state: "interrupted" } : part) }, "stopped");
        continue;
      }
      if (run.status === "queued" && !run.startedAt) continue;
      const recovery = recoveryState(store, run, "服务已恢复，将从已保存的执行结果继续");
      if (!run.checkpoint || recovery.attempts >= 3) { recovery.state = "blocked"; recovery.reason = "需要检查中断记录后继续"; }
      const waiting = run.question && !run.question.answer ? "user" : store.harness.approvals(run.id).some((a) => a.status === "pending") ? "approval" :
        run.waitingFor === "jobs" && jobs.hasWork(run.id) ? "jobs" : recovery.state !== "ready" ? "recovery" : null;
      store.work.patchRun(run.id, { status: waiting ? "waiting" : "queued", waitingFor: waiting, recovery, error: undefined, finishedAt: undefined,
        parts: run.parts.map((part) => part.type === "tool" && part.state === "running" ? { ...part, state: "interrupted" } : part) }, "recovery-available");
    }
    this.approvalTimer = setInterval(() => {
      if (this.closing) return;
      const waiting = this.store.db.prepare("SELECT data FROM workspace_records WHERE kind='run' AND json_extract(data,'$.waitingFor')='approval'").all() as { data: string }[];
      for (const { data } of waiting) {
        const run: Run = JSON.parse(data);
        if (run.waitingFor !== "approval" || run.stopRequestedAt || terminal(run)) continue;
        const approvals = this.store.harness.approvals(run.id);
        for (const approval of approvals) if (approval.status === "pending" && approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now())
          this.store.harness.save("approval", { ...approval, status: "denied", resolution: "expired" });
        if (approvals.length && !this.store.harness.approvals(run.id).some((a) => a.status === "pending"))
          void this.approvalResolved(run.id).catch(() => {});
      }
    }, 1000);
    this.approvalTimer.unref();
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
    this.store.work.patchRun(run.id, { checkpoint: { version: 1, configuration: executionConfiguration(this.store, run), savedAt: new Date().toISOString() } }, "checkpoint");
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
          .find((item) => !terminal(item));
        if (!run || (run.status !== "queued" && !(run.status === "waiting" && run.waitingFor === "jobs"))) break;
        const resumingJobs = run.waitingFor === "jobs";
        const resuming = !!run.startedAt && !!run.recovery;
        this.suspended.delete(run.id);
        this.store.work.patchRun(
          run.id,
          { status: resumingJobs ? "waiting" : "running", startedAt: run.startedAt || new Date().toISOString(),
            ...(!resumingJobs ? { memoryEpoch: this.store.memories.ledger.epoch, waitingFor: null } : {}),
            ...(resuming && run.recovery ? { recovery: { ...run.recovery, attempts: run.recovery.attempts + 1 } } : {}) },
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
          if (!existsSync(checkpoint)) await snapshot(root, checkpoint, privatePaths);
          checkpointReady = true;
          if (!resumingJobs) {
            const latest = this.requireRun(run.id);
            await this.runtime().prompt(id, run.modelId, run.goal || run.text,
              (event) => this.receive(run.id, event), { runId: run.id, thinkingLevel: run.thinkingLevel,
                ...(resuming ? { recovery: { id: `${run.id}:${latest.recovery!.attempts}`, run: latest } } : {}) });
            if (!this.closing && !this.requireRun(run.id).waitingFor) this.store.work.patchRun(run.id, { jobNotification: undefined }, "delivery-settled");
          }
          if (["user", "approval", "recovery"].includes(this.requireRun(run.id).waitingFor || "")) this.suspended.add(run.id);
          if (!terminal(this.requireRun(run.id)) && this.requireRun(run.id).memoryEpoch !== this.store.memories.ledger.epoch) {
            this.store.work.patchRun(run.id, { error: "记忆已更新，旧上下文已停止；可继续当前对话" }, "memory-invalidated");
            await this.stop(run.id);
          }
          while (!this.closing && !this.suspended.has(run.id) && !terminal(this.requireRun(run.id)) && this.jobs.hasWork(run.id)) {
            const controller = new AbortController();
            this.jobWaits.set(run.id, controller);
            this.store.work.patchRun(run.id, { status: "waiting", waitingFor: "jobs" }, "job-waiting");
            try { await this.jobs.wait(run.id, controller.signal); }
            finally { this.jobWaits.delete(run.id); }
            if (this.closing || terminal(this.requireRun(run.id))) break;
            const notification = this.jobs.claim(run.id);
            if (notification) {
              await this.runtime().prompt(id, run.modelId, run.goal || run.text,
                (event) => this.receive(run.id, event), { runId: run.id, thinkingLevel: run.thinkingLevel, notification });
              if (["user", "approval", "recovery"].includes(this.requireRun(run.id).waitingFor || "")) this.suspended.add(run.id);
              else if (!this.closing) this.store.work.patchRun(run.id, { jobNotification: undefined }, "delivery-settled");
            }
          }
          if (!this.suspended.has(run.id)) failureText = this.jobs.problem(run.id);
        } catch (error) {
          if (!this.suspended.has(run.id)) failureText =
            error instanceof UserFacingError
              ? error.message
              : "执行失败，请检查连接后重试";
        } finally {
          // An abort can reject while Pi settles; the durable wait still owns the task.
          if (["user", "approval", "recovery"].includes(this.requireRun(run.id).waitingFor || "")) this.suspended.add(run.id);
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
            if (approval.status === "pending" && !this.suspended.has(run.id))
              this.store.harness.save("approval", {
                ...approval,
                status: "denied" as const, resolution: "cancelled",
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
                ...(failureText ? { recovery: recoveryState(this.store, latest, "执行未完成，请核对中断记录后继续") } : {}),
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
        if (this.suspended.has(run.id)) break;
      }
    })().finally(() => { this.workers.delete(id); this.captures?.wake(); this.wake(); });
    this.workers.set(id, worker);
  }
  wake() {
    if (this.closing) return;
    const first = new Map<string, Run>();
    for (const run of this.store.work.list<Run>("run")) if (!terminal(run) && !first.has(run.conversationId)) first.set(run.conversationId, run);
    for (const run of first.values()) if (run.status === "queued" || (run.status === "waiting" && run.waitingFor === "jobs")) this.drain(run.conversationId);
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
    if (event.type === "phase") {
      this.store.work.patchRun(id, { phase: event.phase }, "phase"); return;
    }
    if (event.type === "queue") {
      if (run.waitingFor || event.cleared) return;
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
    if (!isPartEventType(event.type)) return;
    let projected = event;
    if (event.type === "tool-start") projected = { ...event,
      startedAt: new Date().toISOString(), stepId: run.plan.find((step) => step.status === "running")?.id };
    if (event.type === "tool-end") {
      const extensionWait = run.waitingFor === "approval" && this.store.harness.approvals(run.id)
        .some((approval) => approval.status === "pending" && approval.kind !== "tool" && approval.toolCallId === event.id);
      projected = { ...event, finishedAt: new Date().toISOString(),
        state: extensionWait ? "interrupted" : event.error ? "error" : "complete" };
    }
    const parts = applyPartEvent(run.parts, projected);
    this.store.work.patchRun(id, { parts,
      ...(event.type === "message-start" ? { presentationVersion: 2 as const } : {}),
      ...(event.type === "message-entry" && event.initial ? { inputEntryId: event.entryId } : {}),
    }, event.type, projected);
  }

  async resume(id: string, options: { decisions?: NonNullable<Run["recovery"]>["decisions"]; acceptConfiguration?: boolean } = {}) {
    let run = this.requireRun(id);
    if (run.status === "completed" || this.busy(run.conversationId)) throw new UserFacingError(409, "RUN_BUSY", "任务仍在运行或已经完成");
    if (run.question && !run.question.answer) throw new UserFacingError(409, "ANSWER_REQUIRED", "请先回答任务中的问题");
    if (this.store.harness.approvals(id).some((a) => a.status === "pending")) throw new UserFacingError(409, "APPROVAL_REQUIRED", "请先处理待审批操作");
    const recovery = recoveryState(this.store, run, "继续尚未完成的任务");
    if (recovery.state === "blocked" && !options.acceptConfiguration) throw new UserFacingError(409, "CONFIGURATION_CHANGED", recovery.reason);
    const decisions = options.decisions || run.recovery?.decisions || [];
    if (recovery.pendingToolIds.some((toolCallId) => !decisions.some((d) => d.toolCallId === toolCallId)) || decisions.some((d) => !run.parts.some((p) => p.type === "tool" && p.toolCallId === d.toolCallId)))
      throw new UserFacingError(409, "RECOVERY_REVIEW_REQUIRED", "请核对结果不明的操作，选择跳过或允许重试");
    const other = this.store.work.list<Run>("run", run.conversationId).find((r) => r.id !== run.id && !terminal(r) && r.status !== "queued");
    if (other) throw new UserFacingError(409, "RUN_BUSY", "此对话已有待完成任务");
    run = this.store.work.patchRun(id, { status: "queued", waitingFor: null, error: undefined, finishedAt: undefined, stopRequestedAt: undefined,
      recovery: { ...recovery, state: "ready", attempts: 0, decisions }, checkpoint: { version: 1, configuration: executionConfiguration(this.store, run), savedAt: new Date().toISOString(), entryId: run.entryId },
      memoryEpoch: this.store.memories.ledger.epoch }, "resumed");
    this.suspended.delete(id); this.drain(run.conversationId); return run;
  }
  async answer(id: string, answer: string) {
    const run = this.requireRun(id);
    if (run.status !== "waiting" || !run.question || run.question.answer) throw new UserFacingError(409, "NOT_WAITING", "任务当前没有待回答的问题");
    const answered = { ...run.question, answer };
    this.store.work.patchRun(id, { question: answered, questions: [...(run.questions || []).filter((q) => q.id !== answered.id), answered] }, "answer");
    // The Pi turn may still be settling immediately after it emitted the question.
    const worker = this.workers.get(run.conversationId); if (worker) await worker;
    return this.resume(id);
  }
  async approvalResolved(id: string) {
    const pending = this.resolvingApprovals.get(id);
    if (pending) return pending;
    const operation = this.resolveApprovals(id);
    this.resolvingApprovals.set(id, operation);
    try { await operation; } finally { this.resolvingApprovals.delete(id); }
  }
  private async resolveApprovals(id: string) {
    const run = this.requireRun(id);
    if (terminal(run) || run.stopRequestedAt) return;
    if (this.store.harness.approvals(id).some((a) => a.status === "pending")) return;
    const worker = this.workers.get(run.conversationId); if (worker) await worker;
    if (terminal(this.requireRun(id)) || this.requireRun(id).stopRequestedAt) return;
    const recovery = recoveryState(this.store, this.requireRun(id), "扩展中断前可能已执行操作，请先核对再继续");
    if (recovery.state !== "ready") {
      this.store.work.patchRun(id, { status: "waiting", waitingFor: "recovery", recovery }, "recovery-available");
      return;
    }
    await this.resume(id);
  }
  async stop(id: string) {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const operation = this.stopRun(id);
    this.stopping.set(id, operation);
    try { await operation; } finally { this.stopping.delete(id); }
  }
  private async stopRun(id: string) {
    const run = this.requireRun(id);
    if (terminal(run)) return;
    this.suspended.add(id);
    this.store.work.patchRun(id, { stopRequestedAt: new Date().toISOString() }, "stopping");
    this.jobWaits.get(id)?.abort();
    this.jobs.cancel(id);
    if (run.status !== "queued") await this.runtime().cancel(run.conversationId);
    const latest = this.requireRun(id);
    for (const approval of this.store.harness.approvals(id)) if (approval.status === "pending")
      this.store.harness.save<AgentApproval>("approval", { ...approval, status: "denied", resolution: "cancelled" });
    this.store.work.patchRun(
      id,
      {
        status: "stopped",
        waitingFor: null,
        finishedAt: new Date().toISOString(),
        recovery: recoveryState(this.store, latest, "任务已停止，可从现有结果继续"),
        parts: latest.parts.map((part) =>
          part.type === "tool" && ["input", "running"].includes(part.state)
            ? { ...part, state: "interrupted" }
            : part,
        ),
      },
      "stopped",
    );
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
    clearInterval(this.approvalTimer);
    for (const run of this.store.work.list<Run>("run")) {
      if (terminal(run)) continue;
      this.suspended.add(run.id);
      this.jobWaits.get(run.id)?.abort();
      if (run.status === "running") this.store.work.patchRun(run.id, { status: "waiting", waitingFor: "recovery",
        recovery: recoveryState(this.store, run, "服务关闭，执行进度已保存") }, "suspended");
      await this.runtime().cancel(run.conversationId);
    }
    await Promise.allSettled(this.workers.values());
  }
}
