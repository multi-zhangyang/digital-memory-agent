import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { MemoryFeatureService } from "../src/memory-feature-service.js";
import { MemoryVectors } from "../src/memory-vectors.js";
import type { FeatureInfo, LocalFeatures, TextFeatures } from "../src/local-memory-processor.js";

const fingerprint = "a".repeat(64);
const vector = (slot: number, dimensions = 384) => Array.from({ length: dimensions }, (_, index) => Number(index === slot));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "memory-hybrid-"));
  const store = new Store(directory);
  cleanups.push(() => { if (store.db.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (patch: Partial<MemoryEntry> = {}) => store.work.createMemory({ title: "测试记录", content: "朋友一起去骑自行车。",
    status: "confirmed", kind: "statement", category: "event", occurredAt: "2025-02-01", sources: [],
    conversationId: randomUUID(), runId: randomUUID(), ...patch });
  return { store, create };
}
class ControlledFeatures implements LocalFeatures {
  calls = 0;
  gate?: Promise<void>;
  fail = false;
  async info(): Promise<FeatureInfo> { return { protocol: 1, processorVersion: 1, fingerprint, device: "cpu", network: false,
    encoders: { text: { id: "controlled-text-test", revision: "test", dimensions: 384 },
      image: { id: "controlled-image-test", revision: "test", dimensions: 768 }, face: { id: "controlled-face-test", revision: "test", dimensions: 128 } } }; }
  async embed(texts: string[], _role: "query" | "passage", encoder: "text" | "image_text" = "text"): Promise<TextFeatures> {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("controlled failure");
    return { vectors: texts.map((text) => vector(text.includes("旧") ? 1 : 0, encoder === "text" ? 384 : 768)),
      truncated: texts.map(() => false), tokens: texts.map(() => 10), fingerprint };
  }
  async image(): Promise<never> { throw new Error("Images are not implemented by this test double"); }
  async close() {}
}

describe("native filtered vectors and independent maintenance", () => {
  it("keeps per-space progress counts transactional while jobs move through queue, retry and deletion", async () => {
    const { store, create } = setup(); const features = new MemoryFeatureService(store, new ControlledFeatures());
    cleanups.push(() => features.close());
    const personal = create(); const demo = create({ space: "demo" });
    expect(features.status().jobs.queued).toBe(1); expect(features.status("demo").jobs.queued).toBe(1);
    expect(() => store.work.transaction(() => { create(); expect(features.status().jobs.queued).toBe(2); throw new Error("rollback"); })).toThrow("rollback");
    expect(features.status().jobs.queued).toBe(1);
    await features.idle(); expect(features.status().jobs.completed).toBe(1); expect(features.status("demo").jobs.completed).toBe(1);
    store.work.updateMemory(personal.id, { content: "纠正后重新建立索引" }, personal.version);
    expect(features.status().jobs).toMatchObject({ queued: 1, completed: 0 });
    store.db.prepare("DELETE FROM workspace_records WHERE id=?").run(demo.id);
    expect(Object.values(features.status("demo").jobs).reduce((a, b) => a + b, 0)).toBe(0);
    await features.idle(); expect(features.status().jobs.completed).toBe(1);
  });
  it("filters review state, obsolete versions, dates, space and source status before native KNN limiting", () => {
    const { store, create } = setup();
    const vectors = new MemoryVectors(store.db), namespace = vectors.namespace("personal", fingerprint);
    const desired = create({ occurredAt: "2025-07-01" });
    const wrongYear = create({ occurredAt: "2024-07-01" });
    const demo = create({ space: "demo" });
    const stale = create({ content: "旧记录" });
    store.work.updateMemory(stale.id, { content: "已经纠正的新记录" }, stale.version);
    store.work.transaction(() => {
      for (let index = 0; index < 205; index++) {
        const draft = create({ status: "draft", title: `草稿 ${index}` });
        vectors.put("text", namespace, draft.id, draft.version, vector(0));
      }
      for (const memory of [wrongYear, stale]) vectors.put("text", namespace, memory.id, memory.version, vector(0));
      vectors.put("text", vectors.namespace("demo", fingerprint), demo.id, demo.version, vector(0));
      vectors.put("text", namespace, desired.id, desired.version, vector(0));
    });
    const hits = vectors.search("text", fingerprint, vector(0), { from: "2025-01-01", to: "2025-12-31", limit: 1 }, "Asia/Shanghai");
    expect(hits.map((hit) => hit.memoryId)).toEqual([desired.id]);
    expect(vectors.search("text", "b".repeat(64), vector(0), {}, "Asia/Shanghai")).toEqual([]);
    expect(() => vectors.put("text", namespace, desired.id, desired.version, [Number.NaN])).toThrow();
  });

  it("persists queued work, rejects a late obsolete embedding, and resumes without a main Agent", async () => {
    const { store, create } = setup();
    const processor = new ControlledFeatures();
    let release!: () => void;
    processor.gate = new Promise<void>((resolve) => { release = resolve; });
    const features = new MemoryFeatureService(store, processor);
    cleanups.push(() => features.close());
    const memory = create({ content: "旧内容" });
    features.wake();
    await new Promise<void>((resolve) => { const poll = () => processor.calls ? resolve() : setTimeout(poll, 5); poll(); });
    const next = store.work.updateMemory(memory.id, { content: "纠正后的新内容" }, memory.version);
    processor.gate = undefined; release();
    await features.idle();
    expect(features.status().jobs.completed).toBe(1);
    expect(store.db.prepare("SELECT DISTINCT version FROM memory_vector_meta WHERE subjectId=?").all(memory.id)).toEqual([{ version: next.version }]);
    expect(store.work.list("run")).toEqual([]);
    const row = store.db.prepare("SELECT * FROM memory_feature_jobs WHERE memoryId=?").get(memory.id);
    expect(row).toHaveProperty("status", "completed");
    expect(features.vectors.search("text", fingerprint, vector(0), {}, "Asia/Shanghai").map((hit) => hit.memoryId)).toEqual([memory.id]);
  });

  it("reports unavailable semantic processing and returns current keyword evidence; failures remain diagnosable", async () => {
    const { store, create } = setup();
    const processor = new ControlledFeatures();
    const features = new MemoryFeatureService(store, processor);
    cleanups.push(() => features.close());
    store.work.queries.features = features;
    const memory = create({ content: "和朋友在公园骑自行车。" });
    await features.idle();
    processor.fail = true;
    const recalled = await store.work.queries.recallAsync({ query: "自行车" });
    expect(recalled.entries.map((entry) => entry.id)).toEqual([memory.id]);
    expect(recalled.response.retrieval?.status).toBe("unavailable");
    expect(recalled.response.retrieval?.channels).toEqual(["keyword"]);
    const revised = store.work.updateMemory(memory.id, { content: "改为去图书馆。" }, memory.version);
    await features.idle();
    expect(features.status().jobs.failed).toBe(1);
    expect(features.vectors.search("text", fingerprint, vector(0), {}, "Asia/Shanghai")).toEqual([]);
    processor.fail = false; features.retryFailed(); await features.idle();
    expect(features.status().jobs.completed).toBe(1);
    expect(store.db.prepare("SELECT version FROM memory_feature_jobs WHERE memoryId=?").get(memory.id)).toHaveProperty("version", revised.version);
  });

  it("prioritizes complete identifiers over semantically nearer codes, including case and full-width input", async () => {
    const { store, create } = setup();
    const features = new MemoryFeatureService(store, new ControlledFeatures());
    cleanups.push(() => features.close()); store.work.queries.features = features;
    const near = create({ content: "取件码 ZX8N 对应咖啡机。" });
    const prefix = create({ content: "取件码 ZX8MX 对应打印机。" });
    const exact = create({ content: "取件码 ZX8M 对应投影仪。" });
    await features.idle();
    const namespace = features.vectors.namespace("personal", fingerprint);
    features.vectors.put("text", namespace, exact.id, exact.version, vector(1));
    expect((await features.retrieve({ query: "取件码zx8m对应什么" })).text[0].memoryId).not.toBe(exact.id);
    for (const query of ["取件码zx8m对应什么", "取件码ＺＸ８Ｍ对应什么"]) {
      const result = await store.work.queries.recallAsync({ query, limit: 1 });
      expect(result.entries.map((entry) => entry.id)).toEqual([exact.id]);
      expect(result.response.retrieval?.identifierPriority).toEqual({ requested: 1, matchingCandidates: 1 });
    }
    const ordinary = await store.work.queries.recallAsync({ query: "取件码对应什么", limit: 1 });
    expect([near.id, prefix.id]).toContain(ordinary.entries[0].id);
    expect(ordinary.response.retrieval?.identifierPriority).toBeUndefined();
    const missing = await store.work.queries.recallAsync({ query: "取件码ZX8P对应什么" });
    expect(missing.response.retrieval?.identifierPriority).toEqual({ requested: 1, matchingCandidates: 0 });
    expect(missing.response.retrieval?.relevance).toBe("candidate-evidence");
  });

  it("keeps identifier ranking inside current-version, source, space, person and date boundaries", async () => {
    const { store, create } = setup();
    const features = new MemoryFeatureService(store, new ControlledFeatures());
    cleanups.push(() => features.close()); store.work.queries.features = features;
    const person = store.work.memory.savePerson({ name: "测试人物", aliases: [] });
    const source = { assetId: randomUUID(), name: "receipt-RX-8042.txt", sha256: "e".repeat(64), start: 0, end: 20, quote: "订单 RX-8042" };
    const old = create({ content: "订单 RX-8042", statement: "订单 RX-8042", sources: [source], personIds: [person.id!] });
    const revised = store.work.updateMemory(old.id, { content: "订单 RX-8047", personIds: [person.id!] }, old.version);
    const desired = create({ content: "订单 RX-8042 对应台灯。", personIds: [person.id!] });
    const blockedSource = { ...source, sha256: "f".repeat(64), assetId: randomUUID() };
    const stopped = create({ content: desired.content, sources: [blockedSource], personIds: [person.id!] });
    create({ content: desired.content, sources: [blockedSource], personIds: [person.id!] });
    store.work.forgetMemory(stopped.id, stopped.version);
    create({ content: desired.content, personIds: [person.id!], occurredAt: "2024-02-01" });
    create({ content: desired.content, personIds: [person.id!], space: "demo" });
    create({ content: desired.content, personIds: [person.id!], status: "draft" });
    create({ content: desired.content });
    await features.idle();
    const namespace = features.vectors.namespace("personal", fingerprint);
    features.vectors.put("text", namespace, desired.id, desired.version, vector(1));
    const result = await store.work.queries.recallAsync({ query: "订单rx-8042", personId: person.id!, from: "2025-01-01", to: "2025-12-31" });
    expect(result.entries.map((entry) => entry.id)).toEqual([desired.id, revised.id]);
    expect(result.entries[1].content).toBe("订单 RX-8047");
    expect(result.response.retrieval?.identifierPriority).toEqual({ requested: 1, matchingCandidates: 1 });
  });

  it("uses image recall for a long visual request while keeping experience and storage questions on text", async () => {
    const { store, create } = setup();
    const features = new MemoryFeatureService(store, new ControlledFeatures());
    cleanups.push(() => features.close()); store.work.queries.features = features;
    // Fixed vectors exercise routing, not image recognition. No image model is replaced in production.
    const id = randomUUID(), sha256 = "c".repeat(64);
    store.addAsset({ id, sha256, name: "test-image.jpg", kind: "image", mimeType: "image/jpeg", size: 10, createdAt: new Date().toISOString() });
    const memory = create({ content: "用于图像通道测试的素材。", category: "fact", sources: [{ assetId: id, sha256, name: "test-image.jpg", start: 0, end: 10 }] });
    features.vectors.put("image", features.vectors.namespace("personal", fingerprint), id, 1, vector(0, 768), 0, sha256);
    const visual = await store.work.queries.recallAsync({ query: "找桌面上摆着白色带柄杯子，杯子旁边还有一个透明小壶和一把长柄勺子的照片。" });
    expect(visual.entries[0].id).toBe(memory.id);
    expect(visual.response.retrieval?.channels).toContain("image");
    for (const query of ["我把旧照片存在哪个设备？", "找一下上次寄快递的记录。照片随后再看。"]) {
      expect((await store.work.queries.recallAsync({ query })).response.retrieval?.channels).not.toContain("image");
    }
    expect((await store.work.queries.recallAsync({ query: "找桌面上白杯的照片", category: "event" })).response.retrieval?.channels).not.toContain("image");
  });
});
