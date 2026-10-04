import { randomUUID } from "node:crypto";
import type { MemoryCaptureJob, MemoryEntry, Run } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import type { MemoryData } from "./data.js";
import { UserFacingError } from "../errors.js";
import type { MemoryProcessors } from "./processors.js";
import {
  CAPTURE_VERSION,
  explicitPersonalStatement,
  type CaptureResult,
} from "../memory-capture-extraction.js";
import {
  contentHash,
  evidenceOf,
  messageEvidence,
  normalizeFact,
} from "./ledger.js";
import { resolveMemoryTime } from "./time.js";

const now = () => new Date().toISOString();
const terminal = (status: MemoryCaptureJob["status"]) =>
  ["completed", "failed", "cancelled", "skipped"].includes(status);
export class MemoryCaptures {
  private worker?: Promise<void>;
  private controller?: AbortController;
  private activeId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private preempted = false;
  constructor(
    private readonly store: MemoryData,
    private readonly config: AppConfig,
    private readonly processors: () => MemoryProcessors,
    private readonly foreground: () => boolean,
  ) {
    for (const job of this.pending()) {
      if (job.status === "running") {
        job.recoveries++;
        job.status = job.recoveries > 3 ? "failed" : "queued";
        job.error = job.recoveries > 3 ? "多次重启中断，请手动重试" : undefined;
        this.save(job);
      }
      const run = store.memories.get<Run>("run", job.runId);
      if (job.status === "waiting") {
        job.status = run?.status === "completed" ? "queued" : "cancelled";
        this.save(job);
      }
    }
  }
  jobs(runId?: string, limit = 1000): MemoryCaptureJob[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM memory_capture_jobs WHERE (? IS NULL OR json_extract(data,'$.runId')=?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(runId || null, runId || null, Math.max(1, Math.min(1000, limit))) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  hasPending() {
    return !!this.store.db.prepare("SELECT 1 FROM memory_capture_jobs WHERE json_extract(data,'$.status') IN ('waiting','queued','running') LIMIT 1").get();
  }
  private pending(runId?: string): MemoryCaptureJob[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM memory_capture_jobs WHERE json_extract(data,'$.status') IN ('waiting','queued','running') AND (? IS NULL OR json_extract(data,'$.runId')=?) ORDER BY rowid",
        )
        .all(runId || null, runId || null) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  private nextQueued(): MemoryCaptureJob | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM memory_capture_jobs WHERE json_extract(data,'$.status')='queued' ORDER BY rowid LIMIT 1",
      )
      .get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  job(id: string): MemoryCaptureJob {
    const row = this.store.db
      .prepare("SELECT data FROM memory_capture_jobs WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "记录任务不存在");
    return JSON.parse(row.data);
  }
  private save(job: MemoryCaptureJob) {
    job.updatedAt = now();
    job.revision = (job.revision || 0) + 1;
    this.store.memories.transaction(() => {
    this.store.db
      .prepare("UPDATE memory_capture_jobs SET data=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
      this.store.events.publish("memory-capture.changed", job.id, job.revision!);
    });
    return job;
  }
  private source(run: Run, messageId: string) {
    if (messageId === run.id) return { text: run.text, at: run.createdAt };
    if (messageId === run.id + ":answer" && run.question?.answer)
      return { text: run.question.answer, at: run.finishedAt || run.createdAt };
    const input = run.interventions?.find(
      (value) => value.id === messageId && value.status === "delivered",
    );
    if (!input)
      throw new UserFacingError(
        409,
        "SOURCE_MISSING",
        "原始消息已不存在或未送达",
      );
    return { text: input.text, at: input.createdAt };
  }
  enqueue(run: Run, force = false, messageId = run.id) {
    if (!force && !run.captureMemory) return;
    const row = this.store.db
      .prepare(
        "SELECT data FROM memory_capture_jobs WHERE messageId=? AND extractorVersion=?",
      )
      .get(messageId, CAPTURE_VERSION) as { data: string } | undefined;
    if (row) return JSON.parse(row.data) as MemoryCaptureJob;
    const source = this.source(run, messageId);
    if (!source.text.trim()) return;
    const modelId = this.store.memories.ledger.settings().textModelId || run.modelId;
    const provider = this.config.providers.find(
      (value) => value.model.id === modelId,
    );
    const job: MemoryCaptureJob = {
      id: randomUUID(),
      runId: run.id,
      conversationId: run.conversationId,
      messageId,
      modelId,
      thinkingLevel: provider?.model.reasoning ? "low" : "off",
      sourceHash: contentHash(source.text),
      extractorVersion: CAPTURE_VERSION,
      status: force || run.status === "completed" ? "queued" : "waiting",
      attempts: 0,
      recoveries: 0,
      memoryIds: [],
      createdAt: now(),
      updatedAt: now(),
    };
    if (source.text.length > 12000) {
      job.status = "skipped";
      job.reason = "消息较长，请从记忆页面分段导入";
    }
    if (!this.processors().captureMemories) {
      job.status = "skipped";
      job.reason = "当前模型连接不支持自动记录";
    }
    if (this.store.memories.ledger.sourceBlocked(job.sourceHash)) {
      job.status = "skipped";
      job.reason = "关联来源已停止取用";
    }
    this.store.memories.transaction(() => {
      this.store.db
        .prepare("INSERT INTO memory_capture_jobs VALUES (?,?,?,?)")
        .run(job.id, messageId, CAPTURE_VERSION, JSON.stringify(job));
      this.store.events.publish("memory-capture.changed", job.id, 0);
      const latest = this.store.memories.get<Run>("run", run.id)!;
      this.store.recordMemoryActivity?.(
        run.id,
        { captureJobIds: [...(latest.captureJobIds || []), job.id] },
        "memory-capture",
      );
    });
    this.wake();
    return job;
  }
  settle(run: Run) {
    for (const job of this.pending(run.id))
      if (job.status === "waiting") {
        job.status = run.status === "completed" ? "queued" : "cancelled";
        this.save(job);
      }
    if (run.status === "completed") {
      for (const input of run.interventions || [])
        if (input.status === "delivered") this.enqueue(run, false, input.id);
      if (run.question?.answer) this.enqueue(run, false, run.id + ":answer");
    }
    this.wake();
  }
  busy() {
    return !!this.activeId;
  }
  preempt() {
    if (this.controller) {
      this.preempted = true;
      this.controller.abort();
    }
  }
  async yieldToForeground() {
    this.preempt();
    await this.worker;
  }
  wake() {
    if (this.closing || this.worker || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.foreground()) {
        if (this.nextQueued()) this.wake();
        return;
      }
      this.worker = this.drain().finally(() => {
        this.worker = undefined;
        if (!this.closing && this.nextQueued()) this.wake();
      });
    }, 250);
    this.timer.unref();
  }
  private async drain() {
    while (!this.closing && !this.foreground()) {
      const job = this.nextQueued();
      if (!job) return;
      this.activeId = job.id;
      this.controller = new AbortController();
      this.preempted = false;
      const signal = this.controller.signal;
      job.status = "running";
      job.attempts++;
      job.error = undefined;
      this.save(job);
      try {
        const run = this.store.memories.get<Run>("run", job.runId);
        if (!run)
          throw new UserFacingError(409, "SOURCE_MISSING", "原始对话已删除");
        const source = this.source(run, job.messageId);
        if (contentHash(source.text) !== job.sourceHash)
          throw new UserFacingError(409, "SOURCE_CHANGED", "原始消息已改变");
        if (this.store.memories.ledger.sourceBlocked(job.sourceHash)) {
          job.status = "skipped";
          job.reason = "关联来源已停止取用";
          this.save(job);
          continue;
        }
        const candidates = [
          ...new Map(
            [
              ...this.store.memories.searchMemories(source.text.slice(0, 200), 8),
              ...this.store.memories.searchMemories("", 4, { category: "profile" }),
            ].map((value) => [value.id, value]),
          ).values(),
        ];
        const result = await this.processors().captureMemories!(
          {
            modelId: job.modelId,
            thinkingLevel: job.thinkingLevel,
            text: source.text,
            referenceTime: source.at,
            timeZone: this.store.memories.ledger.settings().timeZone,
            existing: candidates.map(
              ({ id, content, category, attribute, occurredAt, validity }) => ({
                id,
                content,
                category,
                attribute,
                occurredAt,
                validity,
              }),
            ),
          },
          signal,
        );
        signal.throwIfAborted();
        this.store.memories.transaction(() => {
          const latest = this.job(job.id);
          if (latest.status !== "running") throw new Error("Cancelled capture");
          job.memoryIds = this.persist(run, job, source, result, candidates);
          job.usage = result.usage;
          job.status = "completed";
          this.save(job);
          this.store.recordMemoryActivity?.(run.id, {}, "memory-captured");
        });
      } catch (error) {
        const latest = this.job(job.id);
        if (latest.status !== "cancelled") {
          const invalidResponse = !this.closing && !this.preempted && error instanceof UserFacingError &&
            error.code === "CAPTURE_FAILED" && (job.invalidResponseRetries || 0) < 1;
          if (invalidResponse) job.invalidResponseRetries = (job.invalidResponseRetries || 0) + 1;
          job.status = this.closing || this.preempted || invalidResponse ? "queued" : "failed";
          if (this.preempted) job.attempts--;
          job.error =
            job.status === "failed"
              ? error instanceof UserFacingError
                ? error.message
                : "记录未完成，可手动重试"
              : invalidResponse ? "自动记录未返回有效结果，正在重试（1/1）" : undefined;
          this.save(job);
        }
      } finally {
        this.activeId = undefined;
        this.controller = undefined;
      }
    }
  }
  private persist(
    run: Run,
    job: MemoryCaptureJob,
    source: { text: string; at: string },
    result: CaptureResult,
    candidates: MemoryEntry[],
  ) {
    const ids = new Set<string>();
    for (const entry of result.entries) {
      if (!entry.personal) continue;
      const evidence = messageEvidence(
        run,
        entry.quote,
        job.messageId,
        source.text,
      );
      if (
        entry.people.some((name) => !source.text.includes(name)) ||
        (entry.place && !source.text.includes(entry.place)) ||
        (entry.attribute &&
          (entry.category !== "profile" ||
            !entry.quote.includes(entry.attribute.value))) ||
        (entry.timeExpression && !entry.quote.includes(entry.timeExpression))
      )
        throw new UserFacingError(
          422,
          "INVALID_EVIDENCE",
          "人物、属性或时间无法通过原话校验",
        );
      if (
        this.store.memories.ledger.sourceBlocked(
          job.sourceHash,
          evidence.start,
          evidence.end,
        )
      )
        continue;
      const time = resolveMemoryTime(
        entry.timeExpression,
        source.at,
        this.store.memories.ledger.settings().timeZone,
      );
      const validity =
        entry.category === "profile" && time?.precision === "day"
          ? { ...time, to: undefined }
          : time;
      const input: Omit<
        MemoryEntry,
        "id" | "version" | "createdAt" | "updatedAt"
      > = {
        title: entry.title,
        content: entry.content,
        category: entry.category,
        kind: entry.kind,
        occurredAt: time?.precision === "day" ? time.from || "" : "",
        validity,
        evidence: [evidence],
        sources: [],
        statement: entry.quote,
        status: "draft",
        space: "personal",
        people: entry.people,
        place: entry.place,
        attribute: entry.attribute || undefined,
        uncertainty: entry.uncertainty,
        conversationId: run.conversationId,
        runId: run.id,
        conflictsWith: entry.conflictIds.filter((id) =>
          candidates.some((candidate) => candidate.id === id),
        ),
        ingestion: {
          jobId: job.id,
          chunkId: job.messageId,
          modelId: job.modelId,
          extractorVersion: CAPTURE_VERSION,
        },
      };
      const direct =
        entry.direct &&
        entry.kind === "statement" &&
        !entry.identityClaim &&
        !entry.uncertainty &&
        explicitPersonalStatement(source.text, entry.quote);
      const conflicts = this.store.memories.memoryConflicts(input);
      if (direct && !conflicts.length) {
        input.status = "confirmed";
        input.acceptedBy = "policy";
      } else
        input.reason = conflicts.length
          ? "与现有记忆冲突，等待核对"
          : entry.identityClaim
            ? "人物身份关联等待核对"
            : "来源或陈述需要核对";
      const liveDuplicate = entry.duplicateOf
        ? this.store.memories.get<MemoryEntry>("memory", entry.duplicateOf)
        : undefined;
      const suggested =
        liveDuplicate &&
        candidates.some(
          (candidate) =>
            candidate.id === liveDuplicate.id &&
            candidate.version === liveDuplicate.version,
        ) &&
        normalizeFact(liveDuplicate.content) === normalizeFact(entry.content)
          ? liveDuplicate
          : undefined;
      const duplicate =
        suggested && direct && !conflicts.length && !suggested.forgottenAt
          ? suggested
          : this.store.memories.duplicateMemory(input);
      if (duplicate && (duplicate.status === "draft" || direct)) {
        const merged = this.store.memories.addMemoryEvidence(duplicate.id, [
          evidence,
        ]);
        const sameMessageProfile = merged.status === "draft" && input.status === "confirmed" && merged.kind === "statement" &&
          merged.category === "profile" && !merged.editedBy && !merged.supersededBy &&
          evidenceOf(duplicate).some((source) => source.type === "message" && source.messageId === job.messageId && source.sha256 === job.sourceHash) &&
          !this.store.memories.memoryConflicts(merged).length;
        const saved = sameMessageProfile ? this.store.memories.confirmCapturedProfile(merged.id, merged.version, input.ingestion!) : merged;
        ids.add(saved.id);
      } else ids.add(this.store.memories.createMemory(input).id);
    }
    return [...ids];
  }
  cancel(id: string) {
    const job = this.job(id);
    if (terminal(job.status)) return job;
    job.status = "cancelled";
    this.save(job);
    if (id === this.activeId) this.controller?.abort();
    return job;
  }
  cancelPending() {
    for (const job of this.pending()) {
      this.cancel(job.id);
      const run = this.store.memories.get<Run>("run", job.runId);
      if (
        run?.captureMemory &&
        ["queued", "running", "waiting"].includes(run.status)
      )
        this.store.recordMemoryActivity?.(
          run.id,
          { captureMemory: false },
          "memory-capture-disabled",
        );
    }
  }
  retry(id: string) {
    const job = this.job(id);
    if (
      job.id === this.activeId ||
      !["failed", "cancelled"].includes(job.status)
    )
      throw new UserFacingError(409, "CAPTURE_BUSY", "任务仍在运行或无需重试");
    if (
      !this.config.providers.some(
        (provider) => provider.model.id === job.modelId,
      )
    )
      throw new UserFacingError(400, "MODEL_UNAVAILABLE", "请恢复原模型连接");
    job.status = "queued";
    job.error = undefined;
    job.recoveries = 0;
    job.invalidResponseRetries = 0;
    this.save(job);
    this.wake();
    return job;
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.worker;
  }
}
