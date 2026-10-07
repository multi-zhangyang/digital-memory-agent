import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { featureConnectionUpdate, publicFeatureSettings, readFeatureSettings, saveFeatureSettings } from "../src/feature-config.js";
import { HttpFeatureProcessor } from "../src/integrations/http-features.js";
import { MemoryFeatureService } from "../src/memory/feature-service.js";
import { MemoryVectors, vectorBytes } from "../src/memory/vectors.js";
import type { Asset, FeatureConnectionUpdate } from "@memory/contracts";

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), "feature-services-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const connection = (baseUrl: string, patch: Partial<FeatureConnectionUpdate> = {}): FeatureConnectionUpdate => ({
  enabled: true, baseUrl, modelName: "user-selected-model", protocol: "memory-features-v1", revision: "1", ...patch,
});
const unit = (n: number) => Array.from({ length: n }, (_, i) => Number(i === 0));
async function provider() {
  const server = Fastify();
  const requests: { body: any; authorization?: string }[] = [];
  const state = { dimensions: 7, revision: "weights-a", spaceId: "unified-space", malformed: false, reverseDelay: false, fail: false, gate: undefined as Promise<void> | undefined };
  server.post<{ Body: Record<string, any> }>("/features", async (request, reply) => {
    const body = request.body;
    requests.push({ body, authorization: request.headers.authorization });
    if (state.fail) return reply.code(500).send({ error: request.headers.authorization, privateInput: body });
    if (body.action === "info") {
      if ((body.capability === "text") === state.reverseDelay) await new Promise((resolve) => setTimeout(resolve, 15));
      return { protocol: 1, revision: state.revision, dimensions: state.dimensions, spaceId: state.spaceId, capabilities: ["text", "image", "face"] };
    }
    if (body.action === "embed" && state.gate) await state.gate;
    const vector = state.malformed ? unit(state.dimensions + 1) : unit(state.dimensions);
    if (body.action === "embed") return { revision: state.revision, vectors: body.texts.map(() => vector), truncated: body.texts.map(() => false), tokens: body.texts.map(() => 4) };
    if (body.capability === "image") return { revision: state.revision, vector };
    return { revision: state.revision, coordinateSpace: "exif-oriented", faces: [{ region: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }, detectionScore: 0.99, quality: "usable", vector }] };
  });
  server.post<{ Body: Record<string, any> }>("/v1/embeddings", async (request) => {
    requests.push({ body: request.body, authorization: request.headers.authorization });
    return { data: request.body.input.map((_: string, index: number) => ({ index, embedding: unit(state.dimensions) })).reverse() };
  });
  const url = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  return { url, requests, state };
}
function storeFixture() {
  const dataDir = directory(), store = new Store(dataDir);
  cleanups.push(() => { if (store.db.isOpen) store.close(); });
  const memory = () => store.work.createMemory({ title: "测试资料", content: "周末去公园骑车", status: "confirmed", kind: "statement", category: "event", occurredAt: "2025-02-01", sources: [], conversationId: randomUUID(), runId: randomUUID() });
  return { dataDir, store, memory };
}

