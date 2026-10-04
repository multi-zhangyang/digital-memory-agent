import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, MemoryEntry, MemoryImportJob } from "@memory/contracts";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { photoHash } from "../src/photo-source.js";
import { memoryContext } from "../src/memory-retrieval.js";
import type { PhotoObservation } from "../src/photo-extraction.js";
import type { MemoryProcessors } from "../src/memory-processors.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const observation = (fields: Partial<PhotoObservation> = {}): PhotoObservation => ({
  title: "桥梁观察", content: "照片里有一座桥梁。", kind: "observation", uncertainty: "",
  region: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 }, visibleText: "2024-07-19", ...fields,
});
type Body = { messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[] };
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 300; n++) { const value = await read(); if (matches(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Photo task did not settle");
}
async function fixture(vision = true, result: (call: number) => PhotoObservation[] = () => [observation()]) {
  const dataDir = await mkdtemp(join(tmpdir(), "photo-memory-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const requests: Body[] = [];
  const supplier = Fastify();
  supplier.post<{ Body: Body }>("/v1/chat/completions", async (request, reply) => {
    requests.push(request.body);
    const entries = result(requests.length);
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: unknown, finish: string | null) => "data: " + JSON.stringify({ id: "photo-fixture", object: "chat.completion.chunk", created: 1,
      model: "photo-test", choices: [{ index: 0, delta, finish_reason: finish }], usage: {
        prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 100 },
      } }) + "\n\n";
    reply.raw.end(frame({ tool_calls: [{ index: 0, id: "photo-" + requests.length, type: "function", function: { name: "extract_photo_memories", arguments: JSON.stringify({ entries }) } }] }, null) + frame({}, "tool_calls") + "data: [DONE]\n\n");
  });
  const url = await supplier.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => supplier.close());
  const config = readConfig({ MEMORY_DATA_DIR: dataDir, MEMORY_OPENAI_BASE_URL: url + "/v1", MEMORY_OPENAI_API_KEY: "photo-fixture-key", MEMORY_OPENAI_MODEL: "photo-test", MEMORY_OPENAI_VISION: String(vision) });
  let store = new Store(dataDir);
  // Explicit task/import tests isolate automatic intake, which has its own coverage.
  store.memories.ledger.setSettings({ intake: "manual" });
  let app = buildApp(config, { store });
  await app.ready(); cleanup.push(() => app.close());
  let number = 0;
  async function photo(name = "照片.jpg", space: "personal" | "demo" = "personal", large = false) {
    const data = await sharp({ create: { width: large ? 2400 : 120, height: large ? 1200 : 80, channels: 3, background: { r: ++number * 20, g: 60, b: 120 } } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const asset: Asset = { id: randomUUID(), name, memorySpace: space, kind: "image", mimeType: "image/jpeg", size: data.length, sha256: photoHash(data), createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), data); store.addAsset(asset); return asset;
  }
  async function start(assetIds: string[], extra: object = {}) {
    const response = await app.inject({ method: "POST", url: "/api/memory-imports", payload: { requestId: randomUUID(), modelId: "openai-compatible/photo-test", mode: "photos", assetIds, ...extra } });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ job: MemoryImportJob }>().job;
  }
  const settled = (id: string) => waitFor(async () => (await app.inject("/api/memory-imports/" + id)).json<{ job: MemoryImportJob }>().job,
    (job) => ["completed", "failed", "cancelled"].includes(job.status));
  return { get app() { return app; }, get store() { return store; }, requests, photo, start, settled,
    async restart(processors?: MemoryProcessors) { await app.close(); store = new Store(dataDir); app = buildApp(config, { store, processors }); await app.ready(); } };
}

describe("photo memory through real Pi with a controlled model supplier", () => {
  it("sends only selected bounded rasters, reviews observations and verifies original evidence", async () => {
    const f = await fixture();
    const selected = await f.photo("2024-07-19-私人说明.jpg", "personal", true);
    await f.photo("不允许发送的另一张照片.jpg");
    const job = await f.settled((await f.start([selected.id])).id);
    expect(job.status).toBe("completed"); expect(f.requests).toHaveLength(1);
    expect(job.chunks[0].usage).toMatchObject({ input: 200, output: 100 });
    const user = f.requests[0].messages.find((message) => message.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Exclude<Body["messages"][number]["content"], string>;
    const encoded = parts.find((part) => part.type === "image_url")!.image_url!.url;
    const metadata = await sharp(Buffer.from(encoded.split(",")[1], "base64")).metadata();
    expect(metadata.width).toBe(800); expect(metadata.height).toBe(1600); expect(metadata.exif).toBeUndefined();
    expect(JSON.stringify(f.requests)).not.toContain("私人说明");
    expect(JSON.stringify(f.requests)).not.toContain("不允许发送");
    const id = job.chunks[0].memoryIds[0];
    const memory = f.store.work.get<MemoryEntry>("memory", id)!;
    expect(memory).toMatchObject({ status: "draft", kind: "observation", category: "fact", occurredAt: "", people: [] });
    expect(memory.attribute).toBeUndefined(); expect(f.store.work.searchMemories("桥梁")).toHaveLength(0);
    expect(memory.sources[0].visual).toMatchObject({ width: 800, height: 1600, region: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 } });
    const proof = (await f.app.inject(`/api/memories/${id}/evidence/0`)).json();
    expect(proof).toMatchObject({ verified: true, verification: "asset-hash", previewMatches: true }); expect(proof.quote).toBeUndefined();
    const image = await f.app.inject(`/api/memories/${id}/evidence/0/image`);
    expect(image.statusCode).toBe(200); expect(image.headers["content-type"]).toBe("image/jpeg");
    const review = await f.app.inject({ method: "POST", url: "/api/memories/review", payload: { entries: [{ id, version: memory.version }], status: "confirmed" } });
    expect(review.statusCode).toBe(200); expect(f.store.work.searchMemories("桥梁")[0].id).toBe(id);
    const corrected = f.store.work.updateMemory(id, { content: "照片中桥梁标签日期经核对为 2024-07-20。" }, memory.version + 1);
    expect(JSON.stringify(memoryContext(corrected))).not.toContain("2024-07-19");
    const again = await f.settled((await f.start([selected.id])).id);
    expect(again.chunks[0].status).toBe("skipped"); expect(again.chunks[0].memoryIds).toEqual([id]); expect(f.requests).toHaveLength(1);
    await writeFile(join(f.store.assetsDir, selected.id), "changed");
    expect((await f.app.inject(`/api/memories/${id}/evidence/0`)).statusCode).toBe(409);
    expect((await f.app.inject(`/api/memories/${id}/evidence/0/image`)).statusCode).toBe(409);
  });

  it("rejects unconfigured vision, wrong spaces and invalid files before external calls", async () => {
    const f = await fixture(false);
    const asset = await f.photo();
    const response = await f.app.inject({ method: "POST", url: "/api/memory-imports", payload: { requestId: randomUUID(), modelId: "openai-compatible/photo-test", mode: "photos", assetIds: [asset.id] } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("VISION_UNAVAILABLE"); expect(f.requests).toHaveLength(0);
    const g = await fixture();
    const demo = await g.photo("示例.jpg", "demo");
    const crossed = await g.app.inject({ method: "POST", url: "/api/memory-imports", payload: { requestId: randomUUID(), modelId: "openai-compatible/photo-test", mode: "photos", assetIds: [demo.id] } });
    expect(crossed.statusCode).toBe(400);
    const invalid = await g.photo();
    const data = Buffer.from("not an image"); await writeFile(join(g.store.assetsDir, invalid.id), data);
    g.store.db.prepare("UPDATE assets SET sha256=?,size=? WHERE id=?").run(photoHash(data), data.length, invalid.id);
    const failed = await g.app.inject({ method: "POST", url: "/api/memory-imports", payload: { requestId: randomUUID(), modelId: "openai-compatible/photo-test", mode: "photos", assetIds: [invalid.id] } });
    expect(failed.statusCode).toBe(400); expect(failed.json().error.code).toBe("INVALID_PHOTO"); expect(g.requests).toHaveLength(0);
  });

  it("validates regions atomically and retries only unfinished photos", async () => {
    let broken = true;
    const f = await fixture(true, (call) => call === 2 && broken ? [observation(), observation({ region: { x: 0.8, y: 0.1, width: 0.5, height: 0.3 } })] : [observation()]);
    const a = await f.photo(); const b = await f.photo();
    const job = await f.settled((await f.start([a.id, b.id])).id);
    expect(job.status).toBe("failed"); expect(job.chunks.map((chunk) => chunk.status)).toEqual(["completed", "failed"]);
    expect(f.store.work.list<MemoryEntry>("memory")).toHaveLength(1);
    broken = false;
    expect((await f.app.inject({ method: "POST", url: `/api/memory-imports/${job.id}/retry` })).statusCode).toBe(200);
    const retried = await f.settled(job.id);
    expect(retried.status).toBe("completed"); expect(f.requests).toHaveLength(3);
    const memory = f.store.work.get<MemoryEntry>("memory", retried.chunks[0].memoryIds[0])!;
    expect(memory.evidence).toHaveLength(2);
    expect(memory.evidence!.every((proof) => proof.type === "asset" && !!proof.visual)).toBe(true);
  });

  it("keeps public demo observations out of personal recall and blocks stopped photo extraction", async () => {
    const f = await fixture();
    const demo = await f.photo("公开示例.jpg", "demo");
    const job = await f.settled((await f.start([demo.id], { space: "demo" })).id);
    const id = job.chunks[0].memoryIds[0];
    const memory = f.store.work.get<MemoryEntry>("memory", id)!;
    const confirmed = f.store.work.updateMemory(id, { status: "confirmed" }, memory.version);
    expect(f.store.work.searchMemories("桥梁")).toHaveLength(0);
    expect(f.store.work.searchMemories("桥梁", 10, { space: "demo" })).toHaveLength(1);
    f.store.work.forgetMemory(id, confirmed.version);
    const again = await f.settled((await f.start([demo.id], { space: "demo" })).id);
    expect(again.chunks[0]).toMatchObject({ status: "skipped", memoryIds: [], reason: "关联照片已停止取用，未发送给模型" });
    expect(f.requests).toHaveLength(1);
    expect(f.store.work.searchMemories("桥梁", 10, { space: "demo" })).toHaveLength(0);
  });

  it("requires a fresh review for another photo with the same caption as a confirmed memory", async () => {
    const f = await fixture();
    const first = await f.photo();
    const firstJob = await f.settled((await f.start([first.id])).id);
    const accepted = f.store.work.get<MemoryEntry>("memory", firstJob.chunks[0].memoryIds[0])!;
    f.store.work.updateMemory(accepted.id, { status: "confirmed" }, accepted.version);
    const second = await f.photo();
    const secondJob = await f.settled((await f.start([second.id])).id);
    const candidate = f.store.work.get<MemoryEntry>("memory", secondJob.chunks[0].memoryIds[0])!;
    expect(candidate.id).not.toBe(accepted.id);
    expect(candidate.status).toBe("draft");
    expect(f.store.work.get<MemoryEntry>("memory", accepted.id)!.evidence).toHaveLength(1);
    expect(f.store.work.searchMemories("桥梁").map((memory) => memory.id)).toEqual([accepted.id]);
  });

  it("resumes only unfinished photos after restart and cancellation cannot save a late result", async () => {
    const f = await fixture();
    let calls = 0;
    const blocking: MemoryProcessors = {
      extractPhotoMemories: async (_input, signal) => {
        calls++;
        if (calls > 1) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return { entries: [observation()], usage: { input: 1, output: 1 } };
      },
    };
    await f.restart(blocking);
    const first = await f.photo(); const second = await f.photo();
    const job = await f.start([first.id, second.id]);
    const read = async () => (await f.app.inject("/api/memory-imports/" + job.id)).json<{ job: MemoryImportJob }>().job;
    await waitFor(read, (value) => value.chunks[0].status === "completed" && value.chunks[1].stage === "extract");
    await f.restart(blocking);
    await waitFor(read, (value) => value.chunks[1].stage === "extract");
    expect(calls).toBe(3); expect(f.store.work.list("memory")).toHaveLength(1);
    await f.app.inject({ method: "POST", url: `/api/memory-imports/${job.id}/cancel` });
    await waitFor(read, (value) => value.status === "cancelled" && value.chunks[1].status === "pending");
    expect(f.store.work.list("memory")).toHaveLength(1);
    await f.restart();
    await f.app.inject({ method: "POST", url: `/api/memory-imports/${job.id}/retry` });
    const complete = await f.settled(job.id);
    expect(complete.status).toBe("completed"); expect(f.requests).toHaveLength(1);
    expect(complete.chunks[0].attempts).toBe(1);
    expect(f.store.work.list<MemoryEntry>("memory")[0].evidence).toHaveLength(2);
  });
});
