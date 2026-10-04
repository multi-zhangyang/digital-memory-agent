import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, Asset, ChatPart, ImageRegion, MemoryEntry, Run, TrainingSample } from "@memory/contracts";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { photoHash, preparePhoto } from "../src/memory/photo-source.js";
import { MemoryFeatureService } from "../src/memory/feature-service.js";
import { EvidenceService } from "../src/memory/evidence-service.js";
import { EvidenceIndex } from "../src/memory/evidence-index.js";
import { createEvidenceTools } from "../src/application/evidence-tools.js";
import { memoryCommandContext } from "../src/application/memory-command-context.js";
import { createMemoryCommandTools } from "../src/memory-command-tools.js";
import { createMemoryTools, toolOutput } from "../src/memory-tools.js";
import { requireObservationRead, type SourceInspection } from "../src/memory/observation-review.js";
import { dateMentions, sampleTimeQuality } from "../src/memory/dataset-time-review.js";
import { DatasetService } from "../src/memory/dataset-service.js";
import { createDatasetTools } from "../src/dataset-tools.js";
import { TaskJobs } from "../src/harness/jobs.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "media-review-")), store = new Store(dir);
  store.memories.ledger.setSettings({ capture: "off", intake: "manual" });
  cleanup.push(async () => { if (store.db.isOpen) store.close(); await rm(dir, { recursive: true, force: true }); });
  const config = readConfig({ MEMORY_DATA_DIR: dir, MEMORY_LOCAL_FEATURES: "off", MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    MEMORY_OPENAI_API_KEY: "test-only", MEMORY_OPENAI_MODEL: "review-test", MEMORY_OPENAI_VISION: "true" });
  new EvidenceIndex(store.db);
  const features = new MemoryFeatureService(store); cleanup.push(async () => { if (store.db.isOpen) await features.close(); });
  return { dir, store, config, evidence: new EvidenceService(store, features) };
}
async function source(store: Store, bytes: Buffer, kind: "image" | "text" = "image") {
  const asset: Asset = { id: randomUUID(), name: kind === "image" ? "像素测试.jpg" : "交接原件.txt", kind,
    mimeType: kind === "image" ? "image/jpeg" : "text/plain", memorySpace: "personal", size: bytes.length, sha256: photoHash(bytes), createdAt: new Date().toISOString() };
  await writeFile(join(store.assetsDir, asset.id), bytes); store.addAsset(asset, { processing: "requested" }); return asset;
}
function observation(store: Store, asset: Asset, patch: Partial<MemoryEntry> = {}) {
  return store.memories.createMemory({ title: "待复核观察", content: asset.kind === "image" ? "局部是红色。" : "林舟把钥匙交给陈默。", status: "draft", kind: "observation",
    category: "fact", occurredAt: "", conversationId: "", runId: "", sources: [{ assetId: asset.id, name: asset.name,
      sha256: asset.sha256, start: 0, end: asset.size }], ...patch });
}
function running(store: Store, asset: Asset) {
  const conversation = store.createConversation();
  const run = store.work.createRun(conversation.id, { text: "请对照原件复核这份资料。", modelId: "openai-compatible/review-test", scope: "selected", assetIds: [asset.id], useMemory: true, captureMemory: false, permissionMode: "auto" });
  return store.work.patchRun(run.id, { status: "running" });
}
async function bicolor(orientation = 1, width = 240, height = 120) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255;
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).withMetadata({ orientation }).toBuffer();
}
async function center(data: Buffer) {
  const { data: pixels, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [...pixels.subarray(offset, offset + 3)];
}
const half = { x: 0, y: 0.5, width: 1, height: 0.5 };

describe("original image regions and real read guards", () => {
  it.each([6, 7])("uses oriented original pixels for EXIF %s and strips metadata", async (orientation) => {
    const f = await fixture(), asset = await source(f.store, await bicolor(orientation));
    const photo = await preparePhoto(f.store.assetsDir, asset, half);
    expect(photo.view).toMatchObject({ sourceWidth: 120, sourceHeight: 240, pixels: { left: 0, top: 120, width: 120, height: 120 }, width: 120, height: 120, region: half });
    const [red, , blue] = await center(photo.data);
    // EXIF 7 mirrors across the other diagonal; its lower half comes from original left.
    expect(orientation === 6 ? blue : red).toBeGreaterThan(245);
    expect(orientation === 6 ? red : blue).toBeLessThan(10);
    const metadata = await sharp(photo.data).metadata();
    expect(metadata.exif).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
    expect(photo.sha256).toBe(photoHash(photo.data)); expect(asset.sha256).toBe(photoHash(await readFile(join(f.store.assetsDir, asset.id))));
  });

  it("extracts before downsizing, rounds to actual pixels and rejects invalid regions", async () => {
    const f = await fixture(), asset = await source(f.store, await bicolor(1, 3200, 1600));
    expect((await preparePhoto(f.store.assetsDir, asset)).width).toBe(1600);
    const crop = await preparePhoto(f.store.assetsDir, asset, { x: 0.75, y: 0, width: 0.25, height: 0.5 });
    expect(crop.view).toMatchObject({ width: 800, height: 800, pixels: { left: 2400, top: 0, width: 800, height: 800 } });
    expect((await center(crop.data))[2]).toBeGreaterThan(245);
    const tiny = await preparePhoto(f.store.assetsDir, asset, { x: 0.80001, y: 0.80001, width: 0.000001, height: 0.000001 });
    expect(tiny.view).toMatchObject({ pixels: { width: 1, height: 1 }, width: 1, height: 1 });
    for (const region of [{ x: -0.1, y: 0, width: 0.2, height: 1 }, { x: 0.9, y: 0, width: 0.2, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 }, { x: 1, y: 0, width: 1e-12, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }])
      await expect(preparePhoto(f.store.assetsDir, asset, region)).rejects.toMatchObject({ code: "INVALID_IMAGE_REGION" });
  });

  it("serves the exact versioned crop and fails changed hashes, incomplete regions and stopped sources", async () => {
    const f = await fixture(), asset = await source(f.store, await bicolor(6));
    const read = await f.evidence.read("asset:" + asset.id, {}, { image: true, region: half });
    const app = buildApp(f.config, { store: f.store }); await app.ready(); cleanup.push(() => app.close());
    const path = read.source!.previewUrl!;
    await expect(f.evidence.read("asset:" + asset.id, {}, { version: 1 })).rejects.toMatchObject({ code: "INVALID_EVIDENCE_VERSION" });
    const response = await app.inject(path);
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
    expect(photoHash(response.rawPayload)).toBe(read.source!.view!.sha256);
    const badView = new URL(path, "http://local"); badView.searchParams.set("view", "b".repeat(64));
    expect((await app.inject(badView.pathname + badView.search)).statusCode).toBe(409);
    expect((await app.inject(`/api/evidence/asset:${asset.id}/preview?x=0.1`)).statusCode).toBe(400);
    expect((await app.inject(`/api/evidence/asset:${asset.id}/preview?x=0.9&y=0&width=0.2&height=1`)).statusCode).toBe(400);
    await expect(f.evidence.read("asset:" + asset.id, { allowedAssetIds: [] }, { region: half, image: true })).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    const bytes = await readFile(join(f.store.assetsDir, asset.id)); bytes[bytes.length - 20] ^= 1; await writeFile(join(f.store.assetsDir, asset.id), bytes);
    expect((await app.inject(path)).statusCode).toBe(409);
    const draft = observation(f.store, asset); f.store.memories.forgetMemory(draft.id, 1);
    expect((await app.inject(path)).statusCode).toBe(404);
  });

  it("checks source suppression and cancellation again after asynchronous image decoding", async () => {
    const f = await fixture(), asset = await source(f.store, await bicolor());
    const draft = observation(f.store, asset);
    const pending = f.evidence.read("asset:" + asset.id, {}, { image: true, region: half });
    f.store.memories.forgetMemory(draft.id, draft.version);
    await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    f.store.memories.forgetMemory(draft.id, draft.version + 1, true);
    const controller = new AbortController();
    const cancelled = f.evidence.read("asset:" + asset.id, {}, { image: true, region: half, signal: controller.signal });
    controller.abort(); await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not claim pixels for non-vision models or accept text/observations as crop targets", async () => {
    const f = await fixture(), asset = await source(f.store, await bicolor());
    const current = running(f.store, asset), draft = observation(f.store, asset);
    f.config.providers[0].model.supportsImages = false;
    const read = createEvidenceTools(f.store, f.config, f.evidence, current.conversationId)[1];
    const output = await read.execute("read", { id: "asset:" + asset.id }, undefined, undefined, {} as never);
    expect(toolOutput(output)).toMatchObject({ imageDelivered: false }); expect(output.content.every((part) => part.type !== "image")).toBe(true);
    await expect(read.execute("crop", { id: "asset:" + asset.id, region: half }, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "VISION_UNAVAILABLE" });
    await expect(f.evidence.read("observation:" + draft.id, {}, { region: half })).rejects.toMatchObject({ code: "IMAGE_SOURCE_REQUIRED" });
    const text = await source(f.store, Buffer.from("真实文字原件。"), "text");
    await expect(f.evidence.read("asset:" + text.id, {}, { region: half })).rejects.toMatchObject({ code: "IMAGE_SOURCE_REQUIRED" });
    f.config.providers[0].model.supportsImages = true;
    const before = f.store.work.get<Run>("run", current.id)!.sources;
    const pending = read.execute("late", { id: "asset:" + asset.id, region: half }, undefined, undefined, {} as never);
    f.store.work.patchRun(current.id, { status: "stopped" });
    await expect(pending).rejects.toMatchObject({ code: "RUN_REQUIRED" });
    expect(f.store.work.get<Run>("run", current.id)!.sources).toEqual(before);
  });

  it("requires complete text coverage, original version and real image coverage", async () => {
    const f = await fixture(), text = await source(f.store, Buffer.from("AAAABBBBCCCC"), "text"), entry = observation(f.store, text);
    const read = (start: number, end: number): SourceInspection => ({ toolCallId: "read", assetId: text.id, sha256: text.sha256, kind: "text", start, end });
    expect(() => requireObservationRead(entry, [read(0, 4), read(8, 12)])).toThrow("覆盖来源范围");
    expect(() => requireObservationRead(entry, [{ ...read(0, 12), sha256: "a".repeat(64) }])).toThrow("读取对应原件");
    expect(() => requireObservationRead(entry, [read(4, 8), read(0, 4), read(8, 12)])).not.toThrow();
    const extra = await source(f.store, Buffer.from("另一份独立来源。"), "text");
    const composite = { ...entry, evidence: undefined, sources: [...entry.sources, { assetId: extra.id, name: extra.name, sha256: extra.sha256, start: 0, end: extra.size }] };
    expect(() => requireObservationRead(composite, [read(0, 12)])).toThrow("覆盖来源范围");
    expect(() => requireObservationRead(composite, [read(0, 12), { ...read(0, extra.size), assetId: extra.id, sha256: extra.sha256 }])).not.toThrow();
    const image = await source(f.store, await bicolor());
    const picture = observation(f.store, image, { sources: [{ assetId: image.id, sha256: image.sha256, name: image.name, start: 0, end: image.size,
      visual: { width: 240, height: 120, previewSha256: "a".repeat(64), region: half } }] });
    const proof: SourceInspection = { ...read(0, image.size), assetId: image.id, sha256: image.sha256, kind: "image", viewSha256: "b".repeat(64), region: { x: 0, y: 0, width: 1, height: 0.5 } };
    expect(() => requireObservationRead(picture, [proof])).toThrow("覆盖观察的局部");
    expect(() => requireObservationRead(picture, [{ ...proof, region: half }])).not.toThrow();
    expect(() => requireObservationRead(picture, [{ ...proof, region: undefined }])).not.toThrow();
    expect(() => requireObservationRead({ ...picture, status: "confirmed" }, [proof])).toThrow("用户明确指令");
  });

  it("accepts only completed original tool results for autonomous revision and persists the read receipt", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("林舟把钥匙交给陈默。"), "text");
    const entry = observation(f.store, asset, { content: "陈默把钥匙交给林舟。" }), current = running(f.store, asset);
    const input = { action: "correct" as const, entries: [{ id: entry.id, version: 1, patch: { content: "林舟把钥匙交给陈默。" } }], reason: "读取原文核对动作方向" };
    const changed = createMemoryCommandTools(f.store, current.conversationId)[1];
    const execute = () => changed.execute("revise", { ...input, basis: "observation" }, undefined, undefined, {} as never);
    const read = createEvidenceTools(f.store, f.config, f.evidence, current.conversationId)[1];
    const summary = toolOutput(await read.execute("summary", { id: "observation:" + entry.id }, undefined, undefined, {} as never));
    const part = (output: unknown, state: "complete" | "error" = "complete"): ChatPart => ({ type: "tool", toolCallId: "original-read", name: "read_evidence", input: {}, state, output });
    f.store.work.patchRun(current.id, { parts: [part(summary)] });
    await expect(execute()).rejects.toThrow("读取对应原件");
    const raw = toolOutput(await read.execute("original-read", { id: "asset:" + asset.id }, undefined, undefined, {} as never));
    f.store.work.patchRun(current.id, { parts: [part(raw, "error")] });
    await expect(execute()).rejects.toThrow("读取对应原件");
    f.store.work.patchRun(current.id, { parts: [part(raw)] });
    const context = memoryCommandContext(f.store, current, "revise", input, "observation");
    expect(context.sourceReads).toMatchObject([{ toolCallId: "original-read", assetId: asset.id, start: 0, end: asset.size, kind: "text" }]);
    await execute();
    expect(f.store.memories.get<MemoryEntry>("memory", entry.id)).toMatchObject({ status: "draft", version: 2, editedBy: "agent", content: "林舟把钥匙交给陈默。" });
    const reopened = new Store(f.dir);
    try { expect(reopened.memoryCommands.receipts(current.id)[0]).toMatchObject({ actor: "agent", sourceReads: context.sourceReads, before: [{ id: entry.id, version: 1 }], after: [{ id: entry.id, version: 2 }] }); }
    finally { reopened.close(); }
  });
});

