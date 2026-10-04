import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Asset, MemoryEntry, Run } from "@memory/contracts";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { MemoryImports } from "../src/memory/imports.js";
import { MemoryCaptures } from "../src/memory/captures.js";
import { AssetProcessingService } from "../src/memory/asset-processing-service.js";
import { DatasetService } from "../src/memory/dataset-service.js";
import type { MemoryProcessors } from "../src/memory/processors.js";
import { createMemoryCommandTools } from "../src/memory-command-tools.js";
import { commandOutput, memoryCommandContext } from "../src/application/memory-command-context.js";
import { TaskContextPolicy } from "../src/application/task-context.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";
import { TaskJobs } from "../src/harness/jobs.js";
import { toolOutput } from "../src/memory-tools.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 600; i++) { const value = await read(); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Test state did not settle");
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agent-first-"));
  const store = new Store(dir);
  store.memories.ledger.setSettings({ capture: "off", intake: "manual" });
  cleanup.push(async () => { if (store.db.isOpen) store.close(); await rm(dir, { recursive: true, force: true }); });
  const config = readConfig({ MEMORY_DATA_DIR: dir, MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:1/v1", MEMORY_OPENAI_API_KEY: "test-only", MEMORY_OPENAI_MODEL: "text-test" });
  const original = config.providers[0];
  config.providers.push({ ...original, id: "photos", model: { ...original.model, id: "photos/photo-test", provider: "photos", name: "photo-test", supportsImages: true } });
  store.memories.ledger.setSettings({ textModelId: original.model.id, photoModelId: "photos/photo-test" });
  return { store, config, dir };
}
async function asset(store: Store, content: string | Buffer, kind: "text" | "image" = "text", name = "资料.txt") {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const value: Asset = { id: randomUUID(), name, kind, mimeType: kind === "text" ? "text/plain" : "image/jpeg", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, value.id), bytes); store.addAsset(value, { processing: "requested" }); return value;
}
async function memory(store: Store, content: string, status: "draft" | "confirmed" = "draft") {
  const source = await asset(store, content);
  return store.memories.createMemory({ title: "原始记录", content, status, kind: "observation", occurredAt: "", category: "fact", sources: [
    { assetId: source.id, name: source.name, sha256: source.sha256, start: 0, end: source.size, quote: content }], conversationId: "", runId: "", ...(status === "confirmed" ? { acceptedBy: "user" as const } : {}) });
}
function run(store: Store, text: string, assetIds?: string[], extra: Partial<Run> = {}) {
  const conversation = store.createConversation();
  const current = store.work.createRun(conversation.id, { text, modelId: "openai-compatible/text-test", scope: assetIds ? "selected" : "library", assetIds, permissionMode: "auto", useMemory: true, captureMemory: false });
  return store.work.patchRun(current.id, { status: "running", ...extra });
}
const textResult = (text: string) => ({ entries: [{ title: "文字观察", content: text, quote: text, category: "fact" as const, kind: "observation" as const,
  occurredAt: "", people: [], place: "", uncertainty: "", attribute: null }], usage: { input: 1, output: 1 } });

