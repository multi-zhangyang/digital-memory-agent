import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Asset, MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { MemoryActivities } from "../src/memory/activities.js";
import { MemoryOrganizationService } from "../src/memory/organization-service.js";
import { MemoryImports } from "../src/memory/imports.js";
import { AssetProcessingService } from "../src/memory/asset-processing-service.js";
import { EvidenceService } from "../src/memory/evidence-service.js";
import { MemoryEvents } from "../src/memory/events.js";
import { activityDate, validateActivities, type ActivityExtractionInput, type ActivityExtractionResult } from "../src/memory/activity-extraction.js";
import { MemorySourceVerifier } from "../src/memory/source-verifier.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(organize?: (input: ActivityExtractionInput, signal: AbortSignal) => Promise<ActivityExtractionResult>) {
  const dir = await mkdtemp(join(tmpdir(), "memory-activities-")), store = new Store(dir);
  cleanup.push(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const config = readConfig({ MEMORY_DATA_DIR: dir, MEMORY_LOCAL_FEATURES: "off", MEMORY_OPENAI_API_KEY: "test-only", MEMORY_OPENAI_MODEL: "test-model", MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:1/v1" });
  const activities = new MemoryActivities(store, store.memoryCommands);
  const processors = { organizeActivities: organize || (async (input: ActivityExtractionInput) => ({ activities: [{ title: "公园野餐", summary: "在公园野餐。", occurredAt: input.observations[0].occurredAt,
    place: "公园", members: input.observations.map((m) => m.ref), issues: ["人物身份待核对"], reason: "相同日期和野餐经过，按具体活动关联" }] })) };
  const imports = new MemoryImports(store, config, () => processors);
  const service = new MemoryOrganizationService(store, config, () => processors, activities, new AssetProcessingService(store, config, imports), new EvidenceService(store));
  cleanup.push(async () => { await service.close(); await imports.close(); });
  return { store, activities, service, config };
}
async function source(store: Store, content: string, date = "2026-09-20") {
  const asset: Asset = { id: randomUUID(), name: "生活记录.txt", kind: "text", mimeType: "text/plain", sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, asset.id), content); store.addAsset(asset);
  const memory = store.memories.createMemory({ title: "公园野餐", content, occurredAt: date, status: "draft", kind: "observation", category: "event", conversationId: "", runId: "", space: "personal",
    sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, quote: content }] });
  return { asset, memory };
}
describe("activity organization", () => {
  it("keeps candidates separate, confirms only activity content, and immediately invalidates a derived fact when its source is corrected", async () => {
    const { store, activities } = await fixture(); const { memory } = await source(store, "在公园野餐。");
    const activity = activities.save(activities.candidate({ title: "野餐", summary: "在公园野餐。", occurredAt: memory.occurredAt, place: "公园", issues: [], reason: "素材观察" }, [memory]));
    expect(store.memories.searchMemories("野餐")).toHaveLength(0);
    const input = { action: "confirm-activity" as const, refs: [{ id: activity.id, version: activity.version }], reason: "确认活动内容" };
    const receipt = activities.change(input, { actor: "user", requestKey: "confirm-once" });
    expect(activities.change(input, { actor: "user", requestKey: "confirm-once" }).id).toBe(receipt.id);
    const confirmed = activities.get(activity.id);
    expect(store.memories.get<MemoryEntry>("memory", memory.id)?.status).toBe("draft");
    expect(store.memories.searchMemories("野餐")).toHaveLength(1);
    expect(new MemoryEvents(store).query({ mode: "count" })).toMatchObject({ total: 1 });
    store.memories.updateMemory(memory.id, { content: "纠正：这是植物园的野餐。" }, memory.version);
    expect(activities.get(activity.id)).toMatchObject({ stale: true, summary: "" });
    expect(store.memories.get<MemoryEntry>("memory", confirmed.eventMemoryId!)?.status).toBe("draft");
    expect(store.memories.searchMemories("野餐")).toHaveLength(0);
    expect(() => activities.change({ ...input, refs: [{ id: activity.id, version: confirmed.version }] }, { actor: "user" })).toThrow(/当前来源/);
  });
  it("retains split constraints and refuses stale or out-of-scope commands", async () => {
    const { store, activities, service } = await fixture(); const a = await source(store, "上午在公园野餐。"), b = await source(store, "下午在公园散步。");
    const activity = activities.save(activities.candidate({ title: "公园活动", summary: "两条记录。", occurredAt: a.memory.occurredAt, place: "公园", issues: [], reason: "待核对" }, [a.memory, b.memory]));
    const job = await service.submit({ assetIds: [a.asset.id, b.asset.id] }, { requestId: "before-split", ownership: "library" }); await service.idle();
    expect(() => activities.get(activity.id, [a.asset.id])).toThrow(/范围外/);
    expect(() => activities.change({ action: "confirm-activity", refs: [{ id: activity.id, version: 2 }], reason: "确认" }, { actor: "user" })).toThrow(/更新/);
    activities.change({ action: "split-activity", refs: [{ id: activity.id, version: 1 }], memoryIds: [a.memory.id], reason: "不是同一次活动" }, { actor: "user" });
    expect(activities.list().activities).toHaveLength(2);
    expect(activities.separations()[0].sort()).toEqual([a.memory.id, b.memory.id].sort());
    expect(activities.get(activity.id).status).toBe("superseded");
    expect(activities.current([activity.id]).map((a) => a.id).sort()).toEqual(activities.list().activities.map((a) => a.id).sort());
    expect(activities.current([activity.id], [a.asset.id])).toHaveLength(0);
    expect(service.driver().result(job.id, 0, 10, 12000)).toMatchObject({ total: 2, activities: expect.arrayContaining(activities.list().activities.map((a) => expect.objectContaining({ id: a.id }))) });
  });
  it("keeps form corrections verifiable and removes stopped evidence from current and historical activity views", async () => {
    const { store, activities } = await fixture(); const { memory } = await source(store, "在青禾公园野餐。");
    const activity = activities.save(activities.candidate({ title: "青禾公园野餐", summary: "在青禾公园野餐。", occurredAt: memory.occurredAt, place: "青禾公园", issues: [], reason: "观察" }, [memory]));
    const values = { title: "杉溪公园野餐", summary: "在杉溪公园野餐。", occurredAt: memory.occurredAt, place: "杉溪公园" };
    const input = { action: "correct-activity" as const, refs: [{ id: activity.id, version: 1 }], values, reason: "更正地点" };
    const instruction = store.memoryCommands.recordForm(randomUUID(), JSON.stringify(input));
    expect(() => activities.change({ ...input, values: { ...values, summary: "在青禾公园野餐。" } }, { actor: "user", instruction })).toThrow(/正文/);
    const receipt = activities.change(input, { actor: "user", instruction });
    const corrected = activities.get(activity.id), fact = store.memories.get<MemoryEntry>("memory", corrected.eventMemoryId!)!;
    expect(receipt.after).toContainEqual({ id: fact.id, version: fact.version });
    await expect(new MemorySourceVerifier(store).verify(fact)).resolves.toBeUndefined();
    store.db.prepare("UPDATE memory_command_messages SET text=? WHERE id=?").run("tampered", instruction.messageId);
    await expect(new MemorySourceVerifier(store).verify(fact)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    store.memories.forgetMemory(memory.id, memory.version);
    expect(activities.detail(activity.id)).toMatchObject({ activity: { stale: true, summary: "", sources: [] }, history: [], memories: [] });
  });
  it("normalizes source dates while retaining an explicit user correction", () => {
    const quotes = ["2026年9月20日，在公园野餐。"];
    expect(activityDate({ occurredAt: "" }, quotes)).toBe("2026-09-20");
    expect(activityDate({ occurredAt: "2026-09-21", editedBy: "user" }, quotes)).toBe("2026-09-21");
    expect(activityDate({ occurredAt: "" }, [...quotes, "2026年9月21日再次去公园。"]).length).toBe(0);
  });
  it("organizes incremental batches without a foreground Agent and reuses the same request", async () => {
    let calls = 0;
    const { store, activities, service } = await fixture(async (input) => { calls++; return { activities: [{ title: "公园野餐", summary: "野餐及收拾餐具。", occurredAt: input.observations[0].occurredAt, place: "公园", issues: [], reason: "日期和经过一致", members: input.observations.map((m) => m.ref) }] }; });
    const first = await source(store, "2026-09-20 在公园野餐，带了餐具。");
    const job = await service.submit({ assetIds: [first.asset.id] }, { requestId: "first", ownership: "library" }); await service.idle();
    expect(service.job(job.id).status).toBe("completed");
    expect((await service.submit({ assetIds: [first.asset.id] }, { requestId: "first", ownership: "library" })).id).toBe(job.id);
    expect(calls).toBe(1);
    const second = await source(store, "2026-09-20 公园野餐结束后收拾餐具。");
    const next = await service.submit({ assetIds: [second.asset.id] }, { requestId: "second", ownership: "library" }); await service.idle();
    expect(service.job(next.id)).toMatchObject({ status: "completed", failures: [] });
    expect(activities.list().activities).toHaveLength(1);
    expect(activities.list().activities[0].members).toHaveLength(2);
    // An earlier frozen job cannot disclose sources admitted by a later job.
    expect(service.driver().result(job.id, 0, 10, 12000)).toMatchObject({ total: 0 });
    expect(service.driver().result(next.id, 0, 10, 12000)).toMatchObject({ total: 1, activities: [{ members: expect.arrayContaining([{ id: first.memory.id, version: 1 }, { id: second.memory.id, version: 1 }]) }] });
    expect(store.work.list("run")).toHaveLength(0);
  });
  it("never exposes another library source to a selected-only organization job", async () => {
    const received: ActivityExtractionInput[] = [];
    const { store, service } = await fixture(async (input) => { received.push(input); return { activities: input.requiredRefs.map((ref) => ({ title: "野餐", summary: "候选。", occurredAt: "", place: "", issues: [], reason: "单条来源", members: [ref] })) }; });
    const outside = await source(store, "私有的其他公园野餐记录。");
    await service.submit({ assetIds: [outside.asset.id] }, { requestId: "outside", ownership: "library" }); await service.idle();
    const chosen = await source(store, "此次选中的公园野餐记录。");
    const job = await service.submit({ assetIds: [chosen.asset.id] }, { requestId: "chosen", allowedAssetIds: [chosen.asset.id] }); await service.idle();
    expect(received.at(-1)!.observations.map((o) => o.id)).toEqual([chosen.memory.id]);
    expect(received.at(-1)!.observations[0].sources).toEqual([{ ref: "s1", kind: "text", textRange: { start: 0, end: chosen.asset.size } }]);
    expect(() => service.driver().authorize!(job.id, { scope: "selected", assetIds: [] } as never)).toThrow(/范围/);
    await expect(service.submit({ assetIds: [outside.asset.id] }, { requestId: "forbidden", allowedAssetIds: [chosen.asset.id] })).rejects.toMatchObject({ code: "SOURCE_SCOPE" });
  });
  it("reuses the larger current group when a later model retry returns only a subset", async () => {
    let subset = false, calls = 0;
    const { store, activities, service } = await fixture(async (input) => { calls++; return { activities: [{ title: "公园野餐", summary: "在公园野餐及收拾餐具。", occurredAt: "2026-09-20", place: "公园", issues: [], reason: "同次活动", members: subset ? input.requiredRefs : input.observations.map((m) => m.ref) }] }; });
    const a = await source(store, "在公园野餐。"), b = await source(store, "同一次公园野餐收拾餐具。");
    const first = await service.submit({ assetIds: [a.asset.id, b.asset.id] }, { requestId: "both", ownership: "library" }); await service.idle();
    const larger = activities.list().activities[0]; expect(larger.members).toHaveLength(2);
    subset = true;
    const retry = await service.submit({ assetIds: [b.asset.id] }, { requestId: "later-subset", ownership: "library" }); await service.idle();
    expect(service.job(first.id).status).toBe("completed"); expect(service.job(retry.id).activityIds).toEqual([larger.id]);
    expect(activities.list().activities.map((a) => a.id)).toEqual([larger.id]);
    const maintenance = await service.submit({ assetIds: [a.asset.id, b.asset.id] }, { requestId: "unchanged-maintenance", ownership: "library", maintenance: true }); await service.idle();
    expect(service.job(maintenance.id).status).toBe("completed"); expect(calls).toBe(2);
    activities.change({ action: "reject-activity", refs: [{ id: larger.id, version: larger.version }], reason: "不是同一次" }, { actor: "user" });
    // The model cannot silently undo the user's explicit separation.
    const afterReject = await service.submit({ assetIds: [a.asset.id, b.asset.id] }, { requestId: "after-reject", ownership: "library" }); await service.idle();
    expect(service.job(afterReject.id).status).toBe("failed"); expect(activities.list().activities).toHaveLength(0);
  });
  it("rejects missing evidence, mixed dates and explicit separation even if the model suggests a merge", async () => {
    const base = { modelId: "test", existing: [], separated: [], requiredRefs: ["m1", "m2"], observations: ["2026-09-20", "2026-09-21"].map((date, i) => ({ ref: `m${i + 1}`, id: randomUUID(), version: 1, title: "公园", content: "公园活动", occurredAt: date, place: "", status: "draft", uncertainty: "", entityIds: [], sources: [] })) } satisfies ActivityExtractionInput;
    const proposal = { title: "公园活动", summary: "活动", occurredAt: "", place: "", issues: [], reason: "模型建议", members: ["m1", "m2"] };
    expect(() => validateActivities(base, { activities: [proposal] })).toThrow();
    base.observations[1].occurredAt = base.observations[0].occurredAt;
    expect(() => validateActivities({ ...base, separated: [["m1", "m2"]] }, { activities: [proposal] })).toThrow();
    expect(() => validateActivities(base, { activities: [{ ...proposal, members: ["m1"] }] })).toThrow();
    expect(() => validateActivities(base, { activities: [{ ...proposal, occurredAt: "2020-01-01" }] })).toThrow();
  });
  it("discards a model result when its input was corrected during inference", async () => {
    let revise: () => void = () => undefined;
    const { store, activities, service } = await fixture(async (input) => { revise(); return { activities: [{ title: "野餐", summary: "旧观察", occurredAt: "", place: "", issues: [], reason: "来源", members: input.requiredRefs }] }; });
    const a = await source(store, "公园野餐。");
    revise = () => { store.memories.updateMemory(a.memory.id, { content: "纠正后是散步。" }, a.memory.version); };
    const job = await service.submit({ assetIds: [a.asset.id] }, { requestId: "changed", allowedAssetIds: [a.asset.id] }); await service.idle();
    expect(service.job(job.id).status).toBe("failed");
    expect(activities.list().activities).toHaveLength(0);
  });
  it("keeps undated visual evidence separate from unrelated originals, while retaining regions of the same photo", () => {
    const input: ActivityExtractionInput = { modelId: "test", existing: [], separated: [], requiredRefs: ["m1", "m2"], observations: [
      { ref: "m1", id: "photo", version: 1, title: "杯子", content: "桌上的杯子", occurredAt: "", place: "", status: "draft", uncertainty: "日期地点未知", entityIds: [], sources: [{ ref: "s1", kind: "image" }] },
      { ref: "m2", id: "meal", version: 1, title: "午餐", content: "小馆午餐", occurredAt: "2026-09-21", place: "小馆", status: "draft", uncertainty: "", entityIds: [], sources: [{ ref: "s2", kind: "text" }] },
    ] };
    const proposal = { title: "午餐", summary: "候选", occurredAt: "2026-09-21", place: "小馆", issues: [], reason: "都是餐饮场景", members: ["m1", "m2"] };
    expect(() => validateActivities(input, { activities: [proposal] })).toThrow(/没有共同原件/);
    input.observations[1] = { ...input.observations[1], occurredAt: "", place: "", sources: [{ ref: "s1", kind: "image" }] };
    expect(() => validateActivities(input, { activities: [{ ...proposal, occurredAt: "", place: "" }] })).not.toThrow();
  });
  it("repairs one invalid grouping with specific feedback, and never persists invalid proposals", async () => {
    const inputs: ActivityExtractionInput[] = [];
    let alwaysInvalid = false;
    const { store, service, activities } = await fixture(async (input) => {
      inputs.push(input);
      return { activities: !input.validationFeedback || alwaysInvalid ? [] : input.requiredRefs.map((ref) => ({ title: "野餐", summary: "野餐记录", occurredAt: "", place: "", issues: [], reason: "原件观察", members: [ref] })) };
    });
    const a = await source(store, "公园野餐。");
    const job = await service.submit({ assetIds: [a.asset.id] }, { requestId: "repair", allowedAssetIds: [a.asset.id] }); await service.idle();
    expect(service.job(job.id)).toMatchObject({ status: "completed", validationRetries: 1 });
    expect(inputs).toHaveLength(2);
    expect(inputs[1].validationFeedback).toMatchObject({ reason: expect.stringContaining("遗漏 requiredRefs：m1"), previous: [] });
    expect(inputs[1].observations).toEqual(inputs[0].observations);
    expect(activities.list().activities).toHaveLength(1);
    alwaysInvalid = true;
    const b = await source(store, "2026年9月21日散步。", "2026-09-21");
    const failed = await service.submit({ assetIds: [b.asset.id] }, { requestId: "invalid-twice", allowedAssetIds: [b.asset.id] }); await service.idle();
    expect(service.job(failed.id)).toMatchObject({ status: "failed", validationRetries: 1 });
    expect(inputs).toHaveLength(4);
    expect(activities.list().activities).toHaveLength(1);
  });
});
