import type { ApiError } from "@memory/contracts";

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function responseFor(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch("/api" + path, { ...init, headers: { ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
  } catch { throw new Error("暂时无法连接本地服务，请检查服务是否已启动。"); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    throw new ApiRequestError(body?.error?.message || "请求未完成，请稍后重试。", response.status, body?.error?.code);
  }
  return response;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> { return (await responseFor(path, init)).json() as Promise<T>; }
export async function apiFile(path: string): Promise<Blob> { return (await responseFor(path)).blob(); }

export async function downloadFile(path: string, filename: string, expectedHash?: string) {
  const blob = await apiFile(path);
  if (expectedHash) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== expectedHash) throw new Error("文件已更新，需要重新核验交付");
  }
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const assetUrl = (id: string, download = false) => "/api/assets/" + encodeURIComponent(id) + "/content" + (download ? "?download=1" : "");

// Only server-issued dataset download routes are usable as local Markdown links.
export const datasetDownloadUrl = (href?: string) =>
  href && /^\/api\/memory-datasets\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/files\/(?:training|evaluation|review|manifest)$/.test(href) ? href : undefined;

export function evidencePreviewUrl(href?: string) {
  if (!href?.startsWith("/api/evidence/")) return undefined;
  try {
    const url = new URL(href, "http://digital-memory.invalid");
    if (url.hash || !/^\/api\/evidence\/(?:asset|frame)(?::|%3A)[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/preview$/i.test(url.pathname)) return undefined;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((key) => !["version", "view", "timestamp", "x", "y", "width", "height"].includes(key))) return undefined;
    if (!["version", "view"].every((key) => /^[\da-f]{64}$/.test(url.searchParams.get(key) || ""))) return undefined;
    const region = ["x", "y", "width", "height"].filter((key) => url.searchParams.has(key));
    if (region.length && (region.length !== 4 || region.some((key) => !Number.isFinite(Number(url.searchParams.get(key)))))) return undefined;
    if (url.searchParams.has("timestamp") && (!Number.isFinite(Number(url.searchParams.get("timestamp"))) || Number(url.searchParams.get("timestamp")) < 0)) return undefined;
    return url.pathname + url.search;
  } catch { return undefined; }
}
export function videoTime(seconds: number) {
  const milliseconds = Math.round(seconds * 1000), whole = Math.floor(milliseconds / 1000), hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60;
  const clock = [hours ? String(hours) : undefined, String(minutes).padStart(2, "0"), String(whole % 60).padStart(2, "0")].filter(Boolean).join(":");
  return clock + (milliseconds % 1000 ? "." + (milliseconds % 1000).toString().padStart(3, "0") : "");
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

export function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}
