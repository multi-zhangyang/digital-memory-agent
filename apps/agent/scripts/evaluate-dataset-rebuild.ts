// Real Agent rebuild from an earlier public-frame archive, in a new isolated store; no training.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryEntry, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { contentHash } from "../src/memory/values.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { DATASET_GENERATOR_VERSION } from "../src/dataset-question-generation.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 验证真实 Agent 的数据集重建");
const sourceIndex = process.argv.indexOf("--source-report");
if (sourceIndex < 0) throw new Error("--source-report 须指向已核验的 frame-memory-live 报告");
const sourceReport = resolve(process.argv[sourceIndex + 1]);
const source = JSON.parse(await readFile(sourceReport, "utf8"));
if (!source.completed || source.type !== "frame-memory-live") throw new Error("来源须为完成的公开画面隔离验证");
const original = readConfig(), provider = original.providers.find((item) => item.model.name === "gpt-6-luna");
if (!provider) throw new Error("请配置 gpt-6-luna");
const directory = await mkdtemp(join(projectRoot, ".data/evaluations/dataset-rebuild-live-"));
const dataDir = join(directory, "store");
await restoreMemory(sourceReport.replace(/\/report\.json$/, "-archive"), dataDir);
const config = { ...original, dataDir, providers: [provider], localProcessor: undefined };
let store = new Store(dataDir), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: false, datasetModelId: provider.model.id });
let ledger = new DatasetLedger(store);
const previous = ledger.get(source.delivery.datasetId);
const memories = store.memories.list<MemoryEntry>("memory");
const changed = memories.find((entry) => entry.sources[0]?.video?.timestamp === 0)!;
const stable = memories.find((entry) => entry.sources[0]?.video?.timestamp === 2)!;
if (!changed || !stable || previous.counts.total !== 2 || !previous.generation) throw new Error("来源不是两个已核验画面的模型数据集");
const previousSamples = ledger.samples(previous.id, "", 100);
const correctedContent = "画面中有一个浅色杯子放在带蓝色花纹的碟子上；杯中可见棕黑色液体。";
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "dataset-rebuild-live", at: new Date().toISOString(), sourceReport, model: provider.model.name,
  previous, changed, stable, previousSamples, correctedContent, checks, completed: false, independentSemanticReview: "pending",
  scope: "Existing public-frame validation archive copied into a new isolated store. One explicit test-user correction, original scope and model, real Agent review and file delivery. No private media or model training." };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let activeId: string | undefined;
