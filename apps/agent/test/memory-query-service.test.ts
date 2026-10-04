import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";
import { toolOutput } from "../src/memory-tools.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "memory-queries-"));
  const store = new Store(dir);
  cleanup.push(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const add = (patch: Partial<MemoryEntry> = {}) => store.work.createMemory({
    title: "春游", content: "和小陈去公园春游。", status: "confirmed", kind: "observation",
    category: "event", occurredAt: "2026-03-12", conversationId: "", runId: "",
    sources: [{ assetId: randomUUID(), name: "原文.txt", sha256: randomUUID(), start: 0, end: 10 }], ...patch,
  });
  return { store, add };
}

describe("independent memory query service", () => {
  it("filters suppressed sources before limiting results, including memories sharing evidence", async () => {
    const { store, add } = await fixture();
    const expected = add();
    const source = { assetId: randomUUID(), name: "停用.txt", sha256: randomUUID(), start: 0, end: 10 };
    const blocked = Array.from({ length: 65 }, () => add({ sources: [source] }));
    store.work.forgetMemory(blocked[0].id, 1);
    const result = store.work.queries.recall({ query: "公园春游", limit: 8 });
    expect(result.entries.map((entry) => entry.id)).toEqual([expected.id]);
    expect(result.response.memories[0].evidence[0].sha256).toBe(expected.sources[0].sha256);
  });

  it("returns current uncertainty and excludes stopped draft conflicts", async () => {
    const { store, add } = await fixture();
    const current = add({ content: "我住在杭州。", category: "profile", occurredAt: "", attribute: { key: "home_city", value: "杭州" }, uncertainty: "来自本人陈述，尚无其他来源" });
    const pending = add({ status: "draft", category: "profile", content: "我住在宁波。", attribute: { key: "home_city", value: "宁波" }, occurredAt: "" });
    const query = { query: "我住在哪里" };
    expect(store.work.queries.recall(query).response.pendingConflicts).toEqual([{ pendingId: pending.id, currentId: current.id, status: "待核对" }]);
    store.work.forgetMemory(pending.id, 1);
    const response = store.work.queries.recall(query).response;
    expect(response.pendingConflicts).toEqual([]);
    expect(response.memories[0].uncertainty).toBe(current.uncertainty);
    const epoch = store.work.memory.epoch;
    store.work.updateMemory(current.id, { uncertainty: "已核对来源" }, 1);
    expect(store.work.memory.epoch).toBeGreaterThan(epoch);
    expect(store.work.queries.recall(query).response.memories[0].uncertainty).toBe("已核对来源");
  });

  it("keeps temporal and space boundaries when reporting explicit conflicts", async () => {
    const { store, add } = await fixture();
    const current = add();
    add({ status: "draft", conflictsWith: [current.id], space: "demo" });
    add({ status: "draft", conflictsWith: [current.id], validity: { from: "2028-01-01", precision: "day" } });
    store.work.updateMemory(current.id, { validity: { from: "2026-01-01", to: "2026-12-31", precision: "year" } }, 1);
    const pending = add({ status: "draft", conflictsWith: [current.id] });
    expect(store.work.queries.recall({ query: "春游" }).response.pendingConflicts)
      .toEqual([{ pendingId: pending.id, currentId: current.id, status: "待核对" }]);
  });

  it("bounds the complete evidence response and marks omitted conflicts", async () => {
    const { store, add } = await fixture();
    const current = add();
    for (let i = 0; i < 70; i++) add({ status: "draft", conflictsWith: [current.id] });
    const result = store.work.queries.recall({ query: "春游" }, 1400);
    expect(result.response.memories).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result.response))).toBeLessThanOrEqual(1400);
    expect(result.response.coverage.conflictsTruncated).toBe(true);
    expect(store.work.queries.forTask("春游", { enabled: false, maxBytes: 1400 }).entries).toEqual([]);
  });

  it("exposes the same evidence through the thin tool adapter and persists its trace", async () => {
    const { store, add } = await fixture();
    const memory = add();
    const conversation = store.createConversation();
    const run = store.work.createRun(conversation.id, { text: "春游", modelId: "unused", captureMemory: false });
    store.work.patchRun(run.id, { status: "running" });
    const tool = createWorkspaceTools(store, conversation.id).find((tool) => tool.name === "search_memories")!;
    const output = await tool.execute("query", { query: "春游" }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
    expect(toolOutput(output)).toEqual((await store.work.queries.recallAsync({ query: "春游" })).response);
    expect(store.work.get<typeof run>("run", run.id)?.memoryTraces?.[0].matches[0].id).toBe(memory.id);
    expect(() => store.work.queries.search({ personId: memory.id })).toThrow("personId");
  });
});
