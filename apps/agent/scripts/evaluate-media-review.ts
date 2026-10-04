// Real Pi + configured providers. Explicit seeded defects test recovery; they are never presented as natural model mistakes.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Artifact, Asset, MemoryEntry, Run, TrainingSample } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { ModelAccess } from "../src/integrations/pi/model-access.js";
import { PiMemoryProcessors } from "../src/integrations/pi/processors.js";
import { preparePhoto } from "../src/memory/photo-source.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { dateMentions, sampleTimeQuality } from "../src/memory/dataset-time-review.js";
import type { MemoryProcessors } from "../src/memory/processors.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 显式运行公开照片、程序标签和虚构文字的真实模型验证");
const original = readConfig();
const provider = original.providers.find((item) => item.model.id === process.env.MEMORY_EVAL_MODEL)
  || original.providers.find((item) => item.model.name === "gpt-6-luna" && item.model.supportsImages);
if (!provider) throw new Error("请配置支持图片输入的真实评测模型");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, "media-review-live-"));
const config = { ...original, dataDir: dir, providers: [provider] };
let store = new Store(dir);
store.memories.ledger.setSettings({ intake: "manual", capture: "off", textModelId: provider.model.id, photoModelId: provider.model.id, datasetModelId: provider.model.id });
const actual = new PiMemoryProcessors(config, new ModelAccess(config));
const calls = { text: 0, photo: 0, dataset: 0, capture: 0 };
const processors: MemoryProcessors = {
  async extractMemories(input, signal) { calls.text++; return actual.extractMemories(input, signal); },
  async extractPhotoMemories(input, signal) { calls.photo++; return actual.extractPhotoMemories(input, signal); },
  async generateDatasetQuestions(input, signal) { calls.dataset++; return actual.generateDatasetQuestions(input, signal); },
  async captureMemories(input, signal) { calls.capture++; return actual.captureMemories(input, signal); },
};
let app = buildApp(config, { store, processors });
const checks: Record<string, boolean> = {}, runs: { scenario: string; run: Run; artifacts: Artifact[] }[] = [];
const report: Record<string, unknown> = { type: "media-review-live", at: new Date().toISOString(), model: provider.model.name, calls, checks, runs,
  scope: "New CC0 photograph, generated label, synthetic text; isolated store; explicit draft and date fault injection; no training.",
  independentSemanticReview: "pending: compare actual image pixels, source records, questions and exports; programmatic checks do not establish visual quality", completed: false };
