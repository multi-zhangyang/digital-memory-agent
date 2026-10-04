import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { contentHash } from "../src/memory-values.js";
import { DatasetService } from "../src/dataset-service.js";
import type { ImageFeatures } from "../src/local-memory-processor.js";

it("reviews a controlled face candidate via HTTP, rolls back stale identity requests and invalidates dependent samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-routes-")); const store = new Store(directory);
  const data = await sharp({ create: { width: 100, height: 80, channels: 3, background: "white" } }).jpeg().toBuffer();
  const asset = { id: randomUUID(), name: "controlled-fixture.jpg", kind: "image" as const, mimeType: "image/jpeg", size: data.length, sha256: contentHash(data), createdAt: new Date().toISOString() };
  await writeFile(join(store.assetsDir, asset.id), data); store.addAsset(asset);
  const memory = store.work.createMemory({ title: "受控观察", content: "用于依赖和界面核对的测试替身输出。", status: "confirmed", kind: "observation", acceptedBy: "user", category: "fact",
    occurredAt: "", conversationId: "", runId: "", sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: data.length }] });
  // Feature substitute, not a claim that the blank image contains a person.
  const result: ImageFeatures = { fingerprint: "test-only", vector: Array.from({ length: 768 }, (_, i) => Number(i === 0)), width: 100, height: 80,
    coordinateSpace: "exif-oriented", metadata: { capturedLocal: null, offset: null, source: null, certainty: "unknown", hasGps: false },
    faces: [{ region: { x: .1, y: .1, width: .5, height: .5 }, detectionScore: .99, quality: "usable", vector: Array.from({ length: 128 }, (_, i) => Number(i === 0)) }] };
  const link = store.work.memory.graph.recordImage(asset, result, () => [])[0];
  const datasets = new DatasetService(store);
  const job = datasets.submit({ requestKey: "identity-lineage" }); await datasets.idle(); await datasets.close();
  const app = buildApp(readConfig({ MEMORY_DATA_DIR: directory, MEMORY_LOCAL_FEATURES: "off" }), { store });
  try {
    await app.ready();
    const page = await app.inject("/api/memory-entities"); expect(page.statusCode, page.body).toBe(200);
    expect(page.json().entities[0].observations[0].observation.id).toBe(link.observationId);
    const entity = page.json().entities[0];
    const preview = await app.inject(`/api/memory-observations/${link.observationId}/preview`);
    expect(preview.statusCode).toBe(200); expect(preview.headers["content-type"]).toContain("image/jpeg");
    const identified = await app.inject({ method: "POST", url: `/api/memory-entities/${entity.id}/identify`, payload: {
      version: entity.version, name: "明确的测试人物", reason: "受控测试确认，不代表真实人脸识别结果",
    } });
    expect(identified.statusCode, identified.body).toBe(200);
    expect(store.work.queries.search({ personId: identified.json().personId }).map((entry) => entry.id)).toEqual([memory.id]);
    expect(datasets.ledger.get(job.id).counts.staleSamples).toBe(2);
    expect(datasets.ledger.invalidations(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "entity", parentId: entity.id })]));
    const rejected = await app.inject({ method: "POST", url: `/api/memory-entities/${entity.id}/identify`, payload: { version: entity.version, name: "不应创建", reason: "过期版本" } });
    expect(rejected.statusCode).toBe(409);
    expect(store.db.prepare("SELECT count(*) AS n FROM memory_people").get()).toMatchObject({ n: 1 });
    await writeFile(join(store.assetsDir, asset.id), "changed");
    expect((await app.inject(`/api/memory-observations/${link.observationId}/preview`)).statusCode).toBe(409);
    store.memories.forgetMemory(memory.id, memory.version);
    expect((await app.inject("/api/memory-entities")).json().entities).toEqual([]);
    const current = store.memories.ledger.graph.entity(entity.id);
    expect((await app.inject(`/api/memory-entities/${entity.id}/observations?revision=${current.version}`)).json().observations).toEqual([]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
