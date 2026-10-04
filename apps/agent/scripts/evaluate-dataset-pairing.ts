// Review a previously observed public-frame question mismatch in a new isolated store.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Run, TrainingSample } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { contentHash } from "../src/memory/values.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 验证真实 Agent 的训练与评测题核对");
const sourceIndex = process.argv.indexOf("--source-report");
if (sourceIndex < 0) throw new Error("--source-report 须指向已完成的公开画面 dataset-rebuild-live 报告");
const sourceReport = resolve(process.argv[sourceIndex + 1]);
const source = JSON.parse(await readFile(sourceReport, "utf8"));
if (!source.completed || source.type !== "dataset-rebuild-live") throw new Error("来源须为完成的公开画面重建验证");
const original = readConfig(), provider = original.providers.find((item) => item.model.name === "gpt-6-luna");
if (!provider) throw new Error("请配置 gpt-6-luna");
const directory = await mkdtemp(join(projectRoot, ".data/evaluations/dataset-pairing-live-"));
const dataDir = join(directory, "store");
await restoreMemory(sourceReport.replace(/\/report\.json$/, "-archive"), dataDir);
const config = { ...original, dataDir, providers: [provider], localProcessor: undefined };
let store = new Store(dataDir), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: false, datasetModelId: provider.model.id });
let ledger = new DatasetLedger(store);
const datasetId: string = source.delivery.datasetId;
const before = ledger.samples(datasetId, "", 100);
const memories = store.memories.list("memory");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "dataset-pairing-live", at: new Date().toISOString(), sourceReport,
  model: provider.model.name, datasetId, before, checks, completed: false, independentSemanticReview: "pending",
  scope: "Existing public-frame archive in a new isolated store. Real Agent compares and repairs legacy training/evaluation correspondence. No private media, fact correction or model training." };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let activeId: string | undefined;
try {
  await app.ready(); await save();
  checks.legacyEvaluationBlocked = (await app.inject(`/api/memory-datasets/${datasetId}/files/evaluation`)).statusCode === 422;
  const conversation = store.createConversation();
  console.log(JSON.stringify({ phase: "01-compare-repair-deliver", directory }));
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: `只在此公开画面隔离测试库，请检查最新已完成数据集的全部训练题、评测题及冻结来源。旧评测题没有训练题关联；其中杯碟的两道题虽然答案相同，一道问碟子的特征，另一道问杯子放在哪里，所问关系不同。请通过 inspect_dataset 实际读取每题和 trainingSamples，保持两条确认记忆、原件、日期以及训练题原样；逐对核对所考事实，为全部可支持的评测题选择真实训练题并建立 evaluationOf，用 review_dataset 的 revise 修复不等价评测问法，再交付同一数据集的新导出文件。不能把答案相同当作语义核对；不得重建数据集、修改训练题或个人事实，也不启动模型训练。`,
    modelId: provider.model.id, thinkingLevel: "low", assetIds: [], scope: "library", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (response.statusCode !== 201) throw new Error("隔离 Agent 任务创建失败");
  activeId = response.json<{ run: Run }>().run.id;
  const deadline = Date.now() + 300000;
  let run = store.work.get<Run>("run", activeId)!;
  while (!["completed", "failed", "stopped"].includes(run.status) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 300)); run = store.work.get<Run>("run", activeId)!;
  }
  if (!["completed", "failed", "stopped"].includes(run.status)) {
    await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); run = store.work.get<Run>("run", activeId)!;
  }
  report.run = run; activeId = undefined;
  const samples = ledger.samples(datasetId, "", 100); report.samples = samples;
  const complete = (name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
  checks.realAgentReview = run.status === "completed" && complete("inspect_dataset") && complete("review_dataset") && complete("deliver_dataset");
  checks.originalFactsUnchanged = JSON.stringify(store.memories.list("memory")) === JSON.stringify(memories);
  checks.noNewDatasetOrGeneration = ledger.list().length === 2 && ledger.get(datasetId).usage?.calls === source.rebuilt.usage.calls;
  checks.originalTrainingUnchanged = before.filter((sample) => sample.intendedUse === "training").every((prior) =>
    JSON.stringify(samples.find((sample) => sample.id === prior.id)) === JSON.stringify(prior));
  const evaluations = samples.filter((sample) => sample.intendedUse === "evaluation");
  const paired = (sample: TrainingSample) => samples.find((training) => training.id === sample.evaluationOf?.id);
  checks.allEvaluationsVersioned = evaluations.length === 2 && evaluations.every((sample) => {
    const training = paired(sample);
    return sample.status === "ready" && sample.review?.actor === "agent" && sample.review.runId === run.id && training?.status === "ready"
      && training.version === sample.evaluationOf?.version && sample.answer === training.answer && !sample.quality?.issues.some((issue) => issue.severity === "blocking");
  });
  checks.relationQuestionChanged = evaluations.some((sample) => sample.question !== before.find((prior) => prior.id === sample.id)?.question &&
    sample.memoryRefs.some((ref) => ref.id === source.changed.id));
  checks.reviewHistoryRetained = before.every((sample) => !!store.db.prepare("SELECT 1 FROM dataset_sample_versions WHERE id=? AND version=?").get(sample.id, sample.version));
  checks.noTrainingWeights = !store.db.prepare("SELECT 1 FROM memory_model_versions").get();
  const delivered = run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivery = delivered?.type === "tool" ? delivered.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  if (!delivery || delivery.datasetId !== datasetId) throw new Error("真实 Agent 未交付同一数据集的核对文件");
  report.delivery = delivery;
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of delivery.files) {
    const downloaded = await app.inject(file.href);
    if (downloaded.statusCode !== 200) throw new Error("实际交付文件不可下载");
    files[file.kind] = { sha256: contentHash(downloaded.rawPayload), bytes: downloaded.rawPayload.length };
    await writeFile(join(directory, file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), downloaded.rawPayload, { mode: 0o600 });
  }
  report.files = files;
  checks.fileHashesVerified = delivery.files.every((file) => file.sha256 === files[file.kind].sha256);
  const lines = (await readFile(join(directory, "evaluation.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  checks.exportedPairsMatch = lines.length === 2 && lines.every((line) => JSON.stringify(line.evaluationOf) === JSON.stringify(samples.find((sample) => sample.id === line.sampleId)?.evaluationOf));
  await app.close();
  console.log(JSON.stringify({ phase: "02-nonempty-backup-restore", directory }));
  const archive = directory + "-archive", restored = directory + "-restored";
  report.archive = await backupMemory(dataDir, archive); report.restore = await restoreMemory(archive, restored); report.restoredDirectory = restored;
  store = new Store(restored); app = buildApp({ ...config, dataDir: restored }, { store }); await app.ready(); ledger = new DatasetLedger(store);
  checks.restoredPairsAndHistory = JSON.stringify(ledger.samples(datasetId, "", 100)) === JSON.stringify(samples) && before.every((sample) =>
    !!store.db.prepare("SELECT 1 FROM dataset_sample_versions WHERE id=? AND version=?").get(sample.id, sample.version));
  checks.restoredEvaluationBytes = (await app.inject(`/api/memory-datasets/${datasetId}/files/evaluation`)).rawPayload.equals(await readFile(join(directory, "evaluation.jsonl")));
  report.completed = Object.values(checks).every(Boolean);
} catch (failure) { report.failure = failure instanceof Error ? failure.message : String(failure); }
finally {
  if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }).catch(() => undefined);
  await app.close().catch(() => undefined); await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), completed: report.completed, checks, failure: report.failure }));
}
if (!report.completed) process.exitCode = 1;