const save = () => writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const used = (run: Run, name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
const replyText = (run: Run) => run.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
async function add(bytes: Buffer, kind: "image" | "text", name: string) {
  const value: Asset = { id: randomUUID(), name, kind, mimeType: kind === "text" ? "text/plain" : "image/jpeg", size: bytes.length, sha256: hash(bytes), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, value.id), bytes, { mode: 0o600 }); store.addAsset(value, { processing: "requested" }); return value;
}
async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeout = 360000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw new Error("Isolated evaluation timeout");
}
let activeId: string | undefined;
async function task(scenario: string, text: string, assetIds: string[] = [], options: { conversationId?: string; capture?: boolean } = {}) {
  console.log(JSON.stringify({ phase: "start", scenario })); await save();
  const conversationId = options.conversationId || store.createConversation().id;
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/runs`, payload: {
    text, assetIds, scope: assetIds.length ? "selected" : "library", modelId: provider!.model.id, thinkingLevel: "low", permissionMode: "auto", useMemory: true, captureMemory: !!options.capture,
  } });
  if (response.statusCode !== 201) throw new Error("Could not create isolated task");
  activeId = response.json<{ run: Run }>().run.id;
  let run = await waitFor(() => store.work.get<Run>("run", activeId!)!, (value) => ["completed", "failed", "stopped"].includes(value.status) || (value.status === "waiting" && value.waitingFor !== "jobs" && !!value.question));
  if (run.status === "waiting") { await app.inject({ method: "POST", url: `/api/runs/${run.id}/stop` }); run = store.work.get<Run>("run", run.id)!; }
  const artifacts = store.work.list<Artifact>("artifact", conversationId).filter((artifact) => artifact.runId === run.id);
  runs.push({ scenario, run, artifacts });
  await writeFile(join(dir, scenario + ".json"), JSON.stringify({ run, artifacts }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ phase: "settled", scenario, status: run.status, tools: run.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.name, state: part.state })), calls }));
  await save(); activeId = undefined; return { run, artifacts };
}
function order(artifacts: Artifact[], earlier: string, later: string, ascending: boolean) {
  const dates = artifacts.flatMap((artifact) => dateMentions(artifact.content).map((date) => date.value));
  return dates.includes(earlier) && dates.includes(later) && (ascending ? dates.indexOf(earlier) < dates.indexOf(later) : dates.indexOf(later) < dates.indexOf(earlier));
}
try {
  const code: Record<string, string> = {};
  for (const file of ["application/evidence-tools.ts", "application/task-context.ts", "integrations/pi/runtime.ts", "harness/context-policy.ts", "memory-tools.ts", "workspace-tools.ts", "workspace-store.ts", "memory/query-service.ts", "memory/text-source.ts", "memory/captures.ts", "memory/commands.ts", "memory/records.ts", "memory/dataset-time-review.ts", "harness/product-profile.ts"])
    code[file] = hash(await readFile(join(projectRoot, "apps/agent/src", file)));
  report.code = code;
  await app.ready();
  const manifest = JSON.parse(await readFile(join(projectRoot, "examples/quality/media-review.json"), "utf8")); report.fixtures = manifest;
  const photoBytes = await readFile(join(projectRoot, ".data/quality-stage20-fixtures", manifest.photo.file));
  if (hash(photoBytes) !== manifest.photo.sha256) throw new Error("Public photo checksum mismatch");
  const photo = await add(photoBytes, "image", "室内照片.jpg");
  const label = await add(await sharp(await readFile(join(projectRoot, "examples/quality/archive-label.svg"))).jpeg({ quality: 95 }).toBuffer(), "image", "物品照片.jpg");
  const preview = await preparePhoto(store.assetsDir, label);
  const seeded = store.memories.createMemory({ title: "档案盒标签", content: "照片中的档案盒标签编号为 RZ48。", status: "draft", kind: "observation", category: "fact", occurredAt: "", conversationId: "", runId: "",
    sources: [{ assetId: label.id, name: label.name, sha256: label.sha256, start: 0, end: label.size,
      visual: { width: preview.width, height: preview.height, previewSha256: preview.sha256, region: { x: 0.6625, y: 0.67, width: 0.2375, height: 0.18 } } }] });
  report.seededDraft = seeded; report.assets = [photo, label];
  const visual = await task("01-new-media-review", "请整理这两张照片，并对照原件复核已有观察。先读整图，物品标签的小字用局部读取核对；发现草稿错误就修订。保存一份带来源的整理结果，说明可见物体及相对位置，小字能读到多少就记录多少，不能可靠判断的保持未知。观察保持待核对。", [photo.id, label.id]);
  const revised = store.memories.get<MemoryEntry>("memory", seeded.id)!;
  const receipts = store.memoryCommands.receipts(visual.run.id); report.visualReceipts = receipts; report.revisedDraft = revised;
  checks.originalAndCrop = visual.run.parts.some((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete" &&
    (part.output as { imageDelivered?: boolean; source?: { view?: { region?: unknown } } }).imageDelivered && !!(part.output as { source?: { view?: { region?: unknown } } }).source?.view?.region);
  checks.autonomousDraftRepair = revised.version > 1 && revised.status === "draft" && revised.editedBy === "agent" && revised.content.includes("RZ49") && !revised.content.includes("RZ48");
  checks.readProofRetained = receipts.some((receipt) => receipt.actor === "agent" && receipt.sourceReads?.some((read) => read.assetId === label.id && read.kind === "image"));
  checks.sourcedVisualArtifact = visual.artifacts.some((artifact) => [photo, label].every((asset) => artifact.sources.some((source) => source.assetId === asset.id)));

  const text = await add(Buffer.from("2026年9月5日，唐岚把编号 QB47 的蓝色相册交给许辰。许辰将相册放入书房的第二层木架。2026年9月8日，许辰把同一本蓝色相册归还给唐岚。"), "text", "相册交接.txt");
  const organized = await task("02-text-intake", "请整理这份文字并保存带来源的结果。", [text.id]);
  const confirmed = await task("03-confirm-and-correct", "我确认相册交接.txt 中的两次交接属实，唯一更正是相册编号应为 QB49，不是 QB47。请更正所有涉及编号的文字记录，确认这份文字的候选入库，再告诉我正确编号。", [text.id], { conversationId: organized.run.conversationId });
  const textMemories = () => store.memories.list<MemoryEntry>("memory").filter((entry) => entry.sources.some((source) => source.assetId === text.id));
  checks.textConfirmedAndCorrected = confirmed.run.status === "completed" && textMemories().length > 0 && textMemories().every((entry) => entry.status === "confirmed" && !entry.content.includes("QB47")) && textMemories().some((entry) => entry.content.includes("QB49"));
  const built = await task("04-generate-questions", "请从这份文字已经确认且纠正的记忆生成可训练的问答和独立评测题。本轮只完成构建，先不要审核和交付。", [text.id]);
  const dataset = built.run.jobs?.find((job) => job.kind === "memory-dataset");
  checks.realQuestionGeneration = !!dataset && calls.dataset > 0 && used(built.run, "build_dataset");
  if (dataset) {
    const ledger = new DatasetLedger(store);
    const before = ledger.samples(dataset.id, "", 100); report.generatedBeforeFault = before;
    const target = before.find((sample) => sample.kind === "qa" && !dateMentions(sample.answer).length && ledger.sampleSources(sample).some((memory) => !!memory.occurredAt));
    if (target) {
      const question = target.question.replace(/[12]\d{3}(?:年\s*\d{1,2}月\s*\d{1,2}[日号]?|[-/.]\d{1,2}[-/.]\d{1,2})[，,\s]*/gu, "").trim();
      const seededSample = { ...target, question, quality: undefined };
      store.db.prepare("UPDATE dataset_samples SET data=? WHERE id=?").run(JSON.stringify(seededSample), target.id);
      report.seededSample = { id: target.id, before: target.question, after: question, defects: sampleTimeQuality(seededSample, ledger.sampleSources(target)).issues };
      checks.seededTimeIssueDetected = sampleTimeQuality(seededSample, ledger.sampleSources(target)).issues.some((issue) => issue.severity === "blocking");
    } else checks.seededTimeIssueDetected = false;
    const reviewed = await task("05-review-and-deliver", `请逐题检查数据集 ${dataset.id}，核对人物动作方向、答案、发生日期和有效时间；修订或排除问题样本，最后交付可下载的训练文件和独立评测题。`, [text.id]);
    const delivery = reviewed.run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
    const delivered = delivery?.type === "tool" ? delivery.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
    checks.reviewAndDelivery = !!delivered && used(reviewed.run, "inspect_dataset") && used(reviewed.run, "review_dataset");
    const samples = ledger.samples(dataset.id, "", 100); report.reviewedSamples = samples;
    checks.timeRepair = !!target && samples.some((sample) => sample.id === target.id && sample.version > target.version && !sample.quality?.issues.some((issue) => issue.severity === "blocking"));
    if (delivered) {
      report.delivery = delivered;
      const files: Record<string, { sha256: string; bytes: number; rows?: unknown[] }> = {};
      for (const file of delivered.files) {
        const result = await app.inject(file.href); if (result.statusCode !== 200) throw new Error("Delivered file unavailable");
        const bytes = result.rawPayload;
        files[file.kind] = { sha256: hash(bytes), bytes: bytes.length, ...(file.kind === "manifest" ? {} : { rows: result.body.trim() ? result.body.trim().split("\n").map((line) => JSON.parse(line)) : [] }) };
        await writeFile(join(dir, "delivered-" + file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), bytes, { mode: 0o600 });
      }
      report.files = files;
      checks.nonemptyVerifiedFiles = !!files.training.rows?.length && !!files.evaluation.rows?.length && delivered.files.every((file) => file.sha256 === files[file.kind].sha256);
    }
  }
  store.memories.ledger.setSettings({ capture: "graded" });
  const preference = await task("06-remember-preference", "我喜欢把整理结果按日期从新到旧排列。这是我的长期偏好，请记住。", [], { capture: true });
  await waitFor(() => store.db.prepare("SELECT 1 FROM memory_capture_jobs WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status') IN ('waiting','queued','running')").get(preference.run.id), (pending) => !pending, 180000);
  checks.preferenceStored = store.memories.list<MemoryEntry>("memory").some((entry) => entry.status === "confirmed" && entry.content.includes("从新到旧"));
  const first = await add(Buffer.from("2026年7月3日，唐岚整理了两本旅行相册。2026年7月21日，唐岚给三张照片添加了地点标注。"), "text", "新增批次一.txt");
  const one = await task("07-continuous-first", "请整理这份新增文字，保存简短结果。", [first.id]);
  checks.firstBatchUsesPreference = order(one.artifacts, "2026-07-03", "2026-07-21", false);
  const preferenceChange = await task("08-change-preference", "把我的整理顺序偏好改为按日期从旧到新，以后都采用这个新顺序。请更正已保存的偏好。");
  checks.preferenceCorrected = used(preferenceChange.run, "change_memories") && store.memories.list<MemoryEntry>("memory").some((entry) => entry.status === "confirmed" && !entry.forgottenAt && entry.content.includes("从旧到新"));
  const second = await add(Buffer.from("2026年8月4日，许辰整理了手写说明。2026年8月23日，许辰为五段录音补充了标签。"), "text", "新增批次二.txt");
  const two = await task("09-continuous-second", "请整理这份新增文字，保存简短结果。", [second.id]);
  checks.secondBatchUsesCorrection = order(two.artifacts, "2026-08-04", "2026-08-23", true);
  await app.close(); store = new Store(dir); app = buildApp(config, { store, processors }); await app.ready();
  const third = await add(Buffer.from("2026年10月2日，唐岚给旧底片编号。2026年10月17日，唐岚完成了底片扫描。"), "text", "新增批次三.txt");
  const three = await task("10-continuous-after-restart", "请整理新增批次三.txt 并保存简短结果。另外告诉我之前已纠正的蓝色相册编号，只报告当前编号与依据，不复述旧编号。", [third.id, text.id]);
  checks.thirdBatchSurvivesRestart = order(three.artifacts, "2026-10-02", "2026-10-17", true);
  checks.correctedFactReused = replyText(three.run).includes("QB49") && !replyText(three.run).includes("QB47");
  report.finalMemories = store.memories.list<MemoryEntry>("memory");
  checks.noTraining = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
  report.completed = Object.values(checks).every(Boolean); if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.error = "真实验收未完成，保留现场诊断"; report.errorType = error instanceof Error ? error.name : "unknown";
  if (activeId) { report.interruptedRun = store.work.get<Run>("run", activeId); await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); }
  process.exitCode = 1;
} finally { await save(); await app.close(); console.log(JSON.stringify({ reportPath: join(dir, "report.json"), completed: report.completed, checks, calls })); }
