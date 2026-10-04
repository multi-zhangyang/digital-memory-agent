// Real Agent integration with public-image montage frames and an isolated memory store; no training.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Asset, MemoryEntry, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { contentHash } from "../src/memory/values.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 运行真实模型与公开素材的隔离验证");
const sourceIndex = process.argv.indexOf("--source-report");
if (sourceIndex < 0) throw new Error("--source-report 须指向已核验的 video-index-real 报告");
const sourceReport = resolve(process.argv[sourceIndex + 1]), source = JSON.parse(await readFile(sourceReport, "utf8"));
const original = readConfig(), provider = original.providers.find((item) => item.model.name === "gpt-6-luna" && item.model.supportsImages);
if (!provider) throw new Error("请配置支持图片输入的 gpt-6-luna");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "frame-memory-live-"));
const config = { ...original, dataDir: directory, providers: [provider], localProcessor: undefined };
let store = new Store(directory), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: false, datasetModelId: provider.model.id });
const asset: Asset = { ...source.assets[0], id: randomUUID(), name: "画面整理对照.mp4", createdAt: new Date().toISOString() };
const bytes = await readFile(join(sourceReport.replace(/\/report\.json$/, ""), "assets", source.assets[0].id));
if (contentHash(bytes) !== asset.sha256) throw new Error("公开图像拼接视频的原件摘要不一致");
await writeFile(join(store.assetsDir, asset.id), bytes, { mode: 0o600 }); store.addAsset(asset, { processing: "requested" });
const checks: Record<string, boolean> = {}, runs: { scenario: string; run: Run }[] = [];
const report: Record<string, unknown> = { type: "frame-memory-live", at: new Date().toISOString(), model: provider.model.name, sourceReport, asset, checks, runs, completed: false,
  scope: "Public image montage, actual model image reads and draft creation; user confirmation/date messages are explicit isolated test instructions. No private media or model training.",
  reference: { coffee: 0, bridge: 2, recordingDate: "unknown", identity: "unknown" }, independentSemanticReview: "pending" };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let activeId: string | undefined;
