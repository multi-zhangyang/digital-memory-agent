import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWithin } from "./local-directories.js";
let available: boolean | undefined;
export function sandboxAvailable() {
  if (available === undefined) {
    const probe = spawnSync(
      "bwrap",
      [
        "--unshare-all",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "/usr/bin/true",
      ],
      { timeout: 4000, stdio: "ignore" },
    );
    available = probe.status === 0;
  }
  return available;
}
export function sandboxArguments(
  root: string,
  command: string[],
  network = false,
  readOnly = false,
  privatePaths: readonly string[] = [],
) {
  if (!sandboxAvailable())
    throw new Error("隔离执行环境不可用，请安装并启用 bubblewrap");
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
  ];
  if (network) args.push("--share-net");
  for (const path of ["/usr", "/bin", "/lib", "/lib64"])
    if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
  );
  for (const path of [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/ssl",
    "/etc/ca-certificates",
  ])
    if (existsSync(path)) args.push("--ro-bind", path, path);
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  if (!nodeRoot.startsWith("/usr")) args.push("--ro-bind", nodeRoot, nodeRoot);
  args.push(
    readOnly ? "--ro-bind" : "--bind",
    root,
    root,
    "--chdir",
    root,
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "PATH",
    join(nodeRoot, "bin") + ":/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "TMPDIR",
    "/tmp",
  );
  // Hide application data when its containing repository is the selected project.
  for (const path of privatePaths) {
    if (!isWithin(root, path) || path === root || !existsSync(path)) continue;
    if (statSync(path).isDirectory())
      args.push("--tmpfs", path, "--remount-ro", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  return [...args, ...command];
}
export function executeSandbox(
  root: string,
  command: string,
  onData: (data: Buffer) => void,
  signal?: AbortSignal,
  timeout = 120,
  network = false,
  privatePaths: readonly string[] = [],
) {
  signal?.throwIfAborted();
  return new Promise<{ exitCode: number }>((resolve, reject) => {
    const child = spawn(
      "bwrap",
      sandboxArguments(
        root,
        ["/bin/bash", "--noprofile", "--norc", "-c", command],
        network,
        false,
        privatePaths,
      ),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
        detached: true,
      },
    );
    let killed = false;
    const kill = () => {
      killed = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, Math.max(1, Math.min(timeout, 600)) * 1000);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    let emitted = 0;
    let truncated = false;
    const output = (chunk: Buffer) => {
      if (emitted < 1024 * 1024) {
        onData(chunk.subarray(0, 1024 * 1024 - emitted));
        emitted += chunk.length;
      }
      if (emitted >= 1024 * 1024 && !truncated) {
        truncated = true;
        onData(
          Buffer.from(
            "\n[输出已达到 1 MB 限制；请将完整输出重定向到项目文件]\n",
          ),
        );
      }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (killed)
        onData(
          Buffer.from(signal?.aborted ? "\n执行已停止\n" : "\n执行超时\n"),
        );
      resolve({ exitCode: code ?? 137 });
    });
  });
}
