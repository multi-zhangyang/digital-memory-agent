// Real providers + Pi, isolated public/synthetic materials. No private library is copied or repaired by this evaluator.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, Asset, MemoryEntry, MemoryImportJob, Run, TrainingSample } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { ModelAccess } from "../src/integrations/pi/model-access.js";
import { PiMemoryProcessors } from "../src/integrations/pi/processors.js";
import type { MemoryProcessors } from "../src/memory/processors.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 显式运行公开照片和虚构文字的真实模型验证");
const original = readConfig();
const provider = original.providers.find((item) => item.model.id === process.env.MEMORY_EVAL_MODEL)
  || original.providers.find((item) => item.model.name === "gpt-6-luna" && item.model.supportsImages)
  || original.providers.find((item) => item.model.supportsImages);
if (!provider) throw new Error("请先配置支持图片输入的真实模型");
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, "agent-first-live-"));
const config = { ...original, dataDir: dir, providers: [provider] };
const store = new Store(dir);
store.memories.ledger.setSettings({ intake: "manual", capture: "off", textModelId: provider.model.id, photoModelId: provider.model.id, datasetModelId: provider.model.id });
const actual = new PiMemoryProcessors(config, new ModelAccess(config));
const calls = { text: 0, photo: 0, dataset: 0, capture: 0 };
// Diagnose transport failures without storing request bodies, response bodies, URLs or credentials.
const transport: { status?: number; ms: number; errors?: { name?: string; code?: string }[] }[] = [];
const originalFetch = globalThis.fetch;
const providerOrigin = new URL(provider.baseUrl).origin;
globalThis.fetch = async (input, init) => {
  const started = performance.now();
  const tracked = new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin === providerOrigin;
  try {
    const response = await originalFetch(input, init);
    if (tracked) transport.push({ status: response.status, ms: Math.round(performance.now() - started) });
    return response;
  } catch (error) {
    const errors: { name?: string; code?: string }[] = [];
    let cause: unknown = error;
    while (cause && typeof cause === "object" && errors.length < 4) {
      const value = cause as { name?: string; code?: string; cause?: unknown };
      errors.push({ name: value.name, ...(typeof value.code === "string" && /^[A-Z_\d]+$/.test(value.code) ? { code: value.code } : {}) });
      cause = value.cause;
    }
    if (tracked) transport.push({ ms: Math.round(performance.now() - started), errors });
    throw error;
  }
};
const processors: MemoryProcessors = {
  async extractMemories(input, signal) { calls.text++; return actual.extractMemories(input, signal); },
  async extractPhotoMemories(input, signal) { calls.photo++; return actual.extractPhotoMemories(input, signal); },
  async generateDatasetQuestions(input, signal) { calls.dataset++; return actual.generateDatasetQuestions(input, signal); },
  async captureMemories(input, signal) { calls.capture++; return actual.captureMemories(input, signal); },
};
const app = buildApp(config, { store, processors });
const checks: Record<string, boolean> = {};
const runs: { scenario: string; run: Run; artifacts: Artifact[] }[] = [];
const report: Record<string, unknown> = { type: "agent-first-live", at: new Date().toISOString(), model: provider.model.name, calls, checks, runs, transport,
  scope: "Existing licensed public bridge photo and new synthetic records in an isolated store. Conversation-only operations; no private user assets or model training.",
  completed: false, semanticReview: "pending independent inspection of pixels, answers and exported questions; integration checks alone do not pass quality" };