async function task(scenario: string, text: string) {
  console.log(JSON.stringify({ phase: scenario, directory }));
  const conversation = store.createConversation();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text, modelId: provider!.model.id, thinkingLevel: "low", assetIds: [asset.id], scope: "selected", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (response.statusCode !== 201) throw new Error("隔离 Agent 任务创建失败");
  activeId = response.json<{ run: Run }>().run.id;
  const deadline = Date.now() + 240000;
  let run = store.work.get<Run>("run", activeId)!;
  while (!["completed", "failed", "stopped"].includes(run.status) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 300)); run = store.work.get<Run>("run", activeId)!;
  }
  if (!["completed", "failed", "stopped"].includes(run.status)) {
    await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); run = store.work.get<Run>("run", activeId)!;
  }
  runs.push({ scenario, run }); activeId = undefined; await save(); return run;
}
const completeTool = (run: Run, name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
try {
  await app.ready(); await save();
  const proposed = await task("01-propose-selected-frame-memories", "这段公开图片拼成的视频仅用于隔离验证，不代表我的经历。请实际读取视频 0 秒与 2 秒画面，分别保存两条待核对记忆：第一条只记录杯碟和杯中液体，第二条只记录雾中的红色悬索桥；每条引用自己的实际画面，可读取局部帮助核对。只保存画面可见内容，不确认事实，不补身份、地点名称或拍摄日期。不需要后台生成描述。请完成草稿保存。");
  const drafts = store.memories.list<MemoryEntry>("memory"); report.drafts = drafts;
  checks.agentCreatesDrafts = proposed.status === "completed" && completeTool(proposed, "propose_memory") && drafts.length === 2;
  checks.separateFrameSources = [0, 2].every((time) => drafts.some((memory) => memory.sources.length === 1 && memory.sources[0].video?.timestamp === time));
  checks.noUnconfirmedFacts = drafts.every((memory) => memory.kind === "observation" && memory.status === "draft" && !memory.acceptedBy && !memory.occurredAt && !memory.people?.length);
  checks.actualReadReferences = drafts.every((memory) => memory.sources.every((source) => proposed.parts.some((part) => {
    if (part.type !== "tool" || part.name !== "read_evidence" || part.state !== "complete") return false;
    const read = part.output as { imageDelivered?: boolean; source?: { video?: { timestamp: number }; view?: { sha256: string } } };
    return read.imageDelivered && read.source?.video?.timestamp === source.video?.timestamp && read.source?.view?.sha256 === source.view?.sha256;
  })));
  if (!checks.agentCreatesDrafts || !checks.separateFrameSources || !checks.noUnconfirmedFacts) throw new Error("逐条草稿及来源验收失败，保留真实任务记录");
  const review = await task("02-confirm-and-deliver-files", "只在此隔离测试库，我明确确认这两条画面观察，且补充虚构事件日期为 2026-09-12；该日期来自本条用户指令，不代表视频拍摄日期。请检查刚才的两条待核对记忆，将分类改为记录 fact，occurredAt 设为 2026-09-12，清空 uncertainty，并保留每条正文和各自原始画面来源；然后直接确认两条记录。请从这两条已确认记录使用模型生成训练问答与独立评测题，逐题核对内容与时间限定，必要时修订或排除，再交付实际可下载文件。不做个人模型训练。");
  report.confirmed = store.memories.list<MemoryEntry>("memory");
  checks.userConfirmation = (report.confirmed as MemoryEntry[]).every((memory) => memory.status === "confirmed" && memory.acceptedBy === "user" && memory.occurredAt === "2026-09-12")
    && store.memoryCommands.receipts(review.id).some((receipt) => receipt.actor === "user" && !!receipt.instruction);
  const deliveryTool = review.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivery = deliveryTool?.type === "tool" ? deliveryTool.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  checks.agentReviewedDelivery = !!delivery && completeTool(review, "inspect_dataset") && completeTool(review, "review_dataset");
  if (!delivery) throw new Error("真实 Agent 未完成训练资料交付");
  report.delivery = delivery; report.samples = new DatasetLedger(store).samples(delivery.datasetId, "", 100);
  const files: Record<string, { sha256: string; bytes: number; records?: number }> = {};
  for (const file of delivery.files) {
    const response = await app.inject(file.href);
    if (response.statusCode !== 200) throw new Error("实际交付文件不可下载");
    files[file.kind] = { sha256: contentHash(response.rawPayload), bytes: response.rawPayload.length,
      ...(file.kind === "manifest" ? {} : { records: response.body.trim().split("\n").filter(Boolean).length }) };
    await writeFile(join(directory, file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), response.rawPayload, { mode: 0o600 });
  }
  report.files = files;
  checks.hashVerifiedFiles = !!files.training?.records && !!files.evaluation?.records && delivery.files.every((file) => file.sha256 === files[file.kind].sha256);
  const training = (await readFile(join(directory, "training.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  checks.sampleFrameLineage = training.every((row) => row.lineage.evidence.filter((e: { type: string }) => e.type === "asset").length === 1)
    && new Set(training.flatMap((row) => row.lineage.evidence.filter((e: { type: string }) => e.type === "asset").map((e: { video: { timestamp: number } }) => e.video.timestamp))).size === 2;
  checks.trainingRemainsStopped = !store.db.prepare("SELECT 1 FROM memory_model_versions").get();
  console.log(JSON.stringify({ phase: "03-nonempty-backup-restore", directory }));
  await app.close();
  const archive = join(root, basename(directory) + "-archive"), restored = join(root, basename(directory) + "-restored");
  report.archive = await backupMemory(directory, archive); report.restore = await restoreMemory(archive, restored); report.restoredDirectory = restored;
  const before = JSON.stringify(report.confirmed);
  store = new Store(restored); app = buildApp({ ...config, dataDir: restored }, { store }); await app.ready();
  checks.restoredFrameMemories = JSON.stringify(store.memories.list<MemoryEntry>("memory")) === before;
  checks.restoredDeliveredBytes = (await app.inject(delivery.files.find((file) => file.kind === "training")!.href)).rawPayload.equals(await readFile(join(directory, "training.jsonl")));
  report.completed = true;
} catch (failure) { report.failure = failure instanceof Error ? failure.message : String(failure); }
finally {
  if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }).catch(() => undefined);
  await app.close().catch(() => undefined); await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), completed: report.completed, checks, failure: report.failure }));
}
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
