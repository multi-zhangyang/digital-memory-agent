import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryPage, MemoryOverview } from "@memory/contracts";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "memory-catalog-"));
  let store = new Store(dir);
  cleanup.push(async () => { if (store.db.isOpen) store.close(); await rm(dir, { recursive: true, force: true }); });
  let number = 0;
  const add = (patch: Partial<MemoryEntry> = {}) => store.work.createMemory({
    title: "记录 " + ++number, content: "测试材料 " + number, status: "confirmed", kind: "statement", category: "event",
    occurredAt: "2026-03-12", conversationId: "", runId: "", sources: [], ...patch,
  });
  return { get store() { return store; }, dir, add, restart() { store.close(); store = new Store(dir); } };
}

describe("indexed library enumeration", () => {
  it("enumerates all matching records exactly once, binding cursors to the query and revision", async () => {
    const f = await fixture();
    const ids = f.store.work.transaction(() => Array.from({ length: 123 }, () => f.add({ content: "分页目标材料", people: ["小张"] }).id));
    f.add({ content: "分页目标材料", space: "demo", people: ["小张"] });
    f.add({ content: "别的材料", people: ["小王"] });
    const query = { view: "timeline" as const, query: "目标", person: "小张", from: "2026-01-01", limit: 17 };
    const first = f.store.work.queries.catalog.page(query);
    expect(first.total).toBe(123);
    expect(first.memories).toHaveLength(17);
    const seen = first.memories.map((entry) => entry.id);
    let page = first;
    while (page.nextCursor) {
      page = f.store.work.queries.catalog.page({ ...query, cursor: page.nextCursor });
      expect(page.memories.length).toBeLessThanOrEqual(17);
      seen.push(...page.memories.map((entry) => entry.id));
    }
    expect(new Set(seen).size).toBe(123);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(() => f.store.work.queries.catalog.page({ ...query, person: "小王", cursor: first.nextCursor! })).toThrow("分页条件");
    f.store.work.updateMemory(ids[0], { content: "用户纠正后的材料", people: ["小张"] }, 1);
    expect(() => f.store.work.queries.catalog.page({ ...query, cursor: first.nextCursor! })).toThrow("记忆已更新");
    expect(f.store.work.queries.catalog.page({ ...query, query: "用户纠正" }).memories[0].id).toBe(ids[0]);
  });

  it("indexes exact duplicates, preserving time, review, space and source suppression boundaries", async () => {
    const f = await fixture();
    const source = { assetId: randomUUID(), name: "测试来源", sha256: randomUUID(), start: 0, end: 10 };
    const input = { content: "  ＡＢＣ，今天散步。", occurredAt: "2026-03-12", validity: { precision: "day" as const, from: "2026-03-12" } };
    f.add({ ...input, space: "demo" });
    f.add({ ...input, status: "rejected" });
    f.add({ ...input, occurredAt: "2026-03-13" });
    const expected = f.add({ ...input, content: "abc 今天散步", sources: [source] });
    const shared = f.add({ sources: [source] });
    expect(f.store.work.duplicateMemory(input)?.id).toBe(expected.id);
    f.store.work.forgetMemory(shared.id, 1);
    expect(f.store.work.duplicateMemory(input)).toBeUndefined();
    expect(f.store.work.queries.catalog.page({ view: "forgotten" }).memories.map((entry) => entry.id)).toContain(expected.id);
    expect(f.store.work.queries.catalog.counts().forgotten).toBe(2);
    f.store.work.forgetMemory(shared.id, 2, true);
    expect(f.store.work.queries.catalog.counts().forgotten).toBe(0);
    expect(f.store.work.duplicateMemory(input)?.id).toBe(expected.id);
    expect(() => f.store.work.transaction(() => {
      f.store.work.updateMemory(expected.id, { content: "事务里的修改", status: "rejected" }, 1);
      expect(f.store.work.queries.catalog.counts().rejected).toBe(2);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(f.store.work.duplicateMemory(input)?.version).toBe(1);
    expect(f.store.work.queries.catalog.counts().rejected).toBe(1);
    f.restart();
    expect(f.store.work.duplicateMemory(input)?.id).toBe(expected.id);
  });

  it("pages people without conflating names and limits associated IDs while returning full counts", async () => {
    const f = await fixture();
    const one = f.store.work.memory.savePerson({ name: "小张", aliases: ["张老师"] });
    const two = f.store.work.memory.savePerson({ name: "小张", aliases: [] });
    f.store.work.transaction(() => {
      for (let i = 0; i < 73; i++) f.add({ personIds: [one.id!] });
      f.add({ personIds: [two.id!] });
      f.add({ people: ["小张"] });
      for (let i = 0; i < 70; i++) f.add({ people: ["未核对人物" + i] });
    });
    const page = f.store.work.queries.catalog.people({ limit: 10 });
    expect(page.total).toBe(73);
    expect(page.people[0].id).toBe(one.id);
    expect(page.people[0].memoryCount).toBe(73);
    expect(page.people[0].confirmedCount).toBe(73);
    expect(page.people[0].memoryIds).toHaveLength(50);
    const sameName = f.store.work.queries.catalog.people({ query: "小张" });
    expect(sameName.people).toHaveLength(3);
    expect(sameName.people.filter((person) => person.id)).toHaveLength(2);
    expect(f.store.work.queries.catalog.people({ space: "demo" }).people).toEqual([]);
    const keys: string[] = [];
    let next = page;
    while (true) {
      keys.push(...next.people.map((person) => person.id || person.name));
      if (!next.nextCursor) break;
      next = f.store.work.queries.catalog.people({ limit: 10, cursor: next.nextCursor });
    }
    expect(new Set(keys).size).toBe(73);
    f.store.work.memory.savePerson({ id: one.id, version: one.version, name: "张明", aliases: ["张教授"] });
    expect(f.store.work.searchMemories("", 50, { person: "张老师" })).toEqual([]);
    expect(f.store.work.queries.catalog.page({ person: "张教授" }).total).toBe(73);
  });

  it("rebuilds derived indexes after a backed-up migration without changing memory versions", async () => {
    const f = await fixture();
    const memory = f.add({ content: "迁移保留的数据", people: ["旧人物"] });
    f.store.db.exec("DELETE FROM migrations WHERE version=4; DELETE FROM memory_read; DELETE FROM memory_fts;");
    f.restart();
    await expect(access(join(f.dir, "before-memory-indexes.sqlite"))).resolves.toBeUndefined();
    expect(f.store.work.queries.catalog.page().memories[0].id).toBe(memory.id);
    expect(f.store.work.searchMemories("迁移")[0].version).toBe(1);
    expect(f.store.work.queries.catalog.people().people[0].name).toBe("旧人物");
    expect(f.store.work.versions(memory.id)).toHaveLength(1);
  });

  it("serves paged API views and older record lookups without loading all memories into JS", async () => {
    const f = await fixture();
    const entries = f.store.work.transaction(() => Array.from({ length: 111 }, () => f.add({ status: "draft" })));
    const read = f.store.work.list.bind(f.store.work);
    const spy = vi.spyOn(f.store.work, "list").mockImplementation((kind, conversationId) => {
      if (kind === "memory") throw new Error("Full-memory reads are forbidden on this path");
      return read(kind, conversationId);
    });
    const app = buildApp(readConfig({ MEMORY_DATA_DIR: f.dir }), { store: f.store });
    await app.ready();
    try {
      const response = await app.inject("/api/memory-overview?view=draft&limit=20");
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<MemoryOverview>();
      expect(page.memories).toHaveLength(20);
      expect(page.counts?.draft).toBe(111);
      expect(page.pagination?.total).toBe(111);
      const more = await app.inject("/api/memories?view=draft&limit=20&cursor=" + page.pagination!.nextCursor);
      expect(more.statusCode, more.body).toBe(200);
      expect(more.json<MemoryPage>().memories.some((entry) => page.memories.some((old) => old.id === entry.id))).toBe(false);
      expect((await app.inject("/api/workspace")).json().memories).toHaveLength(50);
      const lookup = await app.inject({ method: "POST", url: "/api/memories/lookup", payload: { ids: [entries[0].id] } });
      expect(lookup.json().memories[0].id).toBe(entries[0].id);
      expect((await app.inject("/api/memory-page?limit=51")).statusCode).toBe(400);
    } finally { spy.mockRestore(); await app.close(); }
  });
});