const save = () => writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const now = () => new Date().toISOString();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const message = (run: Run) => run.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const used = (run: Run, name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
async function add(bytes: Buffer, kind: "image" | "text", name: string) {
  const value: Asset = { id: randomUUID(), name, kind, mimeType: kind === "text" ? "text/plain" : "image/jpeg", size: bytes.length, sha256: hash(bytes), createdAt: now(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, value.id), bytes, { mode: 0o600 }); store.addAsset(value, { processing: "requested" }); return value;
}
async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw new Error("Isolated evaluation timeout");
}
let activeId: string | undefined;
async function task(scenario: string, text: string, assetIds: string[] = [], options: { conversationId?: string; capture?: boolean; useMemory?: boolean } = {}) {
  const conversationId = options.conversationId || store.createConversation().id;
  console.log(JSON.stringify({ phase: "start", scenario })); await save();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/runs`, payload: {
    text, assetIds, scope: assetIds.length ? "selected" : "library", modelId: provider!.model.id, thinkingLevel: "low", permissionMode: "auto",
    useMemory: options.useMemory !== false, captureMemory: !!options.capture,
  } });
  if (response.statusCode !== 201) throw new Error("Could not create isolated evaluation task");
  activeId = response.json<{ run: Run }>().run.id;
  let run = await waitFor(() => store.work.get<Run>("run", activeId!)!, (value) => ["completed", "failed", "stopped"].includes(value.status) || (value.status === "waiting" && value.waitingFor !== "jobs" && !!value.question));
  if (run.status === "waiting") { await app.inject({ method: "POST", url: `/api/runs/${run.id}/stop` }); run = store.work.get<Run>("run", run.id)!; }
  const artifacts = store.work.list<Artifact>("artifact", conversationId).filter((artifact) => artifact.runId === run.id);
  runs.push({ scenario, run, artifacts });
  await writeFile(join(dir, scenario + ".json"), JSON.stringify({ run, artifacts }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ phase: "settled", scenario, status: run.status, tools: run.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.name, state: part.state })), calls }));
  await save(); activeId = undefined; return { run, artifacts };
}

try {
  await app.ready();
  const manifest = JSON.parse(await readFile(join(projectRoot, "examples/photos/manifest.json"), "utf8")) as { photos: { id: string; file: string; sha256: string; source: string; license: string }[] };
  const fixture = manifest.photos.find((item) => item.id === "bridge")!;
  const bytes = await readFile(join(projectRoot, ".data/photo-fixtures", fixture.file));
  if (hash(bytes) !== fixture.sha256) throw new Error("Public photo checksum mismatch");
  report.photo = fixture;
  const photo = await add(bytes, "image", "资料01.jpg");
  const text = await add(Buffer.from("2026年8月14日，林遥把铜钥匙交给周澄。周澄将铜钥匙放进书房的绿色抽屉，抽屉编号 HN74。2026年8月17日，周澄在书房归还铜钥匙给林遥。"), "text", "记录01.txt");
  report.assets = [photo, text];
  const organized = await task("01-attachments-only", "", [photo.id, text.id]);
  const imports = (await app.inject("/api/memory-overview?view=imports")).json<{ jobs: MemoryImportJob[] }>().jobs;
  report.imports = imports;
  checks.attachmentOnly = organized.run.text === "" && !!organized.run.goal && organized.run.status === "completed";
  checks.mixedCoverage = imports.some((job) => job.status === "completed" && [photo, text].every((asset) => job.chunks.some((chunk) => chunk.assetId === asset.id)));
  checks.sourcedArtifact = organized.artifacts.some((artifact) => [photo, text].every((asset) => artifact.sources.some((source) => source.assetId === asset.id)));
  checks.observationsRemainDraft = store.memories.list<MemoryEntry>("memory").length > 0 && store.memories.list<MemoryEntry>("memory").every((entry) => entry.status === "draft");
  checks.defaultIsNotUserMemory = !(store.db.prepare("SELECT 1 FROM memory_capture_jobs WHERE json_extract(data,'$.runId')=?").get(organized.run.id));

  const read = await task("02-direct-read", "请直接对照所选文字与照片，不要再次提取：铜钥匙归还前是谁收到的，抽屉编号是什么？照片里有哪些能直接看见的主要物体？给出原件依据，未知人物和日期不要补写。", [photo.id, text.id], { useMemory: false });
  checks.directRead = read.run.status === "completed" && (used(read.run, "read_evidence") || used(read.run, "read_asset_text")) && message(read.run).includes("HN74") && message(read.run).includes("周澄");
  const followup = await task("03-sourced-followup", "钥匙在归还前具体放在哪里？请引用来源。", [text.id], { conversationId: read.run.conversationId, useMemory: false });
  checks.sourcedFollowup = followup.run.status === "completed" && message(followup.run).includes("绿色抽屉") && followup.run.sources.some((source) => source.assetId === text.id);

  const confirmed = await task("04-confirm-batch", "我确认记录01.txt 的这些文字记录属实，请把这份文字整理出的候选确认入库。照片观察仍保持待核对。告诉我实际确认了多少条。", [photo.id, text.id], { conversationId: organized.run.conversationId });
  const textMemories = () => store.memories.list<MemoryEntry>("memory").filter((entry) => entry.sources.some((source) => source.assetId === text.id));
  checks.conversationConfirmation = confirmed.run.status === "completed" && used(confirmed.run, "change_memories") && textMemories().length > 0 && textMemories().every((entry) => entry.status === "confirmed" && entry.acceptedBy === "user");
  checks.photoNotBlanketConfirmed = store.memories.list<MemoryEntry>("memory").filter((entry) => entry.sources.some((source) => source.assetId === photo.id)).every((entry) => entry.status === "draft");

  const corrected = await task("05-correct-and-answer", "抽屉编号写错了，正确编号是 HN79。请把所有相关记录更正后，再告诉我现在的编号。", [text.id], { conversationId: organized.run.conversationId });
  checks.correctAndContinue = corrected.run.status === "completed" && used(corrected.run, "change_memories") && message(corrected.run).includes("HN79")
    && textMemories().some((entry) => entry.content.includes("HN79")) && textMemories().every((entry) => !entry.content.includes("HN74"));
  checks.userCommandReceipts = [confirmed.run, corrected.run].every((run) => store.memoryCommands.receipts(run.id).some((receipt) => receipt.actor === "user" && receipt.instruction?.runId === run.id));

  const dataset = await task("06-training-files", "请把这份资料中已经确认且已纠正的记忆做成可训练的问答文件，也生成独立评测题。请你完成逐题核对、需要的修订与真实文件交付，我要直接下载使用。保留人物动作方向和时间，不要在问题中泄露答案，不要用只有代词的答案。", [text.id]);
  const delivery = dataset.run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivered = delivery?.type === "tool" ? delivery.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  checks.agentReviewedSamples = used(dataset.run, "inspect_dataset") && used(dataset.run, "review_dataset");
  checks.trainingFilesDelivered = dataset.run.status === "completed" && !!delivered;
  if (delivered) {
    const files: Record<string, { sha256: string; bytes: number; rows?: unknown[] }> = {};
    for (const file of delivered.files) {
      const response = await app.inject(file.href);
      if (response.statusCode !== 200) throw new Error("Delivered export could not be downloaded");
      const bytes = response.rawPayload;
      files[file.kind] = { sha256: hash(bytes), bytes: bytes.length, ...(file.kind === "manifest" ? {} : { rows: response.body.trim() ? response.body.trim().split("\n").map((line) => JSON.parse(line)) : [] }) };
      await writeFile(join(dir, "delivered-" + file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), bytes, { mode: 0o600 });
    }
    report.delivery = delivered; report.files = files;
    const samples = (await app.inject(`/api/memory-datasets/${delivered.datasetId}/samples`)).json<{ samples: TrainingSample[] }>().samples;
    report.samples = samples;
    checks.nonemptyVerifiedFiles = !!files.training.rows?.length && !!files.evaluation.rows?.length && delivered.files.every((file) => files[file.kind].sha256 === file.sha256);
    checks.reviewActorAccurate = samples.filter((sample) => sample.status === "ready").every((sample) => sample.authority === "agent-reviewed" && sample.review?.actor === "agent");
    checks.noObsoleteNumberInTraining = !JSON.stringify(files.training.rows).includes('"content":"HN74"') && !JSON.stringify(files.training.rows?.map((row) => (row as { messages: unknown }).messages)).includes("HN74");
  }

  const forgotten = await task("07-forget", "请停止使用关于书房抽屉编号的记忆。在本次回复中只说明是否已经停用，不要复述编号。", [text.id], { conversationId: organized.run.conversationId });
  checks.stopInConversation = forgotten.run.status === "completed" && used(forgotten.run, "change_memories") && textMemories().some((entry) => !!entry.forgottenAt);
  const unavailable = await task("08-after-forgetting", "书房里放铜钥匙的抽屉编号是什么？");
  const attemptedRecall = unavailable.run.parts.filter((part) => part.type === "tool" && ["search_memories", "inspect_memories"].includes(part.name));
  checks.forgottenNotRecalled = unavailable.run.status === "completed" && !/HN74|HN79/.test(message(unavailable.run))
    && (!attemptedRecall.length || attemptedRecall.some((part) => part.type === "tool" && part.state === "complete"));
  if (delivered) checks.correctionLineageInvalidated = (await app.inject(`/api/memory-datasets/${delivered.datasetId}/files/training`)).statusCode === 409;

  store.memories.ledger.setSettings({ capture: "graded" });
  const preference = await task("09-preference", "我喜欢把整理结果按日期从新到旧排列。这是我的长期偏好，请记住。", [], { capture: true });
  await waitFor(() => store.db.prepare("SELECT 1 FROM memory_capture_jobs WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status') IN ('waiting','queued','running')").get(preference.run.id), (pending) => !pending, 180000);
  checks.preferenceStored = store.memories.list<MemoryEntry>("memory").some((entry) => entry.status === "confirmed" && !entry.forgottenAt && entry.content.includes("从新到旧"));
  const later = await add(Buffer.from("2026年7月2日，林遥归还了借来的绘本。2026年7月19日，林遥在书房整理了三册旧书。"), "text", "记录02.txt");
  const personalized = await task("10-use-preference", "请整理这份文字并保存一份简短结果。", [later.id]);
  const resultText = personalized.artifacts.map((artifact) => artifact.content).join("\n");
  const newer = /2026(?:年|-|\/)0?7(?:月|-|\/)19/.exec(resultText), older = /2026(?:年|-|\/)0?7(?:月|-|\/)0?2(?:日|\b)/.exec(resultText);
  checks.preferenceUsed = personalized.run.status === "completed" && !!newer && !!older && newer.index < older.index;
  report.finalMemories = store.memories.list<MemoryEntry>("memory");
  checks.noTrainingClaimed = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
  report.completed = Object.values(checks).every(Boolean);
  if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.error = "真实会话验收未完成，保留现场以供诊断"; report.errorType = error instanceof Error ? error.name : "unknown";
  if (activeId) { report.interruptedRun = store.work.get<Run>("run", activeId); await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); }
  process.exitCode = 1;
} finally {
  await save(); await app.close();
  globalThis.fetch = originalFetch;
  console.log(JSON.stringify({ reportPath: join(dir, "report.json"), completed: report.completed, checks, calls }));
}
