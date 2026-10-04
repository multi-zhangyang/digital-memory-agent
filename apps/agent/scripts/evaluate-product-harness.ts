// Explicit real-model evaluation using one licensed public photo and synthetic text in a fresh store.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Asset, Artifact, EvidenceRead, EvidenceSearchResult, MemoryEntry, MemoryImportJob, Run, TaskJob } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { ModelAccess } from "../src/integrations/pi/model-access.js";
import { PiMemoryProcessors } from "../src/integrations/pi/processors.js";
import type { MemoryProcessors } from "../src/memory/processors.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 显式运行公开图片和虚构文字的真实模型验证");
const original = readConfig();
const provider = original.providers.find((value) => value.model.supportsImages && value.model.name === "gpt-6-luna")
  || original.providers.find((value) => value.model.supportsImages);
if (!provider || !original.localProcessor) throw new Error("请配置支持图片的模型和本地特征处理器");
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "product-harness-live-"));
const config = { ...original, dataDir: directory, providers: [provider] };
const store = new Store(directory);
store.memories.ledger.setSettings({ capture: "off", intake: "automatic", automaticText: true, automaticPhotos: true,
  textModelId: provider.model.id, photoModelId: "unconfigured/photo" });
const actual = new PiMemoryProcessors(config, new ModelAccess(config));
const calls = { text: 0, photo: 0 };
const processors: MemoryProcessors = {
  async extractMemories(input, signal) { calls.text++; return actual.extractMemories(input, signal); },
  async extractPhotoMemories(input, signal) { calls.photo++; return actual.extractPhotoMemories(input, signal); },
  generateDatasetQuestions: (input, signal) => actual.generateDatasetQuestions(input, signal),
};
const app = buildApp(config, { store, processors });
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "product-harness-live", at: new Date().toISOString(), model: provider.model.name,
  scope: "One licensed public coffee photograph and synthetic text; isolated database; no user library or training", calls, checks,
  completed: false, semanticReview: "pending; integration checks do not score visual or reasoning quality" };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function add(bytes: Buffer, kind: "text" | "image", name: string) {
  const asset: Asset = { id: randomUUID(), name, kind, mimeType: kind === "text" ? "text/plain" : "image/jpeg", size: bytes.length,
    sha256: hash(bytes), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, asset.id), bytes, { mode: 0o600 }); store.addAsset(asset); return asset;
}
async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read(); if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Isolated evaluation timeout");
}
async function jobs(kind: string) { return (await app.inject("/api/jobs?kind=" + kind)).json<{ jobs: TaskJob[] }>().jobs; }
let runId: string | undefined;
try {
  await app.ready();
  const manifest = JSON.parse(await readFile(join(projectRoot, "examples/photos/manifest.json"), "utf8")) as { photos: { id: string; file: string; sha256: string }[] };
  const fixture = manifest.photos.find((photo) => photo.id === "coffee")!;
  const bytes = await readFile(join(projectRoot, ".data/photo-fixtures", fixture.file));
  if (hash(bytes) !== fixture.sha256) throw new Error("Public fixture checksum mismatch");
  const photo = await add(bytes, "image", "公开图像.jpg");
  await waitFor(() => jobs("asset-index"), (items) => items.some((item) => item.id === photo.id && ["completed", "failed"].includes(item.status)));
  const raw = (await app.inject("/api/evidence?kind=image&query=" + encodeURIComponent("咖啡杯"))).json<EvidenceSearchResult>();
  checks.rawImageBeforeAnyObservation = raw.hits.some((hit) => hit.assetId === photo.id && hit.authority === "raw-source") && store.memories.list("memory").length === 0;
  checks.realImageEncoderUsed = raw.hits.some((hit) => hit.assetId === photo.id && hit.channels.includes("image"));
  checks.missingPhotoModelVisible = (await jobs("asset-intake")).some((job) => job.id === photo.id && !!job.blockedReason);
  checks.noSessionForIndexing = store.conversations().length === 0 && (await readdir(store.sessionsDir)).length === 0;
  report.beforeProcessing = raw;
  console.log(JSON.stringify({ phase: "independent-source-index", checks })); await save();

  store.memories.ledger.setSettings({ photoModelId: provider.model.id });
  const text = await add(Buffer.from("2026年5月2日，我与林禾在书房整理星河档案，档案编号为 ZR82。"), "text", "虚构资料.txt");
  const imports = await waitFor(() => (awaitOverview()), (items) => [photo, text].every((asset) => items.some((job) =>
    job.chunks.some((chunk) => chunk.assetId === asset.id) && ["completed", "failed", "cancelled"].includes(job.status))));
  function awaitOverview() { return app.inject("/api/memory-overview?view=imports").then((result) => result.json<{ jobs: MemoryImportJob[] }>().jobs); }
  const memories = store.memories.list<MemoryEntry>("memory");
  checks.automaticJobsCompleted = imports.length === 2 && imports.every((job) => job.status === "completed" && job.ownership === "library");
  checks.noAgentForAutomaticProcessing = store.conversations().length === 0;
  checks.candidatesNotFacts = memories.length > 0 && memories.every((memory) => memory.status === "draft") && store.memories.searchMemories("星河档案").length === 0;
  checks.oneCallPerSource = calls.text === 1 && calls.photo === 1;
  report.imports = imports; report.observations = memories;
  console.log(JSON.stringify({ phase: "automatic-processing", checks, calls })); await save();

  const conversation = store.createConversation();
  const started = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: "请查找所选虚构资料里星河档案的编号，并查看所选公开照片实际画面。资料已经由后台整理。通过素材证据工具检索并对照原件，保存一份有来源的简短整理结果，区分原文、画面观察与未知信息。不要把图片当作我的经历或身份依据。",
    modelId: provider.model.id, thinkingLevel: "low", scope: "selected", assetIds: [photo.id, text.id], permissionMode: "auto", captureMemory: false,
  } });
  if (started.statusCode !== 201) throw new Error("Could not start the isolated task");
  runId = started.json<{ run: Run }>().run.id;
  const run = await waitFor(() => store.work.get<Run>("run", runId!)!, (value) => ["completed", "failed", "stopped"].includes(value.status), 300000);
  const artifacts = store.work.list<Artifact>("artifact");
  checks.taskCompleted = run.status === "completed";
  checks.agentReadEvidence = run.parts.some((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete");
  checks.savedSourcedArtifact = artifacts.some((artifact) => [photo, text].every((asset) => artifact.sources.some((source) => source.assetId === asset.id)));
  report.run = run; report.artifacts = artifacts;

  const textMemory = memories.find((memory) => memory.sources.some((source) => source.assetId === text.id));
  if (textMemory) {
    const corrected = store.memories.updateMemory(textMemory.id, { content: "该虚构档案的编号经核对改为 ZR83。", reason: "隔离验证中的版本修订" }, textMemory.version);
    const old = await app.inject(`/api/evidence/observation:${textMemory.id}?version=${textMemory.version}`);
    const current = (await app.inject(`/api/evidence/observation:${textMemory.id}?version=${corrected.version}`)).json<EvidenceRead>();
    checks.correctionRejectsOldVersion = old.statusCode === 409 && current.observation?.text.includes("ZR83") === true && !JSON.stringify(current).includes("ZR82");
  } else checks.correctionRejectsOldVersion = false;
  const photoMemory = memories.find((memory) => memory.sources.some((source) => source.assetId === photo.id));
  if (photoMemory) {
    store.memories.forgetMemory(photoMemory.id, photoMemory.version);
    const stopped = (await app.inject("/api/evidence?kind=image&query=" + encodeURIComponent("咖啡杯"))).json<EvidenceSearchResult>();
    checks.stoppedSourceUnavailable = !stopped.hits.some((hit) => hit.assetId === photo.id || hit.sources.some((source) => source.type === "asset" && source.assetId === photo.id))
      && (await app.inject(`/api/evidence/asset:${photo.id}`)).statusCode === 404;
  } else checks.stoppedSourceUnavailable = false;
  checks.noTraining = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
  report.completed = Object.values(checks).every(Boolean);
  if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.error = "隔离真实模型验证未完成"; report.errorType = error instanceof Error ? error.name : "unknown";
  if (runId) { report.run = store.work.get<Run>("run", runId); await app.inject({ method: "POST", url: `/api/runs/${runId}/stop` }); }
  process.exitCode = 1;
} finally {
  await save(); await app.close();
  console.log(JSON.stringify({ completed: report.completed, checks, calls, reportPath: join(directory, "report.json"), error: report.error }));
}
