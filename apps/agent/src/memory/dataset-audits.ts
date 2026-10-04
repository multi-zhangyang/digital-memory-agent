import { randomUUID } from "node:crypto";
import type { DatasetAuditDecision, DatasetAuditJob, MemoryEntry, Run, TrainingSample } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { MemoryProcessors } from "./processors.js";
import { DatasetLedger } from "./dataset-ledger.js";
import { MemorySourceVerifier } from "./source-verifier.js";
import { UserFacingError } from "../errors.js";
import { DATASET_REVIEW_VERSION, type DatasetQualityDecision, type DatasetQualityInput } from "../dataset-quality-review.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import type { SampleChange } from "./dataset-review.js";
import { normalizeFact } from "./values.js";

type AuditRow = { data: string; status: DatasetAuditJob["status"]; revision: number };
type InputRow = { jobId: string; ordinal: number; memoryId: string; status: string; data: string; result?: string };
type Batch = { memory: MemoryEntry; samples: TrainingSample[]; selected: string[] };
type BatchResult = { attempts: { at: string; decisions?: DatasetQualityDecision[]; error?: string }[]; decisions: DatasetAuditDecision[] };
const now = () => new Date().toISOString();
const active = (job: DatasetAuditJob) => ["queued", "running"].includes(job.status);

/** Source-sized, durable quality review; owns no conversation or main Agent loop. */
export class DatasetAudits {
  private readonly listeners = new Set<(id: string) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private current?: { id: string; signal: AbortController };
  private closed = false;

  constructor(private readonly store: MemoryData, private readonly ledger: DatasetLedger, private readonly processors: () => MemoryProcessors | undefined,
    private readonly exports: { wake: () => void; flush: (id: string, signal: AbortSignal) => Promise<void>; authorize: (id: string, run: Run) => void }) {
    store.db.exec("UPDATE dataset_audits SET status='queued',revision=revision+1 WHERE status='running'");
  }

  get(id: string) {
    const row = this.store.db.prepare("SELECT data,status,revision FROM dataset_audits WHERE id=?").get(id) as AuditRow | undefined;
    if (!row) throw new UserFacingError(404, "AUDIT_NOT_FOUND", "样本核验作业不存在");
    return { ...JSON.parse(row.data) as DatasetAuditJob, status: row.status, revision: row.revision };
  }
  list() { return (this.store.db.prepare("SELECT id FROM dataset_audits ORDER BY rowid DESC LIMIT 50").all() as { id: string }[]).map(({ id }) => this.get(id)); }
  busy() { return !!this.store.db.prepare("SELECT 1 FROM dataset_audits WHERE status IN ('queued','running') LIMIT 1").get(); }
  assertIdle(datasetId: string) {
    if (this.store.db.prepare("SELECT 1 FROM dataset_audits WHERE datasetId=? AND status IN ('queued','running') LIMIT 1").get(datasetId))
      throw new UserFacingError(409, "AUDIT_BUSY", "样本核验中，请等待结束或先取消核验作业");
  }
  private patch(id: string, patch: Partial<DatasetAuditJob> & { phase?: string }) {
    const job = this.get(id), next = { ...job, ...patch, revision: job.revision + 1, updatedAt: now() };
    this.store.db.prepare("UPDATE dataset_audits SET status=?,revision=?,data=? WHERE id=?").run(next.status, next.revision, JSON.stringify(next), id);
    for (const listener of this.listeners) listener(id);
    return this.get(id);
  }

