// Actual local encoders and original public videos; isolated data, no external AI or training.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import type { Artifact, Asset, EvidenceHit, EvidenceRead, EvidenceSearchResult, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { contentHash } from "../src/memory/values.js";
import { prepareVideoFrame } from "../src/memory/video-source.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";

const original = readConfig();
if (!original.localProcessor) throw new Error("请先安装本地编码器和固定模型文件");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "video-index-real-"));
const agentRequested = process.argv.includes("--agent");
const provider = agentRequested ? original.providers.find((item) => item.model.name === "gpt-6-luna" && item.model.supportsImages) : undefined;
if (agentRequested && !provider) throw new Error("请先配置支持图片的 gpt-6-luna 验证模型");
const config = { ...original, providers: provider ? [provider] : [], dataDir: directory };
let store = new Store(directory), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: true, videoSampleInterval: 2 });
const checks: Record<string, boolean> = {};
const assets: Asset[] = [];
const report: Record<string, unknown> = { type: "video-index-real", at: new Date().toISOString(), checks, assets, completed: false,
  scope: "Two original public natural videos plus public-photo montages. Actual local encoders and SQLite; no captions, confirmed memories or training. Optional --agent sends only selected generated montage frames to gpt-6-luna. Natural identity remains unknown; montage assertions only test known source-image segments." };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const phase = (name: string) => console.log(JSON.stringify({ phase: name, directory }));
