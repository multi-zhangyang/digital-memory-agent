import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { FileChange, FileRevision, ProjectFile } from "@memory/contracts";
import { UserFacingError } from "./harness/runtime.js";
import { isWithin } from "./local-directories.js";

const excluded = new Set([
  ".git",
  "node_modules",
  ".next",
  ".digital-memory",
  ".venv",
  "__pycache__",
]);
export async function safePath(
  root: string,
  path: string,
  missing = false,
  privatePaths: readonly string[] = [],
) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new UserFacingError(
      403,
      "OUTSIDE_PROJECT",
      "只能访问当前项目内的文件",
    );
  if (privatePaths.some((entry) => isWithin(entry, target)))
    throw new UserFacingError(
      403,
      "PRIVATE_PATH",
      "此路径属于应用私人数据，不在项目访问范围内",
    );
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new UserFacingError(403, "SYMLINK", "不允许通过符号链接访问文件");
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw error;
    }
  }
  if ((await realpath(root)) !== resolve(root))
    throw new Error("项目根目录不能是符号链接");
  return target;
}
export async function readProjectFile(
  root: string,
  path: string,
  maxSize = 10 * 1024 * 1024,
  privatePaths: readonly string[] = [],
) {
  const target = await safePath(root, path, false, privatePaths);
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await file.stat();
    if (!s.isFile() || s.size > maxSize)
      throw new UserFacingError(413, "FILE_LIMIT", "文件过大或不是普通文件");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
export async function writeProjectFile(
  root: string,
  path: string,
  content: string | Buffer,
  privatePaths: readonly string[] = [],
) {
  if (Buffer.byteLength(content) > 10 * 1024 * 1024)
    throw new UserFacingError(413, "FILE_LIMIT", "文件不能超过 10 MB");
  const target = await safePath(root, path, true, privatePaths);
  const parent = resolve(target, "..");
  await mkdir(parent, { recursive: true });
  await safePath(root, path, true, privatePaths);
  const file = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
export async function listProjectFiles(
  root: string,
  privatePaths: readonly string[] = [],
): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const walk = async (dir: string) => {
    await safePath(root, dir, false, privatePaths);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        privatePaths.some((path) => isWithin(path, join(dir, entry.name))) ||
        excluded.has(entry.name) ||
        (!entry.isFile() && !entry.isDirectory())
      )
        continue;
      if (files.length >= 5000)
        throw new UserFacingError(
          413,
          "PROJECT_LIMIT",
          "项目文件超过 5000 个，请缩小工作目录",
        );
      const path = join(dir, entry.name),
        info = await stat(path);
      files.push({
        path: relative(root, path),
        size: info.size,
        directory: entry.isDirectory(),
        modifiedAt: info.mtime.toISOString(),
      });
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return files.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
  );
}
export const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function revision(path: string, bytes: Buffer): FileRevision {
  return {
    path,
    hash: hash(bytes),
    size: bytes.length,
    content:
      bytes.length <= 512 * 1024 && !bytes.includes(0)
        ? bytes.toString("utf8")
        : null,
  };
}
export async function snapshot(
  root: string,
  directory: string,
  privatePaths: readonly string[] = [],
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const revisions: Record<string, FileRevision> = {};
  let size = 0;
  for (const file of await listProjectFiles(root, privatePaths)) {
    if (file.directory) continue;
    const bytes = await readProjectFile(
      root,
      file.path,
      undefined,
      privatePaths,
    );
    size += bytes.length;
    if (size > 64 * 1024 * 1024)
      throw new UserFacingError(
        413,
        "CHECKPOINT_LIMIT",
        "项目可回退文件总量不能超过 64 MB",
      );
    const rev = revision(file.path, bytes);
    revisions[file.path] = rev;
    await writeFile(join(directory, rev.hash), bytes, { mode: 0o600 });
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(revisions), {
    mode: 0o600,
  });
  return revisions;
}
export async function changesSince(
  root: string,
  directory: string,
  privatePaths: readonly string[] = [],
): Promise<FileChange[]> {
  const before = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as Record<string, FileRevision>;
  const after: Record<string, FileRevision> = {};
  for (const file of await listProjectFiles(root, privatePaths))
    if (!file.directory)
      after[file.path] = revision(
        file.path,
        await readProjectFile(root, file.path, undefined, privatePaths),
      );
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path]?.hash !== after[path]?.hash)
    .map((path) => ({
      path,
      before: before[path] || null,
      after: after[path] || null,
      status: !before[path] ? "added" : !after[path] ? "deleted" : "modified",
    }));
}
export async function revertChange(
  root: string,
  directory: string,
  change: FileChange,
  privatePaths: readonly string[] = [],
) {
  let current: Buffer | undefined;
  try {
    current = await readProjectFile(root, change.path, undefined, privatePaths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((current ? hash(current) : null) !== (change.after?.hash || null))
    throw new UserFacingError(
      409,
      "FILE_CHANGED",
      "文件已有后续修改，请刷新后检查",
    );
  if (change.before)
    await writeProjectFile(
      root,
      change.path,
      await readFile(join(directory, change.before.hash)),
      privatePaths,
    );
  else await rm(await safePath(root, change.path, false, privatePaths));
}
