import {
  constants,
  existsSync,
  realpathSync,
  statSync,
  accessSync,
} from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir, hostname, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DirectoryListing } from "@memory/contracts";
import { UserFacingError } from "./harness/runtime.js";

export function isWithin(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

// These are mounts supplied by the sandbox, not project workspaces.
const systemDirectories = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/run",
];

function assertBrowsable(path: string, privatePaths: readonly string[]) {
  if (privatePaths.some((entry) => isWithin(entry, path)))
    throw new UserFacingError(
      403,
      "PRIVATE_DIRECTORY",
      "此目录用于保存应用的私人数据，请选择项目文件夹",
    );
  if (
    process.platform !== "win32" &&
    systemDirectories.some((entry) => isWithin(entry, path))
  )
    throw new UserFacingError(
      403,
      "SYSTEM_DIRECTORY",
      "请选择项目文件夹，不能使用系统目录",
    );
}

export function assertProjectDirectory(
  path: string,
  privatePaths: readonly string[],
) {
  assertBrowsable(path, privatePaths);
  if (dirname(path) === path)
    throw new UserFacingError(
      400,
      "ROOT_DIRECTORY",
      "请选择具体文件夹，不能使用整个文件系统",
    );
}

export function normalizeDirectoryInput(input: string) {
  let path = input.trim();
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1);
  if (!path || /[\0\r\n]/.test(path))
    throw new UserFacingError(
      400,
      "INVALID_DIRECTORY",
      "请输入有效的文件夹路径",
    );
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (process.platform === "linux" && /microsoft/i.test(release())) {
    const drive = /^([a-z]):[\\/](.*)$/i.exec(path);
    if (drive)
      path = `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
    const wsl = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.*)$/i.exec(path);
    if (wsl) {
      if (
        process.env.WSL_DISTRO_NAME &&
        wsl[1].toLowerCase() !== process.env.WSL_DISTRO_NAME.toLowerCase()
      )
        throw new UserFacingError(
          400,
          "OTHER_WSL_DISTRIBUTION",
          "请选择当前 Agent 所在 WSL 发行版中的目录",
        );
      path = "/" + wsl[2].replaceAll("\\", "/");
    }
  }
  if (!isAbsolute(path))
    throw new UserFacingError(
      400,
      "ABSOLUTE_DIRECTORY_REQUIRED",
      "请输入完整的文件夹路径，或使用 ~/ 开头的路径",
    );
  return resolve(path);
}

function directoryError(error: unknown): never {
  if (error instanceof UserFacingError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT")
    throw new UserFacingError(
      404,
      "DIRECTORY_NOT_FOUND",
      "文件夹不存在或所在磁盘尚未连接",
    );
  if (code === "ENOTDIR")
    throw new UserFacingError(
      400,
      "NOT_A_DIRECTORY",
      "请选择文件夹，不能选择文件",
    );
  if (code === "EACCES" || code === "EPERM")
    throw new UserFacingError(
      403,
      "DIRECTORY_ACCESS_DENIED",
      "Agent 没有读取此文件夹的权限",
    );
  throw new UserFacingError(
    400,
    "DIRECTORY_UNAVAILABLE",
    "无法打开此文件夹，请检查路径和访问权限",
  );
}

export async function resolveDirectory(input: string) {
  try {
    const path = await realpath(normalizeDirectoryInput(input));
    if (!(await stat(path)).isDirectory())
      throw new UserFacingError(
        400,
        "NOT_A_DIRECTORY",
        "请选择文件夹，不能选择文件",
      );
    await access(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (error) {
    return directoryError(error);
  }
}

export function requireExistingDirectory(path: string) {
  try {
    if (realpathSync(path) !== path || !statSync(path).isDirectory())
      throw new UserFacingError(
        409,
        "DIRECTORY_MOVED",
        "工作目录已移动或替换，请重新打开文件夹",
      );
    accessSync(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (error) {
    return directoryError(error);
  }
}

export async function browseDirectories(
  input: { path?: string; query?: string; hidden?: boolean; offset?: number },
  privatePaths: readonly string[],
  projectsPath: string,
): Promise<DirectoryListing> {
  const path = await resolveDirectory(input.path || homedir());
  assertBrowsable(path, privatePaths);
  const query = (input.query || "").toLocaleLowerCase();
  const offset = input.offset || 0;
  try {
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (input.hidden || !entry.name.startsWith(".")) &&
          entry.name.toLocaleLowerCase().includes(query),
      )
      .filter((entry) => {
        try {
          assertBrowsable(join(path, entry.name), privatePaths);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }));
    const shortcuts = [
      { name: "主目录", path: homedir() },
      { name: "项目", path: projectsPath },
      { name: "文件系统", path: resolve("/") },
    ];
    if (process.platform === "linux")
      for (const letter of "abcdefghijklmnopqrstuvwxyz")
        if (existsSync(`/mnt/${letter}`))
          shortcuts.push({
            name: `${letter.toUpperCase()}:`,
            path: `/mnt/${letter}`,
          });
    return {
      path,
      parent: dirname(path) === path ? null : dirname(path),
      entries: entries.slice(offset, offset + 100),
      total: entries.length,
      nextOffset: offset + 100 < entries.length ? offset + 100 : null,
      canOpen: dirname(path) !== path,
      shortcuts: shortcuts.filter(
        (entry, index) =>
          shortcuts.findIndex((item) => item.path === entry.path) === index &&
          existsSync(entry.path),
      ),
      host: hostname(),
    };
  } catch (error) {
    return directoryError(error);
  }
}
