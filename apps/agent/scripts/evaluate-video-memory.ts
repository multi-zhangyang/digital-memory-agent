// Real Pi/providers on generated video and fictional text in an isolated store. No training.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { Artifact, Asset, MemoryEntry, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { prepareVideoFrame } from "../src/memory/video-source.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 显式运行生成视频与虚构文字的真实模型验证");
const original = readConfig(), provider = original.providers.find((item) => item.model.id === process.env.MEMORY_EVAL_MODEL)
  || original.providers.find((item) => item.model.name === "gpt-6-luna" && item.model.supportsImages);
if (!provider?.model.supportsImages) throw new Error("请配置支持图片输入的真实评测模型");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const resumeIndex = process.argv.indexOf("--resume");
const dir = resumeIndex >= 0 ? resolve(process.argv[resumeIndex + 1]) : await mkdtemp(join(root, "video-memory-live-"));
const previous = resumeIndex >= 0 ? JSON.parse(await readFile(join(dir, "report.json"), "utf8")) : undefined;
const config = { ...original, dataDir: dir, providers: [provider], localProcessor: undefined };
let store = new Store(dir), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", textModelId: provider.model.id, videoModelId: provider.model.id,
  datasetModelId: provider.model.id, videoSampleInterval: 2 });
const checks: Record<string, boolean> = previous?.checks || {}, runs: { scenario: string; run: Run; artifacts: Artifact[] }[] = previous?.runs || [];
const report: Record<string, unknown> = previous ? { ...previous, completed: false, resumedAt: new Date().toISOString() } : { type: "video-memory-live", at: new Date().toISOString(), model: provider.model.name,
  scope: "Generated 6-second label-change video, fictional text, isolated store, explicitly seeded draft defect; no private media or training.",
  reference: { duration: 6, firstCode: "VN73", laterCode: "VN79", changeAt: 2, recordingDate: "unknown", people: "unknown", audio: false },
  independentSemanticReview: "pending; compare frame pixels, observations and actual exported files independently", checks, runs, completed: false };
