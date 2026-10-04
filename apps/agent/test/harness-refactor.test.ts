import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { Asset, MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { MemoryImports } from "../src/memory-imports.js";
import { AssetProcessingService } from "../src/asset-processing-service.js";
import { MemoryFeatureService } from "../src/memory-feature-service.js";
import { AutomaticIntake } from "../src/memory/automatic-intake.js";
import { AssetIndexService } from "../src/memory/asset-index-service.js";
import { EvidenceService } from "../src/memory/evidence-service.js";
import { EventOutbox } from "../src/storage/event-outbox.js";
import { TaskContextPolicy } from "../src/application/task-context.js";
import type { MemoryProcessors } from "../src/memory-processors.js";
import type { FeatureInfo, LocalFeatures } from "../src/local-memory-processor.js";
import { DatasetService } from "../src/dataset-service.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "harness-refactor-"));
  let store = new Store(path);
  cleanup.push(async () => { if (store.db.isOpen) store.close(); await rm(path, { recursive: true, force: true }); });
  return { path, get store() { return store; }, reopen() { store.close(); store = new Store(path); return store; } };
}
async function textAsset(store: Store, text: string, space: "personal" | "demo" = "personal") {
  const bytes = Buffer.from(text);
  const asset: Asset = { id: randomUUID(), name: "原始资料.txt", kind: "text", mimeType: "text/plain", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), memorySpace: space };
  await writeFile(join(store.assetsDir, asset.id), bytes); store.addAsset(asset); return asset;
}
const vector = (size: number) => Array.from({ length: size }, (_, index) => Number(index === 0));
const fingerprint = "b".repeat(64);
class ControlledEmbeddings implements LocalFeatures {
  async info(): Promise<FeatureInfo> { return { protocol: 1, processorVersion: 1, fingerprint, device: "cpu", network: false,
    encoders: { text: { id: "test-text", revision: "test", dimensions: 384 }, image: { id: "test-image", revision: "test", dimensions: 768 }, face: { id: "test-face", revision: "test", dimensions: 128 } } }; }
  async embed(texts: string[], _role: "query" | "passage", encoder: "text" | "image_text" = "text") {
    return { vectors: texts.map(() => vector(encoder === "text" ? 384 : 768)), truncated: texts.map(() => false), tokens: texts.map(() => 10), fingerprint };
  }
  async image(): Promise<never> { throw new Error("Image quality is not tested by this double"); }
  async close() {}
}
async function services(store: Store, local?: LocalFeatures) {
  const features = new MemoryFeatureService(store, local);
  const index = new AssetIndexService(store, features);
  cleanup.push(async () => { await index.close(); await features.close(); });
  return { features, index, evidence: new EvidenceService(store, features) };
}
function observation(store: Store, asset: Asset, text: string) {
  return store.memories.createMemory({ title: "素材候选", content: text, status: "draft", kind: "observation", occurredAt: "", conversationId: "", runId: "", space: "personal",
    sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, quote: text }] });
}