describe("original text and current confirmed corrections", () => {
  it("retains useful historical artifacts across unrelated corrections and blocks stopped dependencies", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("编号 JD14。"), "text");
    const memory = observation(f.store, asset, { content: "编号 JD14。", status: "confirmed", acceptedBy: "user" });
    const first = running(f.store, asset);
    f.store.work.recordRecall(first.id, { query: "编号" }, [memory], 1);
    const artifact = f.store.work.writeArtifact({ conversationId: first.conversationId, runId: first.id,
      title: "历史整理", content: "编号 JD14。", sources: memory.sources, author: "agent" });
    f.store.work.patchRun(first.id, { status: "completed" });
    const extra = await source(f.store, Buffer.from("偏好按日期排序。"), "text");
    const unrelated = observation(f.store, extra, { content: "偏好按日期排序。", status: "confirmed" });
    f.store.memories.updateMemory(unrelated.id, { content: "偏好按日期升序排序。" }, unrelated.version);
    const next = f.store.work.createRun(first.conversationId, { text: "复核原来的整理结果", modelId: first.modelId, assetIds: [asset.id], scope: "selected", captureMemory: false });
    f.store.work.patchRun(next.id, { status: "running" });
    const tool = createWorkspaceTools(f.store, first.conversationId).find((item) => item.name === "read_artifact")!;
    const read = async () => toolOutput(await tool.execute("history", { artifactId: artifact.id }, undefined, undefined, {} as never));
    expect(await read()).toMatchObject({ id: artifact.id, content: "编号 JD14。", version: 1, memoryContextUpdated: true });
    f.store.memories.updateMemory(memory.id, { content: "编号 JD19。" }, memory.version);
    expect(await read()).toMatchObject({ content: "编号 JD14。", memoryContextUpdated: true });
    f.store.memories.forgetMemory(memory.id, memory.version + 1);
    await expect(read()).rejects.toThrow("停止取用");
    expect(f.store.work.get<Artifact>("artifact", artifact.id)?.content).toBe("编号 JD14。");
  });

  it("keeps original bytes and carries only overlapping, scoped current confirmations through both tools", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("相册编号 QB47。\n归还日期另行核对。"), "text");
    const end = Buffer.byteLength("相册编号 QB47。");
    const entry = observation(f.store, asset, { content: "相册编号 QB47。", status: "confirmed", acceptedBy: "user",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end }] });
    const corrected = f.store.memories.updateMemory(entry.id, { content: "相册编号 QB49。" }, entry.version);
    observation(f.store, asset, { content: "未经确认的编号 XX99。" });
    observation(f.store, asset, { content: "不重叠的确认内容。", status: "confirmed",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: end, end: asset.size }] });
    const extra = await source(f.store, Buffer.from("其他资料只允许独立读取。"), "text");
    observation(f.store, asset, { content: "跨范围确认内容。", status: "confirmed", sources: [...entry.sources,
      { assetId: extra.id, name: extra.name, sha256: extra.sha256, start: 0, end: extra.size }] });
    const current = running(f.store, asset);
    const legacy = createMemoryTools(f.store, current.conversationId).find((tool) => tool.name === "read_asset_text")!;
    const old = toolOutput(await legacy.execute("legacy", { assetId: asset.id, maxBytes: end }, undefined, undefined, {} as never)) as {
      text: string; verification: string; memoryContext: { memories: MemoryEntry[] };
    };
    const modern = createEvidenceTools(f.store, f.config, f.evidence, current.conversationId)[1];
    const read = toolOutput(await modern.execute("evidence", { id: "asset:" + asset.id, limit: end }, undefined, undefined, {} as never)) as {
      source: { text: string }; memoryContext: typeof old.memoryContext;
    };
    expect(old.text).toBe("相册编号 QB47。"); expect(read.source.text).toBe(old.text);
    expect(old.verification).toBe("asset-hash"); expect(read.memoryContext).toEqual(old.memoryContext);
    expect(old.memoryContext.memories).toMatchObject([{ id: corrected.id, version: corrected.version, content: "相册编号 QB49。", editedBy: "user", status: "confirmed" }]);
    expect(old.memoryContext.memories).toHaveLength(1);
    expect((await readFile(join(f.store.assetsDir, asset.id))).toString()).toContain("QB47");
    f.store.work.patchRun(current.id, { useMemory: false });
    const disabled = toolOutput(await legacy.execute("disabled", { assetId: asset.id }, undefined, undefined, {} as never));
    expect(disabled).not.toHaveProperty("memoryContext");
    const newer = toolOutput(await modern.execute("disabled-new", { id: "asset:" + asset.id }, undefined, undefined, {} as never));
    expect(newer).not.toHaveProperty("memoryContext");
  });

  it("pages large originals at UTF-8 boundaries and rejects changed, stopped, cancelled or symlinked originals", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("甲乙丙。".repeat(30000)), "text");
    const current = running(f.store, asset);
    const legacy = createMemoryTools(f.store, current.conversationId).find((tool) => tool.name === "read_asset_text")!;
    const execute = (offset = 0, signal?: AbortSignal) => legacy.execute(randomUUID(), { assetId: asset.id, offset, maxBytes: 5 }, signal, undefined, {} as never);
    const first = toolOutput(await execute()) as { text: string; nextOffset: number };
    expect(first).toMatchObject({ text: "甲", nextOffset: 3 });
    expect(toolOutput(await execute(first.nextOffset))).toMatchObject({ text: "乙", offset: 3, nextOffset: 6 });
    await expect(execute(1)).rejects.toMatchObject({ code: "INVALID_OFFSET" });
    const controller = new AbortController(); controller.abort();
    await expect(execute(0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const original = await readFile(join(f.store.assetsDir, asset.id));
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
    await writeFile(join(f.store.assetsDir, asset.id), changed);
    await expect(execute()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await writeFile(join(f.store.assetsDir, asset.id), original);
    const entry = observation(f.store, asset); f.store.memories.forgetMemory(entry.id, entry.version);
    await expect(execute()).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    f.store.memories.forgetMemory(entry.id, entry.version + 1, true);
    const pending = execute(); f.store.work.patchRun(current.id, { status: "stopped" });
    await expect(pending).rejects.toMatchObject({ code: "RUN_CHANGED" });
    const { symlink } = await import("node:fs/promises");
    await rm(join(f.store.assetsDir, asset.id));
    const target = join(f.dir, "outside.txt"); await writeFile(target, original);
    await symlink(target, join(f.store.assetsDir, asset.id));
    await expect(f.evidence.read("asset:" + asset.id)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("marks bounded source context and never substitutes an older corrected value", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("编号 KB10。"), "text");
    const old = observation(f.store, asset, { status: "confirmed", acceptedBy: "user", content: "编号 KB10。" });
    f.store.memories.updateMemory(old.id, { content: "编号 KB12。" }, old.version);
    for (let i = 0; i < 65; i++) observation(f.store, asset, { status: "confirmed", content: "相册附加信息。".repeat(100) + i });
    const context = f.store.memories.queries.forSource({ assetId: asset.id, sha256: asset.sha256, start: 0, end: asset.size }, [asset.id], 1800);
    expect(context.truncated).toBe(true); expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(1800);
    expect(context.memories[0]).toMatchObject({ content: "编号 KB12。", editedBy: "user" });
    expect(JSON.stringify(context)).not.toContain("KB10");
  });
});

