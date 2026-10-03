import type { ApiError } from "@memory/contracts";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, { ...init, headers: { ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
  } catch { throw new Error("暂时无法连接本地服务，请检查服务是否已启动。"); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    throw new Error(body?.error?.message || "请求未完成，请稍后重试。");
  }
  return response.json() as Promise<T>;
}

export const assetUrl = (id: string, download = false) => "/api/assets/" + encodeURIComponent(id) + "/content" + (download ? "?download=1" : "");
export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

export function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}
