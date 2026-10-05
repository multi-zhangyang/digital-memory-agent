import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, MemoryEntry } from "@memory/contracts";
import { readConfig, projectRoot } from "../src/config.js";
import { ModelAccess } from "../src/integrations/pi/model-access.js";
import { PiMemoryProcessors } from "../src/integrations/pi/processors.js";
import { Store } from "../src/store.js";
import { DatasetService } from "../src/memory/dataset-service.js";
import type { DatasetQuestionInput } from "../src/dataset-question-generation.js";

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (!process.argv.includes("--live")) throw new Error("需要 --live：只发送清单中的虚构来源，会调用已配置模型");
const split = argument("--split") || "development";
if (!["development", "holdout", "confirmation"].includes(split)) throw new Error("--split 应为 development、holdout 或 confirmation");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
type Question = { question: string; answerQuote: string; referenceAnswer: string | null; risk: string | null };
type Fixture = { id: string; split: string; memory: DatasetQuestionInput["memory"]; training: Question[];
  evaluation: { question: string; trainingIndex: number; referenceAnswer: string | null; risk: string | null }[] };
const manifestPath = join(projectRoot, "examples/quality", argument("--manifest") || "dataset-answerability.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString()) as { scope: string; cases: Fixture[] };
const fixtures = manifest.cases.filter((item) => item.split === split && (!argument("--case") || item.id === argument("--case")));
if (!fixtures.length) throw new Error("所选清单为空");
const config = readConfig();
const provider = config.providers.find((item) => !argument("--model") || [item.model.name, item.model.id].includes(argument("--model")!));
if (!provider) throw new Error("所选模型未配置");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, `dataset-answerability-${split}-`));
const store = new Store(directory);
const models = new ModelAccess({ ...config, providers: [provider], localProcessor: undefined });
const runtime = await models.get();
const complete = runtime.completeSimple.bind(runtime);
const calls: { tools: string[]; input: unknown; response: unknown; stopReason: string; usage: unknown; elapsedMs: number }[] = [];
runtime.completeSimple = async (model, context, options) => {
  const started = Date.now(), response = await complete(model, context, options);
  calls.push({ tools: context.tools?.map((tool) => tool.name) || [], input: context.messages,
    response: response.content, stopReason: response.stopReason, usage: response.usage, elapsedMs: Date.now() - started });
  console.log(JSON.stringify({ phase: "model-call", calls: calls.length, stopReason: response.stopReason }));
  return response;
};
const processor = new PiMemoryProcessors(config, models);
// QA are fixed adversarial fixtures; only the reviewer/answer checker uses a real model.
const datasets = new DatasetService(store, () => ({
  hasModel: (id) => processor.hasModel(id),
  reviewDatasetSamples: (input, signal) => processor.reviewDatasetSamples(input, signal),
  answerDatasetQuestions: (input, signal) => processor.answerDatasetQuestions(input, signal),
  generateDatasetQuestions: async ({ memory }) => {
    const fixture = fixtures.find((item) => item.memory.content === memory.content)!;
    return { training: fixture.training.map(({ question, answerQuote }) => ({ question, answerQuote })),
      evaluation: fixture.evaluation.map(({ question, trainingIndex }) => ({ question, trainingIndex, answerQuote: fixture.training[trainingIndex].answerQuote })),
      usage: { input: 0, output: 0 } };
  },
}));
const sourceIds = new Map<string, string>();
const codeHashes = Object.fromEntries(await Promise.all([
  "dataset-quality-review.ts", "integrations/pi/dataset-answer-checker.ts", "memory/dataset-answer-checks.ts",
  "memory/dataset-audits.ts", "memory/dataset-ledger.ts", "memory/dataset-review.ts", "memory/dataset-time-review.ts",
].map(async (path) => {
  try { return [path, hash(await readFile(new URL("../src/" + path, import.meta.url)))]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null]; throw error; }
})));
const report: Record<string, unknown> = { at: new Date().toISOString(), label: argument("--label") || "unlabelled", split,
  scope: manifest.scope, model: provider.model.name, thinkingLevel: provider.model.thinkingLevel, manifestHash: hash(manifestBytes),
  modelId: provider.model.id, protocol: provider.protocol, maxTokens: provider.model.maxTokens, codeHashes,
  reviewerHash: hash(await readFile(new URL("../src/dataset-quality-review.ts", import.meta.url))),
  trainingStarted: false, generatedQuestions: "fixed-fixture-not-model-generation", calls, semanticReview: "pending" };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