function timeSample(question: string, answer = "林舟"): TrainingSample {
  return { id: "sample", datasetId: "dataset", version: 1, kind: "qa", question, answer, status: "review", stale: false,
    memoryRefs: [], evidence: [], checks: [], authority: "unreviewed", intendedUse: "training" };
}
const event = { id: "event", category: "event", content: "2024年2月29日，林舟把钥匙交给陈默。", occurredAt: "2024-02-29" } as MemoryEntry;
const issues = (question: string, memories = [event], answer?: string) => sampleTimeQuality(timeSample(question, answer), memories).issues;

describe("temporal grounding against frozen sources", () => {
  it("starts with explicit null cursors, follows returned pages and rejects expired or foreign cursors", async () => {
    const f = await fixture(), asset = await source(f.store, Buffer.from("2024年2月29日，林舟把钥匙交给陈默。"), "text");
    const entry = observation(f.store, asset, { content: "2024年2月29日，林舟把钥匙交给陈默。", title: "钥匙交接", occurredAt: "2024-02-29", status: "confirmed", acceptedBy: "user" });
    const service = new DatasetService(f.store); cleanup.push(() => service.close());
    const dataset = service.submit({ requestKey: "pages", format: "mixed", scope: { memoryIds: [entry.id] } }); await service.idle();
    const current = running(f.store, asset), jobs = new TaskJobs(f.store);
    jobs.register("memory-dataset", service.driver()); cleanup.push(() => jobs.close());
    const tools = createDatasetTools(f.store, service, jobs, current.conversationId);
    const inspect = (input: object) => tools.find((tool) => tool.name === "inspect_dataset")!.execute(randomUUID(), input as never, undefined, undefined, {} as never);
    const first = toolOutput(await inspect({ datasetId: dataset.id, after: null, revision: null, limit: 1 })) as {
      dataset: { revision: number }; samples: (TrainingSample & { ref: string })[]; nextPage: { datasetId: string; after: string; revision: number; limit: number };
    };
    expect(first.samples).toHaveLength(1); expect(first.nextPage.after).toBe(first.samples[0].id);
    await expect(inspect({ datasetId: dataset.id, after: randomUUID(), revision: first.dataset.revision })).rejects.toThrow("游标不属于此数据集");
    const second = toolOutput(await inspect(first.nextPage)) as { samples: TrainingSample[]; nextPage: null };
    expect(second.samples).toHaveLength(1); expect(second.samples[0].id).not.toBe(first.samples[0].id); expect(second.nextPage).toBeNull();
    await tools.find((tool) => tool.name === "review_dataset")!.execute("review", { datasetId: dataset.id, reason: "核对完整冻结原文与已知日期", samples: [{ ref: first.samples[0].ref, action: "approve", question: null, answer: null }] }, undefined, undefined, {} as never);
    await service.idle();
    await expect(inspect(first.nextPage)).rejects.toThrow("after=null、revision=null");
    const restarted = toolOutput(await inspect({ datasetId: dataset.id, after: null, revision: null, limit: null })) as { samples: TrainingSample[] };
    expect(restarted.samples).toHaveLength(2); expect(restarted.samples.find((sample) => sample.id === first.samples[0].id)?.version).toBe(2);
  });

  it("requires exact known event dates, accepts a direct date answer and handles leap days and Chinese dates", () => {
    expect(issues("谁把钥匙交给陈默？")).toMatchObject([{ code: "missing-event-time", severity: "blocking" }]);
    expect(issues("2024年2月29日，谁把钥匙交给陈默？")).toEqual([]);
    expect(issues("林舟在哪一天把钥匙交给陈默？", [event], "2024年2月29日")).toEqual([]);
    expect(issues("2024年，谁把钥匙交给陈默？").some((issue) => issue.code === "missing-event-time")).toBe(true);
    expect(issues("2023-02-29，谁把钥匙交给陈默？").some((issue) => issue.code === "invalid-question-date")).toBe(true);
    expect(issues("2024-03-01，谁把钥匙交给陈默？").some((issue) => issue.code === "unsupported-question-date")).toBe(true);
    expect(dateMentions("2024年2月29日、2024年以及２０２５／３／２").map((date) => date.value)).toEqual(["2024-02-29", "2024", "2025-03-02"]);
  });

  it("does not extrapolate unknown dates, open-ended validity or precision from a bare source year", () => {
    const unknown = { ...event, content: "林舟把钥匙交给陈默。", occurredAt: "" };
    expect(issues("谁把钥匙交给陈默？", [unknown])).toMatchObject([{ code: "unknown-event-time", severity: "review" }]);
    expect(issues("现在谁保管钥匙？", [unknown]).some((issue) => issue.code === "relative-time")).toBe(true);
    expect(issues("2026-08-01，谁保管钥匙？", [unknown]).some((issue) => issue.code === "unsupported-question-date")).toBe(true);
    const state = { ...unknown, category: "profile" as const, validity: { from: "2024-01-01", to: "2024-12-31", precision: "day" as const } };
    expect(issues("2024-06-15，谁保管钥匙？", [state])).toEqual([]);
    expect(issues("谁保管钥匙？", [state]).some((issue) => issue.code === "missing-validity-time")).toBe(true);
    expect(issues("2025-06-15，谁保管钥匙？", [{ ...state, validity: { from: "2024-01-01", precision: "day" } }]).some((issue) => issue.code === "unsupported-question-date")).toBe(true);
    expect(issues("2024-05-03，谁保管钥匙？", [{ ...unknown, content: "2024年，林舟把钥匙交给陈默。" }]).some((issue) => issue.code === "unsupported-question-date")).toBe(true);
  });

  it("keeps all event anchors in a multiple-event question and treats excluded material separately", () => {
    const second = { ...event, id: "second", occurredAt: "2024-03-03", content: "2024-03-03，陈默归还钥匙。" };
    expect(issues("2024-02-29 和 2024-03-03，钥匙分别由谁保管？", [event, second])).toEqual([]);
    expect(issues("2024-02-29，钥匙分别由谁保管？", [event, second])).toMatchObject([{ code: "missing-event-time", memoryId: "second" }]);
    expect(sampleTimeQuality({ ...timeSample("现在钥匙在哪里？"), status: "excluded" }, [event]).issues).toEqual([]);
  });

  it("blocks legacy ready samples at HTTP download, allows inspection and repairs atomically through the shared review service", async () => {
    const f = await fixture(), text = "2024年2月29日，林舟把钥匙交给陈默。", asset = await source(f.store, Buffer.from(text), "text");
    const entry = observation(f.store, asset, { content: text, title: "钥匙交接", category: "event", occurredAt: "2024-02-29", status: "confirmed", acceptedBy: "user" });
    const service = new DatasetService(f.store); cleanup.push(() => service.close());
    const dataset = service.submit({ requestKey: "legacy", format: "qa", scope: { memoryIds: [entry.id] } }); await service.idle();
    const sample = service.ledger.samples(dataset.id)[0];
    // Explicit legacy DB fixture: an already-approved sample created before time-check v1.
    const legacy = { ...sample, question: "谁把钥匙交给陈默？", answer: "林舟", quality: undefined };
    f.store.db.prepare("UPDATE dataset_samples SET data=? WHERE id=?").run(JSON.stringify(legacy), sample.id);
    const app = buildApp(f.config, { store: f.store }); await app.ready(); cleanup.push(() => app.close());
    const files = `/api/memory-datasets/${dataset.id}/files/`;
    const blocked = await app.inject(files + "training");
    expect(blocked.statusCode).toBe(422); expect(blocked.json().error.code).toBe("SAMPLE_TIME_AMBIGUOUS");
    expect((await app.inject(files + "manifest")).statusCode).toBe(200);
    const inspection = await app.inject(`/api/memory-datasets/${dataset.id}/samples`);
    expect(inspection.json().samples[0].quality.issues[0].code).toBe("missing-event-time");
    const submit = (question: string) => app.inject({ method: "POST", url: `/api/memory-datasets/${dataset.id}/review`, payload: {
      samples: [{ id: sample.id, version: 1, action: "revise", question }], reason: "核对冻结原件的交接日期", requestKey: "web-repair" } });
    expect((await submit("2025年2月28日，谁把钥匙交给陈默？")).statusCode).toBe(422);
    expect(service.ledger.samples(dataset.id)[0].version).toBe(1);
    const repaired = await submit("2024年2月29日，谁把钥匙交给陈默？");
    expect(repaired.statusCode, repaired.body).toBe(200); expect(repaired.json().receipt.actor).toBe("user");
    let response = await app.inject(files + "training");
    for (let n = 0; n < 200 && response.statusCode === 409; n++) { await new Promise((resolve) => setTimeout(resolve, 10)); response = await app.inject(files + "training"); }
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ messages: [{ role: "user", content: "2024年2月29日，谁把钥匙交给陈默？" }, { role: "assistant", content: "林舟" }], quality: { version: 1, issues: [] } });
    expect(service.ledger.samples(dataset.id)[0]).toMatchObject({ version: 2, status: "ready", checks: expect.arrayContaining(["time-grounding-v1"]) });
  });
});