describe("Agent-first services with explicit processor doubles", () => {
  it("accepts attachments without invented user text and never captures the default goal", async () => {
    const { store, config } = await fixture();
    const source = await asset(store, "待整理的文字。");
    const current = run(store, "", [source.id], { captureMemory: true });
    expect(current.text).toBe(""); expect(current.goal).toContain("整理本次");
    const captures = new MemoryCaptures(store, config, () => ({}), () => false);
    cleanup.push(() => captures.close());
    expect(captures.enqueue(current)).toBeUndefined(); expect(captures.jobs()).toHaveLength(0);
    expect(await new TaskContextPolicy(store).completion(current.conversationId, { runId: current.id })).toMatchObject({ code: "DELIVERY_INCOMPLETE" });
    expect(() => store.work.createRun(current.conversationId, { text: "  ", modelId: current.modelId })).toThrow("内容或添加资料");
  });

  it("processes mixed media with separate models, isolates a bad file, and reports duplicates and every asset", async () => {
    const { store, config } = await fixture();
    const calls: { kind: string; modelId: string }[] = [];
    const processors: MemoryProcessors = {
      extractMemories: async (input) => { calls.push({ kind: "text", modelId: input.modelId }); return textResult(input.text); },
      extractPhotoMemories: async (input) => { calls.push({ kind: "image", modelId: input.modelId }); return { entries: [], usage: { input: 1, output: 1 } }; },
    };
    const imports = new MemoryImports(store, config, () => processors); cleanup.push(() => imports.close());
    const processing = new AssetProcessingService(store, config, imports);
    const text = await asset(store, "文字资料。"), bad = await asset(store, Buffer.from([255, 254]));
    const photo = await asset(store, await sharp({ create: { width: 16, height: 12, channels: 3, background: "white" } }).jpeg().toBuffer(), "image", "照片.jpg");
    const duplicate = await asset(store, "文字资料。", "text", "相同副本.txt");
    const ids = [text.id, bad.id, photo.id, duplicate.id];
    const job = await processing.submit({ assetIds: ids }, { requestId: "mixed", allowedAssetIds: ids });
    await waitFor(() => imports.job(job.id), (value) => value.status === "failed");
    expect(calls).toEqual(expect.arrayContaining([{ kind: "text", modelId: "openai-compatible/text-test" }, { kind: "image", modelId: "photos/photo-test" }]));
    expect(calls).toHaveLength(2);
    const driver = processing.driver();
    expect(driver.get(job.id).coverage).toEqual({ total: 4, completed: 2, reused: 1, failed: 1, pending: 0, blocked: 0 });
    const first = driver.result(job.id, 0, 2, 12000, "assets") as { assets: { assetId: string }[]; nextAssetOffset: number };
    const second = driver.result(job.id, first.nextAssetOffset, 2, 12000, "assets") as { assets: { assetId: string }[]; nextAssetOffset: null };
    expect([...first.assets, ...second.assets].map((value) => value.assetId)).toEqual(ids);
    expect(second.nextAssetOffset).toBeNull();
    expect(store.memories.list<MemoryEntry>("memory").every((entry) => entry.status === "draft")).toBe(true);
    const attached = run(store, "重试失败资料", ids);
    const jobs = new TaskJobs(store); jobs.register("memory-import", driver); cleanup.push(() => jobs.close());
    jobs.attach(attached.id, "memory-import", job.id, "submit", "library");
    jobs.manage(attached.id, job.id, "retry", "retry", [bad.id]);
    await waitFor(() => imports.job(job.id), (value) => value.status === "failed");
    expect(calls).toHaveLength(2);
    expect(() => jobs.manage(attached.id, job.id, "retry", "again")).toThrow("已重试");
  });

  it("re-prepares and splits a previously unavailable text modality after configuration is fixed", async () => {
    const { store, config } = await fixture();
    store.memories.ledger.setSettings({ textModelId: "missing/text" });
    const textInputs: string[] = [];
    const processors: MemoryProcessors = { extractMemories: async (input) => { textInputs.push(input.text); return { entries: [], usage: { input: 1, output: 1 } }; },
      extractPhotoMemories: async () => ({ entries: [], usage: { input: 1, output: 1 } }) };
    const imports = new MemoryImports(store, config, () => processors); cleanup.push(() => imports.close());
    const processing = new AssetProcessingService(store, config, imports);
    const text = await asset(store, "长文字段。".repeat(1100));
    const photo = await asset(store, await sharp({ create: { width: 16, height: 12, channels: 3, background: "black" } }).jpeg().toBuffer(), "image");
    const job = await processing.submit({ assetIds: [text.id, photo.id] }, { requestId: "modality" });
    await waitFor(() => imports.job(job.id), (value) => value.status === "failed");
    expect(textInputs).toHaveLength(0);
    store.memories.ledger.setSettings({ textModelId: "openai-compatible/text-test" });
    imports.retry(job.id, [text.id]);
    const done = await waitFor(() => imports.job(job.id), (value) => value.status === "completed");
    expect(textInputs.length).toBeGreaterThan(1);
    expect(textInputs.every((value) => value.length <= 2200)).toBe(true);
    expect(textInputs.join("")).toBe("长文字段。".repeat(1100));
    expect(done.chunks.every((chunk) => !chunk.preparationFailed)).toBe(true);
  });

  it("reports a stopped source separately and still processes the other file", async () => {
    const { store, config } = await fixture();
    const stopped = await memory(store, "这份资料已停止取用。", "confirmed");
    store.memories.forgetMemory(stopped.id, stopped.version);
    const available = await asset(store, "另一份可以整理的资料。");
    const inputs: string[] = [];
    const imports = new MemoryImports(store, config, () => ({ extractMemories: async (input) => { inputs.push(input.text); return textResult(input.text); } }));
    cleanup.push(() => imports.close());
    const service = new AssetProcessingService(store, config, imports);
    const job = await service.submit({ assetIds: [stopped.sources[0].assetId, available.id] }, { requestId: "partial-stopped" });
    await waitFor(() => imports.job(job.id), (value) => value.status === "completed");
    expect(inputs).toEqual(["另一份可以整理的资料。"]);
    expect(service.driver().get(job.id).coverage).toMatchObject({ total: 2, completed: 1, blocked: 1, failed: 0 });
  });

  it("enforces current scope, version, actual instruction and distinct user/Agent authorship", async () => {
    const { store } = await fixture();
    const draft = await memory(store, "原始的观察。"), outside = await memory(store, "范围外的观察。");
    const current = run(store, "确认这份资料的记录", [draft.sources[0].assetId]);
    const change = { action: "confirm" as const, entries: [{ id: draft.id, version: 1 }], reason: "用户明确确认" };
    expect(() => memoryCommandContext(store, current, "bad", change, "user", "用户从未发送的原话")).toThrow("实际送达");
    const generic = { ...current, text: "整理这份资料" };
    expect(() => memoryCommandContext(store, generic, "bad", change, "user", generic.text)).toThrow("未明确指定");
    const context = memoryCommandContext(store, current, "confirm", change, "user", current.text);
    expect(() => store.memoryCommands.change({ ...change, entries: [{ id: outside.id, version: 1 }] }, context)).toThrow("范围外");
    expect(() => store.memoryCommands.change({ ...change, entries: [{ id: draft.id, version: 99 }] }, context)).toThrow("已更新");
    const receipt = store.memoryCommands.change(change, context);
    expect(receipt).toMatchObject({ actor: "user", instruction: { messageId: current.id, quote: current.text }, after: [{ id: draft.id, version: 2 }] });
    expect(store.work.get<Run>("run", current.id)?.memoryEpoch).toBe(store.memories.ledger.epoch);
    expect(store.memoryCommands.change(change, context).id).toBe(receipt.id);
    expect(store.memories.get<MemoryEntry>("memory", draft.id)?.version).toBe(2);
    expect(() => store.memoryCommands.change({ ...change, entries: [{ id: outside.id, version: 1 }] }, { actor: "agent" })).toThrow("明确指令");
    const correction = { action: "correct" as const, entries: [{ id: outside.id, version: 1, patch: { content: "对照原件修订的观察。" } }], reason: "对照原件" };
    expect(() => store.memoryCommands.change(correction, { actor: "agent" })).toThrow("读取对应原件");
    // Trusted service context; persisted Pi reads are exercised separately below.
    const source = outside.sources[0];
    expect(await readFile(join(store.assetsDir, source.assetId), "utf8")).toBe(outside.content);
    const edited = store.memoryCommands.change(correction, { actor: "agent", sourceReads: [{ toolCallId: "original-read", assetId: source.assetId,
      sha256: source.sha256, start: source.start, end: source.end, kind: "text" }] });
    expect((edited.result as { memories: MemoryEntry[] }).memories[0]).toMatchObject({ status: "draft", editedBy: "agent" });
    expect((edited.result as { memories: MemoryEntry[] }).memories[0].acceptedBy).toBeUndefined();
  });

  it("scopes the full inspection before pagination and masks forgotten content", async () => {
    const { store } = await fixture();
    const target = await memory(store, "这条在所选范围内。");
    for (let i = 0; i < 24; i++) await memory(store, `范围外的较新记录 ${i}`);
    const current = run(store, "查看所选记录", [target.sources[0].assetId]);
    const inspect = createMemoryCommandTools(store, current.conversationId)[0];
    const result = toolOutput(await inspect.execute("inspect", { limit: 1 }, undefined, undefined, {} as never)) as { total: number; memories: MemoryEntry[] };
    expect(result.total).toBe(1); expect(result.memories[0].id).toBe(target.id);
    const stopped = store.memories.forgetMemory(target.id, 1);
    store.work.patchRun(current.id, { memoryEpoch: store.memories.ledger.epoch });
    const forgotten = toolOutput(await inspect.execute("inspect-forgotten", { view: "forgotten" }, undefined, undefined, {} as never));
    expect(forgotten).toMatchObject({ memories: [{ id: stopped.id, version: 2, stopped: true }] });
    expect(JSON.stringify(forgotten)).not.toContain(target.content);
  });

  it("binds short references to the inspected version and run, and preserves them across restart", async () => {
    const { store, dir } = await fixture();
    const initial = await memory(store, "用短引用确认的记录。");
    const draft = store.memories.updateMemory(initial.id, { uncertainty: "等待用户核对" }, initial.version, "agent");
    const current = run(store, "确认这条记录", [draft.sources[0].assetId]);
    const tools = createMemoryCommandTools(store, current.conversationId);
    const inspected = toolOutput(await tools[0].execute("inspect", { ids: [draft.id] }, undefined, undefined, {} as never)) as { memories: { ref: string; id: string; version: number }[] };
    const reference = inspected.memories[0];
    expect(reference.ref).toBe("m1");
    expect(() => store.work.resolveRecordRef("another-run", "memory", { ref: reference.ref })).toThrow("不属于本次任务");
    expect(() => store.work.resolveRecordRef(current.id, "memory", { ref: reference.ref, version: 99 })).toThrow("版本不一致");
    const result = toolOutput(await tools[1].execute("confirm", { action: "confirm", entries: [{ ref: reference.ref, patch: { uncertainty: "" } }], basis: "user", instructionQuote: current.text, reason: "用户确认并解除待核对的不确定性" }, undefined, undefined, {} as never)) as { current: { ref: string; version: number; uncertainty: string; status: string }[] };
    expect(result.current[0]).toMatchObject({ ref: "m2", version: 3, uncertainty: "", status: "confirmed" });
    expect(store.work.resolveRecordRef(current.id, "memory", { ref: reference.ref })).toEqual({ id: draft.id, version: 2 });
    const reopened = new Store(dir);
    try { expect(reopened.work.resolveRecordRef(current.id, "memory", { ref: "m2" })).toEqual({ id: draft.id, version: 3 }); }
    finally { reopened.close(); }
  });

  it("accepts absent optional search filters as null and still enforces stopped-source exclusion", async () => {
    const { store } = await fixture();
    const fact = await memory(store, "书房抽屉的编号是 KD41。", "confirmed");
    const current = run(store, "查询书房抽屉");
    const search = createWorkspaceTools(store, current.conversationId).find((tool) => tool.name === "search_memories")!;
    const query = { query: "书房抽屉", person: null, personId: null, eventId: null, category: null, from: null, to: null, includeHistorical: null, limit: null };
    const before = toolOutput(await search.execute("search", query, undefined, undefined, {} as never));
    expect(JSON.stringify(before)).toContain("KD41");
    store.memories.forgetMemory(fact.id, fact.version);
    store.work.patchRun(current.id, { memoryEpoch: store.memories.ledger.epoch });
    const after = toolOutput(await search.execute("search-after", query, undefined, undefined, {} as never));
    expect(JSON.stringify(after)).not.toContain("KD41");
    expect(after).toMatchObject({ memories: [] });
  });

  it("rolls back a batch including its audit/epoch when any version or fact conflicts", async () => {
    const { store } = await fixture();
    const a = await memory(store, "一号观察。"), b = await memory(store, "二号观察。");
    const epoch = store.memories.ledger.epoch;
    expect(() => store.memoryCommands.change({ action: "confirm", entries: [{ id: a.id, version: 1 }, { id: b.id, version: 2 }], reason: "批量确认" }, { actor: "user" })).toThrow("已更新");
    expect(store.memories.get<MemoryEntry>("memory", a.id)?.version).toBe(1);
    expect(store.memories.ledger.epoch).toBe(epoch);
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_commands").get()).toMatchObject({ n: 0 });
  });

  it("refuses stopped/read-only tools and does not use stopped facts in replayed command output", async () => {
    const { store } = await fixture();
    const draft = await memory(store, "不能重新泄露的记录。");
    const current = run(store, "确认记录", undefined, { permissionMode: "read" });
    const tool = createMemoryCommandTools(store, current.conversationId)[1];
    await expect(tool.execute("deny", { action: "confirm", entries: [{ id: draft.id, version: 1 }], reason: "明确确认", basis: "user", instructionQuote: current.text }, undefined, undefined, {} as never)).rejects.toThrow("只读");
    store.work.patchRun(current.id, { status: "stopped" });
    await expect(tool.execute("deny", { action: "confirm", entries: [{ id: draft.id, version: 1 }], reason: "明确确认", basis: "user", instructionQuote: current.text }, undefined, undefined, {} as never)).rejects.toThrow("已结束");
    const change = { action: "confirm" as const, entries: [{ id: draft.id, version: 1 }], reason: "用户确认" };
    const receipt = store.memoryCommands.change(change, { actor: "user", requestKey: "stable" });
    store.memories.forgetMemory(draft.id, 2);
    expect(JSON.stringify(commandOutput(store, receipt, { actor: "user" }))).not.toContain(draft.content);
  });

  it("carries a sourced preference into a new task and replaces or removes it after user commands", async () => {
    const { store, config } = await fixture();
    store.memories.ledger.setSettings({ capture: "graded" });
    const quote = "我喜欢按日期从新到旧整理。";
    const initial = run(store, quote, undefined, { status: "completed", captureMemory: true });
    const captures = new MemoryCaptures(store, config, () => ({ captureMemories: async () => ({ entries: [{ title: "整理偏好", content: quote, quote,
      category: "profile", kind: "statement", personal: true, direct: true, identityClaim: false, people: [], place: "", uncertainty: "", timeExpression: "",
      attribute: null, duplicateOf: null, conflictIds: [] }], usage: { input: 1, output: 1 } }) }), () => false);
    cleanup.push(() => captures.close());
    const capture = captures.enqueue(initial)!; captures.wake();
    await waitFor(() => captures.job(capture.id), (job) => job.status === "completed");
    const preference = store.memories.list<MemoryEntry>("memory")[0];
    expect(preference).toMatchObject({ status: "confirmed", category: "profile", acceptedBy: "policy", evidence: [{ type: "message", runId: initial.id }] });
    const policy = new TaskContextPolicy(store);
    const next = run(store, "请整理新资料");
    const prepared = await policy.prepare(next.conversationId, next.text, { contextWindow: 32000, maxTokens: 4000 }, { runId: next.id });
    expect(prepared?.content).toContain("从新到旧");
    const correction = run(store, "把整理排序改为从旧到新。");
    const change = { action: "correct" as const, entries: [{ id: preference.id, version: preference.version, patch: { content: "我喜欢按日期从旧到新整理。" } }], reason: "用户更改排序偏好" };
    store.memoryCommands.change(change, memoryCommandContext(store, correction, "correct-preference", change, "user", correction.text));
    const refreshed = await policy.replacement(correction.conversationId);
    expect(refreshed?.content).toContain("从旧到新"); expect(refreshed?.content).not.toContain("从新到旧");
    const stopped = run(store, "忘记排序偏好。");
    const forget = { action: "forget" as const, entries: [{ id: preference.id, version: preference.version + 1 }], reason: "用户停止取用偏好" };
    store.memoryCommands.change(forget, memoryCommandContext(store, stopped, "forget-preference", forget, "user", stopped.text));
    const later = run(store, "继续整理资料");
    const without = await policy.prepare(later.conversationId, later.text, { contextWindow: 32000, maxTokens: 4000 }, { runId: later.id });
    expect(without?.content).not.toContain("从旧到新"); expect(without?.content).not.toContain("从新到旧");
  });

  it("exports the actual correction instruction lineage and invalidates files if its message is removed", async () => {
    const { store, dir } = await fixture();
    const fact = await memory(store, "储物盒编号是 A1。", "confirmed");
    const current = run(store, "把储物盒编号改为 B2。", [fact.sources[0].assetId]);
    const change = { action: "correct" as const, entries: [{ id: fact.id, version: fact.version, patch: { content: "储物盒编号是 B2。" } }], reason: "用户纠正编号" };
    const receipt = store.memoryCommands.change(change, memoryCommandContext(store, current, "correct-number", change, "user", current.text));
    const service = new DatasetService(store); cleanup.push(() => service.close());
    const job = service.submit({ requestKey: "corrected-data", scope: { memoryIds: [fact.id] } }, current.assetIds); await service.idle();
    expect((await service.delivery(job.id)).verified).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, "datasets", job.id, "manifest.json"), "utf8"));
    expect(manifest.commands).toMatchObject([{ id: receipt.id, actor: "user", instruction: { quote: current.text, runId: current.id } }]);
    expect(manifest.inputs[0].dependencies).toEqual(expect.arrayContaining([{ kind: "memory-command", parentId: receipt.id, parentVersion: "1" },
      { kind: "message-run", parentId: current.id, parentVersion: receipt.instruction!.sha256 }]));
    store.db.prepare("DELETE FROM workspace_records WHERE id=? AND kind='run'").run(current.id);
    expect(service.ledger.get(job.id).stale).toBe(true);
    await expect(service.download(job.id, "training")).rejects.toThrow("修订");
  });

  it("excludes unusable samples and keeps their review audit out of training exports", async () => {
    const { store, dir } = await fixture();
    const fact = await memory(store, "林青在周一把蓝色手册交给许禾。", "confirmed");
    const service = new DatasetService(store, () => ({ generateDatasetQuestions: async () => ({ training: [
      { question: "谁把手册交给许禾？", answerQuote: "林青" }, { question: "手册交接发生在哪一天？", answerQuote: "周一" }],
      evaluation: [{ trainingIndex: 0, question: "许禾是从谁那里接过手册的？", answerQuote: "林青" }], usage: { input: 1, output: 1 } }) }));
    cleanup.push(() => service.close());
    const job = service.submit({ requestKey: "exclude-data", modelId: "generator", scope: { memoryIds: [fact.id] } }); await service.idle();
    const current = run(store, "检查样本");
    const inspected = await service.inspect(job.id, { runId: current.id });
    const unchanged = inspected.samples.find((sample) => sample.answer === "林青")!;
    await expect(service.changeSamples(job.id, [{ id: unchanged.id, version: unchanged.version, action: "approve", answer: "许禾" }], "不能用批准偷偷改答案", { actor: "agent", runId: current.id })).rejects.toThrow("revise");
    await service.changeSamples(job.id, inspected.samples.map((sample) => ({ id: sample.id, version: sample.version,
      action: sample.answer === "周一" ? "exclude" : "approve", question: sample.question, answer: sample.answer })), "排除缺少具体日期的问题，其余人物方向已核对", { actor: "agent", runId: current.id });
    await service.idle();
    const delivery = await service.delivery(job.id);
    expect(delivery.sampleCounts).toEqual({ ready: 2, review: 0, excluded: 1 });
    expect(delivery.files.find((file) => file.kind === "training")?.records).toBe(1);
    const review = JSON.parse((await readFile(join(dir, "datasets", job.id, "review.jsonl"), "utf8")).trim());
    expect(review).toMatchObject({ status: "excluded", review: { actor: "agent", runId: current.id } });
  });

  it("requires sample inspection, rejects ungounded/meaningless QA, revises and delivers real files with an Agent audit", async () => {
    const { store, dir } = await fixture();
    const fact = await memory(store, "2026年9月3日，林青把蓝色手册交给许禾，她把手册放进抽屉。", "confirmed");
    const service = new DatasetService(store, () => ({ generateDatasetQuestions: async () => ({
      training: [{ question: "谁把蓝色手册交给许禾？", answerQuote: "她" }, { question: "林青交给许禾的是什么？", answerQuote: "蓝色手册" }],
      evaluation: [{ trainingIndex: 0, question: "许禾从谁手中收到蓝色手册？", answerQuote: "她" }], usage: { input: 1, output: 1 },
    }) }));
    cleanup.push(() => service.close());
    const job = service.submit({ requestKey: "review-flow", modelId: "generator", scope: { memoryIds: [fact.id] } }); await service.idle();
    const samples = service.ledger.samples(job.id);
    const current = run(store, "请核对并修订训练样本");
    const context = { actor: "agent" as const, runId: current.id, requestKey: "review-samples" };
    const changes = samples.map((sample) => ({ id: sample.id, version: sample.version, action: "revise" as const, answer: sample.answer === "她" ? "林青" : sample.answer }));
    await expect(service.changeSamples(job.id, changes, "根据正文核对人物和动作方向", context)).rejects.toThrow("先在本次任务中读取");
    await service.inspect(job.id, { runId: current.id });
    const pronoun = samples.find((sample) => sample.answer === "她")!;
    await expect(service.changeSamples(job.id, [{ id: pronoun.id, version: 1, action: "approve" }], "检查原文", context)).rejects.toThrow("代词");
    await expect(service.changeSamples(job.id, [{ id: pronoun.id, version: 1, action: "revise", answer: "不存在的名字" }], "错误修订", context)).rejects.toThrow("冻结");
    await expect(service.changeSamples(job.id, [{ id: pronoun.id, version: 1, action: "revise", question: "林青是谁？", answer: "林青" }], "泄露答案", context)).rejects.toThrow("透露完整答案");
    const receipt = await service.changeSamples(job.id, changes, "根据正文核对人物和动作方向", context); await service.idle();
    expect((await service.changeSamples(job.id, changes, "根据正文核对人物和动作方向", context)).id).toBe(receipt.id); await service.idle();
    const reviewed = service.ledger.samples(job.id);
    expect(reviewed.every((sample) => sample.version === 2 && sample.status === "ready" && sample.authority === "agent-reviewed" && sample.review?.actor === "agent")).toBe(true);
    const delivery = await service.delivery(job.id);
    expect(delivery).toMatchObject({ verified: true, partial: false, trainingStarted: false });
    expect(delivery.files.find((file) => file.kind === "training")?.records).toBe(2);
    expect(delivery.files.find((file) => file.kind === "evaluation")?.records).toBe(1);
    const training = (await readFile(join(dir, "datasets", job.id, "training.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(training.every((sample) => sample.lineage.authority === "agent-reviewed" && sample.review.actor === "agent")).toBe(true);
    const epoch = store.memories.ledger.epoch;
    store.memories.updateMemory(fact.id, { content: "已纠正的不同经历。" }, fact.version);
    expect(store.memories.ledger.epoch).toBeGreaterThan(epoch);
    await expect(service.delivery(job.id)).rejects.toThrow("修订");
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()).toMatchObject({ n: 0 });
  });
});