try {
  await app.ready(); await save();
  console.log(JSON.stringify({ phase: "01-correct-rebuild-review-deliver", directory }));
  const conversation = store.createConversation();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: `只在此公开画面隔离测试库，我明确纠正 0 秒杯碟记录的正文为「${correctedContent}」。请保留该记录的确认状态、2026-09-12 虚构事件日期、原始画面来源及其他字段；2 秒红色悬索桥记录保持原样。请读取当前记录后执行纠正，检查原数据集，再按原范围与原生成模型重建，沿用未变更样本的既有核对决定。检查和核对新产生的问答及评测题，必要时修订或排除，然后交付新版本的实际下载文件，并说明沿用了多少样本。不要启动个人模型训练。`,
    modelId: provider.model.id, thinkingLevel: "low", assetIds: [changed.sources[0].assetId], scope: "selected", permissionMode: "auto", useMemory: true, captureMemory: false,
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
  report.run = run; activeId = undefined; await save();
  const complete = (name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
  const updated = store.memories.get<MemoryEntry>("memory", changed.id)!;
  const instructions = store.memoryCommands.receipts(run.id);
  report.updated = updated; report.instructions = instructions;
  checks.explicitUserCorrection = complete("change_memories") && updated.content === correctedContent && updated.version === changed.version + 1
    && instructions.some((receipt) => receipt.actor === "user" && receipt.action === "correct" && receipt.instruction?.quote.includes(correctedContent));
  checks.stableMemoryUnchanged = JSON.stringify(store.memories.get("memory", stable.id)) === JSON.stringify(stable);
  checks.oldDatasetRemainsStale = ledger.get(previous.id).stale && (await app.inject(`/api/memory-datasets/${previous.id}/files/training`)).statusCode === 409;
  const newJob = ledger.list().find((job) => job.rebuild?.datasetId === previous.id);
  if (!newJob) throw new Error("真实 Agent 没有按原数据集重建，保留任务结果");
  report.rebuilt = newJob;
  checks.realRebuildTool = complete("rebuild_dataset") && run.status === "completed";
  checks.singleRebuild = ledger.list().filter((job) => job.rebuild).length === 1;
  checks.originalScopeAndModel = JSON.stringify(newJob.scope) === JSON.stringify(previous.scope) && newJob.generation?.modelId === previous.generation.modelId
    && newJob.generation?.strategy === previous.generation.strategy && newJob.generation?.version === DATASET_GENERATOR_VERSION;
  const samples = ledger.samples(newJob.id, "", 100); report.samples = samples;
  const stableSamples = previousSamples.filter((sample) => sample.memoryRefs[0].id === stable.id);
  const reusablePolicy = previous.generation.version === DATASET_GENERATOR_VERSION;
  report.generationPolicyChanged = !reusablePolicy;
  checks.noRedundantGeneration = newJob.usage?.calls === (reusablePolicy ? 1 : 2) && newJob.rebuild?.reusedMemories === (reusablePolicy ? 1 : 0)
    && newJob.rebuild?.reusedSamples === (reusablePolicy ? stableSamples.length : 0);
  checks.preservedReviewAndVersions = reusablePolicy ? stableSamples.every((before) => samples.some((sample) => sample.reusedFrom?.datasetId === previous.id && sample.reusedFrom.sampleId === before.id
    && sample.reusedFrom.version === before.version && sample.question === before.question && sample.answer === before.answer && sample.status === before.status
    && sample.authority === before.authority && JSON.stringify(sample.review) === JSON.stringify(before.review)))
    : samples.filter((sample) => sample.memoryRefs[0].id === stable.id).every((sample) => !sample.reusedFrom && sample.generation?.version === DATASET_GENERATOR_VERSION
      && (sample.status === "excluded" || sample.review?.actor === "agent" && sample.review.runId === run.id));
  checks.currentCorrectedInputs = samples.filter((sample) => sample.memoryRefs[0].id === changed.id).every((sample) => sample.memoryRefs[0].version === updated.version && !sample.reusedFrom);
  checks.agentReviewsNewSamples = complete("inspect_dataset") && complete("review_dataset") && samples.filter((sample) => sample.memoryRefs[0].id === changed.id && sample.status === "ready").every((sample) => sample.review?.actor === "agent" && sample.review.runId === run.id);
  const tool = run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivery = tool?.type === "tool" ? tool.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  if (!delivery || delivery.datasetId !== newJob.id) throw new Error("真实 Agent 未完成新版训练资料交付");
  report.delivery = delivery;
  const files: Record<string, { sha256: string; bytes: number; records?: number }> = {};
  for (const file of delivery.files) {
    const downloaded = await app.inject(file.href);
    if (downloaded.statusCode !== 200) throw new Error("实际交付文件不可下载");
    files[file.kind] = { sha256: contentHash(downloaded.rawPayload), bytes: downloaded.rawPayload.length,
      ...(file.kind === "manifest" ? {} : { records: downloaded.body.trim().split("\n").filter(Boolean).length }) };
    await writeFile(join(directory, file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), downloaded.rawPayload, { mode: 0o600 });
  }
  report.files = files;
  checks.hashVerifiedFiles = !!files.training?.records && !!files.evaluation?.records && delivery.files.every((file) => file.sha256 === files[file.kind].sha256);
  checks.trainingRemainsStopped = !store.db.prepare("SELECT 1 FROM memory_model_versions").get();
  console.log(JSON.stringify({ phase: "02-nonempty-backup-restore", directory }));
  await app.close();
  const archive = directory + "-archive", restored = directory + "-restored";
  report.archive = await backupMemory(dataDir, archive); report.restore = await restoreMemory(archive, restored); report.restoredDirectory = restored;
  store = new Store(restored); app = buildApp({ ...config, dataDir: restored }, { store }); await app.ready(); ledger = new DatasetLedger(store);
  checks.restoredSampleLineage = JSON.stringify(ledger.samples(newJob.id, "", 100)) === JSON.stringify(samples) && JSON.stringify(ledger.get(newJob.id).rebuild) === JSON.stringify(newJob.rebuild);
  checks.restoredDeliveredBytes = (await app.inject(delivery.files.find((file) => file.kind === "training")!.href)).rawPayload.equals(await readFile(join(directory, "training.jsonl")));
  checks.restoredPreviousStillStale = ledger.get(previous.id).stale && (await app.inject(`/api/memory-datasets/${previous.id}/files/training`)).statusCode === 409;
  report.completed = true;
} catch (failure) { report.failure = failure instanceof Error ? failure.message : String(failure); }
finally {
  if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }).catch(() => undefined);
  await app.close().catch(() => undefined); await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), completed: report.completed, checks, failure: report.failure }));
}
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