  submit(input: { datasetId: string; revision: number; requestKey: string; modelId: string; mode?: DatasetAuditJob["mode"] }) {
    const existing = this.store.db.prepare("SELECT id FROM dataset_audits WHERE requestKey=?").get(input.requestKey) as { id: string } | undefined;
    if (existing) {
      const job = this.get(existing.id);
      if (job.datasetId !== input.datasetId || job.datasetRevision !== input.revision || job.modelId !== input.modelId || job.mode !== (input.mode || "pending"))
        throw new UserFacingError(409, "COMMAND_CONFLICT", "此请求标识已经用于其他样本核验");
      return job;
    }
    const processor = this.processors();
    if (!processor?.reviewDatasetSamples || processor.hasModel && !processor.hasModel(input.modelId))
      throw new UserFacingError(400, "MODEL_UNAVAILABLE", "所选样本核验模型未配置");
    const job = this.store.memories.transaction(() => {
      const dataset = this.ledger.get(input.datasetId); this.assertIdle(dataset.id);
      if (dataset.revision !== input.revision) throw new UserFacingError(409, "VERSION_CONFLICT", "数据集已更新，请重新读取");
      if (dataset.stale || dataset.status !== "completed") throw new UserFacingError(409, "DATASET_NOT_READY", "请先完成当前确认版本的构建");
      const mode = input.mode || "pending", id = randomUUID();
      const counts: DatasetAuditJob["counts"] = { total: 0, processed: 0, approved: 0, revised: 0, excluded: 0, deferred: 0, failed: 0, retained: 0, unsupported: 0 };
      const data: DatasetAuditJob & { phase: string } = { id, datasetId: dataset.id, datasetRevision: dataset.revision, modelId: input.modelId,
        title: "核验样本 · " + dataset.title, protocolVersion: DATASET_REVIEW_VERSION, mode, status: "queued", revision: 1, counts,
        usage: { calls: 0, input: 0, output: 0 }, phase: "reviewing", createdAt: now(), updatedAt: now() };
      this.store.db.prepare("INSERT INTO dataset_audits VALUES(?,?,?,'queued',1,?)").run(id, dataset.id, input.requestKey, JSON.stringify(data));
      counts.unsupported = Number(this.store.db.prepare(`SELECT count(*) AS n FROM dataset_samples WHERE datasetId=? AND status<>'excluded'
        AND (json_extract(data,'$.kind')<>'qa' OR json_array_length(json_extract(data,'$.memoryRefs'))<>1)`).get(dataset.id)!.n);
      let ordinal = 0;
      for (const row of this.store.db.prepare("SELECT data FROM dataset_inputs WHERE datasetId=? ORDER BY ordinal").iterate(dataset.id)) {
        const memory = JSON.parse(String(row.data)) as MemoryEntry;
        const samples = (this.store.db.prepare(`SELECT s.data,s.version,s.status,s.stale FROM dataset_samples s JOIN dataset_sample_dependencies d ON d.sampleId=s.id
          WHERE s.datasetId=? AND d.kind='memory' AND d.parentId=? AND json_extract(s.data,'$.kind')='qa'
          AND json_array_length(json_extract(s.data,'$.memoryRefs'))=1 ORDER BY s.id`).all(dataset.id, memory.id) as
          { data: string; version: number; status: TrainingSample["status"]; stale: number }[])
          .map((sample) => ({ ...JSON.parse(sample.data) as TrainingSample, version: sample.version, status: sample.status, stale: !!sample.stale }));
        const selected = new Set(samples.filter((sample) => sample.status !== "excluded" && (mode === "all" || sample.status === "review")).map((sample) => sample.id));
        for (const sample of samples) if (sample.status !== "excluded" && sample.evaluationOf && selected.has(sample.evaluationOf.id)) selected.add(sample.id);
        counts.retained += samples.length - selected.size;
        if (!selected.size) continue;
        if (samples.length > 50) throw new UserFacingError(422, "AUDIT_BATCH_TOO_LARGE", "同一来源问答超过单批核验范围，请先整理重复样本");
        counts.total += selected.size;
        this.store.db.prepare("INSERT INTO dataset_audit_inputs(jobId,ordinal,memoryId,status,data) VALUES(?,?,?,'pending',?)")
          .run(id, ++ordinal, memory.id, JSON.stringify({ memory, samples, selected: [...selected] } satisfies Batch));
      }
      if (!counts.total) throw new UserFacingError(422, "EMPTY_AUDIT", "此范围没有需要核验的问答样本");
      this.store.db.prepare("UPDATE dataset_audits SET data=? WHERE id=?").run(JSON.stringify(data), id);
      return this.get(id);
    });
    this.wake(); return job;
  }