type ModelRequest = { messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }[] };
async function piFixture(respond: (request: ModelRequest, index: number) => unknown | Promise<unknown>, vision = false) {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const supplier = Fastify();
  supplier.post<{ Body: ModelRequest }>("/v1/chat/completions", async (request, reply) => {
    requests.push(request.body); const delta = await respond(request.body, requests.length);
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (value: unknown, reason: string | null) => "data: " + JSON.stringify({ id: "agent-first-protocol", object: "chat.completion.chunk", created: 1,
      model: "text-test", choices: [{ index: 0, delta: value, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + "\n\n";
    reply.raw.end(frame(delta, null) + frame({}, delta && typeof delta === "object" && "tool_calls" in delta ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  const url = await supplier.listen({ host: "127.0.0.1", port: 0 }); cleanup.push(() => supplier.close());
  f.config.providers[0].baseUrl = url + "/v1";
  f.config.providers[0].model.supportsImages = vision;
  let app = buildApp(f.config, { store: f.store }); await app.ready(); cleanup.push(() => app.close());
  return { ...f, app, requests, async start(text: string, assetIds?: string[]) {
    const conversation = f.store.createConversation();
    const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
      text, modelId: f.config.providers[0].model.id, permissionMode: "auto", useMemory: true, captureMemory: false, assetIds, scope: assetIds ? "selected" : "library",
    } });
    expect(response.statusCode, response.body).toBe(201); return response.json<{ run: Run }>().run;
  } };
}
const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });

describe("Agent-first commands through the real Pi loop and controlled provider", () => {
  it("continues the same Pi session when a requested result was omitted, then saves actual read sources", async () => {
    let original: Asset;
    const f = await piFixture((request, index) => {
      if (index === 1) return call("read_asset_text", { assetId: original.id });
      if (index === 2) return { content: "2026年9月3日，林青整理了照片。" };
      if (index === 3) {
        expect(JSON.stringify(request.messages)).toContain("本任务实际保存的结果数为 0");
        expect(JSON.stringify(request.messages)).toContain(original.sha256);
        return call("write_artifact", { title: "照片整理记录", content: "2026年9月3日，林青整理了照片。", sourceAssetIds: [original.id] });
      }
      return { content: "整理结果已保存，引用了本轮读取的文字原件。" };
    });
    original = await asset(f.store, "2026年9月3日，林青整理了照片。");
    const initial = await f.start("请整理这份文字，保存简短结果。", [original.id]);
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status, JSON.stringify(finished.parts)).toBe("completed");
    expect(f.requests).toHaveLength(4);
    const artifacts = f.store.work.list<Artifact>("artifact", initial.conversationId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ runId: initial.id, content: "2026年9月3日，林青整理了照片。", sources: [{ assetId: original.id, sha256: original.sha256 }] });
    expect(finished.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notice", state: "complete", text: "交付检查结束" }),
      expect.objectContaining({ type: "tool", name: "write_artifact", state: "complete" })]));
    const history = await readFile(join(f.dir, "sessions", initial.conversationId + ".jsonl"), "utf8");
    expect(history).toContain("digital-memory-delivery-check");
    expect(history).toContain("照片整理记录");
  });

  it("reports a missing saved result after one continuation and does not invent an artifact or loop", async () => {
    const f = await piFixture(() => ({ content: "这里只给出聊天回复。" }));
    const initial = await f.start("整理成报告并保存结果。");
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status).toBe("failed");
    expect(f.requests).toHaveLength(2);
    expect(f.store.work.list("artifact", initial.conversationId)).toHaveLength(0);
    expect(finished.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notice", state: "error", text: "交付尚未完成" })]));
    expect(JSON.stringify(finished)).toContain("用户要求的保存或确认尚未全部完成");
  });

  it("checks only the current delivered saving request and defers while background work is pending", async () => {
    const { store } = await fixture();
    const previous = run(store, "上一轮已保存。");
    store.work.writeArtifact({ conversationId: previous.conversationId, runId: previous.id, title: "上一轮", content: "历史整理结果。", sources: [], author: "agent" });
    store.work.patchRun(previous.id, { status: "completed" });
    const created = store.work.createRun(previous.conversationId, { text: "请整理文字，保存一份结果。", modelId: previous.modelId, permissionMode: "auto" });
    const current = store.work.patchRun(created.id, { status: "running" });
    const policy = new TaskContextPolicy(store), options = { runId: current.id };
    expect(await policy.completion(current.conversationId, options)).toMatchObject({ code: "DELIVERY_INCOMPLETE" });
    store.work.patchRun(current.id, { jobs: [{ id: "background", kind: "memory-import", toolCallId: "submit", status: "running", title: "整理资料",
      revision: 1, progress: { completed: 0, total: 1, failed: 0 }, updatedAt: new Date().toISOString() }] });
    expect(await policy.completion(current.conversationId, options)).toBeUndefined();
    store.work.patchRun(current.id, { jobs: [], interventions: [{ id: "cancel-saving", text: "不用保存，只回复即可。", status: "delivered", createdAt: new Date().toISOString() }] });
    expect(await policy.completion(current.conversationId, options)).toBeUndefined();
    store.work.patchRun(current.id, { interventions: [
      { id: "cancel-saving", text: "不用保存，只回复即可。", status: "delivered", createdAt: new Date().toISOString() },
      { id: "queued-saving", text: "请保存整理结果。", status: "queued", createdAt: new Date().toISOString() },
    ] });
    expect(await policy.completion(current.conversationId, options)).toBeUndefined();
    store.work.patchRun(current.id, { interventions: [{ id: "resume-saving", text: "请保存整理结果。", status: "delivered", createdAt: new Date().toISOString() }] });
    expect(await policy.completion(current.conversationId, options)).toMatchObject({ code: "DELIVERY_INCOMPLETE" });
    store.work.writeArtifact({ conversationId: current.conversationId, runId: current.id, title: "本轮", content: "本轮整理结果。", sources: [], author: "agent" });
    expect(await policy.completion(current.conversationId, options)).toBeUndefined();
  });

  it("continues an explicitly authorized selected batch confirmation when one candidate was omitted", async () => {
    let first: MemoryEntry, second: MemoryEntry;
    const instruction = "我确认所选资料的全部候选入库。";
    const f = await piFixture((request, index) => {
      if (index === 1 || index === 3) {
        if (index === 3) expect(JSON.stringify(request.messages)).toContain("仍有 1 条待核对记录");
        return call("change_memories", { action: "confirm", entries: [{ id: index === 1 ? first.id : second.id, version: 1 }],
          basis: "user", instructionQuote: instruction, reason: "用户明确确认所选资料全部候选" });
      }
      return { content: "所选资料的候选已经确认。" };
    });
    first = await memory(f.store, "2026年9月3日整理照片。"); second = await memory(f.store, "2026年9月8日扫描底片。");
    const initial = await f.start(instruction, [first.sources[0].assetId, second.sources[0].assetId]);
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status, finished.error).toBe("completed");
    expect(f.requests).toHaveLength(4);
    expect(f.store.memories.get<MemoryEntry>("memory", first.id)?.status).toBe("confirmed");
    expect(f.store.memories.get<MemoryEntry>("memory", second.id)?.status).toBe("confirmed");
    expect(f.store.memoryCommands.receipts(initial.id)).toHaveLength(2);
    const partial = run(f.store, "我只确认第一条记录属实。", [first.sources[0].assetId, second.sources[0].assetId]);
    expect(await new TaskContextPolicy(f.store).completion(partial.conversationId, { runId: partial.id })).toBeUndefined();
    const leftover = await memory(f.store, "尚未获得确认的第三条。");
    for (const text of ["请确认这份资料的候选中的第一条。", "如何确认所选资料的全部候选入库？"]) {
      const limited = run(f.store, text, [leftover.sources[0].assetId]);
      expect(await new TaskContextPolicy(f.store).completion(limited.conversationId, { runId: limited.id })).toBeUndefined();
    }
  });

  it("confirms an explicit own-profile correction from a draft while retaining observation and conflict boundaries", async () => {
    const { store } = await fixture();
    const origin = run(store, "我喜欢按日期从新到旧整理。");
    const quote = origin.text;
    const preference = store.memories.createMemory({ title: "整理顺序", content: quote, status: "draft", kind: "statement", category: "profile", sources: [],
      evidence: [{ type: "message", messageId: origin.id, conversationId: origin.conversationId, runId: origin.id,
        sha256: createHash("sha256").update(quote).digest("hex"), start: 0, end: Buffer.byteLength(quote), quote }], occurredAt: "", conversationId: origin.conversationId, runId: origin.id });
    store.work.patchRun(origin.id, { status: "completed" });
    const instruction = "把我的整理顺序改为按日期从旧到新，以后都采用这个新顺序。";
    const current = run(store, instruction);
    const change = { action: "correct" as const, entries: [{ id: preference.id, version: 1, patch: { content: "我喜欢按日期从旧到新整理。" } }], reason: "用户明确纠正自己的长期偏好" };
    const receipt = store.memoryCommands.change(change, memoryCommandContext(store, current, "correct-profile", change, "user", instruction));
    expect(store.memories.get<MemoryEntry>("memory", preference.id)).toMatchObject({ status: "confirmed", editedBy: "user", acceptedBy: "user", version: 2 });
    expect(receipt).toMatchObject({ actor: "user", before: [{ id: preference.id, version: 1 }], after: [{ id: preference.id, version: 2 }], instruction: { quote: instruction } });
    expect(store.memories.queries.forTask("整理文字", { enabled: true, maxBytes: 6000 }).entries.some((entry) => entry.id === preference.id)).toBe(true);
    const rawObservation = await memory(store, "图片显示一个蓝色盒子。");
    const correction = { action: "correct" as const, entries: [{ id: rawObservation.id, version: 1, patch: { content: "盒子是绿色。" } }], reason: "只纠正观察" };
    store.memoryCommands.change(correction, { actor: "user", instruction: receipt.instruction });
    expect(store.memories.get<MemoryEntry>("memory", rawObservation.id)?.status).toBe("draft");
    const existing = store.memories.createMemory({ title: "职业", content: "我是设计师。", status: "confirmed", kind: "statement", category: "profile",
      attribute: { key: "occupation", value: "设计师" }, evidence: preference.evidence, sources: [], occurredAt: "", conversationId: current.conversationId, runId: current.id });
    const candidate = store.memories.createMemory({ title: "职业候选", content: "我是工程师。", status: "draft", kind: "statement", category: "profile",
      attribute: { key: "occupation", value: "工程师" }, evidence: preference.evidence, sources: [], occurredAt: "", conversationId: current.conversationId, runId: current.id });
    const conflicting = { action: "correct" as const, entries: [{ id: candidate.id, version: 1, patch: { content: "我是工程师。", attribute: { key: "occupation" as const, value: "工程师" } } }], reason: "职业冲突" };
    expect(() => store.memoryCommands.change(conflicting, { actor: "user", instruction: receipt.instruction })).toThrow("冲突");
    expect(store.memories.get<MemoryEntry>("memory", candidate.id)).toMatchObject({ status: "draft", version: 1 });
    expect(store.memories.get<MemoryEntry>("memory", existing.id)?.status).toBe("confirmed");
  });

  it("requires actual original reads, sends a crop to Pi and retains autonomous draft-revision proof after restart", async () => {
    let entry: MemoryEntry, picture: Asset;
    const correction = () => call("change_memories", { action: "correct", entries: [{ id: entry.id, version: 1, patch: { content: "图片中为蓝色区域。" } }], basis: "observation", reason: "对照原图与局部像素复核" });
    const f = await piFixture((_request, index) => {
      if (index === 1 || index === 3 || index === 6) return correction();
      if (index === 2) return call("read_evidence", { id: "observation:" + entry.id });
      if (index === 4) return call("read_evidence", { id: "asset:" + picture.id, version: picture.sha256 });
      if (index === 5) return call("read_evidence", { id: "asset:" + picture.id, version: picture.sha256, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
      return { content: "已对照原图修订观察，仍待用户核对。" };
    }, true);
    picture = await asset(f.store, await sharp({ create: { width: 160, height: 120, channels: 3, background: "blue" } }).jpeg().toBuffer(), "image");
    entry = f.store.memories.createMemory({ title: "待核对颜色", content: "图片中为红色区域。", status: "draft", kind: "observation", category: "fact", occurredAt: "", conversationId: "", runId: "",
      sources: [{ assetId: picture.id, name: picture.name, sha256: picture.sha256, start: 0, end: picture.size }] });
    const initial = await f.start("请对照原件复核图片观察。", [picture.id]);
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status, JSON.stringify(finished.parts)).toBe("completed"); expect(f.requests).toHaveLength(7);
    expect(JSON.stringify(f.requests[0].messages)).toContain(picture.sha256);
    const changes = finished.parts.filter((part) => part.type === "tool" && part.name === "change_memories");
    expect(changes.map((part) => part.type === "tool" && part.state)).toEqual(["error", "error", "complete"]);
    const originalParts = finished.parts.filter((part) => part.type === "tool" && part.name === "read_evidence" && (part.output as { imageDelivered?: boolean })?.imageDelivered);
    expect(originalParts).toHaveLength(2);
    const images = f.requests[5].messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "image_url");
    expect(images).toHaveLength(2);
    const crop = Buffer.from(images[1].image_url.url.split(",")[1], "base64");
    expect(await sharp(crop).metadata()).toMatchObject({ width: 80, height: 60 });
    const receipt = f.store.memoryCommands.receipts(initial.id)[0];
    expect(receipt.sourceReads).toHaveLength(2);
    expect(receipt.sourceReads![1]).toMatchObject({ assetId: picture.id, sha256: picture.sha256, kind: "image", viewSha256: createHash("sha256").update(crop).digest("hex"), region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    expect(JSON.stringify(f.requests[6].messages)).not.toContain("红色区域");
    expect(JSON.stringify(f.requests[6].messages)).toContain(picture.sha256);
    const refreshedText = f.requests[6].messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
    expect(refreshedText).toContain("completedChanges");
    expect(refreshedText).toContain("须在最终整理结果和回复中如实报告");
    expect(refreshedText).toContain('"action":"correct"');
    expect(refreshedText).toContain('"actor":"agent"');
    expect(await readFile(join(f.dir, "sessions", initial.conversationId + ".jsonl"), "utf8")).toContain("红色区域");
    const reopened = new Store(f.dir);
    try {
      expect(reopened.memoryCommands.receipts(initial.id)[0].sourceReads).toEqual(receipt.sourceReads);
      expect(reopened.memories.get<MemoryEntry>("memory", entry.id)).toMatchObject({ status: "draft", content: "图片中为蓝色区域。", editedBy: "agent", version: 2 });
    } finally { reopened.close(); }
  });

  it("corrects and answers in one task, removes obsolete model/evidence context, retains native history and durable receipt", async () => {
    let entry: MemoryEntry;
    const instruction = "把整理手册的日期改为2026-09-04，然后告诉我新日期。";
    const f = await piFixture((request, index) => {
      if (index === 1) return { content: "旧结论 2026-09-03", ...call("inspect_memories", { ids: [entry.id] }) };
      if (index === 2) {
        const raw = request.messages.filter((message) => message.role === "tool").at(-1)?.content;
        const inspected = JSON.parse(typeof raw === "string" ? raw : (raw as { text: string }[]).map((part) => part.text).join(""));
        return call("change_memories", { action: "correct", entries: [{ ref: inspected.memories[0].ref,
          patch: { content: "2026-09-04，在书房整理手册。", occurredAt: "2026-09-04" } }], basis: "user", instructionQuote: instruction, reason: "用户纠正日期" });
      }
      return { content: "已纠正，日期为 2026-09-04。" };
    });
    entry = await memory(f.store, "2026-09-03，在书房整理手册。", "confirmed");
    const initial = await f.start(instruction, [entry.sources[0].assetId]);
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status, JSON.stringify(finished.parts)).toBe("completed");
    expect(f.requests).toHaveLength(3);
    const context = JSON.stringify(f.requests[2].messages);
    expect(context).toContain("2026-09-04"); expect(context).not.toContain("2026-09-03"); expect(context).not.toContain("旧结论");
    expect(finished.parts.some((part) => part.type === "tool" && part.name === "change_memories" && part.state === "complete")).toBe(true);
    expect(f.store.memoryCommands.receipts(initial.id)[0].instruction?.quote).toBe(instruction);
    expect(await readFile(join(f.dir, "sessions", initial.conversationId + ".jsonl"), "utf8")).toContain("旧结论");
    const policy = new TaskContextPolicy(f.store);
    f.store.work.patchRun(initial.id, { status: "running", jobs: [] });
    const firstContext = (await policy.replacement(initial.conversationId))!.content;
    f.store.work.patchRun(initial.id, { jobs: [{ id: "rebuilt-dataset", kind: "memory-dataset", toolCallId: "rebuild", title: "按当前记忆重建",
      status: "completed", revision: 8, progress: { completed: 1, total: 1, failed: 0 }, updatedAt: new Date().toISOString() }] });
    const continuedContext = (await policy.replacement(initial.conversationId))!.content;
    expect(continuedContext).not.toBe(firstContext);
    expect(continuedContext).toContain('"id":"rebuilt-dataset"'); expect(continuedContext).toContain('"status":"completed"');
    expect(continuedContext).toContain('"action":"correct"');
    f.store.work.patchRun(initial.id, { status: "completed" });
    const reopened = new Store(f.dir);
    try { expect(reopened.memoryCommands.receipts(initial.id)).toHaveLength(1); expect(reopened.memories.get<MemoryEntry>("memory", entry.id)?.version).toBe(2); }
    finally { reopened.close(); }
  });

  it("preserves external invalidation instead of exempting all writes from cancellation", async () => {
    let release: () => void = () => {};
    const response = new Promise<void>((resolve) => { release = resolve; });
    const f = await piFixture(async () => { await response; return { content: "旧上下文回答不能交付。" }; });
    const entry = await memory(f.store, "需要保护的旧事实。", "confirmed");
    const initial = await f.start("检查记忆");
    await waitFor(() => f.requests.length, (n) => n > 0);
    f.store.memories.updateMemory(entry.id, { content: "外部页面已经纠正。" }, 1);
    release();
    const stopped = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(stopped.status).toBe("stopped");
    expect(stopped.error).toContain("记忆已更新");
    expect(stopped.parts.filter((part) => part.type === "text")).toEqual([]);
  });

  it("keeps valid tool-call pairing when a memory change and an inspection share a Pi round", async () => {
    let entry: MemoryEntry;
    const instruction = "把编号改为 ZX92，再检查新编号。";
    const f = await piFixture((_request, index) => {
      if (index === 1) return { tool_calls: [
        ...call("change_memories", { action: "correct", entries: [{ id: entry.id, version: entry.version, patch: { content: "编号是 ZX92。" } }],
          basis: "user", instructionQuote: instruction, reason: "用户纠正编号" }).tool_calls,
        ...call("inspect_memories", { ids: [entry.id] }).tool_calls.map((tool) => ({ ...tool, index: 1 })),
      ] };
      return { content: "新编号为 ZX92。" };
    });
    entry = await memory(f.store, "编号是 ZX91。", "confirmed");
    const initial = await f.start(instruction, [entry.sources[0].assetId]);
    const finished = await waitFor(() => f.store.work.get<Run>("run", initial.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(finished.status).toBe("completed"); expect(f.requests).toHaveLength(2);
    const messages = f.requests[1].messages;
    expect(JSON.stringify(messages)).toContain("ZX92"); expect(JSON.stringify(messages)).not.toContain("ZX91");
    const calls = new Set(messages.flatMap((message) => message.tool_calls?.map((tool) => tool.id) || []));
    for (const message of messages) if (message.role === "tool") expect(calls.has(message.tool_call_id!)).toBe(true);
    expect(finished.parts.filter((part) => part.type === "tool").every((part) => part.state === "complete")).toBe(true);
  });

  it("starts the queued task with the current epoch after the previous task is invalidated", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await piFixture(async (_request, index) => { if (index === 1) await gate; return { content: index === 1 ? "过期回复" : "已读取当前编号。" }; });
    const entry = await memory(f.store, "当前编号为 JK71。", "confirmed");
    const first = await f.start("当前编号是什么？");
    await waitFor(() => f.requests.length, (n) => n === 1);
    const response = await f.app.inject({ method: "POST", url: `/api/conversations/${first.conversationId}/runs`, payload: {
      text: "再次检查当前编号。", modelId: first.modelId, permissionMode: "auto", useMemory: true, captureMemory: false,
    } });
    expect(response.statusCode).toBe(201);
    const queued = response.json<{ run: Run }>().run;
    expect(queued.status).toBe("queued");
    f.store.memories.updateMemory(entry.id, { content: "当前编号为 JK72。" }, entry.version); release();
    const completed = await waitFor(() => f.store.work.get<Run>("run", queued.id)!, (run) => ["completed", "failed", "stopped"].includes(run.status));
    expect(completed.status).toBe("completed");
    expect(completed.memoryEpoch).toBe(f.store.memories.ledger.epoch);
    expect(f.store.work.get<Run>("run", first.id)?.status).toBe("stopped");
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain("JK71");
  });
});
