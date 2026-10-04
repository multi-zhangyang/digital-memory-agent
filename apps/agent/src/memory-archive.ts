import { DatabaseSync } from "node:sqlite";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import * as sqliteVec from "sqlite-vec";
import type { MemoryDataset } from "@memory/contracts";
import { UserFacingError } from "./harness/runtime.js";

type FileRecord = { path: string; sha256: string; bytes: number };
const version = 1;
const allowedPath = /^(?:memory\.sqlite|assets\/[0-9a-f-]{36}|sessions\/[0-9a-f-]{36}\.jsonl|datasets\/[0-9a-f-]{36}\/(?:training\.jsonl|evaluation\.jsonl|review\.jsonl|manifest\.json))$/;
function database(path: string) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: true }); sqliteVec.load(db); db.enableLoadExtension(false); return db;
}
async function absent(path: string) {
  try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new UserFacingError(409, "DESTINATION_EXISTS", "目标目录已存在，请使用新目录");
}
async function copyVerified(source: string, target: string, expected?: Pick<FileRecord, "sha256" | "bytes">) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const output = await open(target, "wx", 0o600);
  let bytes = 0; const hash = createHash("sha256");
  try {
    const before = await input.stat(); if (!before.isFile()) throw new Error("invalid source");
    for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      const buffer = chunk as Buffer; hash.update(buffer); bytes += buffer.length; await output.writeFile(buffer);
    }
    const after = await input.stat();
    const sha256 = hash.digest("hex");
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== before.size
      || (expected && (expected.bytes !== bytes || expected.sha256 !== sha256)))
      throw new UserFacingError(409, "ARCHIVE_SOURCE_CHANGED", "备份文件已改变或校验不一致");
    await output.sync(); return { bytes, sha256 };
  } finally { await input.close(); await output.close(); }
}
async function hashFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const hash = createHash("sha256"); let bytes = 0;
  try { for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += (chunk as Buffer).length; } }
  finally { await file.close(); }
  return { sha256: hash.digest("hex"), bytes };
}

