import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Asset } from "@memory/contracts";
import { readConfig, projectRoot } from "../src/config.js";
import { ModelAccess } from "../src/model-access.js";
import { PiMemoryProcessors } from "../src/memory-processors.js";
import type { DatasetQuestionInput } from "../src/dataset-question-generation.js";
import { Store } from "../src/store.js";
import { DatasetService } from "../src/dataset-service.js";

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const config = readConfig();
const configured = config.providers.find((item) => !argument("--model") || item.model.name === argument("--model") || item.model.id === argument("--model"));
if (!configured) throw new Error("Configure the selected model before evaluating");
const manifestBytes = await readFile(resolve(projectRoot, "examples/quality/dataset-questions.json"));
const manifest = JSON.parse(manifestBytes.toString()) as { scope: string; cases: { id: string; memory: DatasetQuestionInput["memory"]; review: string[] }[] };
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, "dataset-questions-"));
const store = new Store(dir);
const models = new ModelAccess({ ...config, providers: [configured], localProcessor: undefined });
const runtime = await models.get();
const complete = runtime.completeSimple.bind(runtime);
const responses: { content: unknown; stopReason: string; usage: unknown }[] = [];
runtime.completeSimple = async (model, context, options) => {
  const response = await complete(model, context, options);
  responses.push({ content: response.content, stopReason: response.stopReason, usage: response.usage });
  return response;
};
const processor = new PiMemoryProcessors(config, models);
const inputs: DatasetQuestionInput[] = [];
const datasets = new DatasetService(store, () => ({ generateDatasetQuestions: async (input, signal) => {
  inputs.push(input); return processor.generateDatasetQuestions(input, signal);
} }));
const sourceIds: { id: string; memoryId: string; review: string[] }[] = [];
try {
  for (const fixture of manifest.cases) {
    const bytes = Buffer.from(fixture.memory.content);
    const asset: Asset = { id: randomUUID(), name: "source.txt", kind: "text", mimeType: "text/plain", size: bytes.length,
      sha256: hash(bytes), createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), bytes); store.addAsset(asset);
    const entry = store.work.createMemory({ ...fixture.memory, kind: "statement", status: "confirmed", acceptedBy: "user",
      conversationId: randomUUID(), runId: randomUUID(), sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: bytes.length, quote: fixture.memory.content }] });
    sourceIds.push({ id: fixture.id, memoryId: entry.id, review: fixture.review });
  }
  const job = datasets.submit({ requestKey: "isolated-natural-questions", title: "虚构材料问法评测", modelId: configured.model.id });
  datasets.driver().subscribe((id) => {
    const current = datasets.ledger.get(id);
    console.log(JSON.stringify({ processed: current.counts.processed, total: current.counts.total, calls: current.usage?.calls, status: current.status }));
  });
  await datasets.idle();
  const completed = datasets.ledger.get(job.id);
  const samples = datasets.ledger.samples(job.id, "", 100);
  const review = completed.status === "completed" ? await readFile(join(dir, "datasets", job.id, "review.jsonl"), "utf8") : "";
  const report = { at: new Date().toISOString(), model: configured.model.name, protocol: configured.protocol, scope: manifest.scope,
    manifestHash: hash(manifestBytes), generatorHash: hash(await readFile(new URL("../src/dataset-question-generation.ts", import.meta.url))),
    dataset: completed, responses, trainingStarted: false,
    checks: { fullManifest: completed.counts.total === manifest.cases.length && completed.counts.processed === completed.counts.total,
      allQuestionsRequireReview: samples.length > 0 && samples.every((sample) => sample.status === "review"),
      onlyCurrentMemorySent: inputs.length === manifest.cases.length && inputs.every((input) => Object.keys(input).sort().join() === "memory,modelId"),
      noAgentSession: store.db.prepare("SELECT count(*) AS n FROM conversations").get()!.n === 0,
      noTrainingWeights: store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n === 0 },
    cases: sourceIds.map((source) => ({ ...source, memory: inputs.find((input) => input.memory.content === manifest.cases.find((fixture) => fixture.id === source.id)!.memory.content)?.memory,
      samples: samples.filter((sample) => sample.memoryRefs.some((ref) => ref.id === source.memoryId)), semanticReview: "pending" })),
    reviewLines: review.trim() ? review.trim().split("\n").length : 0,
    limitation: "六条虚构确认记录的实际模型调用；原文引用校验不证明问题语义正确，另按预先固定的评分项核对。没有训练或记忆能力评分。" };
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ report: join(dir, "report.json"), counts: completed.counts, usage: completed.usage, checks: report.checks }));
  if (completed.status !== "completed" || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
} finally { await datasets.close(); store.close(); }