const save = () => writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const used = (run: Run, name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
async function add(bytes: Buffer, kind: "video" | "text", name: string) {
  const asset: Asset = { id: randomUUID(), name, kind, mimeType: kind === "video" ? "video/mp4" : "text/plain", size: bytes.length,
    sha256: hash(bytes), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, asset.id), bytes, { mode: 0o600 }); store.addAsset(asset, { processing: "requested" }); return asset;
}
let activeId: string | undefined;
async function task(scenario: string, text: string, assetIds: string[], conversationId = store.createConversation().id) {
  console.log(JSON.stringify({ phase: "start", scenario })); await save();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/runs`, payload: {
    text, assetIds, scope: "selected", modelId: provider!.model.id, thinkingLevel: "low", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (response.statusCode !== 201) throw new Error("Could not create isolated video task");
  activeId = response.json<{ run: Run }>().run.id;
  const end = Date.now() + 360000;
  let run: Run;
  while (true) {
    run = store.work.get<Run>("run", activeId)!;
    if (["completed", "failed", "stopped"].includes(run.status)) break;
    if ((run.status === "waiting" && run.waitingFor !== "jobs") || Date.now() > end) {
      await app.inject({ method: "POST", url: `/api/runs/${run.id}/stop` }); run = store.work.get<Run>("run", run.id)!; break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const artifacts = store.work.list<Artifact>("artifact", conversationId).filter((artifact) => artifact.runId === run.id);
  runs.push({ scenario, run, artifacts }); await save(); activeId = undefined;
  console.log(JSON.stringify({ phase: "settled", scenario, status: run.status, tools: run.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.name, state: part.state })) }));
  return { run, artifacts };
}
try {
  if (previous) {
    await writeFile(join(dir, `report-before-resume-${Date.now()}.json`), JSON.stringify(previous, null, 2) + "\n", { mode: 0o600 });
    await app.ready();
    const video = store.assets("personal").find((asset) => asset.kind === "video")!, text = store.assets("personal").find((asset) => asset.kind === "text")!;
    const reviewed = await task("05-resume-video-review", "继续完成视频原件复核。检查视频 2.5 秒处的已有标签观察，从原始像素读取该时点的整幅画面及标签局部；同时读取前后画面核对变化，纠正已有草稿的误读，保持待核对。保存带视频时间和来源的复核结果。", [video.id]);
    const seed = previous.seededDraft as MemoryEntry, repaired = store.memories.get<MemoryEntry>("memory", seed.id)!;
    report.resumedRepairedDraft = repaired;
    checks.resumedTimedPixelCrop = reviewed.run.parts.some((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete"
      && !!(part.output as { source?: { video?: unknown; view?: { region?: unknown } }; imageDelivered?: boolean }).source?.video
      && !!(part.output as { source?: { view?: { region?: unknown } } }).source?.view?.region && (part.output as { imageDelivered?: boolean }).imageDelivered === true);
    checks.resumedDraftRepair = repaired.version > seed.version && repaired.status === "draft" && repaired.editedBy === "agent" && repaired.content.includes("VN79");
    checks.resumedReadReceipt = store.memoryCommands.receipts(reviewed.run.id).some((receipt) => receipt.actor === "agent" && receipt.sourceReads?.some((read) => read.kind === "video" && read.video?.timestamp === 2.5));
    checks.resumedSourcedArtifact = reviewed.artifacts.some((artifact) => artifact.sources.some((source) => source.assetId === video.id && source.video));
    const delivered = await task("06-resume-delivery", "这些人物和经历仍全部是虚构的隔离评测素材。本轮我明确更正并确认档案盒交接.txt 的记忆正文为：2026年9月12日，林舟把编号 VN79 的档案盒交给陈默，陈默把它放在书房第二层木架上。请用该正文替换候选中额外的限定，并清空因虚构评测情境产生的 uncertainty；这只作用于本隔离测试库，保留原件和用户纠正依据。请从当前确认版本生成训练问答和独立评测题，逐题核对、修订，再交付实际可下载的文件。", [text.id]);
    const tool = delivered.run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
    const delivery = tool?.type === "tool" ? tool.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
    checks.resumedReviewedDelivery = !!delivery && used(delivered.run, "inspect_dataset") && used(delivered.run, "review_dataset");
    if (delivery) {
      report.delivery = delivery; report.samples = new DatasetLedger(store).samples(delivery.datasetId, "", 100);
      const files: Record<string, { bytes: number; sha256: string; records?: number }> = {};
      for (const file of delivery.files) {
        const result = await app.inject(file.href); if (result.statusCode !== 200) throw new Error("Actual resumed delivery unavailable");
        files[file.kind] = { bytes: result.rawPayload.length, sha256: hash(result.rawPayload), ...(file.kind === "manifest" ? {} : { records: result.body.trim().split("\n").filter(Boolean).length }) };
        await writeFile(join(dir, "delivered-" + file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), result.rawPayload, { mode: 0o600 });
      }
      report.files = files;
      checks.resumedNonemptyFiles = !!files.training?.records && !!files.evaluation?.records && delivery.files.every((file) => file.sha256 === files[file.kind].sha256);
    }
  } else {
  const svg = await readFile(join(projectRoot, "examples/quality/archive-label.svg"), "utf8");
  for (let i = 0; i < 12; i++) await sharp(Buffer.from(svg.replace("RZ49", i < 4 ? "VN73" : "VN79"))).resize(1600, 1000).png().toFile(join(dir, `frame-${String(i).padStart(2, "0")}.png`));
  const path = join(dir, "source.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-framerate", "2", "-i", join(dir, "frame-%02d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
  const video = await add(await readFile(path), "video", "档案盒编号变化.mp4");
  const text = await add(Buffer.from("以下人物和经历完全虚构。2026年9月12日，林舟把编号 VN79 的档案盒交给陈默，陈默把它放在书房第二层木架上。这份文字不说明视频拍摄日期。"), "text", "档案盒交接.txt");
  const frame = await prepareVideoFrame(store.assetsDir, video, 2.5);
  await writeFile(join(dir, "original-frame-2.5.jpg"), frame.data, { mode: 0o600 });
  const seed = store.memories.createMemory({ title: "视频标签", content: "视频 2.5 秒处档案盒标签编号为 VN78。", status: "draft", kind: "observation", category: "fact",
    occurredAt: "", conversationId: "", runId: "", sources: [{ assetId: video.id, name: video.name, sha256: video.sha256, start: 0, end: video.size, video: frame.video,
      visual: { width: frame.width, height: frame.height, previewSha256: frame.sha256, region: { x: 0.6625, y: 0.67, width: 0.2375, height: 0.18 } } }] });
  report.assets = [video, text]; report.seededDraft = seed; await app.ready();
  const organized = await task("01-mixed-video", "请整理这段视频和文字，对照视频原件复核已有标签观察。读取前后画面，标签小字用局部读取核对；有错误就修订草稿。保存带来源和视频时间点的整理结果。视频画面不能当作文字经历的拍摄证明，所有观察保持待核对。", [video.id, text.id]);
  const repaired = store.memories.get<MemoryEntry>("memory", seed.id)!;
  report.repairedDraft = repaired;
  const reads = organized.run.parts.filter((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete");
  checks.actualTimedFrameAndCrop = reads.some((part) => part.type === "tool" && !!(part.output as { source?: { video?: unknown; view?: { region?: unknown } }; imageDelivered?: boolean }).source?.video
    && !!(part.output as { source?: { view?: { region?: unknown } } }).source?.view?.region && (part.output as { imageDelivered?: boolean }).imageDelivered === true);
  checks.autonomousVideoDraftRepair = repaired.version > seed.version && repaired.status === "draft" && repaired.editedBy === "agent" && repaired.content.includes("VN79") && !repaired.content.includes("VN78");
  checks.reviewRetainsTimedReads = store.memoryCommands.receipts(organized.run.id).some((receipt) => receipt.actor === "agent" && receipt.sourceReads?.some((read) => read.kind === "video" && read.video?.timestamp === 2.5));
  checks.backgroundVideoProcessing = used(organized.run, "process_assets") && store.db.prepare("SELECT 1 FROM memory_import_jobs WHERE json_extract(data,'$.status')='completed'").get() !== undefined;
  checks.sourcedArtifact = organized.artifacts.some((artifact) => artifact.sources.some((source) => source.assetId === video.id && source.video) && artifact.sources.some((source) => source.assetId === text.id));
  checks.videoDateStaysUnknown = store.memories.list<MemoryEntry>("memory").filter((entry) => entry.sources.some((source) => source.assetId === video.id)).every((entry) => !entry.occurredAt && entry.status === "draft");
  const confirmed = await task("02-confirm-text", "我确认档案盒交接.txt 这份文字中的档案盒交接和放置位置属实，请确认该文件的全部文字候选。视频观察继续待核对。", [text.id], organized.run.conversationId);
  checks.textConfirmed = confirmed.run.status === "completed" && store.memories.list<MemoryEntry>("memory").filter((entry) => entry.sources.some((source) => source.assetId === text.id)).every((entry) => entry.status === "confirmed");
  const built = await task("03-reviewed-delivery", "请把这份文字已经确认的档案盒交接记忆生成训练问答和独立评测题，逐题核对人物、编号、位置和日期，修订或排除错误，交付可以下载的训练文件与评测题。", [text.id]);
  const delivered = built.run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
  const delivery = delivered?.type === "tool" ? delivered.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
  checks.agentReviewedDelivery = !!delivery && used(built.run, "inspect_dataset") && used(built.run, "review_dataset");
  if (delivery) {
    report.delivery = delivery; report.samples = new DatasetLedger(store).samples(delivery.datasetId, "", 100);
    const files: Record<string, { bytes: number; sha256: string; records?: number }> = {};
    for (const file of delivery.files) {
      const result = await app.inject(file.href); if (result.statusCode !== 200) throw new Error("Actual delivered file unavailable");
      files[file.kind] = { bytes: result.rawPayload.length, sha256: hash(result.rawPayload), ...(file.kind === "manifest" ? {} : { records: result.body.trim().split("\n").filter(Boolean).length }) };
      await writeFile(join(dir, "delivered-" + file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), result.rawPayload, { mode: 0o600 });
    }
    report.files = files; checks.nonemptyHashVerifiedFiles = !!files.training?.records && !!files.evaluation?.records && delivery.files.every((file) => file.sha256 === files[file.kind].sha256);
  }
  await app.close(); store = new Store(dir); app = buildApp(config, { store }); await app.ready();
  const resumed = await task("04-recall-after-restart", "请查找视频标签编号的变化，对照原件画面核对开始和后来的编号，保存带视频时间和来源的结果。", [video.id]);
  checks.restartTimedRecall = used(resumed.run, "search_evidence") && resumed.artifacts.some((artifact) => artifact.sources.some((source) => source.assetId === video.id && source.video));
  }
  report.observations = store.memories.list<MemoryEntry>("memory"); report.completed = true;
} catch (failure) { report.failure = failure instanceof Error ? failure.message : String(failure); }
finally {
  if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }).catch(() => undefined);
  await app.close(); await save(); console.log(JSON.stringify({ report: join(dir, "report.json"), completed: report.completed, checks, failure: report.failure }));
}
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