describe("product harness boundaries", () => {
  it("indexes original UTF-8 evidence without an Agent, generated observation, or embedding model", async () => {
    const { store } = await fixture();
    const asset = await textAsset(store, "开场资料。".repeat(150) + "星河档案编号 QX78，保存在书房。\n");
    const { index, evidence } = await services(store);
    await index.idle();
    const found = await evidence.search({ query: "星河档案" });
    expect(found.hits[0]).toMatchObject({ assetId: asset.id, authority: "raw-source", status: "source" });
    expect(found.hits[0].excerpt).toContain("QX78");
    expect(found.retrieval.channels).toEqual(["keyword"]);
    const source = found.hits[0].sources[0];
    const read = await evidence.read(found.hits[0].id, {}, { version: asset.sha256, offset: source.start });
    expect(read.source?.text).toContain("星河档案");
    expect(read.verification).toBe("asset-hash");
    expect(store.memories.list("memory")).toEqual([]);
    expect(store.work.list("run")).toEqual([]);
    expect(await readdir(store.sessionsDir)).toEqual([]);
  });

  it("retrieves drafts as unverified evidence while confirmed recall and datasets exclude them", async () => {
    const { store } = await fixture();
    const text = "在青禾公园野餐，人物尚未核实。";
    const asset = await textAsset(store, text);
    const memory = observation(store, asset, text);
    const { index, features, evidence } = await services(store, new ControlledEmbeddings());
    await features.idle(); await index.idle();
    const found = await evidence.search({ query: "青禾公园" });
    expect(found.hits.find((hit) => hit.memoryId === memory.id)).toMatchObject({ authority: "unverified", version: 1, status: "draft" });
    expect(found.retrieval.channels).toContain("text");
    expect(store.memories.searchMemories("青禾公园")).toEqual([]);
    const datasets = new DatasetService(store);
    cleanup.push(() => datasets.close());
    expect(() => datasets.submit({ requestKey: "unconfirmed" })).toThrow("确认记忆");
    expect((await evidence.read(`observation:${memory.id}`)).verification).toBe("source-links");
    const confirmed = store.memories.updateMemory(memory.id, { status: "confirmed" }, memory.version);
    expect(store.memories.searchMemories("青禾公园").map((entry) => entry.id)).toEqual([confirmed.id]);
  });

  it("applies space, selected scope, suppression, and source versions before keyword/vector ranking and reads", async () => {
    const { store } = await fixture();
    const text = "同义素材字句。";
    const allowed = await textAsset(store, text), outside = await textAsset(store, text + "外部"), demo = await textAsset(store, text, "demo");
    const draft = observation(store, outside, text + "外部");
    const { index, features, evidence } = await services(store, new ControlledEmbeddings());
    await features.idle(); await index.idle();
    const found = await evidence.search({ query: "完全不同的语义词" }, { allowedAssetIds: [allowed.id], allowObservations: false });
    expect(found.hits.map((hit) => hit.assetId)).toEqual([allowed.id]);
    await expect(evidence.read(`asset:${outside.id}`, { allowedAssetIds: [allowed.id] })).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    await expect(evidence.read(`asset:${demo.id}`)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    await expect(evidence.read(`asset:${allowed.id}`, {}, { version: "a".repeat(64) })).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    await expect(evidence.read(`asset:${allowed.id}`, {}, { version: "old" })).rejects.toMatchObject({ code: "INVALID_EVIDENCE_VERSION" });
    store.memories.forgetMemory(draft.id, draft.version);
    expect((await evidence.search({ query: "同义素材" })).hits.every((hit) => hit.assetId !== outside.id && hit.memoryId !== draft.id)).toBe(true);
    await expect(evidence.read(`observation:${draft.id}`)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    const bytes = await readFile(join(store.assetsDir, allowed.id));
    await writeFile(join(store.assetsDir, allowed.id), Buffer.alloc(bytes.length, 65));
    await expect(evidence.read(`asset:${allowed.id}`)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("pages current observations at UTF-8 boundaries without injecting original quotations after corrections", async () => {
    const { store } = await fixture();
    const original = "旧资料记载在青禾公园。";
    const asset = await textAsset(store, original);
    const draft = observation(store, asset, original);
    store.memories.updateMemory(draft.id, { title: original }, draft.version);
    const content = "核对后是星河公园。🙂".repeat(400);
    const corrected = store.memories.updateMemory(draft.id, { content }, draft.version + 1);
    const { evidence } = await services(store);
    const id = `observation:${draft.id}`;
    const parts: string[] = []; let offset = 0;
    do {
      const result = await evidence.read(id, {}, { version: corrected.version, offset });
      expect(Buffer.byteLength(result.observation!.text)).toBeLessThanOrEqual(6000);
      expect(JSON.stringify(result)).not.toContain(original);
      expect(result.hit.sources[0]).not.toHaveProperty("quote");
      parts.push(result.observation!.text); offset = result.nextOffset ?? 0;
    } while (offset);
    expect(parts.join("")).toBe(content);
    expect(parts.length).toBeGreaterThan(1);
    await expect(evidence.read(id, {}, { version: draft.version })).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    await expect(evidence.read(id, {}, { offset: 1 })).rejects.toMatchObject({ code: "INVALID_OFFSET" });
  });

  it("keeps durable events atomic and retries failed delivery after reopen without repeating acknowledged effects", async () => {
    const f = await fixture();
    expect(() => f.store.memories.transaction(() => { f.store.events.publish("test.event", "item", 1); throw new Error("rollback"); })).toThrow("rollback");
    expect(f.store.db.prepare("SELECT count(*) AS n FROM domain_events").get()).toMatchObject({ n: 0 });
    f.store.events.publish("test.event", "item", 2);
    f.store.events.subscribe("test.consumer", ["test.event"], () => { throw new Error("temporary failure"); });
    await f.store.events.flush(); await f.store.events.close();
    f.reopen();
    f.store.db.exec("UPDATE event_deliveries SET retryAt=0");
    const received: number[] = [];
    f.store.events.subscribe("test.consumer", ["test.event"], (event) => { received.push(event.seq); });
    await f.store.events.flush(); await f.store.events.flush();
    expect(received).toHaveLength(1);
    expect(f.store.db.prepare("SELECT attempts,deliveredAt FROM event_deliveries").get()).toMatchObject({ attempts: 2, deliveredAt: expect.any(String) });
  });

  it("recovers pending automatic intake, reports missing configuration and creates only one durable library job", async () => {
    const f = await fixture();
    const asset = await textAsset(f.store, "2026年5月2日，在书房整理星河档案。");
    f.reopen(); // Upload committed; event delivery had not started.
    const config = readConfig({ MEMORY_DATA_DIR: f.path });
    let calls = 0;
    const processors: MemoryProcessors = { extractMemories: async (input) => { calls++; return { entries: [{ title: "整理档案", content: input.text, quote: input.text,
      category: "event", kind: "observation", occurredAt: "2026-05-02", people: [], place: "书房", uncertainty: "", attribute: null }], usage: { input: 1, output: 1 } }; } };
    const imports = new MemoryImports(f.store, config, () => processors);
    const processing = new AssetProcessingService(f.store, config, imports);
    const intake = new AutomaticIntake(f.store, processing);
    cleanup.push(async () => { await intake.close(); await imports.close(); });
    await f.store.events.flush(); await intake.idle();
    expect(intake.driver().get(asset.id)).toMatchObject({ status: "queued", ownership: "library", blockedReason: expect.any(String) });
    expect(calls).toBe(0);
    const configured = readConfig({ MEMORY_DATA_DIR: f.path, MEMORY_OPENAI_API_KEY: "test-only", MEMORY_OPENAI_MODEL: "test-model", MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:1/v1" });
    config.providers = configured.providers;
    f.store.events.publish("processing.configuration-changed", "models", "test");
    await f.store.events.flush(); await intake.idle();
    for (let attempt = 0; attempt < 100 && imports.busy(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(imports.jobs()).toHaveLength(1);
    expect(imports.jobs()[0]).toMatchObject({ status: "completed", ownership: "library" });
    expect(f.store.memories.list("memory")).toHaveLength(1);
    f.store.events.publish("asset.added", asset.id, asset.sha256, { processing: "automatic" });
    await f.store.events.flush(); await intake.idle();
    expect(calls).toBe(1);
    expect(f.store.work.list("run")).toEqual([]);
  });

  it("preserves record versions and returns new context after correction even with an undelivered event", async () => {
    const f = await fixture(); const asset = await textAsset(f.store, "星河档案存放在书房。");
    const original = observation(f.store, asset, "星河档案存放在书房。");
    const corrected = f.store.memories.updateMemory(original.id, { content: "已纠正为客厅", reason: "用户纠正" }, original.version);
    const epoch = f.store.memories.ledger.epoch;
    f.reopen();
    expect(f.store.memories.get<MemoryEntry>("memory", original.id)).toMatchObject({ id: original.id, version: corrected.version, status: "draft" });
    expect(f.store.memories.versions(original.id)).toHaveLength(2);
    const conversation = f.store.createConversation();
    const run = f.store.work.createRun(conversation.id, { text: "查找档案", modelId: "test" });
    expect(run.memoryEpoch).toBe(epoch);
    const context = new TaskContextPolicy(f.store);
    expect(context.reset(conversation.id, { runId: run.id })).toMatchObject({ customType: "digital-memory-reset" });
    expect(f.store.db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(f.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
