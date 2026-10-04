// Real Agent and independent processor, using only a stopped fictional-corpus evaluation in a new store.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatasetAuditJob, Run } from "@memory/contracts";
import { readConfig, projectRoot } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { ModelAccess } from "../src/model-access.js";
import { PiMemoryProcessors } from "../src/memory-processors.js";
import type { DatasetQualityInput } from "../src/dataset-quality-review.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { contentHash } from "../src/memory/values.js";

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (!process.argv.includes("--live") || !argument("--source-report")) throw new Error("使用 --live --source-report 指定已完成的虚构问法评测报告");
const sourceReport = resolve(argument("--source-report")!), source = JSON.parse(await readFile(sourceReport, "utf8"));
const manifest = await readFile(join(projectRoot, "examples/quality/dataset-questions.json"));
if (source.manifestHash !== contentHash(manifest) || source.cases?.length !== 6 || !Object.values(source.checks || {}).every(Boolean) || !source.checks?.noAgentSession)
  throw new Error("来源须为完整的六条虚构问法评测；不得使用个人资料库");
const original = readConfig(), provider = original.providers.find((item) => item.model.name === (argument("--model") || "gpt-6-luna"));
if (!provider) throw new Error("请先配置所选核验模型");
const directory = await mkdtemp(join(projectRoot, ".data/evaluations/dataset-audit-live-")), dataDir = join(directory, "store");
await backupMemory(dirname(sourceReport), directory + "-source-archive"); await restoreMemory(directory + "-source-archive", dataDir);
const config = { ...original, dataDir, providers: [provider], localProcessor: undefined };
let store = new Store(dataDir);
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: false, datasetReviewModelId: provider.model.id });
const models = new ModelAccess(config), processor = new PiMemoryProcessors(config, models);
const inputs: DatasetQualityInput[] = [], outputs: unknown[] = [];
let app = buildApp(config, { store, processors: { hasModel: (id) => processor.hasModel(id),
  reviewDatasetSamples: async (input, signal) => {
    inputs.push(structuredClone(input));
    console.log(JSON.stringify({ phase: "processor-review", call: inputs.length, title: input.memory.title, repair: !!input.repair }));
    const output = await processor.reviewDatasetSamples(input, signal); outputs.push(output); return output;
  },
} });
let ledger = new DatasetLedger(store);
const datasetId: string = source.dataset.id, before = ledger.samples(datasetId, "", 100), memories = store.memories.list("memory");
const checks: Record<string, boolean> = {};
const auditHistory = () => Object.fromEntries(["dataset_audits", "dataset_audit_inputs", "dataset_audit_views", "dataset_review_commands"]
  .map((table) => [table, contentHash(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
const report: Record<string, unknown> = { type: "dataset-audit-live", at: new Date().toISOString(), sourceReport, model: provider.model.name,
  scope: source.scope, datasetId, before, checks, completed: false, trainingStarted: false, independentSemanticReview: "pending" };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let activeId: string | undefined;
try {
  await app.ready(); await save(); console.log(JSON.stringify({ phase: "agent-audit-deliver", directory }));
  const conversation = store.createConversation();
  const started = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: "此处只有六条虚构材料的隔离评测，不是我的真实经历。请核验最新已完成数据集的整批训练题和评测题：先实际 inspect_dataset 获得 ID 与当前版本，再用 audit_dataset 的 pending 模式交给独立后台处理器逐来源核验。不要用主会话逐题指挥整批。核验结束后根据真实作业结果检查覆盖、修订、待核对和失败项；保留模型审阅，个人事实与材料不修改。对剩余的具体疑点可实际查看、修订或排除，不为提高通过数强行认可。用 deliver_dataset 验证并交付同一数据集的实际训练、评测、待审和清单文件，报告数量与限制，不重建或重新生成，也不启动训练。",
    modelId: provider.model.id, thinkingLevel: "low", assetIds: [], scope: "library", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (started.statusCode !== 201) throw new Error("隔离核验任务创建失败");
  activeId = started.json<{ run: Run }>().run.id;
  const deadline = Date.now() + 360000;
  let run = store.work.get<Run>("run", activeId)!;
  while (!["completed", "failed", "stopped"].includes(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300)); run = store.work.get<Run>("run", activeId)!;
  }
  if (!["completed", "failed", "stopped"].includes(run.status)) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` });
  run = store.work.get<Run>("run", activeId)!; report.run = run; activeId = undefined;
  const samples = ledger.samples(datasetId, "", 100); report.samples = samples; report.inputs = inputs; report.outputs = outputs;
  const rows = store.db.prepare("SELECT data,status,revision FROM dataset_audits WHERE datasetId=? ORDER BY rowid").all(datasetId);
  const audits = rows.map((row) => ({ ...JSON.parse(String(row.data)) as DatasetAuditJob, status: row.status, revision: row.revision })); report.audits = audits;
  const complete = (name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
  checks.realAgentAudit = run.status === "completed" && complete("inspect_dataset") && complete("audit_dataset") && complete("deliver_dataset");
  checks.independentFullBatch = audits.length === 1 && audits[0].counts.total === before.length && audits[0].counts.processed === before.length;
  checks.auditFailuresPreserved = audits.every((audit) => !audit.counts.failed || audit.status === "failed");
  checks.onlyFrozenSourcesSent = inputs.length >= 6 && inputs.every((input) => source.cases.some((fixture: { memory: DatasetQualityInput["memory"] }) => fixture.memory.content === input.memory.content)
    && input.samples.length === 3 && Object.keys(input).every((key) => ["memory", "modelId", "samples", "repair"].includes(key)));
  checks.factsAndGenerationUnchanged = JSON.stringify(store.memories.list("memory")) === JSON.stringify(memories) && ledger.list().length === 1 && ledger.get(datasetId).usage?.calls === source.dataset.usage.calls;
  checks.processorReviewsHaveProvenance = samples.some((sample) => sample.review?.actor === "processor") && samples.filter((sample) => sample.review?.actor === "processor")
    .every((sample) => sample.review!.jobId === audits[0].id && sample.review!.modelId === provider.model.id && sample.review!.protocolVersion === 1);
  checks.allVersionsRetained = before.every((sample) => !!store.db.prepare("SELECT 1 FROM dataset_sample_versions WHERE id=? AND version=?").get(sample.id, sample.version));
  checks.pairsUseFinalVersions = samples.filter((sample) => sample.intendedUse === "evaluation" && sample.status === "ready").every((sample) => {
    const training = samples.find((target) => target.id === sample.evaluationOf?.id);
    return training?.status === "ready" && training.version === sample.evaluationOf?.version && training.answer === sample.answer;
  });
  checks.noWeights = !store.db.prepare("SELECT 1 FROM memory_model_versions").get();
  const part = run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivery = part?.type === "tool" ? part.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  if (!delivery || delivery.datasetId !== datasetId) throw new Error("真实 Agent 未交付核验后的同一数据集");
  report.delivery = delivery;
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of delivery.files) {
    const response = await app.inject(file.href); if (response.statusCode !== 200) throw new Error("核验交付文件不可下载");
    files[file.kind] = { sha256: contentHash(response.rawPayload), bytes: response.rawPayload.length };
    await writeFile(join(directory, file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), response.rawPayload, { mode: 0o600 });
  }
  report.files = files; checks.actualFileHashesMatch = delivery.files.every((file) => files[file.kind].sha256 === file.sha256);
  const history = auditHistory();
  await app.close(); await backupMemory(dataDir, directory + "-archive"); await restoreMemory(directory + "-archive", directory + "-restored");
  store = new Store(directory + "-restored"); ledger = new DatasetLedger(store);
  app = buildApp({ ...config, dataDir: directory + "-restored", providers: [] }, { store }); await app.ready();
  checks.restoredSamplesIdentical = JSON.stringify(ledger.samples(datasetId, "", 100)) === JSON.stringify(samples);
  checks.restoredAuditHistoryIdentical = JSON.stringify(auditHistory()) === JSON.stringify(history);
  checks.restoredFilesIdentical = true;
  for (const file of delivery.files) checks.restoredFilesIdentical &&= contentHash((await app.inject(file.href)).rawPayload) === files[file.kind].sha256;
  report.completed = Object.values(checks).every(Boolean); await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), checks, audits: audits.map(({ status, counts, usage }) => ({ status, counts, usage })) }));
  if (!report.completed) process.exitCode = 1;
} catch (failure) {
  report.inputs = inputs; report.outputs = outputs; report.error = failure instanceof Error ? failure.message : "核验验证未完成"; await save(); throw failure;
} finally { if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); await app.close(); }
