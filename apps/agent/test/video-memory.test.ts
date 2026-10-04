import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Asset, MemoryEntry, MemoryImportJob } from "@memory/contracts";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { MemoryImports } from "../src/memory/imports.js";
import { AssetProcessingService } from "../src/memory/asset-processing-service.js";
import { EvidenceService } from "../src/memory/evidence-service.js";
import { photoHash } from "../src/memory/photo-source.js";
import { inspectVideo, prepareVideoFrame } from "../src/memory/video-source.js";
import { requireObservationRead } from "../src/memory/observation-review.js";
import { DatasetService } from "../src/memory/dataset-service.js";
import { createEvidenceTools } from "../src/application/evidence-tools.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";
import type { ChatPart } from "@memory/contracts";
import { MemoryFeatureService } from "../src/memory/feature-service.js";
import { AssetIndexService } from "../src/memory/asset-index-service.js";
import type { ImageFeatures, LocalFeatures } from "../src/integrations/local-features.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let videoBytes: Buffer;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "video-pixels-")), path = join(dir, "source.mp4");
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=4:d=2",
      "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=4:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
    videoBytes = await readFile(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "video-memory-")), store = new Store(dataDir);
  store.memories.ledger.setSettings({ intake: "manual", capture: "off", videoSampleInterval: 2 });
  cleanup.push(async () => { if (store.db.isOpen) store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const asset: Asset = { id: randomUUID(), name: "两段画面.mp4", kind: "video", mimeType: "video/mp4", size: videoBytes.length, sha256: photoHash(videoBytes), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, asset.id), videoBytes); store.addAsset(asset, { processing: "requested" });
  const config = readConfig({ MEMORY_DATA_DIR: dataDir, MEMORY_LOCAL_FEATURES: "off", MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:1/v1", MEMORY_OPENAI_API_KEY: "test-only", MEMORY_OPENAI_MODEL: "video-test", MEMORY_OPENAI_VISION: "true" });
  return { store, asset, config };
}
async function settled(imports: MemoryImports, id: string): Promise<MemoryImportJob> {
  for (let i = 0; i < 400; i++) { const job = imports.job(id); if (["completed", "failed"].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Video processing did not settle");
}

describe("video sources through real local decoding", () => {
  it("proposes separate memories from selected completed frame reads and exports only their own sources", async () => {
    const { store, asset, config } = await fixture();
    const conversation = store.createConversation(), run = store.work.createRun(conversation.id, {
      text: "请把视频画面保存为待核对记忆", modelId: config.providers[0].model.id, assetIds: [asset.id], scope: "selected", captureMemory: false,
    });
    store.work.patchRun(run.id, { status: "running" });
    const tools = [...createEvidenceTools(store, config, new EvidenceService(store), conversation.id), ...createWorkspaceTools(store, conversation.id)];
    const execute = async (name: string, input: unknown, id: string) => {
      const result = await (tools.find((tool) => tool.name === name)! as unknown as { execute: (id: string, input: unknown) => Promise<{ content: { type: string; text?: string }[] }> }).execute(id, input);
      const output = JSON.parse(result.content.find((part) => part.type === "text")!.text!);
      const current = store.work.get<import("@memory/contracts").Run>("run", run.id)!;
      store.work.patchRun(run.id, { parts: [...current.parts, { type: "tool", toolCallId: id, name, input, state: "complete", output } as ChatPart] });
      return output;
    };
    const red = await execute("read_evidence", { id: "asset:" + asset.id, version: asset.sha256, timestamp: 0 }, "read-red");
    const blue = await execute("read_evidence", { id: "asset:" + asset.id, version: asset.sha256, timestamp: 2.2, region: { x: 0.5, y: 0, width: 0.5, height: 1 } }, "read-blue");
    const input = { title: "红色画面", content: "视频开始画面为红色。", kind: "observation", sourceAssetIds: [asset.id], category: "fact" };
    await expect(execute("propose_memory", input, "missing-frame")).rejects.toMatchObject({ code: "FRAME_SELECTION_REQUIRED" });
    const first = await execute("propose_memory", { ...input, sourceRefs: [red.sourceRef] }, "red-draft");
    const second = await execute("propose_memory", { ...input, title: "蓝色局部", content: "视频此时右半侧为蓝色。", sourceRefs: [blue.sourceRef] }, "blue-draft");
    const memories = [first, second].map(({ memoryId }) => store.memories.get<MemoryEntry>("memory", memoryId)!);
    expect(memories.map((memory) => memory.sources.map((source) => source.video!.timestamp))).toEqual([[0], [2.25]]);
    expect(memories[1].sources[0].view?.pixels).toEqual({ left: 320, top: 0, width: 320, height: 360 });
    expect(memories[1].sources[0].visual?.region).toEqual(blue.source.view.region);
    expect(memories.every((memory) => memory.status === "draft" && !memory.acceptedBy && memory.occurredAt === "")).toBe(true);
    expect(store.work.get<import("@memory/contracts").Run>("run", run.id)!.memoryIds).toEqual(memories.map((memory) => memory.id));
    const proof = { toolCallId: "read-blue", assetId: asset.id, sha256: asset.sha256, start: 0, end: asset.size, kind: "video" as const,
      video: blue.source.video, region: blue.source.view.region, viewSha256: blue.source.view.sha256 };
    expect(() => requireObservationRead(memories[1], [proof])).not.toThrow();
    store.memoryCommands.change({ action: "confirm", entries: memories.map(({ id, version }) => ({ id, version })), reason: "用户确认测试色块观察" }, { actor: "user" });
    const datasets = new DatasetService(store); cleanup.push(() => datasets.close());
    const dataset = datasets.submit({ requestKey: randomUUID(), scope: { memoryIds: memories.map((memory) => memory.id) }, format: "qa" });
    await datasets.idle();
    const frozen = datasets.ledger.samples(dataset.id).map((sample) => sample.evidence.filter((source) => source.type === "asset").map((source) => source.video!.timestamp));
    expect(frozen.sort((a, b) => a[0] - b[0])).toEqual([[0], [2.25]]);
    let data = ""; for await (const bytes of (await datasets.download(dataset.id, "training")).stream) data += bytes.toString();
    const training = data.trim().split("\n").map((row) => JSON.parse(row));
    expect(training).toHaveLength(2);
    const reopened = new Store(store.dataDir); cleanup.push(() => reopened.close());
    expect(reopened.memories.get<MemoryEntry>("memory", memories[1].id)!.sources[0].view!.sha256).toBe(blue.source.view.sha256);
    const app = buildApp(config, { store }); await app.ready(); cleanup.push(() => app.close());
    const preview = await app.inject(`/api/memories/${memories[1].id}/evidence/0/image`);
    expect(preview.statusCode).toBe(200); expect(photoHash(preview.rawPayload)).toBe(blue.source.view.sha256);
    expect((await app.inject(`/api/memories/${memories[1].id}/evidence/0`)).json().previewMatches).toBe(true);
  });

  it("indexes original frames independently, resumes only failed frames and keeps exact time in retrieval", async () => {
    const { store, asset } = await fixture();
    const fingerprint = "a".repeat(64), vector = (slot: number, size = 768) => Array.from({ length: size }, (_, index) => Number(index === slot));
    let calls = 0, failSecond = true;
    // Controlled vectors and detections verify service behavior, not encoder quality.
    const processor: LocalFeatures = {
      info: async () => ({ protocol: 1, processorVersion: 1, fingerprint, device: "cpu", network: false,
        encoders: { text: { id: "test-text", revision: "test", dimensions: 384 }, image: { id: "test-image", revision: "test", dimensions: 768 }, face: { id: "test-face", revision: "test", dimensions: 128 } } }),
      embed: async (texts, _role, encoder) => ({ fingerprint, vectors: texts.map(() => vector(1, encoder === "image_text" ? 768 : 384)), tokens: texts.map(() => 1), truncated: texts.map(() => false) }),
      image: async (data): Promise<ImageFeatures> => {
        calls++; if (calls === 2 && failSecond) throw new Error("controlled second-frame failure");
        const stats = await sharp(data).stats(), blue = stats.channels[2].mean > stats.channels[0].mean;
        return { fingerprint, vector: vector(blue ? 1 : 0), width: 640, height: 360, coordinateSpace: "exif-oriented",
          faces: [{ region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, detectionScore: 0.99, quality: "usable", vector: vector(blue ? 1 : 0, 128) }],
          metadata: { capturedLocal: null, offset: null, source: null, certainty: "unknown", hasGps: false } };
      }, close: async () => {},
    };
    const features = new MemoryFeatureService(store, processor); cleanup.push(() => features.close());
    let index = new AssetIndexService(store, features); cleanup.push(() => index.close());
    await index.idle();
    expect(index.driver().get(asset.id)).toMatchObject({ status: "failed", ownership: "library", progress: { total: 3, completed: 2, failed: 1 } });
    expect(store.memories.list("memory")).toEqual([]); expect(store.work.list("run")).toEqual([]);
    const before = features.vectors.videoFrames.frames(asset.id);
    await index.close(); failSecond = false;
    index = new AssetIndexService(store, features); cleanup.push(() => index.close());
    index.driver().retry!(asset.id); await index.idle();
    const frames = features.vectors.videoFrames.frames(asset.id);
    expect(calls).toBe(4); expect(frames.map((frame) => frame.id)).toEqual(before.map((frame) => frame.id));
    expect(index.driver().get(asset.id)).toMatchObject({ status: "completed", progress: { total: 3, completed: 3, failed: 0 } });
    const evidence = new EvidenceService(store, features), results = await evidence.search({ query: "蓝色画面", kind: "video" });
    expect(results.hits.filter((hit) => hit.type === "frame").map((hit) => hit.sources[0].type === "asset" ? hit.sources[0].video!.timestamp : -1).sort((a, b) => a - b)).toEqual([2, 3.75]);
    const read = await evidence.read("frame:" + frames[1].id, {}, { image: true });
    expect(read.source?.video?.timestamp).toBe(2); expect(read.source?.view?.sha256).toBe(JSON.parse(frames[1].view!).sha256);
    await expect(evidence.read("frame:" + frames[1].id, {}, { timestamp: 0 })).rejects.toMatchObject({ code: "FRAME_TIME_MISMATCH" });
    expect((await evidence.search({ query: "蓝色画面" }, { allowedAssetIds: [] })).hits).toEqual([]);
    store.memories.ledger.setSettings({ videoSampleInterval: 3 }); await store.events.flush(); await index.idle();
    expect(features.vectors.videoFrames.frames(asset.id).map((frame) => frame.requestedTimestamp)).toEqual([0, 3, 3.75]);
    expect(calls).toBe(5);
    await expect(evidence.read("frame:" + frames[1].id)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
  });

  it("limits a confirmed video identity to the observed frame and stops all source retrieval", async () => {
    const { store, asset } = await fixture();
    const fingerprint = "b".repeat(64), vector = Array.from({ length: 768 }, (_, index) => Number(index === 0));
    const features: ImageFeatures = { fingerprint, vector, width: 640, height: 360, coordinateSpace: "exif-oriented",
      faces: [{ region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, detectionScore: 0.99, quality: "usable", vector: Array.from({ length: 128 }, (_, index) => Number(index === 0)) }],
      metadata: { capturedLocal: null, offset: null, source: null, certainty: "unknown", hasGps: false } };
    const atZero = await prepareVideoFrame(store.assetsDir, asset, 0), atTwo = await prepareVideoFrame(store.assetsDir, asset, 2);
    const graph = store.memories.ledger.graph;
    const [face] = graph.recordImage(asset, features, () => [], atZero.video);
    const person = store.memories.ledger.savePerson({ name: "明确的测试身份", aliases: [] });
    graph.identify(face.entityId, 1, person.id!, "仅确认开始画面的测试人物");
    const memories = [atZero, atTwo].map((frame) => store.memories.createMemory({ title: "同源不同画面", content: "受控测试画面", kind: "observation", status: "confirmed", occurredAt: "", conversationId: "", runId: "",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, video: frame.video }] }));
    expect(store.memories.queries.recall({ personId: person.id! }).entries.map((memory) => memory.id)).toEqual([memories[0].id]);
    expect(graph.context(memories[1]).entities).toEqual([]);
    const evidence = new EvidenceService(store);
    expect((await evidence.search({ query: "受控", personId: person.id! })).hits.filter((hit) => hit.memoryId).map((hit) => hit.memoryId)).toEqual([memories[0].id]);
    expect((await evidence.search({ query: "受控", entityId: face.entityId })).hits.filter((hit) => hit.memoryId).map((hit) => hit.memoryId)).toEqual([memories[0].id]);
    store.memories.forgetMemory(memories[0].id, memories[0].version);
    expect((await evidence.search({ query: "受控", personId: person.id! })).hits).toEqual([]);
    expect(graph.entityPage("personal").entities).toEqual([]);
  });

  it("returns actual frame time and original-pixel crop with a reproducible hash", async () => {
    const { store, asset } = await fixture();
    expect(await inspectVideo(store.assetsDir, asset)).toMatchObject({ duration: 4, width: 640, height: 360, hasAudio: false });
    const frame = await prepareVideoFrame(store.assetsDir, asset, 2.2, { region: { x: 0.5, y: 0, width: 0.5, height: 1 } });
    expect(frame.video).toMatchObject({ requestedTimestamp: 2.2, timestamp: 2.25 });
    expect(frame.view.pixels).toEqual({ left: 320, top: 0, width: 320, height: 360 });
    expect((await sharp(frame.data).stats()).channels[2].mean).toBeGreaterThan(245);
    expect((await prepareVideoFrame(store.assetsDir, asset, 2.2, { region: { x: 0.5, y: 0, width: 0.5, height: 1 } })).sha256).toBe(frame.sha256);
    const evidence = new EvidenceService(store);
    const read = await evidence.read("asset:" + asset.id, {}, { timestamp: 2.2, image: true });
    expect(read.source?.video?.timestamp).toBe(2.25); expect(read.source?.previewUrl).toContain("timestamp=2.2");
    expect(read.image).toBeInstanceOf(Buffer);
    await expect(evidence.read("asset:" + asset.id, { allowedAssetIds: [] }, { timestamp: 2 })).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    await writeFile(join(store.assetsDir, asset.id), videoBytes.subarray(0, 100));
    await expect(prepareVideoFrame(store.assetsDir, asset, 1)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("processes mixed media and keeps frame evidence through confirmation, export and correction", async () => {
    const { store, asset, config } = await fixture();
    const text = Buffer.from("2026年9月12日，林舟把备用钥匙交给陈默。"), textAsset: Asset = { ...asset, id: randomUUID(), name: "交接.txt", kind: "text", mimeType: "text/plain", size: text.length, sha256: photoHash(text) };
    await writeFile(join(store.assetsDir, textAsset.id), text); store.addAsset(textAsset, { processing: "requested" });
    const calls: number[] = [];
    const imports = new MemoryImports(store, config, () => ({
      extractMemories: async () => ({ entries: [], usage: { input: 1, output: 1 } }),
      // A controlled description exercises evidence flow; actual decoding is checked separately.
      extractPhotoMemories: async (input) => { calls.push(input.photo.video!.timestamp); return { entries: [{ title: "抽样色块", content: "视频画面中有蓝色方块。", kind: "observation", uncertainty: "", visibleText: "", region: null }], usage: { input: 1, output: 1 } }; },
    }));
    cleanup.push(() => imports.close());
    const processing = new AssetProcessingService(store, config, imports);
    const job = await settled(imports, (await processing.submit({ assetIds: [asset.id, textAsset.id] }, { requestId: randomUUID(), ownership: "library" })).id);
    expect(job.status).toBe("completed"); expect(calls).toEqual([0, 2, 3.75]);
    expect(job.assets![0].video).toMatchObject({ duration: 4, frames: 3, sampleInterval: 2, coverage: "sampled-frames" });
    const memory = store.memories.list<MemoryEntry>("memory")[0];
    const sources = memory.evidence!.filter((source) => source.type === "asset");
    expect(sources.map((source) => source.video!.timestamp)).toEqual([0, 2, 3.75]);
    expect(memory.status).toBe("draft");
    expect((await new EvidenceService(store).search({ query: "蓝色方块", kind: "video" })).hits.some((hit) => hit.memoryId === memory.id && hit.sources.length === 3)).toBe(true);
    const confirmed = store.memories.updateMemory(memory.id, { status: "confirmed" }, memory.version);
    const datasets = new DatasetService(store); cleanup.push(() => datasets.close());
    const dataset = datasets.submit({ requestKey: randomUUID(), scope: { memoryIds: [confirmed.id] }, format: "qa" });
    await datasets.idle();
    const delivery = await datasets.delivery(dataset.id);
    expect(delivery.verified).toBe(true); expect(delivery.trainingStarted).toBe(false);
    const download = await datasets.download(dataset.id, "training");
    let data = ""; for await (const bytes of download.stream) data += bytes.toString();
    expect(data).toContain('"timestamp":2'); expect(data).toContain(asset.sha256);
    store.memories.updateMemory(confirmed.id, { content: "视频画面中有红色方块。" }, confirmed.version);
    await expect(datasets.delivery(dataset.id)).rejects.toMatchObject({ code: "DATASET_UNAVAILABLE" });
    expect((await processing.submit({ assetIds: [asset.id, textAsset.id] }, { requestId: randomUUID() })).id).toBe(job.id);
    store.memories.ledger.setSettings({ videoSampleInterval: 3 });
    const changed = await processing.submit({ assetIds: [asset.id, textAsset.id] }, { requestId: randomUUID() });
    expect(changed.id).not.toBe(job.id);
    expect((await settled(imports, changed.id)).assets![0].video).toMatchObject({ frames: 3, sampleInterval: 3 });
    expect(calls).toEqual([0, 2, 3.75, 3]);
  });

  it("requires the observation's actual frame and serves the same pixels through HTTP", async () => {
    const { store, asset, config } = await fixture();
    const frame = await prepareVideoFrame(store.assetsDir, asset, 2.2);
    const memory = store.memories.createMemory({ title: "待核对画面", content: "视频画面中有蓝色方块。", status: "draft", kind: "observation", occurredAt: "", conversationId: "", runId: "",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, video: frame.video,
        visual: { width: frame.width, height: frame.height, previewSha256: frame.sha256 } }] });
    const proof = { toolCallId: "actual-frame", assetId: asset.id, sha256: asset.sha256, start: 0, end: asset.size, kind: "video" as const, video: frame.video, viewSha256: frame.sha256 };
    expect(() => requireObservationRead(memory, [{ ...proof, video: { ...frame.video, timestamp: 0 } }])).toThrow();
    expect(() => requireObservationRead(memory, [proof])).not.toThrow();
    const app = buildApp(config, { store }); await app.ready(); cleanup.push(() => app.close());
    const read = (await app.inject(`/api/evidence/asset:${asset.id}?timestamp=2.2`)).json();
    const image = await app.inject(read.source.previewUrl);
    expect(image.statusCode).toBe(200); expect(photoHash(image.rawPayload)).toBe(frame.sha256);
    expect((await app.inject(`/api/memories/${memory.id}/evidence/0/image`)).rawPayload).toEqual(image.rawPayload);
    expect((await app.inject(`/api/evidence/asset:${asset.id}?timestamp=4`)).statusCode).toBe(400);
    const input = { version: asset.sha256, viewSha256: read.source.view.sha256, timestamp: 2.2, title: "蓝色画面草稿", content: "画面中为蓝色。" };
    const saved = await app.inject({ method: "POST", url: `/api/evidence/asset:${asset.id}/drafts`, payload: input });
    expect(saved.statusCode).toBe(201);
    const draft = saved.json<{ memory: MemoryEntry }>().memory;
    expect(draft).toMatchObject({ status: "draft", kind: "observation", occurredAt: "", editedBy: "user" });
    expect(draft.acceptedBy).toBeUndefined(); expect(draft.sources[0].video).toEqual(frame.video);
    expect(draft.sources[0].view!.sha256).toBe(frame.sha256);
    expect((await app.inject({ method: "POST", url: `/api/evidence/asset:${asset.id}/drafts`, payload: { ...input, timestamp: 0 } })).statusCode).toBe(409);
  });
});
