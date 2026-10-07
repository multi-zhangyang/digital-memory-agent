import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { MemoryEvents } from "../src/memory-events.js";
import type { ImageFeatures } from "../src/local-memory-processor.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "memory-graph-"));
  const store = new Store(directory);
  cleanup.push(() => { if (store.db.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const memory = (patch: Partial<MemoryEntry> = {}) => store.work.createMemory({ title: "去公园", content: "和朋友去公园散步。",
    status: "confirmed", kind: "statement", category: "event", occurredAt: "2025-03-02", sources: [],
    conversationId: randomUUID(), runId: randomUUID(), ...patch });
  return { store, memory, events: new MemoryEvents(store), graph: store.work.memory.graph };
}
function image(store: Store) {
  const asset: Asset = { id: randomUUID(), name: "测试照片.jpg", kind: "image", mimeType: "image/jpeg", size: 10,
    sha256: randomUUID().replaceAll("-", "").repeat(2), memorySpace: "personal", createdAt: new Date().toISOString() };
  store.addAsset(asset);
  return asset;
}
const features: ImageFeatures = { fingerprint: "1".repeat(64), width: 100, height: 100, coordinateSpace: "exif-oriented",
  vector: Array.from({ length: 768 }, (_, index) => Number(index === 0)),
  metadata: { capturedLocal: null, offset: null, source: null, certainty: "unknown", hasGps: false },
  faces: [{ region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, detectionScore: 0.99, quality: "usable", vector: Array.from({ length: 128 }, (_, index) => Number(index === 0)) }] };

describe("versioned observations, identities and complete events", () => {
  it("keeps face observations and existing links when only the semantic model changes", () => {
    const { store, graph } = setup(), asset = image(store);
    const first = graph.recordImage(asset, { ...features, faceFingerprint: "face-model" }, () => [])[0];
    const person = store.work.memory.savePerson({ name: "确认人物", aliases: [] });
    graph.identify(first.entityId, 1, person.id!, "用户确认");
    const links = store.db.prepare("SELECT * FROM memory_entity_links ORDER BY id").all();
    const next = graph.recordImage(asset, { ...features, fingerprint: "new-text-model", faceFingerprint: "face-model" }, () => [])[0];
    expect(next.observationId).toBe(first.observationId);
    expect(store.db.prepare("SELECT * FROM memory_entity_links ORDER BY id").all()).toEqual(links);
  });

  it("preserves original observation IDs/output when a claim is corrected, including restart", () => {
    const { store, memory, graph } = setup();
    const asset = image(store);
    const entry = memory({ content: "画面中有一只浅碗。", kind: "observation", status: "draft",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size }],
      ingestion: { modelId: "test-processor", extractorVersion: 1, jobId: randomUUID(), chunkId: randomUUID() } });
    const original = graph.context(entry).observationIds;
    const corrected = store.work.updateMemory(entry.id, { content: "画面中有一个蓝白花纹的杯子。", status: "confirmed" }, entry.version);
    expect(graph.context(corrected).observationIds).toEqual(original);
    expect(graph.observation(original[0]).output.content).toBe("画面中有一只浅碗。");
    const event = graph.context(corrected).events[0] as { id: string; version: number };
    expect(event.version).toBe(2);
    const directory = store.dataDir;
    store.close();
    const reopened = new Store(directory);
    expect(reopened.work.memory.graph.observation(original[0]).output.content).toBe("画面中有一只浅碗。");
    expect(reopened.work.memory.graph.context(reopened.work.get<MemoryEntry>("memory", entry.id)!).events).toEqual([event]);
    reopened.close();
  });

  it("keeps same-name people distinct and returns ambiguity with bounded identifying context", async () => {
    const { store, memory } = setup();
    const first = store.work.memory.savePerson({ name: "小张", aliases: ["同事张工"] });
    const second = store.work.memory.savePerson({ name: "小张", aliases: ["邻居小张"] });
    const a = memory({ content: "和同事张工去公园散步。", personIds: [first.id!] });
    const b = memory({ content: "和邻居小张去公园散步。", personIds: [second.id!] });
    const ambiguous = await store.work.queries.recallAsync({ query: "公园", person: "小张" });
    expect(ambiguous.entries).toEqual([]);
    expect(ambiguous.response.personResolution?.status).toBe("ambiguous");
    expect(ambiguous.response.personResolution?.candidates.map((person) => person.personId).sort()).toEqual([first.id, second.id].sort());
    const resolved = await store.work.queries.recallAsync({ query: "公园", person: "邻居小张" });
    expect(resolved.entries.map((entry) => entry.id)).toEqual([b.id]);
    expect(resolved.entries.some((entry) => entry.id === a.id)).toBe(false);
    expect((await store.work.queries.recallAsync({ space: "demo", query: "小张" })).response.personResolution).toBeUndefined();
  });

  it("associates repeated faces as candidates; user identity, split and merge preserve separate history", () => {
    const { store, graph, memory } = setup();
    const a = image(store), b = image(store);
    const record = (asset: Asset) => memory({ category: "fact", kind: "observation", occurredAt: "", content: "照片中有一位人物。",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size }] });
    const ma = record(a), mb = record(b);
    const first = graph.recordImage(a, features, () => [])[0];
    const second = graph.recordImage(b, features, () => [{ entityId: first.entityId, similarity: 0.8 }])[0];
    expect(second.entityId).toBe(first.entityId);
    expect(graph.entity(first.entityId).state).toBe("unknown");
    expect(graph.context(mb).entities[0].personId).toBeUndefined();
    const person = store.work.memory.savePerson({ name: "测试人物", aliases: [] });
    const identified = graph.identify(first.entityId, graph.entity(first.entityId).version, person.id!, "用户核对两张照片后确认");
    expect(store.work.queries.search({ personId: person.id }).map((entry) => entry.id).sort()).toEqual([ma.id, mb.id].sort());
    expect(() => graph.identify(first.entityId, 1, person.id!, "过期确认")).toThrow("已更新");
    const split = graph.splitEntity(first.entityId, identified.version, [second.observationId], "第二张关联错误，分离重新核对");
    expect(split.state).toBe("unknown");
    expect(graph.context(mb).entities[0].personId).toBeUndefined();
    expect(store.work.queries.search({ personId: person.id }).map((entry) => entry.id)).toEqual([ma.id]);
    const merged = graph.mergeEntities([{ id: first.entityId, version: graph.entity(first.entityId).version }, { id: split.id, version: split.version }], "保留候选关联，未再次确认第二张身份");
    expect(merged.personId).toBe(person.id);
    expect(graph.context(mb).entities[0].association).toBe("candidate");
    expect(graph.context(mb).entities[0].personId).toBeUndefined();
    expect((store.db.prepare("SELECT count(*) AS n FROM memory_graph_versions WHERE id=?").get(first.entityId) as { n: number }).n).toBeGreaterThanOrEqual(5);
    store.db.prepare("UPDATE assets SET sha256=? WHERE id=?").run("f".repeat(64), a.id);
    expect(store.work.queries.search({ personId: person.id })).toEqual([]);
  });

  it("counts and enumerates every event, invalidates cursors, merges/splits without losing sources or inventing dates", () => {
    const { store, memory, graph, events } = setup();
    const entries = Array.from({ length: 37 }, (_, index) => memory({ title: `公园活动 ${index}`, content: `公园活动记录 ${index}` }));
    memory({ title: "时间未知的活动", occurredAt: "" });
    expect(events.query({ mode: "count" }).total).toBe(38);
    const page = events.query({ from: "2025-01-01", to: "2025-12-31", limit: 4 });
    expect(page.total).toBe(37);
    expect(page.events).toHaveLength(4);
    expect(page.coverage).toHaveProperty("undatedEventsInSpace", 1);
    const seen = page.events.map((event) => event.id);
    let cursor = page.nextCursor;
    while (cursor) { const next = events.query({ from: "2025-01-01", to: "2025-12-31", limit: 4, cursor }); seen.push(...next.events.map((event) => event.id)); cursor = next.nextCursor; }
    expect(new Set(seen).size).toBe(37);
    const first = graph.context(entries[0]).events[0] as { id: string; version: number };
    const second = graph.context(entries[1]).events[0] as { id: string; version: number };
    const combined = graph.mergeEvents([first, second], "同一次公园活动", "用户确认两条素材来自同一事件");
    expect(events.query({ mode: "count" }).total).toBe(37);
    expect(() => events.query({ from: "2025-01-01", to: "2025-12-31", cursor: page.nextCursor! })).toThrow("已更新");
    const split = graph.splitEvent(combined.id, combined.version, [entries[1].id], "另一次活动", "纠正合并");
    expect(events.query({ mode: "count" }).total).toBe(38);
    expect(graph.context(entries[1]).events).toEqual([{ id: split.id, version: 1 }]);
    const fixed = store.work.updateMemory(entries[1].id, { occurredAt: "", uncertainty: "具体日期未知" }, entries[1].version);
    expect(fixed.occurredAt).toBe("");
    expect(events.query({ from: "2025-01-01", to: "2025-12-31", mode: "count" }).total).toBe(36);
  });
});
