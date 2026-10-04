import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import type { DatasetService } from "./memory/dataset-service.js";
import type { TaskJobs } from "./harness/jobs.js";
import { UserFacingError } from "./harness/runtime.js";
import { commandRun } from "./application/memory-command-context.js";
import { inspectedReference, versionedReference } from "./application/tool-record-references.js";

const uuid = Type.String({ format: "uuid" });
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const sampleChange = {
  action: Type.Union([Type.Literal("approve"), Type.Literal("revise"), Type.Literal("exclude"), Type.Literal("defer")], { description: "approve keeps the current question and answer (omit them or echo unchanged values). revise changes question/answer. exclude removes the sample from exports while keeping its audit. defer retains the current question and answer in review with a specific unresolved reason, removing it from training/evaluation exports." }),
  question: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()])),
  answer: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 24000 }), Type.Null()])),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Explain this exact inspected question using its intendedUse, current question/answer and frozen source. Do not call a training question an evaluation question or copy another sample's pair comparison. Overrides the batch reason for this sample's review record." })),
  evaluationOf: Type.Optional(Type.Union([
    inspectedReference("sample"), versionedReference, Type.Null(),
  ], { description: "Only for action=revise of an evaluation question: the exact training sample previously read in trainingSamples, preferably its short ref. Compare the relation being asked, not only the answer. Omit or set null for approve, exclude and defer; these keep the current pairing." })),
};
export function createDatasetTools(store: Store, datasets: DatasetService, jobs: TaskJobs, conversationId: string) {
  return [defineTool({
    name: "build_dataset", label: "构建数据集",
    description: "Build a dataset from all eligible confirmed memories in an authorized scope. Set generation=model to generate natural training questions and separate closed-book evaluation question variants; the service uses the selected connection, validates answer quotes and keeps generated questions for review. generation=template preserves grounded QA/narratives without a model call. The independent worker persists progress, verifies sources and exports separate files. It does not train a model. Do not approximate a corpus with search Top-K. Revisions invalidate dependent samples. End this model turn after submission; completion is delivered automatically without polling.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      format: Type.Optional(Type.Union([Type.Literal("qa"), Type.Literal("narrative"), Type.Literal("mixed")])),
      generation: Type.Optional(Type.Union([Type.Literal("model"), Type.Literal("template")])),
      modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      scope: Type.Optional(Type.Object({
        memoryIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 200, uniqueItems: true })),
        assetIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 200, uniqueItems: true })),
        category: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("event"), Type.Literal("relationship"), Type.Literal("profile")])),
        personId: Type.Optional(uuid), eventId: Type.Optional(uuid),
        from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const run = store.work.activeRun(conversationId);
      if (!run?.useMemory) throw new UserFacingError(403, "MEMORY_DISABLED", "本次任务未启用个人记忆");
      if ((run.jobs?.length || 0) >= 8) throw new UserFacingError(409, "JOB_LIMIT", "本次任务已达到后台作业数量上限");
      const scope = input.scope || {};
      const modelId = input.generation === "model" ? input.modelId || store.memories.ledger.settings().datasetModelId || run.modelId : undefined;
      const requestKey = createHash("sha256").update(JSON.stringify([run.id, "build_dataset", store.work.memory.revision, input.format || "mixed",
        modelId,
        { ...scope, assetIds: scope.assetIds && [...scope.assetIds].sort(), memoryIds: scope.memoryIds && [...scope.memoryIds].sort() }])).digest("hex");
      const job = datasets.submit({ title: input.title, format: input.format, scope, modelId, requestKey }, run.scope === "selected" ? run.assetIds : undefined);
      const attached = jobs.attach(run.id, "memory-dataset", job.id, toolCallId);
      if (signal?.aborted) { jobs.cancel(run.id); signal.throwIfAborted(); }
      return { content: [{ type: "text" as const, text: JSON.stringify({ job: attached, accepted: true, frozenMemories: job.counts.total,
        trainingStarted: false, next: "后台完成后自动返回核验结果和导出链接；不要轮询或把受理当作完成。" }) }], details: {} };
    },
  }),
  defineTool({
    name: "rebuild_dataset", label: "从当前记忆重建数据集",
    description: "Rebuild a completed, failed or cancelled dataset from current confirmed versions using its original scope, format and generation model. Inspect datasetId=null to obtain its real ID and revision, especially for stale datasets; never invent IDs. The independent service follows explicit memory replacements, excludes stopped/unconfirmed records, rechecks all source bytes and dependencies, and reuses unchanged sample versions with their existing review/exclusion status. Changed/new records generate new review samples. Old dataset/files/history remain unchanged. Check rebuild counts, inspect and review the new dataset, then deliver_dataset. End this model turn after submission; job completion resumes the task automatically.",
    parameters: Type.Object({ datasetId: uuid, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const run = commandRun(store, conversationId, true);
      datasets.authorize(input.datasetId, run);
      const requestKey = createHash("sha256").update(JSON.stringify([run.id, "rebuild_dataset", input])).digest("hex");
      const job = datasets.rebuild({ ...input, requestKey }, run.scope === "selected" ? run.assetIds : undefined);
      jobs.attach(run.id, "memory-dataset", job.id, toolCallId, "library");
      return output({ job: jobs.list(run.id).find((item) => item.id === job.id), dataset: job,
        next: "原范围已冻结为新版本，等待后台完成后核对新样本；未变更样本保留已有审阅决定，再交付新文件。" });
    },
  }),
  defineTool({
    name: "audit_dataset", label: "批量核验训练样本",
    description: "Submit independent quality review of the real dataset ID and current revision obtained from inspect_dataset. The source-sized worker reads frozen confirmed text, compares training/evaluation relations, repairs supported questions and exact answer quotes, and saves per-sample processor-reviewed decisions. mode=pending processes unreviewed QA plus affected paired evaluations, retaining other review decisions; mode=all also rechecks ready QA. It never confirms personal facts. It persists progress, supports cancellation/retry and reexports files. It does not require the main Agent to paginate every sample. On completion inspect deferred/failed or unsupported samples, then deliver_dataset with real file links. End this turn after submission; completion resumes automatically.",
    parameters: Type.Object({ datasetId: uuid, revision: Type.Integer({ minimum: 1 }),
      modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      mode: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("all")])),
    }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const run = commandRun(store, conversationId, true);
      if ((run.jobs?.length || 0) >= 8) throw new UserFacingError(409, "JOB_LIMIT", "本次任务已达到后台作业数量上限");
      datasets.authorize(input.datasetId, run);
      const modelId = input.modelId || store.memories.ledger.settings().datasetReviewModelId || run.modelId;
      const requestKey = createHash("sha256").update(JSON.stringify([run.id, "audit_dataset", input, modelId])).digest("hex");
      const job = datasets.audits.submit({ ...input, modelId, requestKey });
      jobs.attach(run.id, "dataset-audit", job.id, toolCallId, "library");
      return output({ audit: job, accepted: true, trainingStarted: false, next: "独立核验按冻结来源处理并保存每题决定；等待后台完成，检查剩余待审和失败项后交付。" });
    },
  }),
  defineTool({
    name: "inspect_dataset", label: "检查训练样本",
    description: "Inspect real dataset samples with exact versions, review state, quality.issues and frozen source text. Use view=review for remaining unreviewed questions, or sampleIds copied from actual audit decisions to inspect only failed/deferred samples. matchingSamples is the full filtered count, not this page size. Evaluation samples retain evaluationOf; trainingSamples includes their corresponding training questions and same-source alternatives, with short refs usable in review_dataset. Compare each pair's subjects, relation, direction, time and answer scope: equal answers do not prove the same fact is asked. FIRST CALL: set after=null, revision=null (or omit both); NEVER invent cursor UUIDs or guess revision 1. Set datasetId=null to list recent authorized datasets. For subsequent pages copy nextPage including view/sampleIds. A change expires the cursor: restart. Read samples, paired training and sources before review_dataset.",
    parameters: Type.Object({ datasetId: Type.Optional(Type.Union([uuid, Type.Null()])),
      after: Type.Optional(Type.Union([uuid, Type.Null()], { description: "null for first/restarted page; otherwise exact nextCursor returned by this task. No placeholder UUID." })),
      revision: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "null for first/restarted page; otherwise copy the revision accompanying nextCursor." })),
      limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 20 }), Type.Null()])),
      view: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("review"), Type.Literal("ready"), Type.Literal("excluded"), Type.Null()])),
      sampleIds: Type.Optional(Type.Union([Type.Array(uuid, { minItems: 1, maxItems: 50, uniqueItems: true }), Type.Null()], { description: "Exact IDs from actual job decisions; omit to inspect the whole selected view." })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const run = commandRun(store, conversationId);
      if (!input.datasetId) return output({ datasets: datasets.ledger.list().filter((job) => {
        try { datasets.authorize(job.id, run); return true; } catch { return false; }
      }), coverage: "最近 30 个数据集中的获准范围，非全库统计" });
      datasets.authorize(input.datasetId, run);
      const result = await datasets.inspect(input.datasetId, { after: input.after ?? undefined, revision: input.revision ?? undefined, limit: input.limit ?? undefined,
        view: input.view ?? undefined, sampleIds: input.sampleIds ?? undefined, runId: run.id });
      signal?.throwIfAborted(); commandRun(store, conversationId);
      return output({ ...result, samples: result.samples.map((sample) => ({ ref: store.work.recordRef(run.id, "sample", sample.id, sample.version), ...sample })),
        trainingSamples: result.trainingSamples.map((sample) => ({ ref: store.work.recordRef(run.id, "sample", sample.id, sample.version), ...sample })),
        referencePolicy: "审阅时优先使用本次返回的短 ref（如 s1），它绑定已读取的样本版本；无需抄写长 ID。" });
    },
  }),
  defineTool({
    name: "review_dataset", label: "核对与修订训练样本",
    description: "Review samples actually inspected in this task, including paired training for each evaluation. approve accepts an unchanged question/answer and existing pairing; revise replaces question/answer or evaluationOf; exclude retains audit and removes exports; defer retains the unchanged question in review with its concrete unresolved reason. Set each sample's optional reason for its own evidence, using the batch reason only as fallback. Evaluation must ask the same relation as its exact training target, not merely share the answer. Use evaluationOf with a short ref from trainingSamples when assigning a pair; changing a training question or answer returns its unreviewed evaluation variants to review. Cite the semantic comparison in reason. Agent review does not confirm facts. Answers must quote frozen confirmed memory. Revise training and evaluation together when appropriate. The transaction records explicit decisions and propagated changes, then reexports in the background. End this turn after submission.",
    parameters: Type.Object({ datasetId: uuid, reason: Type.String({ minLength: 1, maxLength: 1000 }),
      samples: Type.Array(Type.Union([
        Type.Object({ ...inspectedReference("sample").properties, ...sampleChange }, { additionalProperties: false }),
        Type.Object({ ...versionedReference.properties, ...sampleChange }, { additionalProperties: false }),
      ]), { minItems: 1, maxItems: 50 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const run = commandRun(store, conversationId, true);
      datasets.authorize(input.datasetId, run);
      const existing = jobs.list(run.id).find((job) => job.kind === "memory-dataset" && job.id === input.datasetId);
      jobs.attach(run.id, "memory-dataset", input.datasetId, toolCallId, existing?.ownership || "library");
      const requestKey = createHash("sha256").update(JSON.stringify([run.id, "review_dataset", input])).digest("hex");
      const changes = input.samples.map((sample) => ({ ...store.work.resolveRecordRef(run.id, "sample", sample), action: sample.action, reason: sample.reason,
        question: sample.question ?? undefined, answer: sample.answer ?? undefined,
        ...(sample.evaluationOf ? { evaluationOf: store.work.resolveRecordRef(run.id, "sample", sample.evaluationOf) } : {}),
      }));
      const receipt = await datasets.changeSamples(input.datasetId, changes, input.reason, { actor: "agent", runId: run.id, requestKey }, () => {
        signal?.throwIfAborted(); commandRun(store, conversationId, true);
      });
      store.work.event(run.id, "dataset-command", { receipt });
      return output({ receipt, dataset: datasets.ledger.get(input.datasetId), next: "等待后台重新导出完成，随后检查剩余待审样本并用 deliver_dataset 核验交付文件。" });
    },
  }),
  defineTool({
    name: "deliver_dataset", label: "核验并交付训练文件",
    description: "Verify the actual exported training/evaluation/review/manifest files, their hashes, source versions and ready training/evaluation correspondence. Returns downloadable links, bytes, row counts and remaining-review coverage. Empty training exports or stale data cannot be delivered. Use after sample review and completed reexport, then give the user these real file links and material limitations. This delivers trainable files; it does not claim a model was trained or evaluated.",
    parameters: Type.Object({ datasetId: uuid }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const run = commandRun(store, conversationId);
      datasets.authorize(input.datasetId, run);
      const delivery = await datasets.delivery(input.datasetId);
      signal?.throwIfAborted(); commandRun(store, conversationId);
      jobs.acknowledge(run.id, "memory-dataset", input.datasetId, delivery.revision);
      return output(delivery);
    },
  })];
}
