// Read a stopped/consistent baseline, exercise only an isolated copy, and never connect a model.
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { projectRoot, readConfig } from "../src/config.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";

if (!process.argv[2]) throw new Error("请提供已停止服务或一致性备份的数据目录；验证只写入新建的隔离目录");
const source = resolve(process.argv[2]);
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "harness-migration-"));
const instance = join(directory, "instance");
await cp(source, instance, { recursive: true, force: false, errorOnExist: true });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function snapshot(path: string) {
  const db = new DatabaseSync(join(path, "memory.sqlite"), { readOnly: true, allowExtension: true });
  sqliteVec.load(db); db.enableLoadExtension(false);
  try {
    const query = (table: string, sql: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table) ? db.prepare(sql).all() : [];
    const domain = Object.fromEntries([
      "memory_people", "memory_suppressions", "memory_observations", "memory_observation_links", "memory_entities", "memory_entity_links",
      "memory_events", "memory_event_links", "memory_graph_versions", "memory_datasets", "dataset_inputs", "dataset_samples",
      "dataset_sample_versions", "dataset_input_dependencies", "dataset_sample_dependencies", "dataset_invalidations", "memory_model_versions", "model_dataset_links",
      "dataset_audits", "dataset_audit_inputs", "dataset_audit_views", "dataset_review_commands",
    ].filter((table) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)).map((table) =>
      [table, hash(JSON.stringify(query(table, `SELECT * FROM ${table}`).map((row) => JSON.stringify(row)).sort()))]));
    return {
      domain,
      ids: query("workspace_records", "SELECT id,kind FROM workspace_records ORDER BY id"),
      memories: hash(JSON.stringify(query("workspace_records", "SELECT id,data FROM workspace_records WHERE kind='memory' ORDER BY id"))),
      versions: hash(JSON.stringify(query("workspace_versions", "SELECT * FROM workspace_versions ORDER BY id,version"))),
      assets: query("assets", "SELECT * FROM assets ORDER BY id"),
      conversations: query("conversations", "SELECT id FROM conversations ORDER BY id"),
      intakeCount: Number(query("asset_intake", "SELECT count(*) AS n FROM asset_intake")[0]?.n || 0),
      uploadEvents: Number(query("domain_events", "SELECT count(*) AS n FROM domain_events WHERE topic='asset.added'")[0]?.n || 0),
      counts: { records: query("workspace_records", "SELECT count(*) AS n FROM workspace_records")[0]?.n || 0,
        memories: query("workspace_records", "SELECT count(*) AS n FROM workspace_records WHERE kind='memory'")[0]?.n || 0,
        versions: query("workspace_versions", "SELECT count(*) AS n FROM workspace_versions")[0]?.n || 0,
        datasets: query("memory_datasets", "SELECT count(*) AS n FROM memory_datasets")[0]?.n || 0,
        samples: query("dataset_samples", "SELECT count(*) AS n FROM dataset_samples")[0]?.n || 0 },
      healthy: db.prepare("PRAGMA integrity_check").get()!.integrity_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0,
    };
  } finally { db.close(); }
}
async function files(path: string, names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    try { result[name] = hash(await readFile(join(path, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
const baseline = snapshot(instance);
const sessions = (await readdir(join(instance, "sessions"))).filter((name) => name.endsWith(".jsonl")).map((name) => "sessions/" + name);
const privateNames = ["settings.json", "harness.json"];
const beforeFiles = await files(instance, [...sessions, ...privateNames]);
const config = { ...readConfig({ MEMORY_DATA_DIR: instance, MEMORY_LOCAL_FEATURES: "off" }), providers: [] };
const store = new Store(instance);
const app = buildApp(config, { store });
const checks: Record<string, boolean> = {};
const report = { type: "harness-migration", createdAt: new Date().toISOString(), source: "private consistent baseline",
  counts: baseline.counts, checks, completed: false, externalCalls: 0 };
try {
  await app.ready();
  await store.events.flush();
  checks.noInventedIntake = Number(store.db.prepare("SELECT count(*) AS n FROM asset_intake").get()!.n) === baseline.intakeCount;
  checks.noInventedUploadEvents = Number(store.db.prepare("SELECT count(*) AS n FROM domain_events WHERE topic='asset.added'").get()!.n) === baseline.uploadEvents;
  checks.compatibleHistory = (await app.inject("/api/conversations")).statusCode === 200;
  checks.jobsAvailable = (await app.inject("/api/jobs")).statusCode === 200;
  store.memories.ledger.rebuild();
  store.memories.ledger.rebuild();
} finally { await app.close(); }
const migrated = snapshot(instance);
checks.recordIdsPreserved = JSON.stringify(migrated.ids) === JSON.stringify(baseline.ids);
checks.memoriesAndVersionsPreserved = migrated.memories === baseline.memories && migrated.versions === baseline.versions;
checks.datasetsAndGraphPreserved = Object.entries(baseline.domain).every(([table, digest]) => migrated.domain[table] === digest);
checks.assetsPreserved = JSON.stringify(migrated.assets) === JSON.stringify(baseline.assets);
checks.conversationsPreserved = JSON.stringify(migrated.conversations) === JSON.stringify(baseline.conversations);
checks.sessionsAndPrivateSettingsPreserved = JSON.stringify(await files(instance, [...sessions, ...privateNames])) === JSON.stringify(beforeFiles);
checks.migratedDatabaseHealthy = migrated.healthy;
await backupMemory(instance, join(directory, "archive"));
await restoreMemory(join(directory, "archive"), join(directory, "restored"));
const restored = snapshot(join(directory, "restored"));
checks.restoredDatabaseHealthy = restored.healthy;
checks.restoredRecordsAndVersions = JSON.stringify(restored.ids) === JSON.stringify(baseline.ids) && restored.memories === baseline.memories && restored.versions === baseline.versions;
checks.restoredDomainData = Object.entries(baseline.domain).every(([table, digest]) => restored.domain[table] === digest);
checks.restoredAssetsAndSessions = JSON.stringify(restored.assets) === JSON.stringify(baseline.assets)
  && JSON.stringify(await files(join(directory, "restored"), sessions)) === JSON.stringify(await files(instance, sessions));
report.completed = Object.values(checks).every(Boolean);
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath: join(directory, "report.json") }));
if (!report.completed) process.exitCode = 1;
