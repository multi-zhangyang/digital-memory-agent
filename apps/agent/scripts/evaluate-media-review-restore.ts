// Validate completed, non-empty real-evaluation data without a model or a live user database.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { projectRoot } from "../src/config.js";
import { Store } from "../src/store.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { DatasetService } from "../src/memory/dataset-service.js";
import { EvidenceService } from "../src/memory/evidence-service.js";

if (!process.argv[2]) throw new Error("请提供已结束的媒体复核评测目录；只写入新的恢复验证目录");
const source = resolve(process.argv[2]);
const evaluation = JSON.parse(await readFile(join(source, "report.json"), "utf8"));
if (!["media-review-live", "video-memory-live"].includes(evaluation.type) || !evaluation.runs?.length || !evaluation.delivery?.datasetId)
  throw new Error("需要包含真实任务、修订回执及实际数据集交付的评测记录");
const root = join(projectRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "media-review-restore-"));
const restored = join(directory, "restored"), hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const tables = ["workspace_records", "workspace_versions", "run_events", "conversations", "assets", "memory_commands", "memory_command_versions",
  "run_record_refs", "memory_session_epochs", "memory_suppressions", "memory_observations", "memory_observation_links", "memory_entities",
  "memory_entity_links", "memory_events", "memory_event_links", "memory_graph_versions", "memory_datasets", "dataset_inputs", "dataset_input_dependencies",
  "dataset_samples", "dataset_sample_versions", "dataset_sample_dependencies", "dataset_review_commands", "dataset_sample_views", "memory_model_versions", "memory_import_jobs", "memory_extractions"];
function snapshot(path: string) {
  const db = new DatabaseSync(join(path, "memory.sqlite"), { readOnly: true, allowExtension: true });
  sqliteVec.load(db); db.enableLoadExtension(false);
  try {
    const active = db.prepare("SELECT 1 FROM workspace_records WHERE kind='run' AND json_extract(data,'$.status') IN ('queued','running','waiting') LIMIT 1").get();
    if (active) throw new Error("仍有活动任务，不能把活动目录作为一致性恢复基线");
    return { healthy: db.prepare("PRAGMA integrity_check").get()!.integrity_check === "ok" && !db.prepare("PRAGMA foreign_key_check").get(),
      tables: Object.fromEntries(tables.filter((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
        .map((name) => [name, { count: Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n),
          sha256: hash(JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all().map((row) => JSON.stringify(row)).sort())) }])) };
  } finally { db.close(); }
}
const baseline = snapshot(source), checks: Record<string, boolean> = {};
const report = { type: "media-review-restore", createdAt: new Date().toISOString(), evaluation: source.split("/").at(-1),
  counts: Object.fromEntries(Object.entries(baseline.tables).map(([name, value]) => [name, value.count])), checks, externalCalls: 0,
  completed: false, limitations: "验证实际资料与来源链恢复，不衡量模型内容质量；恢复后项目目录及权限按归档规则重新绑定。" };
let store: Store | undefined, datasets: DatasetService | undefined;
try {
  const archive = await backupMemory(source, join(directory, "archive"));
  const recovery = await restoreMemory(join(directory, "archive"), restored);
  checks.nonemptyBaseline = baseline.tables.workspace_records.count > 0 && baseline.tables.memory_commands.count > 0 && baseline.tables.dataset_samples.count > 0;
  checks.archiveAndRestore = archive.files > 1 && recovery.databaseIntegrity === "ok" && !recovery.credentialsRestored && !recovery.trainingStarted;
  const recoverySnapshot = snapshot(restored);
  checks.databaseHealthy = baseline.healthy && recoverySnapshot.healthy;
  checks.recordsVersionsAndEvidencePreserved = tables.every((name) => !baseline.tables[name] || baseline.tables[name].sha256 === recoverySnapshot.tables[name]?.sha256);
  store = new Store(restored);
  const beforeRebuild = snapshot(restored);
  store.memories.ledger.rebuild(); store.memories.ledger.rebuild();
  const afterRebuild = snapshot(restored);
  checks.rebuildPreservesHistory = tables.every((name) => !beforeRebuild.tables[name] || beforeRebuild.tables[name].sha256 === afterRebuild.tables[name]?.sha256);
  const refs = store.db.prepare("SELECT * FROM run_record_refs ORDER BY runId,kind,ordinal").all() as { runId: string; kind: "memory" | "sample"; ordinal: number; recordId: string; version: number }[];
  checks.shortRefsResolveAfterRestart = refs.length > 0 && refs.every((ref) => {
    const resolved = store!.work.resolveRecordRef(ref.runId, ref.kind, { ref: (ref.kind === "memory" ? "m" : "s") + ref.ordinal });
    return resolved.id === ref.recordId && resolved.version === ref.version;
  });
  checks.actualOriginalsAndSessionsPreserved = true;
  for (const line of (await readFile(join(directory, "archive/files.jsonl"), "utf8")).trim().split("\n")) {
    const file = JSON.parse(line);
    if (file.path.startsWith("assets/") || file.path.startsWith("sessions/"))
      checks.actualOriginalsAndSessionsPreserved &&= hash(await readFile(join(restored, file.path))) === file.sha256;
  }
  const evidence = new EvidenceService(store);
  const text = store.assets("personal").find((asset) => asset.name === (evaluation.type === "video-memory-live" ? "档案盒交接.txt" : "相册交接.txt"))!;
  const read = await evidence.read("asset:" + text.id, {}, { version: text.sha256, limit: 8000 });
  if (evaluation.type === "video-memory-live") {
    checks.originalAndCurrentCorrectionRemainDistinct = !!read.source?.text?.includes("完全虚构") &&
      !!read.memoryContext?.memories.some((memory) => memory.content.includes("VN79") && memory.editedBy === "user" && !memory.uncertainty);
    const video = store.assets("personal").find((asset) => asset.kind === "video")!;
    const frame = await evidence.read("asset:" + video.id, {}, { timestamp: 2.5, image: true });
    checks.videoFrameTimeAndPixelHash = frame.source?.video?.timestamp === 2.5 && !!frame.image &&
      hash(frame.image) === hash(await readFile(join(source, "original-frame-2.5.jpg")));
  } else checks.originalAndCurrentCorrectionRemainDistinct = !!read.source?.text?.includes("QB47") &&
      !!read.memoryContext?.memories.some((memory) => memory.content.includes("QB49") && memory.editedBy === "user") &&
      !read.memoryContext?.memories.some((memory) => memory.content.includes("QB47"));
  datasets = new DatasetService(store, () => { throw new Error("恢复验证不得调用模型"); });
  const delivered = await datasets.delivery(evaluation.delivery.datasetId);
  checks.actualDownloadsStillVerified = delivered.verified && delivered.files.every((file) => file.sha256 === evaluation.files[file.kind]?.sha256);
  for (const file of delivered.files) {
    const download = await datasets.download(evaluation.delivery.datasetId, file.kind as "training" | "evaluation" | "review" | "manifest");
    const digest = createHash("sha256"); for await (const chunk of download.stream) digest.update(chunk);
    checks.actualDownloadsStillVerified &&= digest.digest("hex") === file.sha256;
  }
  checks.noTraining = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
  report.completed = Object.values(checks).every(Boolean);
} catch (error) {
  Object.assign(report, { error: error instanceof Error ? error.message : "恢复验证失败" });
} finally {
  if (datasets) await datasets.close(); if (store?.db.isOpen) store.close();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath: join(directory, "report.json") }));
}
if (!report.completed) process.exitCode = 1;