  start() { if (!this.closed && !this.timer) { this.timer = setInterval(() => this.wake(), 500); this.timer.unref(); this.wake(); } }
  wake() { if (!this.closed && !this.running) this.running = this.drain().finally(() => { this.running = undefined; }); }
  private check(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const job = this.get(id), dataset = this.ledger.get(job.datasetId);
    if (!active(job)) throw new UserFacingError(409, "AUDIT_STOPPED", "样本核验已停止");
    if (dataset.stale) throw new UserFacingError(409, "DATASET_STALE", "来源已纠正，请重新构建当前版本");
    return job;
  }
  private async drain() {
    while (!this.closed) {
      const row = this.store.db.prepare("SELECT id FROM dataset_audits WHERE status='queued' ORDER BY rowid LIMIT 1").get() as { id: string } | undefined;
      if (!row) return;
      const controller = new AbortController(); this.current = { id: row.id, signal: controller };
      try { await this.run(row.id, controller.signal); }
      catch (failure) {
        if (this.closed) return;
        if (active(this.get(row.id))) this.patch(row.id, { status: "failed", error: failure instanceof UserFacingError ? failure.message : "样本核验未完成，可重试未完成部分" });
        this.exports.wake();
      } finally { this.current = undefined; }
    }
  }

  private changes(batch: Batch, decisions: DatasetQualityDecision[]): SampleChange[] {
    const targets = new Set(batch.selected);
    if (decisions.length !== targets.size || new Set(decisions.map((decision) => decision.index)).size !== targets.size ||
      decisions.some((decision) => !batch.samples[decision.index] || !targets.has(batch.samples[decision.index].id)))
      throw new UserFacingError(422, "AUDIT_COVERAGE", "核验须覆盖本批每道待审题且不得修改未选择题");
    return decisions.map((decision) => {
      const sample = batch.samples[decision.index];
      const training = decision.trainingIndex === null ? undefined : batch.samples[decision.trainingIndex];
      if (decision.trainingIndex !== null && (!training || sample.intendedUse !== "evaluation" || training.intendedUse !== "training"))
        throw new UserFacingError(422, "EVALUATION_MISMATCH", "评测须选择本批实际训练题");
      return { id: sample.id, version: sample.version, action: decision.action, reason: decision.reason,
        question: decision.question ?? undefined, answer: decision.answerQuote ?? undefined,
        ...(training ? { evaluationOf: { id: training.id, version: training.version } } : {}),
      };
    });
  }

