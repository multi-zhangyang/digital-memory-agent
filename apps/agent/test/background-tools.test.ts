import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sharp from "sharp";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Asset, MemoryEntry, Run } from "@memory/contracts";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { MemoryProcessors } from "../src/memory-processors.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor<T>(read: () => T | Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) { const value = await read(); if (check(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Background task did not settle");
}
type Message = { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] };
type Request = { messages: Message[] };

async function fixture(options: { automatic?: boolean; duplicate?: boolean; fail?: boolean; ignoreAbort?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "background-tools-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const requests: Request[] = [];
  let selected: string[] = [];
  let requested: string[] | undefined;
  const supplier = Fastify();
  supplier.post<{ Body: Request }>("/v1/chat/completions", async (request, reply) => {
    requests.push(request.body);
    const messages = request.body.messages;
    const hasCall = (name: string) => messages.some((message) => message.tool_calls?.some((call) => call.function.name === name));
    const notified = JSON.stringify(messages).includes("后台作业返回的数据");
    const call = (name: string, args: unknown, index = 0) => ({ index, id: `${name}-${requests.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    let delta: unknown;
    let finish = "stop";
    if (!hasCall("process_assets")) {
      const args = { assetIds: requested || selected, title: "整理这批资料" };
      delta = { tool_calls: [call("process_assets", args), ...(options.duplicate ? [call("process_assets", args, 1)] : [])] };
      finish = "tool_calls";
    } else if (notified && !hasCall("write_artifact") && !options.fail) {
      delta = { tool_calls: [call("write_artifact", { title: "资料整理结果", content: "提取到一条测试观察，等待核对。", sourceAssetIds: selected })] };
      finish = "tool_calls";
    } else delta = { content: notified ? (options.fail ? "处理失败，已保留失败状态。" : "资料整理结果已保存，观察仍待核对。") : "处理任务已受理，等待后台结果。" };
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (value: unknown, reason: string | null) => "data: " + JSON.stringify({ id: "background-fixture", object: "chat.completion.chunk", created: 1,
      model: "background-test", choices: [{ index: 0, delta: value, finish_reason: reason }], usage: { prompt_tokens: 180, completion_tokens: 80, total_tokens: 260 } }) + "\n\n";
    reply.raw.end(frame(delta, null) + frame({}, finish) + "data: [DONE]\n\n");
  });
  const url = await supplier.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => supplier.close());
  const config = readConfig({ MEMORY_DATA_DIR: dataDir, MEMORY_OPENAI_BASE_URL: url + "/v1", MEMORY_OPENAI_API_KEY: "background-fixture-secret",
    MEMORY_OPENAI_MODEL: "background-test", MEMORY_OPENAI_VISION: "true" });
  let blocked = true;
  let processorCalls = 0;
  const processorModelIds: string[] = [];
  const releases = new Set<() => void>();
  const processors: MemoryProcessors = {
    extractMemories: async () => ({ entries: [], usage: { input: 1, output: 1 } }),
    extractPhotoMemories: async (input, signal) => {
      processorCalls++;
      processorModelIds.push(input.modelId);
      if (blocked) await new Promise<void>((resolve, reject) => {
        const release = () => { releases.delete(release); resolve(); };
        releases.add(release);
        if (!options.ignoreAbort) signal.addEventListener("abort", () => { releases.delete(release); reject(new Error("aborted")); }, { once: true });
      });
      if (options.fail) throw new Error("controlled processor failure");
      return { entries: [{ title: "测试观察", content: "用于验证调度的图片观察。", kind: "observation", uncertainty: "测试替身输出，不验证视觉识别质量", region: null, visibleText: "" }], usage: { input: 1, output: 1 } };
    },
  };
  let store = new Store(dataDir);
  // Explicit task/import tests isolate automatic intake, which has its own coverage.
  store.memories.ledger.setSettings({ intake: options.automatic ? "automatic" : "manual" });
  let app = buildApp(config, { store, processors });
  await app.ready();
  cleanup.push(async () => { for (const release of releases) release(); await app.close(); });
  let photoNumber = 0;
  async function photo(name: string) {
    const data = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: ++photoNumber * 20, g: 60, b: 80 } } }).jpeg().toBuffer();
    const asset: Asset = { id: randomUUID(), name, kind: "image", mimeType: "image/jpeg", size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"), createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), data); store.addAsset(asset); return asset;
  }
  const asset = await photo("所选照片.jpg");
  selected = [asset.id];
  return {
    get app() { return app; }, get store() { return store; }, requests, asset, photo,
    get processorCalls() { return processorCalls; }, processorModelIds,
    async configurePhotoModel() {
      const response = await app.inject({ method: "POST", url: "/api/settings/providers/photo-processor", payload: {
        enabled: true, baseUrl: url + "/v1", modelName: "photo-test", apiKey: "photo-fixture-secret",
        protocol: "openai-completions", supportsImages: true, contextWindow: 32768, maxTokens: 4096, reasoning: false, thinkingLevel: "off",
      } });
      expect(response.statusCode, response.body).toBe(200);
      const settings = await app.inject({ method: "PATCH", url: "/api/memory-settings", payload: { photoModelId: "photo-processor/photo-test" } });
      expect(settings.statusCode).toBe(200);
    },
    setRequested(ids: string[]) { requested = ids; },
    release() { blocked = false; for (const release of releases) release(); },
    async start(permissionMode: "auto" | "read" = "auto", conversationId?: string, text = "整理所选照片并保存结果") {
      const conversation = conversationId ? { id: conversationId } : (await app.inject({ method: "POST", url: "/api/conversations" })).json<{ conversation: { id: string } }>().conversation;
      const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
        text, modelId: "openai-compatible/background-test", scope: "selected", assetIds: selected, captureMemory: false, permissionMode,
      } });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ run: Run }>().run;
    },
    read(id: string) { return store.work.get<Run>("run", id)!; },
    async restart() { await app.close(); store = new Store(dataDir); app = buildApp(config, { store, processors }); await app.ready(); },
    async session(conversationId: string) { return readFile(join(dataDir, "sessions", conversationId + ".jsonl"), "utf8"); },
  };
}

describe("background business tools through real Pi with controlled model outputs", () => {
  it("lets a task observe automatic library work without acquiring cancellation ownership", async () => {
    const f = await fixture({ automatic: true });
    await waitFor(() => f.processorCalls, (count) => count === 1);
    const initial = await f.start();
    const waiting = await waitFor(() => f.read(initial.id), (run) => run.waitingFor === "jobs");
    expect(waiting.jobs?.[0].ownership).toBe("library");
    const response = await f.app.inject({ method: "POST", url: `/api/runs/${initial.id}/stop` });
    expect(response.statusCode).toBe(200);
    f.release();
    await waitFor(() => f.store.work.list("memory"), (entries) => entries.length === 1);
    expect(f.read(initial.id).status).toBe("stopped");
    expect(f.requests).toHaveLength(2);
  });
  it("persists an independent photo processor while the Agent keeps its own model", async () => {
    const f = await fixture();
    await f.configurePhotoModel();
    await f.restart();
    expect((await f.app.inject("/api/memory-settings")).json().settings.photoModelId).toBe("photo-processor/photo-test");
    const initial = await f.start();
    await waitFor(() => f.processorCalls, (count) => count === 1);
    expect(f.processorModelIds).toEqual(["photo-processor/photo-test"]);
    expect(f.read(initial.id).modelId).toBe("openai-compatible/background-test");
    f.release();
    const completed = await waitFor(() => f.read(initial.id), (run) => ["completed", "failed"].includes(run.status));
    expect(completed.status, completed.error).toBe("completed");
  });

  it("reports an unavailable selected photo processor without substituting the Agent model", async () => {
    const f = await fixture();
    const settings = await f.app.inject({ method: "PATCH", url: "/api/memory-settings", payload: { photoModelId: "missing/photo-test" } });
    expect(settings.statusCode).toBe(200);
    const initial = await f.start();
    const completed = await waitFor(() => f.read(initial.id), (run) => ["completed", "failed"].includes(run.status));
    expect(completed.parts.some((part) => part.type === "tool" && part.name === "process_assets" && part.state === "error")).toBe(true);
    expect(completed.jobs || []).toEqual([]);
    expect(f.processorCalls).toBe(0);
  });

  it("submits once, waits without model polling, then delivers evidence and a saved artifact", async () => {
    const f = await fixture({ duplicate: true });
    const initial = await f.start();
    const waiting = await waitFor(() => f.read(initial.id), (run) => run.status === "waiting" && run.waitingFor === "jobs");
    expect(waiting.jobs).toHaveLength(1);
    expect(waiting.parts.filter((part) => part.type === "tool" && part.name === "process_assets")).toHaveLength(2);
    await waitFor(() => f.processorCalls, (count) => count === 1);
    expect(f.processorCalls).toBe(1);
    expect(f.requests).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.requests).toHaveLength(2);
    f.release();
    const completed = await waitFor(() => f.read(initial.id), (run) => ["completed", "failed"].includes(run.status));
    expect(completed.status, completed.error).toBe("completed");
    expect(completed.jobs?.[0].status).toBe("completed");
    expect(completed.sources[0].assetId).toBe(f.asset.id);
    expect(f.store.work.list("artifact")).toHaveLength(1);
    expect(f.store.work.list<MemoryEntry>("memory")[0].status).toBe("draft");
    expect(f.store.work.events(initial.id).filter((event) => event.type === "job-results")).toHaveLength(1);
    expect(f.requests).toHaveLength(4);
    expect(JSON.stringify(f.requests)).not.toContain("background-fixture-secret");
    const session = await f.session(initial.conversationId);
    expect(session).toContain('"customType":"background-job-results"');
    expect(session.split('\n').filter((line) => line.includes('"role":"user"') && line.includes("整理所选照片并保存结果"))).toHaveLength(1);
  });

  it("resumes a durable wait after restart without replaying the submitting Agent turn", async () => {
    const f = await fixture();
    const initial = await f.start();
    await waitFor(() => f.read(initial.id), (run) => run.waitingFor === "jobs");
    await waitFor(() => f.processorCalls, (count) => count === 1);
    await f.restart();
    await waitFor(() => f.processorCalls, (count) => count === 2);
    expect(f.read(initial.id).status).toBe("waiting");
    expect(f.requests).toHaveLength(2);
    f.release();
    const completed = await waitFor(() => f.read(initial.id), (run) => ["completed", "failed"].includes(run.status));
    expect(completed.status, completed.error).toBe("completed");
    expect(f.requests).toHaveLength(4);
    expect(f.store.work.events(initial.id).filter((event) => event.type === "job-results")).toHaveLength(1);
    expect(f.store.work.list("memory")).toHaveLength(1);
  });

  it("cancels owned jobs and rejects late processor output without resuming the Agent", async () => {
    const f = await fixture({ ignoreAbort: true });
    const initial = await f.start();
    await waitFor(() => f.read(initial.id), (run) => run.waitingFor === "jobs");
    await waitFor(() => f.processorCalls, (count) => count === 1);
    const response = await f.app.inject({ method: "POST", url: `/api/runs/${initial.id}/stop` });
    expect(response.statusCode, response.body).toBe(200);
    f.release();
    await waitFor(() => f.read(initial.id), (run) => run.jobs?.[0].status === "cancelled");
    expect(f.read(initial.id).status).toBe("stopped");
    expect(f.store.work.list("memory")).toHaveLength(0);
    expect(f.requests).toHaveLength(2);
    expect(f.store.work.events(initial.id).some((event) => event.type === "job-results")).toBe(false);
    const next = await f.start("auto", initial.conversationId, "说明上一任务的停止状态。");
    const resumed = await waitFor(() => f.read(next.id), (run) => ["completed", "failed"].includes(run.status));
    expect(resumed.status, resumed.error).toBe("completed");
    expect(f.requests).toHaveLength(3);
    expect(resumed.parts.some((part) => part.type === "text" && part.text.length > 0)).toBe(true);
  });

  it("keeps processor failure visible and cannot turn it into a successful task", async () => {
    const f = await fixture({ fail: true });
    const initial = await f.start();
    await waitFor(() => f.read(initial.id), (run) => run.waitingFor === "jobs");
    f.release();
    const failed = await waitFor(() => f.read(initial.id), (run) => run.status === "failed");
    expect(failed.jobs?.[0].status).toBe("failed");
    expect(failed.error).toContain("后台作业未完成");
    expect(f.store.work.list("memory")).toHaveLength(0);
    expect(f.requests).toHaveLength(3);
  });

  it("enforces read-only mode and selected-asset scope before processing", async () => {
    const readOnly = await fixture();
    const first = await readOnly.start("read");
    const stopped = await waitFor(() => readOnly.read(first.id), (run) => ["completed", "failed"].includes(run.status));
    expect(stopped.jobs || []).toEqual([]);
    expect(stopped.parts.some((part) => part.type === "tool" && part.name === "process_assets" && part.state === "error")).toBe(true);
    expect(readOnly.processorCalls).toBe(0);
    const scoped = await fixture();
    const outside = await scoped.photo("范围外照片.jpg");
    scoped.setRequested([outside.id]);
    const second = await scoped.start();
    const denied = await waitFor(() => scoped.read(second.id), (run) => ["completed", "failed"].includes(run.status));
    expect(denied.jobs || []).toEqual([]);
    expect(scoped.processorCalls).toBe(0);
  });
});
