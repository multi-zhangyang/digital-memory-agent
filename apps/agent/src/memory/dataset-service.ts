import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetRebuildInput, DatasetSampleSelection, DatasetScope, MemoryDataset, MemoryEntry, Run, TrainingSample } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { MemoryProcessors } from "./processors.js";
import { DATASET_GENERATOR_VERSION, verifyGeneratedQuestions } from "../dataset-question-generation.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import { DatasetLedger, type DatasetInput } from "./dataset-ledger.js";
import { MemorySourceVerifier, SourceVerificationError } from "./source-verifier.js";
import { evidenceOf, normalizeFact } from "./values.js";
import { UserFacingError } from "../errors.js";
import type { SampleChange, SampleReviewContext } from "./dataset-review.js";
import type { CommandReceipt } from "./commands.js";
import { DatasetRebuilds, datasetSampleId as sampleId } from "./dataset-rebuild.js";
import { DatasetAudits } from "./dataset-audits.js";

const finished = (job: MemoryDataset) => ["completed", "failed", "cancelled"].includes(job.status);
const filenames = { training: "training.jsonl", evaluation: "evaluation.jsonl", review: "review.jsonl", manifest: "manifest.json" } as const;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Frozen input iteration and independent processing, without a main Agent session. */
export class DatasetService {
  readonly ledger: DatasetLedger;
  readonly audits: DatasetAudits;
  private readonly listeners = new Set<(id: string) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private active?: { id: string; controller: AbortController };
  private closed = false;
  private invalidationCursor = 0;
  private readonly rebuilds: DatasetRebuilds;
  constructor(private readonly store: MemoryData, private readonly processors?: () => MemoryProcessors) {
    this.ledger = new DatasetLedger(store);
    this.rebuilds = new DatasetRebuilds(store, this.ledger);
    this.audits = new DatasetAudits(store, this.ledger, () => this.processors?.(), {
      wake: () => this.wake(), flush: (id, signal) => this.flush(id, signal), authorize: (id, run) => this.authorize(id, run),
    });
  }