/** Consistent memory archive; credentials, model caches and project working trees are intentionally separate. */
export async function backupMemory(dataDir: string, destination: string) {
  dataDir = resolve(dataDir); destination = resolve(destination);
  const relation = relative(dataDir, destination);
  if (relation !== ".." && !relation.startsWith(".." + sep)) throw new UserFacingError(400, "ARCHIVE_LOCATION", "备份目录应位于运行资料目录之外");
  await absent(destination); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(destination), ".memory-backup-"));
  const source = database(join(dataDir, "memory.sqlite"));
  let snapshot: DatabaseSync | undefined;
  try {
    const dataVersion = () => Number(source.prepare("PRAGMA data_version").get()!.data_version);
    const initial = dataVersion();
    source.prepare("VACUUM INTO ?").run(join(temporary, "memory.sqlite"));
    snapshot = database(join(temporary, "memory.sqlite"));
    const entries = await open(join(temporary, "files.jsonl"), "wx", 0o600);
    let files = 0, bytes = 0;
    const record = async (entry: FileRecord) => { await entries.writeFile(JSON.stringify(entry) + "\n"); files++; bytes += entry.bytes; };
    try {
      await record({ path: "memory.sqlite", ...await hashFile(join(temporary, "memory.sqlite")) });
      for (const raw of snapshot.prepare("SELECT id,sha256,size FROM assets ORDER BY id").iterate()) {
        const asset = raw as { id: string; sha256: string; size: number }; const path = "assets/" + asset.id;
        if (!allowedPath.test(path)) throw new Error("invalid asset id");
        await record({ path, ...await copyVerified(join(dataDir, path), join(temporary, path), { sha256: asset.sha256, bytes: asset.size }) });
      }
      for (const raw of snapshot.prepare("SELECT id FROM conversations ORDER BY id").iterate()) {
        const path = "sessions/" + raw.id + ".jsonl";
        if (!allowedPath.test(path)) throw new Error("invalid conversation id");
        try { await stat(join(dataDir, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        await record({ path, ...await copyVerified(join(dataDir, path), join(temporary, path)) });
      }
      if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_datasets'").get()) {
        for (const row of snapshot.prepare("SELECT id,data FROM memory_datasets WHERE status='completed'").iterate()) {
          const data = JSON.parse(row.data as string) as MemoryDataset;
          for (const [kind, expected] of Object.entries(data.files || {})) {
            const path = `datasets/${row.id}/${kind === "manifest" ? "manifest.json" : kind + ".jsonl"}`;
            if (!allowedPath.test(path)) throw new Error("invalid export path");
            await record({ path, ...await copyVerified(join(dataDir, path), join(temporary, path), expected) });
          }
        }
      }
      await entries.sync();
    } finally { await entries.close(); }
    if (dataVersion() !== initial) throw new UserFacingError(409, "ARCHIVE_BUSY", "备份期间仍有数据写入，请停止服务后重试");
    const result = { format: "digital-memory-archive", version, createdAt: new Date().toISOString(), files, bytes,
      manifest: await hashFile(join(temporary, "files.jsonl")), scope: ["database", "assets", "datasets", "sessions"],
      excluded: ["provider-credentials", "harness-settings-and-secrets", "model-cache", "project-working-trees", "training-weights"] };
    const header = await open(join(temporary, "archive.json"), "wx", 0o600);
    try { await header.writeFile(JSON.stringify(result, null, 2) + "\n"); await header.sync(); } finally { await header.close(); }
    snapshot.close(); snapshot = undefined; source.close();
    await absent(destination); await rename(temporary, destination); return result;
  } catch (error) { if (snapshot?.isOpen) snapshot.close(); if (source.isOpen) source.close(); await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function restoreMemory(archive: string, destination: string) {
  archive = resolve(archive); destination = resolve(destination);
  await absent(destination);
  const header = JSON.parse(await readFile(join(archive, "archive.json"), "utf8")) as { format: string; version: number; files: number; manifest: { sha256: string; bytes: number } };
  const manifest = await hashFile(join(archive, "files.jsonl"));
  if (header.format !== "digital-memory-archive" || header.version !== version || manifest.sha256 !== header.manifest.sha256 || manifest.bytes !== header.manifest.bytes)
    throw new UserFacingError(422, "INVALID_ARCHIVE", "备份清单校验失败");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(destination), ".memory-restore-"));
  let count = 0;
  try {
    const lines = createInterface({ input: createReadStream(join(archive, "files.jsonl")), crlfDelay: Infinity });
    for await (const line of lines) {
      const file = JSON.parse(line) as FileRecord;
      if (!allowedPath.test(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
        throw new UserFacingError(422, "INVALID_ARCHIVE", "备份条目无效");
      await copyVerified(join(archive, file.path), join(temporary, file.path), file); count++;
    }
    if (count !== header.files) throw new UserFacingError(422, "INVALID_ARCHIVE", "备份文件数量不一致");
    const db = database(join(temporary, "memory.sqlite"));
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get())
        throw new UserFacingError(422, "INVALID_ARCHIVE", "恢复数据库校验失败");
    } finally { db.close(); }
    // A memory archive does not contain project working trees. Restoring it must not silently
    // reconnect executable projects to directories belonging to the original instance.
    const bindings = new DatabaseSync(join(temporary, "memory.sqlite"));
    let projectsReset = 0;
    try {
      if (bindings.prepare("SELECT 1 FROM sqlite_master WHERE name='harness_records'").get()) {
        const rows = bindings.prepare("SELECT id,data FROM harness_records WHERE kind='project'").all();
        for (const row of rows) {
          const project = JSON.parse(row.data as string);
          project.directory = row.id === "default" ? join(destination, "workspace") : join(destination, "projects", String(row.id), "workspace");
          project.directoryKind = "managed"; project.permissionMode = "read"; project.network = false;
          bindings.prepare("UPDATE harness_records SET data=? WHERE id=?").run(JSON.stringify(project), row.id); projectsReset++;
        }
      }
    } finally { bindings.close(); }
    await absent(destination); await rename(temporary, destination);
    return { restored: true, files: count, databaseIntegrity: "ok", projectsReset, credentialsRestored: false, trainingStarted: false };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