  private async batch(id: string, row: InputRow, signal: AbortSignal) {
    const batch = JSON.parse(row.data) as Batch;
    const result: BatchResult = row.result ? JSON.parse(row.result) : { attempts: [], decisions: [] };
    const verifier = new MemorySourceVerifier(this.store);
    const input: DatasetQualityInput = { modelId: this.get(id).modelId,
      memory: { title: batch.memory.title, content: batch.memory.content, category: batch.memory.category, occurredAt: batch.memory.occurredAt, validity: batch.memory.validity },
      samples: batch.samples.map((sample) => {
        const trainingIndex = sample.evaluationOf ? batch.samples.findIndex((training) => training.id === sample.evaluationOf!.id) : -1;
        return { question: sample.question, answer: sample.answer, intendedUse: sample.intendedUse, status: sample.status,
          reviewable: batch.selected.includes(sample.id), trainingIndex: trainingIndex < 0 ? null : trainingIndex };
      }),
    };
    const previousAttempt = result.attempts.at(-1);
    if (previousAttempt?.decisions && previousAttempt.error) input.repair = { decisions: previousAttempt.decisions, error: previousAttempt.error };
    let decisions: DatasetQualityDecision[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const job = this.check(id, signal);
        await verifier.verify(batch.memory, signal);
        for (const sample of batch.samples) {
          if (this.ledger.pairings.get(job.datasetId, sample.id)?.version !== sample.version)
            throw new UserFacingError(409, "VERSION_CONFLICT", "核验期间样本已更新，请重新提交核验");
          this.store.db.prepare("INSERT OR IGNORE INTO dataset_audit_views VALUES(?,?,?)").run(id, sample.id, sample.version);
        }
        this.patch(id, { usage: { ...job.usage, calls: job.usage.calls + 1 } });
        const generated = await this.processors()!.reviewDatasetSamples!(input, signal);
        this.check(id, signal); decisions = generated.decisions;
        const usage = this.get(id).usage;
        this.patch(id, { usage: { ...usage, input: usage.input + generated.usage.input, output: usage.output + generated.usage.output } });
        result.attempts.push({ at: now(), decisions });
        await verifier.verify(batch.memory, signal); this.check(id, signal);
        const changes = this.changes(batch, decisions);
        const receipt = this.store.memories.transaction(() => {
          const applied = this.ledger.changeSamples(job.datasetId, changes, "按冻结正文逐题核验人物、所问关系、时间、答案与训练/评测关联", {
            actor: "processor", jobId: id, modelId: job.modelId, protocolVersion: job.protocolVersion, requestKey: `audit:${id}:${row.ordinal}`,
          });
          result.decisions = changes.map((change) => ({ id: change.id, previousVersion: change.version,
            version: applied.after.find((sample) => sample.id === change.id)!.version,
            question: this.ledger.pairings.get(job.datasetId, change.id)!.question, action: change.action, reason: change.reason!, status: "applied" }));
          this.store.db.prepare("UPDATE dataset_audit_inputs SET status='completed',result=? WHERE jobId=? AND ordinal=?").run(JSON.stringify(result), id, row.ordinal);
          const current = this.get(id), counts = { ...current.counts, processed: current.counts.processed + changes.length };
          for (const change of changes) counts[change.action === "approve" ? "approved" : change.action === "revise" ? "revised" : change.action === "exclude" ? "excluded" : "deferred"]++;
          this.patch(id, { counts });
          return applied;
        });
        return receipt;
      } catch (failure) {
        if (signal.aborted || this.closed) throw failure;
        let error = failure instanceof UserFacingError ? failure.message : "本批样本核验未完成，可重试";
        if (failure instanceof UserFacingError && failure.code === "DUPLICATE_QUESTION" && decisions) {
          const final = batch.samples.map((sample, index) => {
            const decision = decisions!.find((decision) => decision.index === index);
            return { index, excluded: decision?.action === "exclude" || (!decision && sample.status === "excluded"),
              question: normalizeFact(decision?.action === "revise" ? decision.question ?? sample.question : sample.question) };
          });
          const pairs = final.flatMap((sample, index) => sample.excluded ? [] : final.slice(index + 1)
            .filter((other) => !other.excluded && other.question === sample.question).map((other) => `${sample.index} 与 ${other.index}`));
          if (pairs.length) error += `；samples 中从 0 开始的题目索引 ${pairs.join("、")} 的最终问题完全相同。须改写其中至少一道题，保留所问事实与配对答案；仅修改 reason 或 trainingIndex 不解决重复`;
        }
        if (result.attempts.length) result.attempts[result.attempts.length - 1].error = error;
        else result.attempts.push({ at: now(), error });
        this.store.db.prepare("UPDATE dataset_audit_inputs SET result=? WHERE jobId=? AND ordinal=?").run(JSON.stringify(result), id, row.ordinal);
        if (attempt === 0 && decisions && failure instanceof UserFacingError && [400, 422].includes(failure.status)) { input.repair = { decisions, error }; continue; }
        result.decisions = batch.samples.filter((sample) => batch.selected.includes(sample.id)).map((sample) => ({ id: sample.id, previousVersion: sample.version,
          question: sample.question, action: "defer", reason: "核验未提交，保留原样本", status: "failed", error }));
        this.store.memories.transaction(() => {
          this.store.db.prepare("UPDATE dataset_audit_inputs SET status='failed',result=? WHERE jobId=? AND ordinal=?").run(JSON.stringify(result), id, row.ordinal);
          const job = this.get(id); this.patch(id, { counts: { ...job.counts, processed: job.counts.processed + batch.selected.length, failed: job.counts.failed + batch.selected.length } });
        });
        return;
      }
    }
  }

  private async run(id: string, signal: AbortSignal) {
    this.patch(id, { status: "running", error: undefined, phase: "reviewing" });
    for (;;) {
      this.check(id, signal);
      const row = this.store.db.prepare("SELECT * FROM dataset_audit_inputs WHERE jobId=? AND status='pending' ORDER BY ordinal LIMIT 1").get(id) as InputRow | undefined;
      if (!row) break;
      await this.batch(id, row, signal);
    }
    const job = this.check(id, signal);
    this.patch(id, { phase: "exporting" });
    this.ledger.patch(job.datasetId, { status: "queued", files: undefined });
    this.exports.wake(); await this.exports.flush(job.datasetId, signal);
    this.check(id, signal);
    const dataset = this.ledger.get(job.datasetId);
    if (dataset.status !== "completed") throw new UserFacingError(409, "DATASET_NOT_READY", "核验已保存，导出尚未完成，请重试作业");
    this.patch(id, { status: job.counts.failed ? "failed" : "completed", error: job.counts.failed ? "部分问答未核验，保留原样本与失败记录" : undefined });
  }

  cancel(id: string) {
    const job = this.get(id); if (!active(job)) return job;
    const cancelled = this.patch(id, { status: "cancelled", error: "已取消，已核验样本保留" });
    if (this.current?.id === id) this.current.signal.abort(); this.exports.wake(); return cancelled;
  }
  retry(id: string) {
    const job = this.get(id); this.assertIdle(job.datasetId);
    if (!["failed", "cancelled"].includes(job.status) || this.ledger.get(job.datasetId).stale)
      throw new UserFacingError(409, "AUDIT_UNAVAILABLE", "只有未完成且来源未过期的核验可重试");
    this.store.db.prepare("UPDATE dataset_audit_inputs SET status='pending' WHERE jobId=? AND status='failed'").run(id);
    const next = this.patch(id, { status: "queued", error: undefined, phase: "reviewing",
      counts: { ...job.counts, processed: job.counts.processed - job.counts.failed, failed: 0 } });
    this.wake(); return next;
  }
  result(id: string, offset = 0, limit = 8, maxBytes = 12000) {
    const audit = this.get(id), response = { audit, decisions: [] as DatasetAuditDecision[], nextOffset: null as number | null,
      datasetId: audit.datasetId, next: "核验决定已保存为模型审阅。完成后检查待核对和失败项，再交付实际文件。", trainingStarted: false };
    const rows = this.store.db.prepare(`SELECT j.value AS data FROM dataset_audit_inputs i,json_each(i.result,'$.decisions') j
      WHERE i.jobId=? ORDER BY i.ordinal,CAST(j.key AS INTEGER) LIMIT ? OFFSET ?`).all(id, Math.min(50, limit) + 1, offset) as { data: string }[];
    for (const row of rows.slice(0, limit)) {
      const decision = JSON.parse(row.data) as DatasetAuditDecision;
      if (decision.status === "failed" || decision.action === "defer") {
        const current = this.ledger.pairings.get(audit.datasetId, decision.id);
        if (current && !current.stale && current.version > (decision.version ?? decision.previousVersion) && current.review)
          decision.followUp = { version: current.version, status: current.status, actor: current.review.actor, reason: current.review.reason };
      }
      response.decisions.push(decision);
      if (Buffer.byteLength(JSON.stringify(response)) > maxBytes - 64) { response.decisions.pop(); break; }
    }
    response.nextOffset = rows.length > response.decisions.length ? offset + response.decisions.length : null;
    if (!response.decisions.length && rows.length)
      return { audit: { id, status: audit.status, counts: audit.counts }, datasetId: audit.datasetId,
        decisions: [] as DatasetAuditDecision[], detail: `/api/dataset-audits/${id}`, nextOffset: offset, truncated: true, trainingStarted: false };
    return response;
  }
  driver(): TaskJobDriver {
    const get = (id: string) => { const job = this.get(id); return { id, title: job.title, status: job.status, revision: job.revision, updatedAt: job.updatedAt,
      ownership: "library" as const, blockedReason: job.error, progress: { completed: job.counts.processed, total: job.counts.total, failed: job.counts.failed } }; };
    return { get, list: () => this.list().map((job) => get(job.id)), result: (id, offset, limit, maxBytes) => this.result(id, offset, limit, maxBytes),
      cancel: (id) => this.cancel(id), retry: (id) => this.retry(id), authorize: (id, run) => this.exports.authorize(this.get(id).datasetId, run),
      problem: (id) => {
        const job = this.get(id), dataset = this.ledger.get(job.datasetId);
        if (!["failed", "cancelled"].includes(job.status)) return;
        if (dataset.stale || dataset.status !== "completed") return "样本核验或文件导出仍未完成。";
        for (const row of this.store.db.prepare("SELECT data FROM dataset_audit_inputs WHERE jobId=? AND status<>'completed'").iterate(id)) {
          const batch = JSON.parse(String(row.data)) as Batch;
          for (const previous of batch.samples.filter((sample) => batch.selected.includes(sample.id))) {
            const current = this.ledger.pairings.get(job.datasetId, previous.id);
            if (!current || current.stale || current.version <= previous.version || !current.review)
              return "部分问答核验未完成，请检查失败或待核对样本。";
          }
        }
      },
      subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; } };
  }
  async idle() { this.wake(); await this.running; }
  async close() { this.closed = true; clearInterval(this.timer); this.current?.signal.abort(); await this.running; this.listeners.clear(); }
}