try {
  await save();
  for (const fixture of fixtures) {
    const bytes = Buffer.from(fixture.memory.content);
    const asset: Asset = { id: randomUUID(), name: "虚构来源.txt", kind: "text", mimeType: "text/plain", size: bytes.length,
      sha256: hash(bytes), createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), bytes); store.addAsset(asset);
    const memory = store.work.createMemory({ ...fixture.memory, kind: "statement", status: "confirmed", acceptedBy: "user",
      conversationId: randomUUID(), runId: randomUUID(), sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: bytes.length, quote: fixture.memory.content }] });
    sourceIds.set(fixture.id, memory.id);
  }
  const job = datasets.submit({ requestKey: randomUUID(), title: "虚构问答可回答性对照", modelId: provider.model.id });
  await datasets.idle();
  if (datasets.ledger.get(job.id).status !== "completed") throw new Error("固定样本构建失败");
  const before = datasets.ledger.samples(job.id, "", 100);
  report.before = before;
  const audit = datasets.audits.submit({ datasetId: job.id, revision: datasets.ledger.get(job.id).revision, requestKey: randomUUID(), modelId: provider.model.id });
  datasets.audits.driver().subscribe((id) => {
    const current = datasets.audits.get(id);
    console.log(JSON.stringify({ phase: "audit", processed: current.counts.processed, total: current.counts.total, status: current.status, calls: current.usage.calls }));
  });
  await datasets.audits.idle(); await datasets.idle();
  const after = datasets.ledger.samples(job.id, "", 100);
  report.audit = datasets.audits.get(audit.id);
  report.history = store.db.prepare("SELECT ordinal,status,data,result FROM dataset_audit_inputs WHERE jobId=? ORDER BY ordinal").all(audit.id);
  report.cases = fixtures.map((fixture) => ({ id: fixture.id, memory: fixture.memory,
    samples: [...fixture.training, ...fixture.evaluation].map((original) => {
      const initial = before.find((sample) => sample.question === original.question && sample.memoryRefs[0].id === sourceIds.get(fixture.id))!;
      return { referenceAnswer: original.referenceAnswer, risk: original.risk, before: initial, after: after.find((sample) => sample.id === initial.id) };
    }), semanticReview: "pending" }));
  report.observedUsage = calls.reduce((total, call) => {
    const usage = call.usage as { input: number; output: number; cacheRead: number; cacheWrite: number };
    return { calls: total.calls + 1, input: total.input + usage.input + usage.cacheRead + usage.cacheWrite,
      output: total.output + usage.output, elapsedMs: total.elapsedMs + call.elapsedMs };
  }, { calls: 0, input: 0, output: 0, elapsedMs: 0 });
  const sourceCalls = calls.filter((call) => call.tools.includes("submit_dataset_answers"));
  report.sourceAnswerCallCount = sourceCalls.length;
  report.checks = { allInputsProcessed: datasets.audits.get(audit.id).counts.processed === before.length,
    actualCallsCounted: datasets.audits.get(audit.id).usage.calls === calls.length,
    onlySourceAndQuestionsInAnswerChecks: sourceCalls.length ? sourceCalls.every((call) => {
      const messages = call.input as { content: string }[];
      const payload = JSON.parse(messages[0].content);
      return Object.keys(payload).sort().join() === "memory,questions";
    }) : null,
    factsUnchanged: fixtures.every((fixture) => store.memories.get<MemoryEntry>("memory", sourceIds.get(fixture.id)!)?.version === 1),
    noConversation: !store.db.prepare("SELECT 1 FROM conversations").get(), noWeights: !store.db.prepare("SELECT 1 FROM memory_model_versions").get() };
  try { report.delivery = await datasets.delivery(job.id); }
  catch (failure) { report.deliveryError = failure instanceof Error ? failure.message : "交付未完成"; }
  report.limitation = "固定的虚构错误题由真实模型核验；来源存在和状态检查不是语义准确率。逐题参考答案、时间、前提与训练评测所问事实须另外对照。没有运行生成效果或个人训练评测。";
  await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), audit: report.audit, checks: report.checks }));
} catch (failure) {
  report.error = failure instanceof Error ? failure.message : "验证未完成"; await save(); throw failure;
} finally { await datasets.close(); store.close(); }