  submit(input: { requestKey: string; title?: string; scope?: DatasetScope; format?: MemoryDataset["format"]; modelId?: string }, allowedAssetIds?: readonly string[]) {
    const scope = { ...input.scope };
    if (allowedAssetIds) {
      if (scope.assetIds?.some((id) => !allowedAssetIds.includes(id))) throw new UserFacingError(403, "SOURCE_SCOPE", "只能使用本次所选资料");
      scope.assetIds ||= [...allowedAssetIds];
    }
    const job = this.ledger.freeze({ requestKey: input.requestKey, title: input.title?.trim() || "个人记忆数据集", scope,
      space: "personal", format: input.modelId ? "qa" : input.format || "mixed", allowedAssetIds,
      ...(input.modelId ? { generation: { strategy: "model", modelId: input.modelId, version: DATASET_GENERATOR_VERSION } } : {}) });
    this.wake(); return job;
  }
  busy() {
    return this.audits.busy() || !!this.store.db.prepare("SELECT 1 FROM memory_datasets WHERE status IN ('queued','running') AND json_extract(data,'$.generation') IS NOT NULL LIMIT 1").get();
  }
  rebuild(input: DatasetRebuildInput, allowedAssetIds?: readonly string[]) {
    this.audits.assertIdle(input.datasetId);
    const job = this.rebuilds.submit(input, allowedAssetIds);
    this.notify(job.id); this.wake(); return job;
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.wake(), 500); this.timer.unref(); this.wake();
    this.audits.start();
  }
  wake() {
    if (this.closed || this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private notify(id: string) { for (const listener of this.listeners) listener(id); }
  private invalidations() {
    const rows = this.store.db.prepare("SELECT seq,datasetId FROM dataset_invalidations WHERE seq>? ORDER BY seq LIMIT 256")
      .all(this.invalidationCursor) as { seq: number; datasetId: string }[];
    for (const id of new Set(rows.map((row) => row.datasetId))) this.notify(id);
    this.invalidationCursor = rows.at(-1)?.seq || this.invalidationCursor;
  }
  private async drain() {
    this.invalidations();
    while (!this.closed) {
      const row = this.store.db.prepare(`SELECT id FROM memory_datasets d WHERE status='queued' AND stale=0
        AND NOT EXISTS(SELECT 1 FROM dataset_audits a WHERE a.datasetId=d.id AND a.status IN ('queued','running')
          AND json_extract(a.data,'$.phase')<>'exporting') ORDER BY rowid LIMIT 1`).get() as { id: string } | undefined;
      if (!row) return;
      const controller = new AbortController(); this.active = { id: row.id, controller };
      try { await this.build(row.id, controller.signal); }
      catch (error) {
        if (this.closed) return;
        const current = this.ledger.get(row.id);
        if (!finished(current) && !controller.signal.aborted) this.ledger.patch(row.id, { status: "failed", error: error instanceof UserFacingError ? error.message : "数据集构建未完成，可重试未完成部分" });
        this.notify(row.id);
      } finally { this.active = undefined; }
      this.invalidations();
    }
  }
  private check(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const job = this.ledger.get(id);
    if (job.stale || job.status === "cancelled" || job.status === "failed") throw new UserFacingError(409, "DATASET_UNAVAILABLE", job.error || "数据集任务已停止");
    return job;
  }
  private async verify(id: string, memory: MemoryEntry, verifier: MemorySourceVerifier, signal?: AbortSignal) {
    try { await verifier.verify(memory, signal); }
    catch (error) {
      if (error instanceof SourceVerificationError) this.ledger.invalidateSource(id, error.kind, error.parentId, "source-unavailable");
      throw error;
    }
  }
  private exclusion(memory: MemoryEntry) {
    if (memory.kind === "inference") return "推断不作为训练事实";
    if (memory.uncertainty?.trim()) return "记录仍有未解决的不确定性";
    if (this.store.memories.queries.pendingConflicts([memory]).items.length || memory.conflictsWith?.length) return "存在待核对冲突";
    if (!evidenceOf(memory).length && !(memory.kind === "statement" && memory.acceptedBy === "user" && memory.statement?.trim()))
      return "缺少可核验的原始来源或明确用户陈述";
    if (!memory.content.trim() || memory.content.length > 24000) return "记录为空或过长，需要先拆分核对";
    return undefined;
  }
  private makeSample(job: MemoryDataset, entries: MemoryEntry[], kind: TrainingSample["kind"], title: string): TrainingSample {
    const ready = entries.every((entry) => entry.acceptedBy === "user");
    const time = (entry: MemoryEntry) => [entry.occurredAt && `发生日期：${entry.occurredAt}`,
      entry.validity?.from && `记录有效期起点：${entry.validity.from}`, entry.validity?.to && `记录有效期终点：${entry.validity.to}`].filter(Boolean).join("；");
    const subject = title + (entries.length === 1 && time(entries[0]) ? `（${time(entries[0])}）` : "");
    return { id: sampleId(job.id, kind, entries.map((entry) => entry.id)), datasetId: job.id, version: 1, kind,
      question: kind === "narrative" ? `请叙述“${subject}”这条记录。` : kind === "combination" ? `关于“${title}”，有哪些已核对的记录？` : `关于“${subject}”，记录的内容是什么？`,
      answer: entries.map((entry) => kind === "combination" && time(entry) ? `${time(entry)}\n${entry.content}` : entry.content).join("\n"), status: ready ? "ready" : "review", stale: false,
      memoryRefs: entries.map(({ id, version }) => ({ id, version })), evidence: entries.flatMap(evidenceOf),
      checks: ["frozen-memory-versions", "current-source-bytes", "no-unresolved-uncertainty", "no-pending-conflicts", "verbatim-confirmed-content", "explicit-time-context",
        ...(kind === "combination" ? ["explicit-shared-event", "no-additional-inference"] : [])],
      authority: ready ? "user-confirmed" : entries.every((entry) => entry.acceptedBy === "policy") ? "policy-accepted" : "unreviewed", intendedUse: "training" };
  }
  private async process(job: MemoryDataset, input: DatasetInput, verifier: MemorySourceVerifier, signal: AbortSignal) {
    const memory = JSON.parse(input.data) as MemoryEntry;
    const reason = this.exclusion(memory);
    if (reason) { this.ledger.inputState(input, "excluded", reason); return; }
    await this.verify(job.id, memory, verifier, signal);
    this.check(job.id, signal);
    const contentKey = createHash("sha256").update(JSON.stringify([normalizeFact(memory.title), normalizeFact(memory.content), memory.occurredAt, memory.validity])).digest("hex");
    const previous = this.store.db.prepare("SELECT memoryId FROM dataset_unique_content WHERE datasetId=? AND contentKey=?").get(job.id, contentKey) as { memoryId: string } | undefined;
    if (previous && previous.memoryId !== memory.id) { this.ledger.inputState(input, "excluded", "与清单内已生成记录完全重复：" + previous.memoryId); return; }
    if (this.rebuilds.reuse(job, input, memory, contentKey)) return;
    if (job.generation) {
      const processors = this.processors?.();
      if (!processors?.generateDatasetQuestions) throw new UserFacingError(400, "PROCESSOR_UNAVAILABLE", "样本生成处理器未配置");
      const questionInput = { modelId: job.generation.modelId,
        memory: { title: memory.title, content: memory.content, category: memory.category, occurredAt: memory.occurredAt, validity: memory.validity } };
      const currentUsage = this.ledger.get(job.id).usage || { calls: 0, input: 0, output: 0 };
      this.ledger.patch(job.id, { usage: { ...currentUsage, calls: currentUsage.calls + 1 } });
      this.notify(job.id);
      const generated = await processors.generateDatasetQuestions(questionInput, signal);
      signal.throwIfAborted();
      verifyGeneratedQuestions(questionInput, generated);
      await this.verify(job.id, memory, verifier, signal);
      this.check(job.id, signal);
      this.store.memories.transaction(() => {
        const base = this.makeSample(job, [memory], "qa", memory.title.slice(0, 120));
        const generatedSample = (question: { question: string; answerQuote: string }, purpose: TrainingSample["intendedUse"], index: number): TrainingSample => ({ ...base,
          id: sampleId(job.id, `generated-${purpose}-${index}`, [memory.id]), question: question.question, answer: question.answerQuote,
          status: "review", authority: "unreviewed", intendedUse: purpose, generation: { modelId: job.generation!.modelId, version: job.generation!.version },
          checks: ["frozen-memory-versions", "current-source-bytes", "answer-quote-in-current-content", "distinct-training-and-evaluation-questions", "question-semantics-require-review"],
        });
        const training = generated.training.map((question, index) => generatedSample(question, "training", index));
        for (const sample of training) this.ledger.saveSample(sample);
        for (const [index, question] of generated.evaluation.entries()) this.ledger.saveSample({ ...generatedSample(question, "evaluation", index),
          evaluationOf: { id: training[question.trainingIndex].id, version: training[question.trainingIndex].version },
        });
        this.store.db.prepare("INSERT OR IGNORE INTO dataset_unique_content VALUES(?,?,?)").run(job.id, contentKey, memory.id);
        this.ledger.inputState(input, "review");
        const usage = this.ledger.get(job.id).usage!;
        this.ledger.patch(job.id, { usage: { ...usage, input: usage.input + generated.usage.input, output: usage.output + generated.usage.output } });
      });
      return;
    }
    this.store.memories.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO dataset_unique_content VALUES(?,?,?)").run(job.id, contentKey, memory.id);
      // IDs make the commit idempotent after interruption; a record and its samples commit together.
      const kinds: TrainingSample["kind"][] = job.format === "mixed" ? ["qa", "narrative"] : [job.format];
      for (const kind of kinds) this.ledger.saveSample(this.makeSample(job, [memory], kind, memory.title.slice(0, 120)));
      this.ledger.inputState(input, memory.acceptedBy === "user" ? "ready" : "review");
    });
  }
  private async combinations(job: MemoryDataset, signal: AbortSignal) {
    if (job.format !== "mixed" || job.generation) return;
    this.rebuilds.reuseCombinations(job);
    let after = "";
    for (;;) {
      const events = this.store.db.prepare(`SELECT d.parentId AS id FROM dataset_input_dependencies d JOIN dataset_inputs i
        ON i.datasetId=d.datasetId AND i.memoryId=d.memoryId WHERE d.datasetId=? AND d.kind='event' AND d.parentId>?
        AND i.status='ready' GROUP BY d.parentId HAVING count(*) BETWEEN 2 AND 3 ORDER BY d.parentId LIMIT 50`).all(job.id, after) as { id: string }[];
      if (!events.length) return;
      for (const event of events) {
        this.check(job.id, signal);
        const rows = this.store.db.prepare(`SELECT i.data FROM dataset_inputs i JOIN dataset_input_dependencies d
          ON d.datasetId=i.datasetId AND d.memoryId=i.memoryId WHERE i.datasetId=? AND d.kind='event' AND d.parentId=? AND i.status='ready' ORDER BY i.ordinal`)
          .all(job.id, event.id) as { data: string }[];
        const entries = rows.map((row) => JSON.parse(row.data) as MemoryEntry);
        // Combining repeated copies adds no coverage; larger events need a separate generation strategy.
        if (new Set(entries.map((entry) => normalizeFact(entry.content))).size !== entries.length) continue;
        const title = this.store.memories.ledger.graph.event(event.id).title;
        this.store.memories.transaction(() => this.ledger.saveSample(this.makeSample(job, entries, "combination", title.slice(0, 120))));
      }
      after = events.at(-1)!.id; await tick();
    }
  }
  private async build(id: string, signal: AbortSignal) {
    let job = this.ledger.patch(id, { status: "running", error: undefined }); this.notify(id);
    const verifier = new MemorySourceVerifier(this.store);
    for (let index = 0;; index++) {
      this.check(id, signal);
      const input = this.ledger.pending(id); if (!input) break;
      try { await this.process(job, input, verifier, signal); }
      catch (error) {
        if (signal.aborted || this.closed || this.ledger.get(id).stale) throw error;
        this.ledger.inputState(input, "failed", error instanceof UserFacingError ? error.message : "核验未完成");
      }
      if (job.generation || index % 20 === 19) { this.ledger.patch(id, {}); this.notify(id); await tick(); }
    }
    job = this.ledger.get(id);
    if (job.counts.failed) throw new UserFacingError(422, "DATASET_PARTIAL", "部分记录核验失败，请重试未完成部分");
    await this.combinations(job, signal);
    await this.verifyInputs(id, verifier, signal);
    const files = await this.export(id, signal);
    this.check(id, signal);
    this.ledger.patch(id, { status: "completed", files, error: undefined }); this.notify(id);
  }
  private async verifyInputs(id: string, verifier = new MemorySourceVerifier(this.store), signal?: AbortSignal) {
    let after = 0;
    for (;;) {
      const inputs = this.ledger.inputPage(id, after, 100); if (!inputs.length) return;
      for (const input of inputs) if (["ready", "review"].includes(input.status)) await this.verify(id, JSON.parse(input.data), verifier, signal);
      after = inputs.at(-1)!.ordinal; await tick();
      this.check(id, signal);
    }
  }
  private async write(id: string, name: keyof typeof filenames, chunks: AsyncIterable<string>, signal: AbortSignal) {
    const dir = join(this.store.dataDir, "datasets", id); await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, filenames[name]); const temporary = path + ".partial";
    const file = await open(temporary, "w", 0o600); const hash = createHash("sha256"); let bytes = 0;
    try {
      for await (const chunk of chunks) { this.check(id, signal); await file.writeFile(chunk); hash.update(chunk); bytes += Buffer.byteLength(chunk); }
      await file.sync();
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    finally { await file.close(); }
    this.check(id, signal); await rename(temporary, path);
    return { sha256: hash.digest("hex"), bytes };
  }
  private async *sampleLines(id: string, status: TrainingSample["status"], purpose?: TrainingSample["intendedUse"]) {
    let after = "";
    for (;;) {
      const samples = this.ledger.samples(id, after, 100); if (!samples.length) return;
      for (const sample of samples) if ((sample.status === status || (status === "review" && sample.status === "excluded")) && !sample.stale && (!purpose || sample.intendedUse === purpose)) yield JSON.stringify({
        sampleId: sample.id, version: sample.version,
        ...(purpose === "evaluation" ? { question: sample.question, expectedAnswer: sample.answer } :
          { messages: [{ role: "user", content: sample.question }, { role: "assistant", content: sample.answer }] }),
        lineage: { datasetId: id, memoryRefs: sample.memoryRefs, evidence: sample.evidence, checks: sample.checks, authority: sample.authority },
        ...(sample.reusedFrom ? { reusedFrom: sample.reusedFrom } : {}),
        ...(sample.evaluationOf ? { evaluationOf: sample.evaluationOf } : {}),
        intendedUse: sample.intendedUse, kind: sample.kind, status: sample.status, review: sample.review, quality: sample.quality, ...(sample.generation ? { generation: sample.generation } : {}),
      }) + "\n";
      after = samples.at(-1)!.id;
    }
  }
  private async *manifest(id: string, files: Partial<MemoryDataset["files"]>) {
    const job = this.ledger.get(id);
    yield JSON.stringify({ ...job, audit: undefined, revision: job.revision + 1, status: "completed", files,
      generator: job.generation ? `grounded-questions-v${job.generation.version}` : "grounded-templates-v1", trainingStarted: false,
      timeCheckVersion: 1,
      evaluationPairingVersion: 1,
      evaluationSplit: job.generation ? "held-out-question-variants" : "not-created",
      limitation: job.generation ? "评测候选题关联训练题的具体版本；是否考察同一事实须逐对核对。关联及原文校验不证明语义等价，未验证训练效果。" :
        "模板问答与原文叙述；组合仅限 2–3 条同事件确认记录。未验证改写多样性或训练效果。" }).slice(0, -1) + ',"inputs":[';
    let after = 0, first = true;
    for (;;) {
      const inputs = this.ledger.inputPage(id, after, 100); if (!inputs.length) break;
      for (const input of inputs) {
        yield (first ? "" : ",") + JSON.stringify({ memoryId: input.memoryId, version: input.memoryVersion, status: input.status,
          reason: input.reason, dependencies: this.ledger.dependencies(id, input.memoryId) }); first = false;
      }
      after = inputs.at(-1)!.ordinal;
    }
    yield '],"commands":[';
    first = true;
    for (const row of this.store.db.prepare(`SELECT DISTINCT c.rowid,c.data FROM dataset_input_dependencies d
      JOIN memory_commands c ON c.id=d.parentId WHERE d.datasetId=? AND d.kind='memory-command' ORDER BY c.rowid`).iterate(id)) {
      const { id: commandId, action, actor, instruction, sourceReads, before, after, createdAt } = JSON.parse(String(row.data)) as CommandReceipt;
      yield (first ? "" : ",") + JSON.stringify({ id: commandId, action, actor, instruction, sourceReads, before, after, createdAt }); first = false;
    }
    yield "]}\n";
  }
  private async export(id: string, signal: AbortSignal) {
    const training = await this.write(id, "training", this.sampleLines(id, "ready", "training"), signal);
    const evaluation = this.ledger.get(id).generation ? await this.write(id, "evaluation", this.sampleLines(id, "ready", "evaluation"), signal) : undefined;
    const review = await this.write(id, "review", this.sampleLines(id, "review"), signal);
    const files = { training, review, ...(evaluation ? { evaluation } : {}) };
    const manifest = await this.write(id, "manifest", this.manifest(id, files), signal);
    return { ...files, manifest };
  }
  async download(id: string, kind: keyof typeof filenames) {
    this.audits.assertIdle(id);
    const job = this.check(id);
    if (job.status !== "completed" || !job.files) throw new UserFacingError(409, "DATASET_NOT_READY", "数据集尚未完成");
    const expected = job.files[kind];
    if (!expected) throw new UserFacingError(404, "DATASET_FILE_NOT_FOUND", "此数据集没有该导出文件");
    await this.verifyInputs(id); this.check(id);
    if (kind === "training" || kind === "evaluation") await this.verifySampleQuality(id, kind);
    if (this.ledger.get(id).revision !== job.revision) throw new UserFacingError(409, "VERSION_CONFLICT", "数据集已更新，请重新下载");
    const path = join(this.store.dataDir, "datasets", id, filenames[kind]);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== expected.sha256) throw new UserFacingError(409, "EXPORT_CHANGED", "导出文件校验不一致，请重新构建");
      this.check(id);
      if (this.ledger.get(id).revision !== job.revision || this.ledger.get(id).status !== "completed") throw new UserFacingError(409, "VERSION_CONFLICT", "文件读取期间数据集已改变，请重新下载");
      return { stream: file.createReadStream({ start: 0, autoClose: true }), filename: filenames[kind], bytes: expected.bytes };
    } catch (error) { await file.close(); throw error; }
  }
  cancel(id: string) {
    const job = this.ledger.get(id); if (finished(job)) return job;
    const cancelled = this.ledger.patch(id, { status: "cancelled", error: "已取消，已核验部分保留" });
    if (this.active?.id === id) this.active.controller.abort(); this.notify(id); return cancelled;
  }
  retry(id: string) {
    this.audits.assertIdle(id);
    const job = this.ledger.get(id);
    if (job.stale) throw new UserFacingError(409, "DATASET_STALE", "依赖已改变，需要从当前版本新建数据集");
    if (!["failed", "cancelled"].includes(job.status)) throw new UserFacingError(409, "DATASET_BUSY", "只能重试失败或取消的任务");
    this.store.memories.transaction(() => {
      this.store.db.prepare("UPDATE dataset_inputs SET status='pending',reason=NULL WHERE datasetId=? AND status='failed'").run(id);
      this.ledger.patch(id, { status: "queued", error: undefined, files: undefined });
    });
    this.notify(id); this.wake(); return this.ledger.get(id);
  }
  async review(id: string, refs: { id: string; version: number }[], reason: string) {
    await this.changeSamples(id, refs.map((ref) => ({ ...ref, action: "approve" })), reason, { actor: "user" });
    return this.ledger.get(id);
  }
  private async verifySampleQuality(id: string, purpose: TrainingSample["intendedUse"]) {
    let after = "";
    for (;;) {
      const samples = this.ledger.samples(id, after, 100);
      if (!samples.length) return;
      for (const sample of samples) if (sample.status === "ready" && sample.intendedUse === purpose) {
        const problem = sample.quality?.issues.find((issue) => issue.severity === "blocking");
        if (problem) throw new UserFacingError(422, problem.code.startsWith("evaluation-") ? "EVALUATION_MISMATCH" : "SAMPLE_TIME_AMBIGUOUS", problem.message + "。请检查并修订或排除后重新交付");
      }
      after = samples.at(-1)!.id; await tick(); this.check(id);
    }
  }
  async changeSamples(id: string, changes: SampleChange[], reason: string, context: SampleReviewContext, validate?: () => void) {
    this.audits.assertIdle(id);
    await this.verifyInputs(id);
    validate?.();
    const receipt = this.ledger.changeSamples(id, changes, reason, context);
    this.notify(id); this.wake(); return receipt;
  }
  authorize(id: string, run: Run) {
    const job = this.ledger.get(id);
    if (!run.useMemory || job.space !== "personal") throw new UserFacingError(403, "MEMORY_DISABLED", "本次任务未启用个人记忆或数据集不属于个人空间");
    if (run.scope === "selected" && this.store.db.prepare(`SELECT 1 FROM dataset_inputs i WHERE i.datasetId=? AND
      (NOT EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=i.memoryId) OR EXISTS(SELECT 1 FROM memory_evidence_index s
        WHERE s.memoryId=i.memoryId AND (s.assetId IS NULL OR s.assetId NOT IN (SELECT value FROM json_each(?))))) LIMIT 1`).get(id, JSON.stringify(run.assetIds)))
      throw new UserFacingError(403, "SOURCE_SCOPE", "数据集包含本次范围外的资料或消息");
  }
  async inspect(id: string, input: DatasetSampleSelection & { after?: string; limit?: number; revision?: number; runId?: string } = {}) {
    const dataset = this.check(id);
    if (input.after && input.revision !== dataset.revision) throw new UserFacingError(409, "DATASET_CURSOR_EXPIRED",
      "数据集已更新，请从首批重新读取：inspect_dataset 使用当前 datasetId，after=null、revision=null。不要猜测版本或游标；后续页照抄返回的 nextPage");
    if (input.after && !this.store.db.prepare("SELECT 1 FROM dataset_samples WHERE datasetId=? AND id=?").get(id, input.after))
      throw new UserFacingError(400, "INVALID_DATASET_CURSOR", "游标不属于此数据集；首次读取请设置 after=null、revision=null，后续页使用上次返回的 nextPage");
    await this.verifyInputs(id);
    const limit = Math.max(1, Math.min(20, input.limit || 6));
    const selection = { view: input.view || "all", ...(input.sampleIds ? { sampleIds: input.sampleIds } : {}) } satisfies DatasetSampleSelection;
    const page = this.ledger.samples(id, input.after, limit + 1, selection);
    const samples: TrainingSample[] = [];
    const trainingSamples = new Map<string, TrainingSample>();
    const memories = new Map<string, MemoryEntry>();
    for (const sample of page.slice(0, limit)) {
      const added = sample.memoryRefs.filter((ref) => !memories.has(ref.id)).map((ref) => {
        const row = this.store.db.prepare("SELECT data FROM dataset_inputs WHERE datasetId=? AND memoryId=? AND memoryVersion=?").get(id, ref.id, ref.version) as { data: string };
        return JSON.parse(row.data) as MemoryEntry;
      });
      const candidates = this.ledger.pairings.candidates(sample);
      const addedTraining = candidates.filter((training) => !trainingSamples.has(training.id));
      const bytes = Buffer.byteLength(JSON.stringify({ samples: [...samples, sample], trainingSamples: [...trainingSamples.values(), ...addedTraining], memories: [...memories.values(), ...added] }));
      if (samples.length && bytes > 16000) break;
      samples.push(sample);
      for (const memory of added) memories.set(memory.id, memory);
      for (const training of addedTraining) trainingSamples.set(training.id, training);
      if (input.runId) for (const viewed of [sample, ...candidates]) this.store.db.prepare("INSERT OR IGNORE INTO dataset_sample_views VALUES(?,?,?)").run(input.runId, viewed.id, viewed.version);
    }
    if (this.ledger.get(id).revision !== dataset.revision) throw new UserFacingError(409, "VERSION_CONFLICT", "数据集已更新，请重新读取");
    const nextCursor = page.length > samples.length ? samples.at(-1)?.id || null : null;
    return { dataset, samples, trainingSamples: [...trainingSamples.values()], memories: [...memories.values()].map(({ id, version, title, content, occurredAt, validity, acceptedBy }) => ({ id, version, title, content, occurredAt, validity, acceptedBy })),
      matchingSamples: this.ledger.sampleCount(id, selection), selection,
      nextCursor, nextPage: nextCursor ? { datasetId: id, after: nextCursor, revision: dataset.revision, limit, ...selection } : null,
      policy: "逐题结合冻结正文核对。评测题的 evaluationOf 必须指向实际训练题及版本；将评测题与 trainingSamples 中对应训练题逐对比较：人物、动作方向、所问关系、时间和答案范围都应一致，不能只看答案相同。关系不同须 revise 评测问法或选择并核对另一训练题，无法支持则排除。先修复 quality.issues 的 blocking 项；训练题修改会让关联评测题重新待核对。Agent 审阅不升级事实确认等级。" };
  }
  async delivery(id: string) {
    const job = this.check(id);
    if (job.status !== "completed" || !job.files) throw new UserFacingError(409, "DATASET_NOT_READY", "请等待导出完成");
    const files: { kind: string; name: string; href: string; bytes: number; sha256: string; records?: number }[] = [];
    for (const kind of ["training", ...(job.generation ? ["evaluation"] as const : []), "review", "manifest"] as const) {
      const file = await this.download(id, kind);
      let records = 0;
      for await (const chunk of file.stream) for (const byte of chunk as Buffer) if (byte === 10) records++;
      files.push({ kind, name: file.filename, href: `/api/memory-datasets/${id}/files/${kind}`, bytes: file.bytes,
        sha256: job.files[kind]!.sha256, ...(kind === "manifest" ? {} : { records }) });
    }
    if (!files.find((file) => file.kind === "training")?.records) throw new UserFacingError(422, "EMPTY_TRAINING_EXPORT", "训练文件为空，请先核对或修订有效样本");
    if (this.ledger.get(id).revision !== job.revision || this.ledger.get(id).stale) throw new UserFacingError(409, "VERSION_CONFLICT", "交付期间来源或样本已经改变，请重新核验");
    return { datasetId: id, revision: job.revision, files, sampleCounts: job.sampleCounts, verified: true, partial: !!job.sampleCounts?.review,
      trainingStarted: false, policy: "导出文件已验证来源版本与文件哈希。样本审阅主体随文件保留；尚未运行个人模型训练或效果评估。" };
  }
  result(id: string, offset = 0, limit = 8, maxBytes = 12000) {
    const job = this.ledger.get(id);
    const response = { dataset: job, inputs: [] as unknown[], nextOffset: null as number | null,
      links: { detail: `/api/memory-datasets/${id}`, training: `/api/memory-datasets/${id}/files/training`, review: `/api/memory-datasets/${id}/files/review`, manifest: `/api/memory-datasets/${id}/files/manifest`,
        ...(job.generation ? { evaluation: `/api/memory-datasets/${id}/files/evaluation` } : {}) },
      trainingStarted: false, policy: "模型生成问题需要核对；训练与评测问法分开导出，过期数据集禁止下载。",
      next: job.stale ? "依赖已变更，按原范围重建。" : job.status === "completed"
        ? `继续检查此数据集 ${id}，核对或修订待审样本，然后交付；已完成的构建或重建无需再提交。` : "等待后台完成后继续原任务。" };
    const rows = this.ledger.inputPage(id, offset, limit);
    for (const input of rows) {
      const entry = { memoryId: input.memoryId, version: input.memoryVersion, status: input.status, reason: input.reason, ordinal: input.ordinal };
      response.inputs.push(entry);
      if (Buffer.byteLength(JSON.stringify(response)) > maxBytes - 32) { response.inputs.pop(); break; }
    }
    const last = response.inputs.at(-1) as { ordinal: number } | undefined;
    response.nextOffset = (last?.ordinal ?? offset) < job.counts.total ? (last?.ordinal ?? offset) : null;
    if (Buffer.byteLength(JSON.stringify(response)) > maxBytes) return { dataset: { id, status: job.status, stale: job.stale, counts: job.counts },
      detail: response.links.detail, nextOffset: offset < job.counts.total ? offset : null, trainingStarted: false, truncated: true };
    return response;
  }
  driver(): TaskJobDriver {
    const get = (id: string) => { const job = this.ledger.get(id); return { id, title: job.title, status: job.status, revision: job.revision, updatedAt: job.updatedAt,
      ownership: "library" as const,
      progress: { completed: job.counts.processed, total: job.counts.total, failed: job.counts.failed } }; };
    return {
      get,
      list: () => this.ledger.list().map((job) => get(job.id)),
      result: (id, offset, limit, maxBytes) => this.result(id, offset, limit, maxBytes), cancel: (id) => this.cancel(id), retry: (id) => this.retry(id),
      subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
      authorize: (id, run) => this.authorize(id, run),
    };
  }
  async idle() { this.wake(); await this.running; }
  private async flush(id: string, signal: AbortSignal) {
    while (!this.closed && ["queued", "running"].includes(this.ledger.get(id).status)) {
      signal.throwIfAborted(); await this.idle(); await tick();
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.active?.controller.abort(); await this.audits.close(); await this.running; this.listeners.clear();
  }
}
