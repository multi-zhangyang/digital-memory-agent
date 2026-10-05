import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Asset, MemoryEntry, Run } from "@memory/contracts";
import { Store } from "../src/store.js";
import { DatasetService } from "../src/dataset-service.js";
import { TaskJobs } from "../src/task-jobs.js";
import { createDatasetTools } from "../src/dataset-tools.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { MemoryVectors } from "../src/memory-vectors.js";
import type { MemoryProcessors } from "../src/memory-processors.js";
import type { DatasetQuestionResult } from "../src/dataset-question-generation.js";
import type { DatasetQualityDecision, DatasetQualityInput } from "../src/dataset-quality-review.js";
import type { DatasetAnswerInput } from "../src/memory/dataset-answer-checks.js";

// Explicit source-answer double for lifecycle fixtures whose questions all ask for the whole source.
const fixtureAnswers: NonNullable<MemoryProcessors["answerDatasetQuestions"]> = async ({ memory, questions }) => ({
  answers: questions.map((_, index) => ({ index, status: "answerable", answerQuote: memory.content, evidenceQuotes: [memory.content], factIndex: 0, reason: "固定协议样例均询问同一段交接正文" })),
  usage: { input: 0, output: 0 },
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(processors?: MemoryProcessors) {
  const dir = await mkdtemp(join(tmpdir(), "memory-dataset-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); const service = new DatasetService(store, processors ? () => processors : undefined);
  cleanup.push(async () => { await service.close(); if (store.db.isOpen) store.close(); });
  let ordinal = 0;
  async function memory(patch: Partial<MemoryEntry> = {}) {
    const text = patch.content || `第 ${++ordinal} 条用户核对的公园记录。`;
    const bytes = Buffer.from(text);
    const asset: Asset = { id: randomUUID(), name: "测试原件.txt", kind: "text", mimeType: "text/plain", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), bytes); store.addAsset(asset);
    const entry = store.work.createMemory({ title: "记录 " + ordinal, content: text, category: "fact", kind: "statement", status: "confirmed",
      acceptedBy: "user", occurredAt: "2025-03-02", conversationId: randomUUID(), runId: randomUUID(),
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: bytes.length, quote: text }], ...patch });
    return { entry, asset };
  }
  const start = (scope = {}) => service.submit({ requestKey: randomUUID(), scope, format: "mixed" });
  return { dir, store, service, memory, start };
}

describe("independent frozen dataset pipeline (real SQLite and source files, no model training)", () => {
  it("audits by frozen source, repairs one rejected batch and preserves processor decisions, exact pairs and archive history", async () => {
    const inputs: DatasetQualityInput[] = [];
    const processors: MemoryProcessors = {
      answerDatasetQuestions: fixtureAnswers,
      generateDatasetQuestions: async ({ memory }) => ({
        training: [{ question: `2025-03-02，${memory.title}确认了什么？`, answerQuote: memory.content },
          { question: `2025-03-02，${memory.title}有哪些记录内容？`, answerQuote: memory.content }],
        evaluation: [{ trainingIndex: 0, question: `2025-03-02，${memory.title}记载的事实是什么？`, answerQuote: memory.content }], usage: { input: 50, output: 30 },
      }),
      reviewDatasetSamples: async (input) => {
        inputs.push(structuredClone(input));
        const decisions: DatasetQualityDecision[] = input.samples.flatMap((sample, index) => !sample.reviewable ? [] : [{ index,
          action: "approve", question: null, answerQuote: null, trainingIndex: null, reason: "冻结正文记载同一交接事实，日期与人物方向一致" }]);
        if (inputs.length === 1) { decisions[0].action = "revise"; decisions[0].answerQuote = "原文没有的答案"; }
        else {
          const evaluation = input.samples.find((sample) => sample.intendedUse === "evaluation")!;
          const paired = decisions.find((decision) => decision.index === evaluation.trainingIndex)!;
          paired.action = "revise"; paired.question = `2025-03-02，${input.memory.title}确认的交接内容是什么？`;
        }
        return { decisions, usage: { input: 100, output: 60 } };
      },
    };
    const f = await fixture(processors);
    const first = await f.memory({ title: "钥匙交接", content: "林舟把备用钥匙交给陈默。" });
    const second = await f.memory({ title: "资料交接", content: "陈默把设计资料交给林舟。" });
    const before = f.store.memories.list("memory");
    const dataset = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator", scope: { memoryIds: [first.entry.id, second.entry.id] } });
    await f.service.idle();
    const job = f.service.audits.submit({ datasetId: dataset.id, revision: f.service.ledger.get(dataset.id).revision, requestKey: randomUUID(), modelId: "configured/reviewer" });
    await f.service.audits.idle();
    expect(f.service.audits.get(job.id)).toMatchObject({ status: "completed", counts: { total: 6, processed: 6, approved: 4, revised: 2, failed: 0 }, usage: { calls: 7, input: 300, output: 180 } });
    expect(inputs).toHaveLength(3); expect(inputs[1].repair?.error).toContain("来源作答不一致");
    expect(inputs.every((input) => input.samples.length === 3 && [first.entry.content, second.entry.content].includes(input.memory.content))).toBe(true);
    expect(f.store.memories.list("memory")).toEqual(before);
    const samples = f.service.ledger.samples(dataset.id);
    expect(samples.every((sample) => sample.version === 2 && sample.authority === "processor-reviewed" && sample.review?.jobId === job.id && sample.review.modelId === "configured/reviewer")).toBe(true);
    expect(samples.every((sample) => sample.answerCheck?.question === sample.question && sample.answerCheck?.answerQuote === sample.answer)).toBe(true);
    for (const sample of samples.filter((sample) => sample.intendedUse === "evaluation"))
      expect(sample.evaluationOf).toEqual({ id: sample.evaluationOf!.id, version: 2 });
    expect(f.service.audits.result(job.id, 0, 2).decisions).toHaveLength(2);
    expect(f.service.audits.result(job.id, 0, 2).nextOffset).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(f.service.audits.result(job.id, 0, 8, 1500)))).toBeLessThanOrEqual(1500);
    expect((await f.service.delivery(dataset.id)).verified).toBe(true);
    const archive = f.dir + "-audit-archive", restored = f.dir + "-audit-restored";
    cleanup.push(() => rm(archive, { recursive: true, force: true }), () => rm(restored, { recursive: true, force: true }));
    await f.service.close(); f.store.close(); await backupMemory(f.dir, archive); await restoreMemory(archive, restored);
    const reopened = new Store(restored), service = new DatasetService(reopened, () => processors);
    cleanup.push(async () => { await service.close(); reopened.close(); });
    expect(service.audits.get(job.id).status).toBe("completed");
    expect(service.ledger.samples(dataset.id)).toEqual(samples);
    expect(service.audits.result(job.id).decisions).toHaveLength(6);
    expect((await service.delivery(dataset.id)).verified).toBe(true);
    expect(inputs).toHaveLength(3);
    const evaluation = samples.find((sample) => sample.intendedUse === "evaluation")!;
    const training = samples.find((sample) => sample.id === evaluation.evaluationOf!.id)!;
    const runId = randomUUID();
    const inspected = await service.inspect(dataset.id, { sampleIds: [training.id], runId });
    expect(inspected.matchingSamples).toBe(1);
    expect(inspected.memories).toHaveLength(1);
    expect(reopened.db.prepare("SELECT sampleId FROM dataset_sample_views WHERE runId=?").all(runId)).toEqual([{ sampleId: training.id }]);
    const other = samples.find((sample) => sample.memoryRefs[0].id !== training.memoryRefs[0].id)!;
    await expect(service.changeSamples(dataset.id, [{ id: other.id, version: other.version, action: "approve" }], "未读取来源", { actor: "agent", runId })).rejects.toThrow("先在本次任务中读取");
    const deferred = await service.changeSamples(dataset.id, [{ id: training.id, version: training.version, action: "defer", reason: "交接事件的具体时间待核对" }], "批次默认依据", { actor: "agent", runId });
    await service.idle();
    expect(deferred.propagated).toEqual([{ id: evaluation.id, previousVersion: 2, version: 3, action: "require-review" }]);
    const pending = await service.inspect(dataset.id, { view: "review", limit: 1 });
    expect(pending.matchingSamples).toBe(2);
    expect(pending.nextPage).toMatchObject({ view: "review", limit: 1 });
    const secondPage = await service.inspect(dataset.id, pending.nextPage!);
    expect(secondPage.samples).toHaveLength(1);
    expect(secondPage.samples[0].id).not.toBe(pending.samples[0].id);
    expect(service.ledger.pairings.get(dataset.id, training.id)).toMatchObject({ question: training.question, answer: training.answer, status: "review", review: { actor: "agent", reason: "交接事件的具体时间待核对" } });
    expect(service.ledger.pairings.get(dataset.id, evaluation.id)?.answerCheck).toBeUndefined();
    expect((await service.delivery(dataset.id)).files.find((file) => file.kind === "review")?.records).toBe(2);
    expect((await service.inspect(dataset.id, { view: "ready", sampleIds: [training.id, other.id] })).samples.map((sample) => sample.id)).toEqual([other.id]);
    expect(reopened.memories.list("memory")).toEqual(before);
  });

  it("cancels an in-flight audit without committing late decisions and resumes only pending sources after a service restart", async () => {
    let calls = 0, answerCalls = 0, entered!: () => void, finish!: (value: { decisions: DatasetQualityDecision[]; usage: { input: number; output: number } }) => void;
    const enteredSecond = new Promise<void>((resolve) => { entered = resolve; });
    const processors: MemoryProcessors = {
      answerDatasetQuestions: async (...args) => { answerCalls++; return fixtureAnswers(...args); },
      generateDatasetQuestions: async ({ memory }) => ({
        training: [{ question: `2025-03-02，${memory.title}的内容是什么？`, answerQuote: memory.content }],
        evaluation: [{ trainingIndex: 0, question: `2025-03-02，${memory.title}确认了哪些内容？`, answerQuote: memory.content }], usage: { input: 1, output: 1 },
      }),
      reviewDatasetSamples: async (input) => {
        calls++;
        const result = { decisions: input.samples.map((_, index) => ({ index, action: "approve" as const, question: null, answerQuote: null, trainingIndex: null, reason: "日期、正文和成对交接关系一致" })), usage: { input: 10, output: 10 } };
        if (calls === 2) { entered(); return new Promise((resolve) => { finish = resolve; }); }
        return result;
      },
    };
    const f = await fixture(processors);
    await f.memory({ title: "甲记录", content: "林舟交出了钥匙。" }); await f.memory({ title: "乙记录", content: "陈默交出了资料。" });
    const dataset = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator" }); await f.service.idle();
    const job = f.service.audits.submit({ datasetId: dataset.id, revision: f.service.ledger.get(dataset.id).revision, requestKey: randomUUID(), modelId: "configured/reviewer" });
    await enteredSecond;
    const saved = f.service.ledger.samples(dataset.id).filter((sample) => sample.status === "ready");
    expect(saved).toHaveLength(2);
    await expect(f.service.changeSamples(dataset.id, saved.map(({ id, version }) => ({ id, version, action: "approve" })), "人工审阅", { actor: "user" })).rejects.toThrow("核验中");
    f.service.audits.cancel(job.id); finish({ decisions: [], usage: { input: 0, output: 0 } }); await f.service.audits.idle(); await f.service.idle();
    expect(f.service.audits.get(job.id).status).toBe("cancelled");
    expect(f.service.ledger.samples(dataset.id).filter((sample) => sample.status === "ready")).toEqual(saved);
    await f.service.close();
    const resumed = new DatasetService(f.store, () => processors); cleanup.push(() => resumed.close());
    resumed.audits.retry(job.id); await resumed.audits.idle();
    expect(resumed.audits.get(job.id)).toMatchObject({ status: "completed", counts: { processed: 4, approved: 4 } });
    expect(calls).toBe(3);
    expect(answerCalls).toBe(2); // The interrupted source already has a durable source-only answer.
    expect(resumed.ledger.samples(dataset.id).filter((sample) => saved.some((previous) => previous.id === sample.id))).toEqual(saved);
    expect((await resumed.delivery(dataset.id)).verified).toBe(true);
    const cancelled = resumed.audits.submit({ datasetId: dataset.id, revision: resumed.ledger.get(dataset.id).revision, requestKey: randomUUID(), modelId: "configured/reviewer", mode: "all" });
    resumed.audits.cancel(cancelled.id); await resumed.audits.idle(); await resumed.idle();
    expect(resumed.audits.driver().problem?.(cancelled.id)).toContain("未完成");
    const jobs = new TaskJobs(f.store); jobs.register("dataset-audit", resumed.audits.driver()); cleanup.push(async () => jobs.close());
    const conversation = f.store.createConversation();
    const continuation = f.store.work.createRun(conversation.id, { text: "读取未完成核验，保留疑点并交付剩余文件", modelId: "test-only", useMemory: true });
    f.store.work.patchRun(continuation.id, { status: "running" });
    jobs.attach(continuation.id, "dataset-audit", cancelled.id, "original-audit", "library");
    expect(jobs.hasWork(continuation.id)).toBe(true);
    expect(jobs.read(continuation.id, cancelled.id)).toMatchObject({ status: "cancelled" });
    expect(jobs.hasWork(continuation.id)).toBe(false);
    expect(jobs.problem(continuation.id)).toContain("未完成");
    const pendingMemory = saved[0].memoryRefs[0].id;
    await resumed.changeSamples(dataset.id, resumed.ledger.samples(dataset.id).map((sample) => ({ id: sample.id, version: sample.version,
      action: sample.memoryRefs[0].id === pendingMemory ? "defer" : "approve", reason: sample.memoryRefs[0].id === pendingMemory ? "该交接来源的事件时间需要补充，按用户要求暂缓训练" : "另一来源的交接事实和时间已核对" })),
      "核验取消后实际读取并处理每条剩余题，保留具体待核对项", { actor: "user" }); await resumed.idle();
    expect(resumed.audits.driver().problem?.(cancelled.id)).toBeUndefined();
    expect(jobs.problem(continuation.id)).toBeUndefined();
    expect(resumed.audits.get(cancelled.id).status).toBe("cancelled");
    expect((await resumed.delivery(dataset.id)).partial).toBe(true);
    expect(resumed.ledger.sampleCount(dataset.id, { view: "review" })).toBe(2);
  });

  it("preserves interrupted old-protocol audits without replaying them under a new protocol", async () => {
    let calls = 0;
    const processors: MemoryProcessors = {
      generateDatasetQuestions: async ({ memory }) => ({
        training: [{ question: "2025-03-02，交接记录是什么？", answerQuote: memory.content }],
        evaluation: [{ trainingIndex: 0, question: "2025-03-02，记载了哪些交接内容？", answerQuote: memory.content }], usage: { input: 0, output: 0 },
      }),
      answerDatasetQuestions: async (...args) => { calls++; return fixtureAnswers(...args); },
      reviewDatasetSamples: async (input) => {
        calls++;
        return { decisions: input.samples.map((_, index) => ({ index, action: "approve", question: null, answerQuote: null,
          trainingIndex: null, reason: "固定交接正文与题目一致" })), usage: { input: 0, output: 0 } };
      },
    };
    const f = await fixture(processors);
    await f.memory({ content: "林舟把钥匙交给陈默。" });
    const dataset = f.service.submit({ requestKey: randomUUID(), modelId: "configured/model" }); await f.service.idle();
    const old = f.service.audits.submit({ datasetId: dataset.id, revision: f.service.ledger.get(dataset.id).revision,
      requestKey: randomUUID(), modelId: "configured/model" });
    f.service.audits.cancel(old.id); await f.service.audits.idle(); await f.service.idle();
    const before = f.service.ledger.samples(dataset.id);
    await f.service.close();
    f.store.db.prepare("UPDATE dataset_audits SET status='running',data=json_set(data,'$.protocolVersion',1) WHERE id=?").run(old.id);
    const resumed = new DatasetService(f.store, () => processors); cleanup.push(() => resumed.close());
    await resumed.audits.idle();
    expect(resumed.audits.get(old.id)).toMatchObject({ status: "failed", protocolVersion: 1 });
    expect(resumed.audits.get(old.id).error).toContain("协议已更新");
    expect(() => resumed.audits.retry(old.id)).toThrow("新建核验作业");
    expect(resumed.ledger.samples(dataset.id)).toEqual(before);
    expect(calls).toBe(0);
    const current = resumed.audits.submit({ datasetId: dataset.id, revision: resumed.ledger.get(dataset.id).revision,
      requestKey: randomUUID(), modelId: "configured/model" });
    await resumed.audits.idle();
    expect(resumed.audits.get(current.id).status).toBe("completed");
    expect(calls).toBe(2);
    expect(resumed.audits.get(old.id)).toMatchObject({ status: "failed", protocolVersion: 1 });
  });

  it("blocks a reviewer that repeatedly approves a wrong but verbatim answer and reuses the completed source check", async () => {
    const answerInputs: DatasetAnswerInput[] = [], reviewInputs: DatasetQualityInput[] = [];
    const f = await fixture({
      generateDatasetQuestions: async () => ({
        training: [{ question: "2025-03-02，谁把雨伞借给了陆青？", answerQuote: "陆青" }],
        evaluation: [{ question: "2025-03-02，陆青从谁那里借到雨伞？", answerQuote: "陆青", trainingIndex: 0 }], usage: { input: 0, output: 0 },
      }),
      answerDatasetQuestions: async (input) => {
        answerInputs.push(structuredClone(input));
        return { answers: input.questions.map((_, index) => ({ index, status: "answerable", answerQuote: "沈禾", evidenceQuotes: [input.memory.content], factIndex: 0, reason: "正文明确沈禾为借出人" })), usage: { input: 20, output: 10 } };
      },
      reviewDatasetSamples: async (input) => {
        reviewInputs.push(structuredClone(input));
        return { decisions: input.samples.map((_, index) => ({ index, action: "approve", question: null, answerQuote: null, trainingIndex: null, reason: "有意错误的认可测试替身" })), usage: { input: 30, output: 10 } };
      },
    });
    const { entry } = await f.memory({ title: "借伞", content: "2025-03-02，沈禾把雨伞借给陆青。" });
    const job = f.service.submit({ requestKey: randomUUID(), modelId: "configured/model" }); await f.service.idle();
    const before = f.service.ledger.samples(job.id);
    const audit = f.service.audits.submit({ datasetId: job.id, revision: f.service.ledger.get(job.id).revision, modelId: "configured/model", requestKey: randomUUID() });
    await f.service.audits.idle();
    expect(f.service.audits.get(audit.id)).toMatchObject({ status: "failed", counts: { failed: 2, approved: 0 }, usage: { calls: 3, input: 80, output: 30 } });
    expect(answerInputs).toHaveLength(1); expect(Object.keys(answerInputs[0]).sort()).toEqual(["memory", "modelId", "questions"]);
    expect(reviewInputs).toHaveLength(2); expect(reviewInputs[1].repair?.error).toContain("来源作答不一致");
    expect(f.service.ledger.samples(job.id)).toEqual(before);
    expect(f.store.memories.get<MemoryEntry>("memory", entry.id)?.version).toBe(1);
    const history = JSON.parse(String(f.store.db.prepare("SELECT result FROM dataset_audit_inputs WHERE jobId=?").get(audit.id)!.result));
    expect(history.answerChecks).toHaveLength(1); expect(history.attempts).toHaveLength(2);
    const training = await f.service.download(job.id, "training");
    let text = ""; for await (const bytes of training.stream) text += bytes.toString();
    expect(text).toBe("");
  });

  it("rechecks revised questions without candidate answers and defers unsupported premises after repair", async () => {
    const inputs: DatasetAnswerInput[] = [];
    const f = await fixture({
      generateDatasetQuestions: async () => ({
        training: [{ question: "2025-03-02，转交给宋伊的旅行箱是什么颜色？", answerQuote: "蓝色" }],
        evaluation: [{ question: "2025-03-02，宋伊收到的旅行箱呈什么颜色？", answerQuote: "蓝色", trainingIndex: 0 }], usage: { input: 0, output: 0 },
      }),
      answerDatasetQuestions: async (input) => {
        inputs.push(structuredClone(input));
        return { answers: input.questions.map((question, index) => question.includes("自己购买")
          ? { index, status: "unsupported" as const, answerQuote: null, evidenceQuotes: [input.memory.content], factIndex: null, reason: "来源只说明接收，不说明购买" }
          : { index, status: "answerable" as const, answerQuote: "蓝色", evidenceQuotes: [input.memory.content], factIndex: 0, reason: "同一交接物品的颜色" }), usage: { input: 10, output: 10 } };
      },
      reviewDatasetSamples: async (input) => ({ decisions: input.samples.map((_, index) => ({ index,
        action: input.repair ? "defer" as const : "revise" as const,
        question: input.repair ? null : `2025-03-02，宋伊自己购买的旅行箱${index ? "呈什么颜色" : "是什么颜色"}？`,
        answerQuote: null, trainingIndex: null, reason: input.repair ? "购买前提没有来源，保留待核对" : "故意引入购买前提的测试替身",
      })), usage: { input: 10, output: 10 } }),
    });
    await f.memory({ content: "2025-03-02，邱野把蓝色旅行箱交给宋伊。旅行箱归谁所有没有记录。" });
    const job = f.service.submit({ requestKey: randomUUID(), modelId: "configured/model" }); await f.service.idle();
    const before = f.service.ledger.samples(job.id);
    const audit = f.service.audits.submit({ datasetId: job.id, revision: f.service.ledger.get(job.id).revision, requestKey: randomUUID(), modelId: "configured/model" });
    await f.service.audits.idle();
    expect(f.service.audits.get(audit.id)).toMatchObject({ status: "completed", counts: { deferred: 2, failed: 0 }, usage: { calls: 4 } });
    expect(inputs).toHaveLength(2); expect(inputs[0].questions.every((question) => !question.includes("自己购买"))).toBe(true);
    expect(inputs[1].questions.every((question) => question.includes("自己购买"))).toBe(true);
    const after = f.service.ledger.samples(job.id);
    expect(after.every((sample) => sample.version === 2 && sample.status === "review" && !sample.answerCheck)).toBe(true);
    expect(after.map((sample) => sample.question)).toEqual(before.map((sample) => sample.question));
  });

  it("rebuilds only a corrected input, retaining unchanged reviewed and excluded samples with exact version lineage", async () => {
    const calls: string[] = [];
    const f = await fixture({ generateDatasetQuestions: async (input) => {
      calls.push(input.memory.content);
      return { training: [{ question: `2025-03-02，${input.memory.title}的记录内容是什么？`, answerQuote: input.memory.content },
        { question: `2025-03-02，关于${input.memory.title}确认了什么？`, answerQuote: input.memory.content }],
        evaluation: [{ trainingIndex: 0, question: `2025-03-02，${input.memory.title}有哪些已确认的内容？`, answerQuote: input.memory.content }],
        usage: { input: 100, output: 50 } };
    } });
    const changed = await f.memory({ title: "钥匙交接", content: "林舟把备用钥匙交给陈默。" });
    const stable = await f.memory({ title: "周末去向", content: "陈默去了青石公园。" });
    await f.memory({ title: "原范围之外", content: "林舟去了枫林书店。" });
    const original = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator", scope: { memoryIds: [changed.entry.id, stable.entry.id] } });
    await f.service.idle();
    const originalSamples = f.service.ledger.samples(original.id);
    const stableEvaluation = originalSamples.find((sample) => sample.memoryRefs[0].id === stable.entry.id && sample.intendedUse === "evaluation")!;
    const stableTraining = originalSamples.filter((sample) => sample.memoryRefs[0].id === stable.entry.id && sample.intendedUse === "training")
      .sort((a, b) => Number(b.id === stableEvaluation.evaluationOf!.id) - Number(a.id === stableEvaluation.evaluationOf!.id));
    await f.service.changeSamples(original.id, f.service.ledger.samples(original.id).map((sample) => ({ id: sample.id, version: sample.version,
      action: sample.id === stableTraining[0].id ? "revise" as const : sample.id === stableTraining[1].id ? "exclude" as const : "approve" as const,
      ...(sample.id === stableTraining[0].id ? { question: "2025-03-02，周末去向这件事的已确认内容是什么？" } : {}) })),
      "核对原文和日期，保留已修订问法，排除重复训练问法", { actor: "user", requestKey: randomUUID() });
    await f.service.idle();
    const reviewedStable = f.service.ledger.samples(original.id).filter((sample) => sample.memoryRefs[0].id === stable.entry.id);
    const corrected = f.store.work.updateMemory(changed.entry.id, { content: "陈默把备用钥匙交给林舟。" }, changed.entry.version);
    const request = { datasetId: original.id, revision: f.service.ledger.get(original.id).revision, requestKey: randomUUID() };
    const rebuilt = f.service.rebuild(request);
    expect(f.service.rebuild(request).id).toBe(rebuilt.id);
    await f.service.idle();
    const done = f.service.ledger.get(rebuilt.id);
    expect(done.status, done.error).toBe("completed");
    expect(done.rebuild).toMatchObject({ datasetId: original.id, addedMemories: 0, removedMemories: 0, updatedMemories: 1,
      unchangedMemories: 1, reusedMemories: 1, reusedSamples: 3, reuseSamples: true });
    expect(done.scope).toEqual(original.scope); expect(done.generation).toEqual(original.generation);
    expect(done.usage?.calls).toBe(1); expect(calls).toHaveLength(3);
    const samples = f.service.ledger.samples(rebuilt.id);
    const fresh = samples.filter((sample) => sample.memoryRefs[0].id === changed.entry.id);
    expect(fresh).toHaveLength(3);
    expect(fresh.every((sample) => sample.status === "review" && sample.memoryRefs[0].version === corrected.version && !sample.reusedFrom)).toBe(true);
    for (const previous of reviewedStable) {
      const reused = samples.find((sample) => sample.reusedFrom?.sampleId === previous.id)!;
      expect(reused).toMatchObject({ question: previous.question, answer: previous.answer, status: previous.status,
        authority: previous.authority, review: previous.review, reusedFrom: { datasetId: original.id, sampleId: previous.id, version: previous.version } });
    }
    const reusedEvaluation = samples.find((sample) => sample.intendedUse === "evaluation" && sample.memoryRefs[0].id === stable.entry.id)!;
    const reusedTraining = samples.find((sample) => sample.id === reusedEvaluation.evaluationOf!.id)!;
    expect(reusedTraining.reusedFrom?.sampleId).toBe(stableEvaluation.evaluationOf!.id);
    expect(reusedEvaluation.evaluationOf!.version).toBe(reusedTraining.version);
    await expect(f.service.download(original.id, "training")).rejects.toThrow("修订");
    await f.service.review(rebuilt.id, fresh.map(({ id, version }) => ({ id, version })), "按纠正后的动作方向和原始日期核对新增问答");
    await f.service.idle();
    expect(f.service.ledger.get(rebuilt.id).usage?.calls).toBe(1);
    const training = (await readFile(join(f.dir, "datasets", rebuilt.id, "training.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(training).toHaveLength(3);
    expect(training.filter((row) => row.lineage.memoryRefs[0].id === changed.entry.id).every((row) => row.messages[1].content === corrected.content)).toBe(true);
    expect(training.find((row) => row.lineage.memoryRefs[0].id === stable.entry.id).reusedFrom).toMatchObject({ datasetId: original.id, version: 2 });
    const manifest = JSON.parse(await readFile(join(f.dir, "datasets", rebuilt.id, "manifest.json"), "utf8"));
    expect(manifest.rebuild).toEqual(done.rebuild); expect(manifest.trainingStarted).toBe(false);
    const reviewed = f.service.ledger.samples(rebuilt.id);
    const evaluation = reviewed.find((sample) => sample.intendedUse === "evaluation" && sample.memoryRefs[0].id === changed.entry.id)!;
    const paired = reviewed.find((sample) => sample.id === evaluation.evaluationOf!.id)!;
    const receipt = await f.service.changeSamples(rebuilt.id, [{ id: paired.id, version: paired.version, action: "revise",
      question: "2025-03-02，钥匙交接记录确认了哪些内容？" }], "训练问法修订，关联评测题需再次比较所问事实", { actor: "user" });
    await f.service.idle();
    const pending = f.service.ledger.samples(rebuilt.id).find((sample) => sample.id === evaluation.id)!;
    expect(pending).toMatchObject({ version: evaluation.version + 1, status: "review", authority: "unreviewed", evaluationOf: { id: paired.id, version: paired.version + 1 } });
    expect(pending.review).toBeUndefined();
    expect(receipt.propagated).toEqual([{ id: pending.id, previousVersion: evaluation.version, version: pending.version, action: "require-review" }]);
    const prior = f.store.db.prepare("SELECT data FROM dataset_sample_versions WHERE id=? AND version=?").get(evaluation.id, evaluation.version)!;
    expect(JSON.parse(String(prior.data)).review).toEqual(evaluation.review);
    await f.service.changeSamples(rebuilt.id, [{ id: pending.id, version: pending.version, action: "revise",
      question: "2025-03-02，关于这次钥匙交接确认了什么？", evaluationOf: pending.evaluationOf }], "训练题与评测题均询问同一交接记录的确认内容", { actor: "user" });
    await f.service.idle();
    expect((await f.service.delivery(rebuilt.id)).verified).toBe(true);
  });

  it("follows replacements within the original explicit scope, drops stopped inputs and never substitutes the whole library", async () => {
    const f = await fixture();
    const prior = await f.memory({ title: "居住城市", category: "profile", content: "我住在杭州。", attribute: { key: "home_city", value: "杭州" } });
    const stopped = await f.memory({ title: "周末去向", content: "周末去了青石公园。" });
    const job = f.start({ memoryIds: [prior.entry.id, stopped.entry.id] }); await f.service.idle();
    const replacement = await f.memory({ title: "居住城市", category: "profile", status: "draft", acceptedBy: undefined,
      content: "我住在苏州。", attribute: { key: "home_city", value: "苏州" } });
    const current = f.store.memories.resolveMemory(replacement.entry.id, replacement.entry.version, [{ id: prior.entry.id, version: prior.entry.version }]);
    f.store.memories.forgetMemory(stopped.entry.id, stopped.entry.version);
    await f.memory({ title: "范围之外", content: "林舟去了枫林书店。" });
    const next = f.service.rebuild({ datasetId: job.id, revision: f.service.ledger.get(job.id).revision, requestKey: randomUUID() });
    await f.service.idle();
    expect(f.service.ledger.get(next.id)).toMatchObject({ status: "completed", counts: { total: 1 },
      rebuild: { addedMemories: 1, removedMemories: 2, updatedMemories: 0, reusedSamples: 0 } });
    expect(next.scope.memoryIds).toEqual(expect.arrayContaining([current.id, stopped.entry.id]));
    expect(f.service.ledger.samples(next.id).every((sample) => sample.memoryRefs.length === 1 && sample.memoryRefs[0].id === current.id && sample.answer === current.content)).toBe(true);
    f.store.memories.forgetMemory(current.id, current.version);
    expect(() => f.service.rebuild({ datasetId: next.id, revision: f.service.ledger.get(next.id).revision, requestKey: randomUUID() })).toThrow("没有可用的确认记忆");
    expect(f.service.ledger.list()).toHaveLength(2);
  });

  it("keeps generated questions in review, exports evaluation separately and invalidates both after correction", async () => {
    const calls: unknown[] = [];
    const result: DatasetQuestionResult = {
      training: [{ question: "谁把钥匙交给了陈默？", answerQuote: "林舟" },
        { question: "林舟交给陈默的是什么？", answerQuote: "备用钥匙" }],
      evaluation: [{ trainingIndex: 0, question: "陈默的备用钥匙是谁交给他的？", answerQuote: "林舟" }],
      usage: { input: 230, output: 110 },
    };
    const f = await fixture({ generateDatasetQuestions: async (input) => { calls.push(input); return result; } });
    const { entry } = await f.memory({ content: "2025年3月2日，林舟把备用钥匙交给陈默，陈默随后保管钥匙。" });
    const job = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator", scope: { memoryIds: [entry.id] } });
    await f.service.idle();
    const done = f.service.ledger.get(job.id);
    expect(done.status, done.error).toBe("completed");
    expect(done.usage).toEqual({ calls: 1, input: 230, output: 110 });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("测试原件.txt");
    const samples = f.service.ledger.samples(job.id);
    expect(samples).toHaveLength(3);
    expect(samples.every((sample) => sample.status === "review")).toBe(true);
    expect(samples.filter((sample) => sample.intendedUse === "evaluation")).toHaveLength(1);
    expect(await readFile(join(f.dir, "datasets", job.id, "training.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(f.dir, "datasets", job.id, "evaluation.jsonl"), "utf8")).toBe("");
    expect(samples.every((sample) => sample.quality?.issues.some((issue) => issue.code === "missing-event-time"))).toBe(true);
    await expect(f.service.review(job.id, samples.map(({ id, version }) => ({ id, version })), "只核对人物，尚未消除时间歧义")).rejects.toThrow("2025-03-02");
    expect(f.service.ledger.samples(job.id).every((sample) => sample.version === 1 && sample.status === "review")).toBe(true);
    await f.service.changeSamples(job.id, samples.map(({ id, version, question }) => ({ id, version, action: "revise" as const,
      question: "2025-03-02，" + question })), "逐题核对原文、人物、动作方向和事件日期", { actor: "user", requestKey: "repair-dates" });
    await f.service.idle();
    expect(calls).toHaveLength(1);
    const training = (await readFile(join(f.dir, "datasets", job.id, "training.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const evaluation = JSON.parse((await readFile(join(f.dir, "datasets", job.id, "evaluation.jsonl"), "utf8")).trim());
    expect(training).toHaveLength(2);
    expect(training.every((sample) => sample.intendedUse === "training")).toBe(true);
    expect(training.some((sample) => sample.messages[0].content === evaluation.question)).toBe(false);
    expect(evaluation).toMatchObject({ question: "2025-03-02，" + result.evaluation[0].question, expectedAnswer: "林舟", intendedUse: "evaluation" });
    expect(evaluation.evaluationOf).toEqual({ id: training.find((sample) => sample.messages[1].content === "林舟").sampleId, version: 2 });
    expect(evaluation.messages).toBeUndefined();
    expect(evaluation.lineage.memoryRefs).toEqual([{ id: entry.id, version: entry.version }]);
    const archiveRoot = await mkdtemp(join(tmpdir(), "generated-dataset-archive-"));
    cleanup.push(() => rm(archiveRoot, { recursive: true, force: true }));
    await backupMemory(f.dir, join(archiveRoot, "snapshot"));
    await restoreMemory(join(archiveRoot, "snapshot"), join(archiveRoot, "restored"));
    const restored = new Store(join(archiveRoot, "restored"));
    const recovered = new DatasetService(restored);
    try {
      const file = await recovered.download(job.id, "evaluation");
      let text = ""; for await (const chunk of file.stream) text += chunk;
      expect(JSON.parse(text)).toEqual(evaluation);
      expect(recovered.ledger.samples(job.id)).toEqual(f.service.ledger.samples(job.id));
    } finally { await recovered.close(); restored.close(); }
    f.store.work.updateMemory(entry.id, { content: "陈默把备用钥匙交给林舟。" }, entry.version);
    expect(f.service.ledger.get(job.id).counts.staleSamples).toBe(3);
    await expect(f.service.download(job.id, "evaluation")).rejects.toThrow("修订");
  });

  it("rejects unsupported answers, duplicate questions and evaluation facts absent from training without saving partial samples", async () => {
    let mode = "unsupported";
    const f = await fixture({ generateDatasetQuestions: async () => ({
      training: [{ question: "备用钥匙交给了谁？", answerQuote: mode === "unsupported" ? "不存在的姓名" : "陈默" }],
      evaluation: [{ trainingIndex: 0, question: mode === "duplicate" ? "备用钥匙交给了谁？" : mode === "untrained" ? "谁交出了备用钥匙？" : "谁收到备用钥匙？", answerQuote: mode === "untrained" ? "林舟" : "陈默" }],
      usage: { input: 100, output: 40 },
    }) });
    await f.memory({ content: "林舟把备用钥匙交给陈默。" });
    for (const current of ["unsupported", "duplicate", "untrained"]) {
      mode = current;
      const job = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator" });
      await f.service.idle();
      expect(f.service.ledger.get(job.id).status).toBe("failed");
      expect(f.service.ledger.get(job.id).counts).toMatchObject({ failed: 1, samples: 0 });
      expect(f.service.ledger.get(job.id).usage?.calls).toBe(1);
    }
  });

  it("keeps the generation connection stable while a background dataset is running", async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const processors: MemoryProcessors = { generateDatasetQuestions: async () => {
      entered(); await new Promise<void>((resolve) => { release = resolve; });
      return { training: [{ question: "备用钥匙交给了谁？", answerQuote: "陈默" }],
        evaluation: [{ trainingIndex: 0, question: "谁收到备用钥匙？", answerQuote: "陈默" }], usage: { input: 100, output: 50 } };
    } };
    const f = await fixture(); await f.memory({ content: "林舟把备用钥匙交给陈默。" });
    const app = buildApp(readConfig({ MEMORY_DATA_DIR: f.dir, MEMORY_LOCAL_FEATURES: "off" }), { store: f.store, processors });
    cleanup.push(async () => { release(); await app.close(); }); await app.ready();
    const submission = await app.inject({ method: "POST", url: "/api/memory-datasets", payload: { requestKey: randomUUID(), modelId: "configured/generator" } });
    expect(submission.statusCode).toBe(202); const id = submission.json().dataset.id;
    await started;
    const connection = { enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "another-test-model", apiKey: "test-only",
      protocol: "openai-completions", supportsImages: false, contextWindow: 32768, maxTokens: 4096, reasoning: false, thinkingLevel: "off" };
    const blocked = await app.inject({ method: "POST", url: "/api/settings/providers/openai-compatible", payload: connection });
    expect(blocked.statusCode).toBe(409);
    release();
    let status = "";
    for (let i = 0; i < 100; i++) {
      status = (await app.inject(`/api/memory-datasets/${id}`)).json().dataset.status;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toBe("completed");
    expect((await app.inject({ method: "POST", url: "/api/settings/providers/openai-compatible", payload: connection })).statusCode).toBe(200);
  });

  it("resumes generated inputs after shutdown without regenerating committed questions", async () => {
    const calls: string[] = [];
    const processors: MemoryProcessors = { generateDatasetQuestions: async (input) => {
      calls.push(input.memory.content);
      return { training: [{ question: "这次出行记录的目的地是什么？", answerQuote: input.memory.content }],
        evaluation: [{ trainingIndex: 0, question: "此次出行去了哪里？", answerQuote: input.memory.content }], usage: { input: 100, output: 50 } };
    } };
    const f = await fixture(processors);
    await f.memory({ content: "周末去了青石公园。" });
    await f.memory({ content: "周末去了枫林书店。" });
    let shutdown: Promise<void> | undefined;
    f.service.driver().subscribe((id) => {
      if (f.service.ledger.get(id).counts.processed === 1 && !shutdown) shutdown = f.service.close();
    });
    const job = f.service.submit({ requestKey: randomUUID(), modelId: "configured/generator" });
    await f.service.idle(); await shutdown;
    expect(calls).toHaveLength(1);
    f.store.close();
    const reopened = new Store(f.dir); const resumed = new DatasetService(reopened, () => processors);
    try {
      await resumed.idle();
      expect(resumed.ledger.get(job.id).status).toBe("completed");
      expect(resumed.ledger.get(job.id).counts).toMatchObject({ total: 2, processed: 2, samples: 4 });
      expect(resumed.ledger.get(job.id).usage?.calls).toBe(2);
      expect(new Set(calls).size).toBe(2);
    } finally { await resumed.close(); reopened.close(); }
  });

  it("covers all 63 inputs, retains review/exclusion counts, deduplicates and exports exact source lineage", async () => {
    const f = await fixture();
    const original = await f.memory();
    for (let i = 1; i < 60; i++) await f.memory();
    await f.memory({ acceptedBy: "policy" });
    await f.memory({ uncertainty: "日期仍不确定" });
    f.store.work.createMemory(original.entry);
    const requestKey = randomUUID();
    const job = f.service.submit({ requestKey });
    expect(f.service.submit({ requestKey }).id).toBe(job.id);
    await f.service.idle();
    const done = f.service.ledger.get(job.id);
    expect(done.status, done.error).toBe("completed");
    expect(done.counts).toMatchObject({ total: 63, processed: 63, ready: 60, review: 1, excluded: 2, failed: 0, samples: 122 });
    const manifest = JSON.parse(await readFile(join(f.dir, "datasets", job.id, "manifest.json"), "utf8"));
    expect(manifest.inputs).toHaveLength(63); expect(manifest.trainingStarted).toBe(false);
    expect(manifest.revision).toBe(done.revision);
    const training = (await readFile(join(f.dir, "datasets", job.id, "training.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(training).toHaveLength(120);
    for (const sample of training) {
      const source = f.store.work.get<MemoryEntry>("memory", sample.lineage.memoryRefs[0].id)!;
      expect(sample.messages[1].content).toBe(source.content);
      expect(sample.lineage.evidence[0].sha256).toBe(source.sources[0].sha256);
    }
    let after = ""; const all = [];
    for (;;) { const page = f.service.ledger.samples(job.id, after, 17); if (!page.length) break; all.push(...page); after = page.at(-1)!.id; }
    expect(new Set(all.map((sample) => sample.id)).size).toBe(122);
    const refs = all.filter((sample) => sample.status === "review").map(({ id, version }) => ({ id, version }));
    await f.service.review(job.id, refs, "核对原始记录后接受"); await f.service.idle();
    expect(f.service.ledger.get(job.id).counts.review).toBe(0);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM dataset_sample_versions WHERE version=2").get()).toMatchObject({ n: 2 });
    expect((await readFile(join(f.dir, "datasets", job.id, "review.jsonl"), "utf8"))).toBe("");
    await expect(f.service.review(job.id, refs, "重复提交")).rejects.toThrow("已更新");
    expect(f.store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()).toMatchObject({ n: 0 });
  });

  it("recovers a 75-record build after shutdown without regenerating already committed samples", async () => {
    const f = await fixture(); for (let i = 0; i < 75; i++) await f.memory();
    let shutdown: Promise<void> | undefined;
    f.service.driver().subscribe((id) => {
      if (f.service.ledger.get(id).counts.processed >= 20 && !shutdown) shutdown = f.service.close();
    });
    const job = f.start(); await f.service.idle(); await shutdown;
    expect(f.service.ledger.get(job.id).counts.processed).toBe(20);
    const first = f.service.ledger.samples(job.id, "", 100).map((sample) => sample.id).sort();
    f.store.close();
    const reopened = new Store(f.dir); const resumed = new DatasetService(reopened);
    try {
      await resumed.idle();
      expect(resumed.ledger.get(job.id).counts).toMatchObject({ total: 75, processed: 75, samples: 150 });
      expect(resumed.ledger.get(job.id).status).toBe("completed");
      for (const id of first) expect(reopened.db.prepare("SELECT count(*) AS n FROM dataset_sample_versions WHERE id=?").get(id)).toMatchObject({ n: 1 });
    } finally { await resumed.close(); reopened.close(); }
  }, 15000);

  it("marks exactly dependent samples and registered model metadata after a correction, preserving frozen versions", async () => {
    const f = await fixture(); const a = await f.memory(); const b = await f.memory();
    const job = f.start(); await f.service.idle();
    // Registry test record only: no weights are created or trained.
    f.store.db.prepare("INSERT INTO memory_model_versions VALUES(?,?,0)").run("test-registry-only", JSON.stringify({ testOnly: true }));
    f.store.db.prepare("INSERT INTO model_dataset_links VALUES(?,?)").run("test-registry-only", job.id);
    const corrected = f.store.work.updateMemory(a.entry.id, { content: "用户纠正后的内容。" }, a.entry.version);
    expect(f.service.ledger.get(job.id).stale).toBe(true);
    const samples = f.service.ledger.samples(job.id);
    expect(samples.filter((sample) => sample.stale)).toHaveLength(2);
    expect(samples.filter((sample) => sample.memoryRefs[0].id === b.entry.id).every((sample) => !sample.stale)).toBe(true);
    expect(f.service.ledger.inputPage(job.id).find((input) => input.memoryId === a.entry.id)?.memoryVersion).toBe(1);
    expect(f.store.db.prepare("SELECT affected FROM memory_model_versions").get()).toMatchObject({ affected: 1 });
    await expect(f.service.download(job.id, "training")).rejects.toThrow("修订");
    expect(() => f.service.retry(job.id)).toThrow("当前版本");
    const rebuilt = f.start(); await f.service.idle();
    expect(f.service.ledger.samples(rebuilt.id).find((sample) => sample.memoryRefs[0].id === a.entry.id)?.answer).toBe(corrected.content);
    expect(f.service.ledger.invalidations(job.id).length).toBeGreaterThan(0);
  });

  it("checks original bytes again at download, and invalidates changed assets without leaking source text", async () => {
    const f = await fixture(); const a = await f.memory(); const b = await f.memory();
    const job = f.start(); await f.service.idle();
    await writeFile(join(f.store.assetsDir, a.asset.id), "原件被改动");
    await expect(f.service.download(job.id, "training")).rejects.toThrow("冻结版本");
    expect(f.service.ledger.get(job.id).counts.staleSamples).toBe(2);
    expect(f.service.ledger.samples(job.id).find((sample) => sample.memoryRefs[0].id === b.entry.id)?.stale).toBe(false);
    expect(JSON.stringify(f.service.ledger.invalidations(job.id))).not.toContain("原件被改动");
  });

  it("invalidates message dependencies when original text changes, without invalidating on run status alone", async () => {
    const f = await fixture(); const conversation = f.store.createConversation();
    const text = "明确的虚构用户陈述，用于来源依赖测试。";
    const run = f.store.work.createRun(conversation.id, { text, modelId: "test-only" });
    f.store.work.patchRun(run.id, { status: "completed" });
    f.store.work.createMemory({ title: "消息来源", content: text, statement: text, status: "confirmed", acceptedBy: "user", kind: "statement",
      occurredAt: "", sources: [], conversationId: conversation.id, runId: run.id });
    const job = f.start(); await f.service.idle(); expect(f.service.ledger.get(job.id).counts.samples).toBe(2);
    f.store.work.patchRun(run.id, { error: "与来源文字无关的状态更新" });
    expect(f.service.ledger.get(job.id).stale).toBe(false);
    f.store.work.patchRun(run.id, { text: "来源已修改。" });
    expect(f.service.ledger.get(job.id).counts.staleSamples).toBe(2);
    expect(f.service.ledger.invalidations(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "message-run", parentId: run.id })]));
  });

  it("tracks person/event revisions and generates combinations only for an explicit shared event", async () => {
    const f = await fixture();
    const person = f.store.work.memory.savePerson({ name: "测试人物", aliases: [] });
    const a = await f.memory({ category: "event", personIds: [person.id!] });
    const b = await f.memory({ category: "event", personIds: [person.id!] });
    const graph = f.store.work.memory.graph;
    const refs = [a, b].map(({ entry }) => graph.context(entry).events[0] as { id: string; version: number });
    const event = graph.mergeEvents(refs, "同一次出游", "用户明确关联");
    const job = f.start({ eventId: event.id }); await f.service.idle();
    expect(f.service.ledger.get(job.id).counts.samples).toBe(5);
    const combination = f.service.ledger.samples(job.id).find((sample) => sample.kind === "combination")!;
    expect(combination.memoryRefs).toHaveLength(2);
    await f.service.changeSamples(job.id, [{ id: combination.id, version: combination.version, action: "exclude" }], "不把合并记录用于当前训练", { actor: "user" });
    await f.service.idle();
    const rebuilt = f.service.rebuild({ datasetId: job.id, revision: f.service.ledger.get(job.id).revision, requestKey: randomUUID() });
    await f.service.idle();
    expect(f.service.ledger.get(rebuilt.id).rebuild?.reusedSamples).toBe(5);
    expect(f.service.ledger.samples(rebuilt.id).find((sample) => sample.kind === "combination")).toMatchObject({
      status: "excluded", reusedFrom: { datasetId: job.id, sampleId: combination.id, version: 2 } });
    graph.splitEvent(event.id, event.version, [a.entry.id], "另一事件", "纠正归属");
    expect(f.service.ledger.get(job.id).stale).toBe(true);
    const afterSplit = f.service.rebuild({ datasetId: rebuilt.id, revision: f.service.ledger.get(rebuilt.id).revision, requestKey: randomUUID() });
    await f.service.idle();
    expect(f.service.ledger.get(afterSplit.id)).toMatchObject({ status: "completed", counts: { total: 1 },
      rebuild: { removedMemories: 1, updatedMemories: 1, unchangedMemories: 0, reusedSamples: 0 } });
    const next = f.start(); await f.service.idle();
    f.store.work.memory.savePerson({ id: person.id, name: "更新称呼", aliases: [], version: person.version });
    expect(f.service.ledger.get(next.id).stale).toBe(true);
  });

  it("enforces memory/selected-source scope and delivers the durable job result once", async () => {
    const calls: string[] = [];
    const f = await fixture({ generateDatasetQuestions: async (input) => {
      calls.push(input.modelId);
      return { training: [{ question: "2025-03-02，用户核对的公园记录是什么？", answerQuote: input.memory.content }],
        evaluation: [{ trainingIndex: 0, question: "2025-03-02，公园经历记载了什么？", answerQuote: input.memory.content }], usage: { input: 100, output: 50 } };
    } }); const a = await f.memory(); const b = await f.memory();
    const jobs = new TaskJobs(f.store); jobs.register("memory-dataset", f.service.driver());
    cleanup.push(async () => jobs.close());
    const conversation = f.store.createConversation();
    const run = f.store.work.createRun(conversation.id, { text: "生成所选资料的数据集", modelId: "test-only", useMemory: true,
      assetIds: [a.asset.id], scope: "selected" });
    f.store.work.patchRun(run.id, { status: "running" });
    const tools = createDatasetTools(f.store, f.service, jobs, conversation.id);
    const tool = tools[0];
    await expect(tool.execute("outside", { scope: { assetIds: [b.asset.id] } }, new AbortController().signal, undefined, {} as never)).rejects.toThrow("所选");
    await tool.execute("build", { generation: "model" }, new AbortController().signal, undefined, {} as never);
    const attached = jobs.list(run.id); expect(attached).toHaveLength(1);
    const completion = jobs.wait(run.id, new AbortController().signal);
    await f.service.idle(); await completion;
    expect(jobs.claim(run.id)).toBeDefined(); expect(jobs.claim(run.id)).toBeUndefined();
    expect(f.service.ledger.get(attached[0].id).counts.total).toBe(1);
    expect(f.service.ledger.get(attached[0].id).generation?.modelId).toBe(run.modelId);
    expect(calls).toEqual([run.modelId]);
    const datasetId = attached[0].id;
    await f.service.changeSamples(datasetId, f.service.ledger.samples(datasetId).map(({ id, version }) => ({ id, version, action: "approve" })), "核对已读原件后认可训练与评测", { actor: "user" });
    await f.service.idle();
    expect(jobs.hasWork(run.id)).toBe(true);
    const deliver = tools.find((item) => item.name === "deliver_dataset")!;
    await deliver.execute("deliver", { datasetId }, new AbortController().signal, undefined, {} as never);
    expect(jobs.hasWork(run.id)).toBe(false);
    expect(jobs.claim(run.id)).toBeUndefined();
    const sample = f.service.ledger.samples(datasetId).find((item) => item.intendedUse === "training")!;
    await f.service.changeSamples(datasetId, [{ id: sample.id, version: sample.version, action: "defer", reason: "此条材料的时间仍需核对" }], "留待核对", { actor: "user" });
    await f.service.idle();
    expect(jobs.hasWork(run.id)).toBe(true);
    await expect(deliver.execute("empty", { datasetId }, new AbortController().signal, undefined, {} as never)).rejects.toThrow("训练文件为空");
    expect(jobs.hasWork(run.id)).toBe(true);
    expect(jobs.claim(run.id)).toBeDefined();
    f.store.work.patchRun(run.id, { useMemory: false });
    await expect(tool.execute("disabled", {}, new AbortController().signal, undefined, {} as never)).rejects.toThrow("未启用");
    expect(() => jobs.read(run.id, attached[0].id)).toThrow("未启用");
    expect(f.store.work.get<Run>("run", run.id)?.jobs?.[0].status).toBe("completed");
  });

  it("serves paged review and verified downloads through HTTP without exposing server paths", async () => {
    const f = await fixture(); await f.memory({ acceptedBy: "policy" }); await f.service.close();
    const app = buildApp(readConfig({ MEMORY_DATA_DIR: f.dir, MEMORY_LOCAL_FEATURES: "off" }), { store: f.store });
    cleanup.push(() => app.close()); await app.ready();
    const submitted = await app.inject({ method: "POST", url: "/api/memory-datasets", payload: { requestKey: randomUUID(), format: "qa" } });
    expect(submitted.statusCode, submitted.body).toBe(202); const id = submitted.json().dataset.id;
    let result;
    for (let i = 0; i < 100; i++) {
      result = await app.inject({ method: "GET", url: `/api/memory-datasets/${id}/samples` });
      if (result.json().dataset.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(result!.json().samples[0].status).toBe("review");
    const downloaded = await app.inject({ method: "GET", url: `/api/memory-datasets/${id}/files/manifest` });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.headers["content-disposition"]).toContain("manifest.json");
    expect(downloaded.body).not.toContain(f.dir);
    expect(JSON.parse(downloaded.body).inputs).toHaveLength(1);
  });

  it("restores stable memory/observation/event IDs, native vectors and dataset dependencies into a new directory", async () => {
    const f = await fixture(); const a = await f.memory({ category: "event" });
    const corrected = f.store.work.updateMemory(a.entry.id, { content: "核对后的经历内容。" }, a.entry.version);
    const context = f.store.work.memory.graph.context(corrected);
    const vectors = new MemoryVectors(f.store.db);
    // Synthetic axis vector tests persistence only, not embedding or identification accuracy.
    vectors.put("text", vectors.namespace("personal", "test-archive"), corrected.id, corrected.version, Array.from({ length: 384 }, (_, i) => Number(i === 0)));
    const job = f.start(); await f.service.idle(); await f.service.close();
    const archiveRoot = await mkdtemp(join(tmpdir(), "memory-archive-test-"));
    cleanup.push(() => rm(archiveRoot, { recursive: true, force: true }));
    const archive = join(archiveRoot, "snapshot"), restoredDir = join(archiveRoot, "restored");
    const result = await backupMemory(f.dir, archive); expect(result.files).toBeGreaterThanOrEqual(5);
    const restored = await restoreMemory(archive, restoredDir); expect(restored.databaseIntegrity).toBe("ok");
    const store = new Store(restoredDir); const datasets = new DatasetService(store);
    try {
      const memory = store.work.get<MemoryEntry>("memory", corrected.id)!;
      expect(memory).toEqual(corrected);
      expect(store.work.memory.graph.context(memory)).toEqual(context);
      expect(store.work.versions(corrected.id)).toHaveLength(2);
      expect(datasets.ledger.get(job.id).counts).toEqual(f.service.ledger.get(job.id).counts);
      expect(datasets.ledger.samples(job.id)).toEqual(f.service.ledger.samples(job.id));
      const newVectors = new MemoryVectors(store.db);
      expect(newVectors.search("text", "test-archive", Array.from({ length: 384 }, (_, i) => Number(i === 0)), {}, "Asia/Shanghai")[0].memoryId).toBe(corrected.id);
      const file = await datasets.download(job.id, "training");
      let text = ""; for await (const chunk of file.stream) text += chunk;
      expect(text).toContain(corrected.content);
      expect(store.harness.project().directory).toBe(join(restoredDir, "workspace"));
      expect(store.harness.project().permissionMode).toBe("read");
      store.work.updateMemory(corrected.id, { content: "恢复后再纠正。" }, corrected.version);
      expect(datasets.ledger.get(job.id).stale).toBe(true);
    } finally { await datasets.close(); store.close(); }
    await expect(restoreMemory(archive, restoredDir)).rejects.toThrow("已存在");
    await writeFile(join(archive, "assets", a.asset.id), "备份内容遭改动");
    await expect(restoreMemory(archive, join(archiveRoot, "tampered"))).rejects.toThrow("校验不一致");
  });
});