async function request<T>(url: string): Promise<T> {
  const result = await app.inject(url);
  if (result.statusCode !== 200) throw new Error(`${url.split("?")[0]}: ${result.statusCode} ${result.json<{ message?: string }>().message || "请求未完成"}`);
  return result.json<T>();
}
async function add(data: Buffer, name: string, mimeType = "video/mp4") {
  const asset: Asset = { id: randomUUID(), name, kind: "video", mimeType, size: data.length, sha256: contentHash(data), memorySpace: "personal", createdAt: new Date().toISOString() };
  await writeFile(join(store.assetsDir, asset.id), data, { mode: 0o600 }); store.addAsset(asset, { processing: "requested" }); assets.push(asset); return asset;
}
async function montage(folder: string, items: { file: string; sha256: string }[], label: string) {
  const frames = join(directory, label); await mkdir(frames, { mode: 0o700 });
  for (const [segment, item] of items.entries()) {
    const bytes = await readFile(join(projectRoot, ".data", folder, item.file));
    if (contentHash(bytes) !== item.sha256) throw new Error("公开图像原件摘要不一致");
    const image = await sharp(bytes).rotate().resize(1024, 1024, { fit: "contain", background: "black" }).png().toBuffer();
    for (let i = 0; i < 8; i++) await writeFile(join(frames, `frame-${String(segment * 8 + i).padStart(2, "0")}.png`), image, { mode: 0o600 });
  }
  const video = join(directory, label + ".mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-framerate", "4", "-i", join(frames, "frame-%02d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
  return add(await readFile(video), `素材对照-${assets.length + 1}.mp4`);
}
async function indexed() {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const rows = store.db.prepare("SELECT assetId,status,error FROM asset_index_jobs ORDER BY assetId").all();
    if (rows.length === assets.length && rows.every((row) => !["queued", "running"].includes(String(row.status)))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本地视频索引超时");
}
function snapshot() {
  return store.db.prepare("SELECT id,assetId,sourceHash,fingerprint,requestedTimestamp,timestamp,status,attempts,view FROM video_index_frames WHERE active=1 ORDER BY assetId,requestedTimestamp").all();
}
async function search(query: string, asset: Asset, entityId?: string) {
  const hits = await request<EvidenceSearchResult>("/api/evidence?" + new URLSearchParams({ query, kind: "video", limit: "20", ...(entityId ? { entityId } : {}) }));
  return hits.hits.filter((hit) => hit.type === "frame" && hit.assetId === asset.id);
}
function time(hit?: EvidenceHit) { const source = hit?.sources[0]; return source?.type === "asset" ? source.video?.timestamp : undefined; }
async function task(text: string, asset: Asset) {
  const conversation = store.createConversation();
  const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text, assetIds: [asset.id], scope: "selected", modelId: provider!.model.id, thinkingLevel: "low", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (result.statusCode !== 201) throw new Error("隔离 Agent 任务未创建");
  const id = result.json<{ run: Run }>().run.id, end = Date.now() + 240000;
  let run = store.work.get<Run>("run", id)!;
  while (!['completed', 'failed', 'stopped'].includes(run.status) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 300)); run = store.work.get<Run>("run", id)!;
  }
  if (!['completed', 'failed', 'stopped'].includes(run.status)) {
    await app.inject({ method: "POST", url: `/api/runs/${id}/stop` }); run = store.work.get<Run>("run", id)!;
  }
  const artifacts = store.work.list<Artifact>("artifact", conversation.id);
  return { run, artifacts };
}
try {
  const photos = JSON.parse(await readFile(join(projectRoot, "examples/photos/manifest.json"), "utf8")).photos;
  const people = JSON.parse(await readFile(join(projectRoot, "examples/people/manifest.json"), "utf8")).images;
  const videos = JSON.parse(await readFile(join(projectRoot, "examples/videos/manifest.json"), "utf8")).videos as { file: string; sha256: string }[];
  const objects = await montage("photo-fixtures", photos, "objects");
  const portraits = await montage("people-fixtures", people, "portraits");
  for (const source of videos) {
    const bytes = await readFile(join(projectRoot, ".data/video-fixtures", source.file));
    if (contentHash(bytes) !== source.sha256) throw new Error("自然视频原件摘要不一致");
    await add(bytes, `素材对照-${assets.length + 1}.ogv`, "video/ogg");
  }
  report.publicSources = { photos, people, videos }; await save();
  phase("local-index"); await app.ready();
  report.jobs = await indexed();
  report.processor = await request("/api/memory-features");
  report.frames = snapshot();
  checks.localFrameIndex = assets.every((asset) => {
    const rows = store.db.prepare("SELECT status FROM video_index_frames WHERE assetId=? AND active=1").all(asset.id);
    return rows.length > 1 && rows.every((row) => row.status === "completed");
  });
  checks.independentOfAgentAndFacts = !store.db.prepare("SELECT 1 FROM workspace_records WHERE kind IN ('memory','run')").get()
    && !store.db.prepare("SELECT 1 FROM memory_import_jobs").get();
  phase("semantic-frame-search");
  const queries = [{ query: "一杯咖啡放在杯碟上", expected: [0] }, { query: "雾中的红色悬索桥", expected: [2] }, { query: "月球表面的宇航员和旗帜", expected: [4, 5.75] }];
  const retrieval = [];
  for (const query of queries) {
    const hits = await search(query.query, objects);
    retrieval.push({ ...query, actualTimes: hits.map(time), top1: query.expected.includes(time(hits[0])!), ids: hits.map((hit) => hit.id) });
  }
  report.retrieval = retrieval; checks.montageFrameTop1 = retrieval.every((item) => item.top1);
  const links = store.db.prepare(`SELECT e.id AS entityId,e.state,e.personId,l.observationId,l.status,json_extract(o.data,'$.evidence[0].video.timestamp') AS timestamp
    FROM memory_entities e JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1 JOIN memory_observations o ON o.id=l.observationId WHERE o.assetId=? ORDER BY timestamp`).all(portraits.id);
  report.portraitAssignments = links;
  const at = (timestamp: number) => links.filter((row) => row.timestamp === timestamp);
  checks.portraitDetection = [0, 2, 4, 5.75].every((timestamp) => at(timestamp).length === 1);
  checks.repeatedPortraitAssociated = at(0)[0]?.entityId === at(2)[0]?.entityId;
  checks.differentPortraitSeparate = !!at(0)[0] && !!at(4)[0] && at(0)[0].entityId !== at(4)[0].entityId;
  checks.identitiesRemainCandidates = links.length > 0 && links.every((row) => row.state === "unknown" && row.personId === null && row.status === "candidate");
  const entityId = String(at(0)[0]?.entityId || "");
  if (entityId) {
    const hits = await search("", portraits, entityId);
    report.personFrameSearch = hits.map((hit) => ({ id: hit.id, timestamp: time(hit) }));
    checks.personFrameScope = hits.length === 2 && hits.every((hit) => [0, 2].includes(time(hit)!));
  } else checks.personFrameScope = false;
  const natural = [];
  for (const asset of assets.slice(2)) {
    const groups = store.db.prepare(`SELECT e.id,e.state,e.personId,l.status,json_extract(o.data,'$.evidence[0].video.timestamp') AS timestamp FROM memory_entities e
      JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1 JOIN memory_observations o ON o.id=l.observationId WHERE o.assetId=? ORDER BY timestamp,e.id`).all(asset.id);
    const hits = await search("两个人一起走路", asset);
    natural.push({ assetId: asset.id, detections: groups, searchTimes: hits.map(time) });
    for (const frame of store.db.prepare("SELECT id,requestedTimestamp FROM video_index_frames WHERE assetId=? AND active=1 AND status='completed'").all(asset.id)) {
      const originalFrame = await prepareVideoFrame(store.assetsDir, asset, Number(frame.requestedTimestamp));
      await writeFile(join(directory, `natural-${assets.indexOf(asset)}-${frame.requestedTimestamp}.jpg`), originalFrame.data, { mode: 0o600 });
    }
  }
  report.naturalVideos = natural;
  checks.naturalVideoCandidateSearch = natural.every((item) => item.searchTimes.length > 0 && item.detections.every((row) => row.personId === null && row.status === "candidate"));
  const target = (await search(queries[1].query, objects))[0];
  const read = await request<EvidenceRead>(`/api/evidence/${encodeURIComponent(target.id)}?version=${target.version}`);
  const preview = await app.inject(read.source!.previewUrl!);
  checks.exactFrameRead = read.source?.video?.timestamp === 2 && read.source.video.requestedTimestamp === 2 && preview.statusCode === 200 && contentHash(preview.rawPayload) === read.source.view?.sha256;
  report.read = read;
  const before = snapshot(); await app.close();
  store = new Store(directory); app = buildApp(config, { store }); await app.ready(); await indexed();
  const after = snapshot(); report.restartFrames = after;
  checks.restartKeepsCompletedFrames = JSON.stringify(before) === JSON.stringify(after);
  checks.restartSemanticSearch = time((await search(queries[1].query, objects))[0]) === 2;
  if (agentRequested) {
    phase("actual-agent-frame-lookup");
    const content = await task("这段是公开图片拼成的隔离测试视频，不代表我的经历。查找有雾的红色悬索桥和杯碟中的咖啡，核对原始画面后，保存一份简短的整理结果，引用各自实际视频时间。不要生成描述草稿或确认记忆。", objects);
    phase("actual-agent-people-lookup");
    const people = await task("这段是公开肖像拼成的隔离测试视频，不代表我的经历。检查素材人物候选，选一组在不同时间重复出现的候选，查找并核对对应的两幅原始画面，保存简短结果及时间来源。身份保持未知，不建立称呼、不确认事实。", portraits);
    report.agent = { model: provider!.model.name, content, people };
    const used = (run: Run, name: string) => run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
    const pixelTimes = (run: Run) => run.parts.flatMap((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete"
      && (part.output as { imageDelivered?: boolean }).imageDelivered ? [(part.output as EvidenceRead).source?.video?.timestamp] : []);
    checks.agentUsesContentFrameSearch = used(content.run, "search_evidence") && [0, 2].every((timestamp) => pixelTimes(content.run).includes(timestamp));
    checks.agentFindsAndReadsPeople = used(people.run, "inspect_source_people") && used(people.run, "search_evidence") && new Set(pixelTimes(people.run)).size >= 2;
    checks.agentSavesTimedSources = [content, people].every((result) => result.run.status === "completed" && result.artifacts.some((artifact) =>
      new Set(artifact.sources.filter((source) => source.video).map((source) => source.video!.timestamp)).size >= 2));
    checks.agentDoesNotCreatePersonalFacts = !store.db.prepare("SELECT 1 FROM workspace_records WHERE kind='memory'").get()
      && !store.db.prepare("SELECT 1 FROM memory_entities WHERE personId IS NOT NULL").get();
    await save();
  }
  phase("nonempty-restore"); await app.close();
  const archive = join(root, basename(directory) + "-archive");
  report.archive = await backupMemory(directory, archive);
  const restored = join(root, basename(directory) + "-restored"); report.restore = await restoreMemory(archive, restored);
  report.archiveDirectory = archive; report.restoredDirectory = restored;
  store = new Store(restored); app = buildApp({ ...config, dataDir: restored }, { store }); await app.ready(); await indexed();
  checks.restoreFramesAndCandidates = JSON.stringify(snapshot()) === JSON.stringify(after) && store.memories.ledger.graph.entityPage("personal").total > 0;
  checks.restoreSemanticSearch = time((await search(queries[1].query, objects))[0]) === 2;
  checks.restoreExactBytes = (await request<EvidenceRead>(`/api/evidence/${encodeURIComponent(target.id)}?version=${target.version}`)).source?.view?.sha256 === read.source?.view?.sha256;
  report.completed = true;
} catch (failure) { report.failure = failure instanceof Error ? failure.message : String(failure); }
finally { await app.close().catch(() => undefined); await save(); console.log(JSON.stringify({ report: join(directory, "report.json"), completed: report.completed, checks, failure: report.failure })); }
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