describe("user-configured feature services (HTTP protocol doubles, not model quality)", () => {
  it("defaults to disabled, persists keys privately and never carries a key to a different address", () => {
    const dataDir = directory(), settings = readFeatureSettings(dataDir);
    expect(Object.values(settings.connections).every((value) => !value.enabled)).toBe(true);
    expect(readConfig({ MEMORY_DATA_DIR: dataDir }).localProcessor).toBeUndefined();
    const saved = featureConnectionUpdate(settings, "text", connection("http://localhost:9898/v1/", { protocol: "openai-embeddings", apiKey: "private-key" }));
    saveFeatureSettings(dataDir, saved);
    expect(statSync(join(dataDir, "feature-models.json")).mode & 0o777).toBe(0o600);
    expect(readFeatureSettings(dataDir)).toEqual(saved);
    expect(JSON.stringify(publicFeatureSettings(saved))).not.toContain("private-key");
    expect(featureConnectionUpdate(saved, "text", connection("http://localhost:9898/v1")).connections.text.apiKey).toBe("private-key");
    expect(featureConnectionUpdate(saved, "text", connection("http://localhost:9899/v1")).connections.text.apiKey).toBe("");
    expect(featureConnectionUpdate(saved, "text", connection("http://localhost:9898/v1", { clearApiKey: true })).connections.text.apiKey).toBe("");
    expect(() => featureConnectionUpdate(saved, "face", connection("http://localhost", { protocol: "openai-embeddings" }))).toThrow();
    expect(() => featureConnectionUpdate(saved, "text", connection("https://user:secret@example.invalid"))).toThrow();
    expect(readConfig({ MEMORY_DATA_DIR: dataDir, MEMORY_WORKER_PYTHON: "/tmp/python", MEMORY_FEATURE_MODELS: "/tmp/models" }).localProcessor).toBeUndefined();
  });
  it("handles arbitrary dimensions, orders OpenAI responses, and reports unknown usage honestly", async () => {
    const { url, requests } = await provider();
    const settings = featureConnectionUpdate(readFeatureSettings(directory()), "text", connection(url + "/v1", { protocol: "openai-embeddings", apiKey: "private-key" }));
    const processor = new HttpFeatureProcessor(settings); cleanups.push(() => processor.close());
    const result = await processor.embed(["first", "second"], "passage");
    expect(result.vectors).toEqual([unit(7), unit(7)]);
    expect(result.tokens).toEqual([null, null]); expect(result.truncated).toEqual([null, null]);
    expect(requests[1].authorization).toBe("Bearer private-key");
    expect(requests[1].body.model).toBe("user-selected-model");
    expect((await processor.info()).encoders.image).toBeUndefined();
  });
  it("uses stable channel fingerprints and rejects silent revision or dimension changes", async () => {
    const { url, state } = await provider();
    let settings = readFeatureSettings(directory());
    for (const channel of ["text", "image", "face"] as const) settings = featureConnectionUpdate(settings, channel, connection(url + "/features"));
    const first = new HttpFeatureProcessor(settings); cleanups.push(() => first.close());
    const before = await first.info(); state.reverseDelay = true;
    const second = new HttpFeatureProcessor(settings); cleanups.push(() => second.close());
    expect((await second.info()).fingerprint).toBe(before.fingerprint);
    expect(before.sharedQueryEmbedding).toBe(true);
    const changed = new HttpFeatureProcessor(featureConnectionUpdate(settings, "text", connection(url + "/features", { revision: "2" })));
    cleanups.push(() => changed.close());
    expect((await changed.info()).encoders.face?.fingerprint).toBe(before.encoders.face?.fingerprint);
    state.malformed = true; await expect(first.embed(["private words"], "query")).rejects.toThrow("特征服务未完成请求");
    state.malformed = false; state.revision = "weights-b";
    await expect(first.embed(["private words"], "query")).rejects.toThrow("特征服务未完成请求");
    state.fail = true;
    await expect(first.embed(["private words"], "query")).rejects.not.toThrow("private words");
  });
  it("sends only sanitized image bytes to enabled services and supports face-only indexing", async () => {
    const { url, requests } = await provider();
    const { store, dataDir } = storeFixture();
    const settings = featureConnectionUpdate(readFeatureSettings(dataDir), "face", connection(url + "/features"));
    const processor = new HttpFeatureProcessor(settings), features = new MemoryFeatureService(store, processor);
    cleanups.push(() => features.close());
    const data = await sharp({ create: { width: 80, height: 60, channels: 3, background: "red" } })
      .withExif({ IFD0: { Artist: "private-person" }, IFD2: { DateTimeOriginal: "2025:01:02 03:04:05" } }).jpeg().toBuffer();
    const result = await processor.image(data, createHash("sha256").update(data).digest("hex"));
    expect(result.vector).toBeNull(); expect(result.faces[0].vector).toHaveLength(7);
    const sent = requests.find((request) => request.body.action === "image")!.body.image;
    expect((await sharp(Buffer.from(sent.data, "base64")).metadata()).exif).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("private-person");
    const entry = store.work.createMemory({ title: "test", content: "only faces enabled", status: "confirmed", kind: "statement", category: "fact", occurredAt: "", sources: [], conversationId: randomUUID(), runId: randomUUID() });
    await features.idle();
    expect(features.job(entry.id).status).toBe("completed");
    expect(requests.some((request) => request.body.action === "embed")).toBe(false);
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_vector_meta").get()).toEqual({ n: 0 });
  });
  it("applies API settings without restart, tests unsaved connections, and never exposes saved keys", async () => {
    const { url } = await provider();
    const dataDir = directory();
    const app = buildApp(readConfig({ MEMORY_DATA_DIR: dataDir })); cleanups.push(() => app.close());
    const payload = connection(url + "/features", { apiKey: "private-key" });
    const tested = await app.inject({ method: "POST", url: "/api/settings/features/text/test", payload });
    expect(tested.statusCode, tested.body).toBe(200);
    expect((await app.inject("/api/settings/features")).json().connections.text.enabled).toBe(false);
    const saved = await app.inject({ method: "POST", url: "/api/settings/features/text", payload });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.body).not.toContain("private-key");
    expect(saved.json().connections.text.hasApiKey).toBe(true);
    await expect.poll(async () => (await app.inject("/api/settings/features")).json().status.state).toBe("ready");
    expect(readFileSync(join(dataDir, "feature-models.json"), "utf8")).toContain("private-key");
    await app.inject({ method: "POST", url: "/api/settings/features/text", payload: { ...payload, enabled: false, apiKey: "" } });
    expect((await app.inject("/api/settings/features")).json().status.state).toBe("not_configured");
    const policy = await app.inject({ method: "POST", url: "/api/settings/features/policy", payload: { faceMatchThreshold: 0.7, faceMatchMargin: 0.2 } });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().faceMatchThreshold).toBe(0.7);
  });
  it("indexes images independently and reuses a shared query only when the service declares the same space", async () => {
    const { url, requests } = await provider(), { store, dataDir, memory } = storeFixture();
    let settings = readFeatureSettings(dataDir);
    for (const channel of ["text", "image"] as const) settings = featureConnectionUpdate(settings, channel, connection(url + "/features"));
    const features = new MemoryFeatureService(store, new HttpFeatureProcessor(settings)); cleanups.push(() => features.close());
    memory(); await features.idle();
    const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: "red" } }).jpeg().toBuffer();
    const asset: Asset = { id: randomUUID(), name: "test.jpg", mimeType: "image/jpeg", kind: "image", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), memorySpace: "personal" };
    store.addAsset(asset); writeFileSync(join(store.assetsDir, asset.id), bytes);
    await features.indexSource(asset, [], () => true, new AbortController().signal);
    let start = requests.length;
    await features.retrieve({ query: "red picture" });
    expect(requests.slice(start).filter((r) => r.body.action === "embed").map((r) => r.body.capability)).toEqual(["text"]);
    settings = featureConnectionUpdate(settings, "text", connection(url + "/features", { enabled: false }));
    await features.reconfigure(new HttpFeatureProcessor(settings)); await features.idle();
    start = requests.length;
    await features.retrieve({ query: "red picture" });
    expect(requests.slice(start).filter((r) => r.body.action === "embed").map((r) => r.body.capability)).toEqual(["image"]);
  });
  it("aborts in-flight requests on reconfiguration and prevents their late vectors from being written", async () => {
    const { url, requests, state } = await provider(), { store, dataDir, memory } = storeFixture();
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    // Always release the HTTP fixture before closing its server, even if an assertion fails.
    cleanups.push(() => release());
    const settings = featureConnectionUpdate(readFeatureSettings(dataDir), "text", connection(url + "/features"));
    const features = new MemoryFeatureService(store, new HttpFeatureProcessor(settings)); cleanups.push(() => features.close());
    memory(); features.wake();
    await expect.poll(() => requests.some((r) => r.body.action === "embed")).toBe(true);
    state.gate = undefined; state.dimensions = 13;
    const next = featureConnectionUpdate(settings, "text", connection(url + "/features", { revision: "new-model" }));
    await features.reconfigure(new HttpFeatureProcessor(next));
    release(); await features.idle();
    expect(features.status().jobs.failed).toBe(0);
    expect(store.db.prepare("SELECT dimensions FROM memory_vector_meta").all()).toEqual([{ dimensions: 13 }]);
  });
  it("switches namespaces and dimensions while retaining old model indexes and keyword behavior", async () => {
    const { url, state } = await provider(), { dataDir, store, memory } = storeFixture();
    let settings = featureConnectionUpdate(readFeatureSettings(dataDir), "text", connection(url + "/features"));
    const features = new MemoryFeatureService(store, new HttpFeatureProcessor(settings)); cleanups.push(() => features.close());
    const entry = memory(); await features.idle();
    expect((await features.retrieve({ query: "公园" })).text[0].memoryId).toBe(entry.id);
    const before = features.status().fingerprint;
    state.dimensions = 13;
    settings = featureConnectionUpdate(settings, "text", connection(url + "/features", { revision: "2" }));
    await features.reconfigure(new HttpFeatureProcessor(settings)); await features.idle();
    expect(features.status().fingerprint).not.toBe(before);
    expect((await features.retrieve({ query: "公园" })).text[0].memoryId).toBe(entry.id);
    expect(store.db.prepare("SELECT DISTINCT dimensions FROM memory_vector_meta ORDER BY dimensions").all()).toEqual([{ dimensions: 7 }, { dimensions: 13 }]);
    await features.reconfigure();
    expect((await features.retrieve({ query: "公园" })).text).toEqual([]);
    expect(store.work.queries.search({ query: "公园" })[0].id).toBe(entry.id);
    features.vectors.remove(entry.id, "text");
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_vector_meta").get()).toEqual({ n: 0 });
  });
  it("migrates legacy vec tables from their schema and survives rolled-back dynamic DDL", () => {
    const { store, memory } = storeFixture();
    const entry = memory();
    store.db.exec(`CREATE TABLE memory_vector_meta(id INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,namespace TEXT NOT NULL,
      subjectId TEXT NOT NULL,version INTEGER NOT NULL,segment INTEGER NOT NULL,sourceHash TEXT,UNIQUE(channel,namespace,subjectId,segment));
      CREATE VIRTUAL TABLE memory_vectors_text USING vec0(id INTEGER PRIMARY KEY,embedding float[5] distance_metric=cosine,namespace TEXT PARTITION KEY)`);
    store.db.prepare("INSERT INTO memory_vector_meta VALUES(1,'text','personal:legacy',?,?,0,NULL)").run(entry.id, entry.version);
    store.db.prepare("INSERT INTO memory_vectors_text VALUES(1,?,'personal:legacy')").run(vectorBytes(unit(5), 5));
    const vectors = new MemoryVectors(store.db);
    expect(vectors.search("text", "legacy", unit(5), {}, "UTC")[0].memoryId).toBe(entry.id);
    expect(() => store.work.transaction(() => { vectors.put("text", "personal:new", entry.id, entry.version, unit(11)); throw new Error("rollback"); })).toThrow("rollback");
    vectors.put("text", "personal:new", entry.id, entry.version, unit(11));
    expect(vectors.search("text", "new", unit(11), {}, "UTC")[0].memoryId).toBe(entry.id);
    expect(() => vectors.put("text", "personal:new", randomUUID(), 1, unit(12))).toThrow("dimensions changed");
    vectors.remove(entry.id, "text");
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_vectors_text").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_vectors_text_11").get()).toEqual({ n: 0 });
  });
});
