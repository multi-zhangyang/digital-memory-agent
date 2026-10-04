// Independent public-image evaluation. Reference labels never reach a processor.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Asset, MemoryEntry, MemoryObservation } from "@memory/contracts";
import { readConfig, projectRoot } from "../src/config.js";
import { Store } from "../src/store.js";
import { LocalMemoryProcessor } from "../src/local-memory-processor.js";
import { MemoryFeatureService } from "../src/memory-feature-service.js";
import { ModelAccess } from "../src/model-access.js";
import { preparePhoto } from "../src/photo-source.js";
import { extractPhotoMemories, PHOTO_EXTRACTOR_VERSION } from "../src/photo-extraction.js";

type Split = "development" | "holdout";
type Fixture = {
  id: string; split: Split; file: string; sha256: string; bytes: number; kind: "object" | "people";
  faceGroups: string[]; expectedFaces?: number; independent?: boolean; vision?: boolean;
};
type Query = { id: string; split: Split; query: string; expected: string[] };
type Manifest = { version: number; images: Fixture[]; queries: Query[] };
function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const split = argument("--split") as Split;
if (!["development", "holdout"].includes(split)) throw new Error("Specify --split development or --split holdout explicitly");
const label = argument("--label") || "current";
if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Invalid evaluation label");
const visionId = argument("--vision-id");
const imageDetail = argument("--image-detail");
if (imageDetail && !["auto", "high"].includes(imageDetail)) throw new Error("Use --image-detail auto or high");
const corpusRoot = resolve(argument("--corpus-root") || projectRoot);
const manifestBytes = await readFile(join(corpusRoot, "examples/quality/images.json"));
const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
if (manifest.version !== 1 || manifest.images.length > 30 || manifest.queries.length > 60) throw new Error("Invalid bounded image corpus");
if (visionId && !manifest.images.some((item) => item.id === visionId && item.split === split && item.vision)) throw new Error("Unknown vision case for the selected split");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const config = readConfig();
if (!config.localProcessor) throw new Error("Install the fixed local encoders before evaluating");
const root = join(corpusRoot, ".data/evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, `image-quality-${split}-${label}-`));
const store = new Store(directory);
const features = new MemoryFeatureService(store, new LocalMemoryProcessor(config.localProcessor));
store.work.queries.features = features;
const images = manifest.images.filter((item) => item.split === "development" || split === "holdout")
  .sort((a, b) => Number(a.split === "holdout") - Number(b.split === "holdout"));
const assets = new Map<string, Asset>(), memories = new Map<string, MemoryEntry>(), keys = new Map<string, string>();
type Face = { observationId: string; entityId: string; state: string; personId: string | null; status: string;
  score: number | null; output: MemoryObservation["output"] };
const faces = new Map<string, Face[]>();
const implementation: Record<string, string> = {};
for (const path of ["apps/agent/src/memory-query-service.ts", "apps/agent/src/memory-feature-service.ts", "apps/agent/src/memory-vectors.ts",
  "apps/agent/src/memory-graph.ts", "apps/agent/src/photo-extraction.ts", "apps/agent/src/photo-source.ts", "services/memory-worker/worker.py", "services/memory-worker/models.json"])
  implementation[path] = hash(await readFile(join(projectRoot, path)));
const report = { type: "independent-image-quality", label, split, at: new Date().toISOString(), manifestHash: hash(manifestBytes),
  selectedInputHash: hash(JSON.stringify({ images, queries: manifest.queries.filter((item) => item.split === split) })), implementation,
  scope: "Licensed public images in an isolated store. Reference metadata and anonymous person labels are withheld from processors; no personal memory or model training.",
  modelTraining: false, modelCalls: 0, completed: false, indexingMs: 0, extractorVersion: PHOTO_EXTRACTOR_VERSION,
  imageDetail: imageDetail || "provider-default", thinkingLevel: "low",
  processor: undefined as ReturnType<MemoryFeatureService["status"]> | undefined,
  images: [] as Record<string, unknown>[], pairs: [] as Record<string, unknown>[], retrieval: [] as Record<string, unknown>[], vision: [] as Record<string, unknown>[],
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
try {
  // Index one source at a time in frozen order so online association is reproducible.
  for (const item of images) {
    if (!/^[a-z0-9-]+\.jpg$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256) || item.bytes > 20 * 1024 * 1024)
      throw new Error("Invalid pinned public fixture");
    const data = await readFile(join(corpusRoot, ".data/quality-fixtures", item.file));
    if (data.length !== item.bytes || hash(data) !== item.sha256) throw new Error("Public fixture checksum mismatch");
    const asset: Asset = { id: randomUUID(), name: `photo-${assets.size + 1}.jpg`, kind: "image", mimeType: "image/jpeg",
      size: data.length, sha256: item.sha256, memorySpace: "personal", createdAt: new Date().toISOString() };
    await writeFile(join(store.assetsDir, asset.id), data, { mode: 0o600 }); store.addAsset(asset); assets.set(item.id, asset);
    // Confirmation is a fixture state solely to exercise retrieval, not a verified caption.
    const memory = store.work.createMemory({ title: `评测图片 ${assets.size}`, content: "未提供图像描述的公开评测图片。", kind: "observation", status: "confirmed",
      category: "fact", occurredAt: "", conversationId: "", runId: "", uncertainty: "公开评测材料，不代表用户经历，身份未确认。",
      sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size }] });
    memories.set(item.id, memory); keys.set(memory.id, item.id);
    const start = performance.now(); await features.idle(); const durationMs = performance.now() - start; report.indexingMs += durationMs;
    const rows = store.db.prepare(`SELECT o.data,l.entityId,l.status,l.score,e.state,e.personId FROM memory_observations o
      JOIN memory_entity_links l ON l.observationId=o.id AND l.active=1 JOIN memory_entities e ON e.id=l.entityId
      WHERE o.assetId=? AND o.kind='face' ORDER BY o.rowid`).all(asset.id) as { data: string; entityId: string; status: string; score: number | null; state: string; personId: string | null }[];
    const assignments = rows.map(({ data: raw, ...row }) => { const observation = JSON.parse(raw) as MemoryObservation;
      return { ...row, observationId: observation.id, output: observation.output }; });
    faces.set(item.id, assignments);
    report.images.push({ id: item.id, split: item.split, anchor: item.split !== split, assetId: asset.id, memoryId: memory.id, sha256: item.sha256,
      expectedFaces: item.expectedFaces, detectedFaces: assignments.length, countCorrect: item.expectedFaces === undefined ? undefined : assignments.length === item.expectedFaces,
      identitiesUnknown: assignments.every((face) => face.state === "unknown" && face.personId === null && face.status === "candidate"),
      cooccurringFacesSeparate: new Set(assignments.map((face) => face.entityId)).size === assignments.length,
      assignments, durationMs, pixelReview: "pending; detection counts alone cannot establish correct face localization" });
    report.processor = features.status(); await save();
    console.log(JSON.stringify({ stage: "index-image", id: item.id, faces: assignments.length, expected: item.expectedFaces }));
  }
  if (report.processor?.jobs.failed || report.processor?.jobs.completed !== images.length) throw new Error("Image indexing incomplete");
  // Source metadata supplies anonymous reference groups only for single portraits.
  // Group photos have no position-to-identity labels and never enter this pair score.
  const portraits = images.filter((item) => item.faceGroups.length === 1 && item.independent !== false);
  for (let i = 0; i < portraits.length; i++) for (let j = i + 1; j < portraits.length; j++) {
    const a = portraits[i], b = portraits[j];
    if (split === "holdout" && a.split !== "holdout" && b.split !== "holdout") continue;
    const left = faces.get(a.id)!, right = faces.get(b.id)!;
    const detected = left.length === 1 && right.length === 1;
    const same = a.faceGroups[0] === b.faceGroups[0];
    const associated = detected && left[0].entityId === right[0].entityId;
    const similarity = detected ? store.db.prepare(`SELECT 1-vec_distance_cosine(a.embedding,b.embedding) AS similarity
      FROM memory_vector_meta ma JOIN memory_vectors_face a ON a.id=ma.id,
      memory_vector_meta mb JOIN memory_vectors_face b ON b.id=mb.id
      WHERE ma.channel='face' AND mb.channel='face' AND ma.subjectId=? AND mb.subjectId=?`)
      .get(left[0].observationId, right[0].observationId) as { similarity: number } | undefined : undefined;
    report.pairs.push({ a: a.id, b: b.id, expectedSame: same, bothDetected: detected, associated, similarity: similarity?.similarity ?? null,
      outcome: same ? associated ? "true-positive" : "false-negative" : associated ? "false-positive" : "true-negative" });
  }
  for (const question of manifest.queries.filter((item) => item.split === split)) {
    const start = performance.now();
    const vector = await features.retrieve({ query: question.query, category: "fact", limit: 8 }, undefined, true);
    const hybrid = await store.work.queries.recallAsync({ query: question.query, category: "fact", limit: 8 });
    const score = (ids: string[]) => { const ranked = ids.map((id) => keys.get(id)!); const index = ranked.findIndex((id) => question.expected.includes(id));
      return { keys: ranked, rank: index < 0 ? null : index + 1, hitAt1: index === 0, hitAt3: index >= 0 && index < 3 }; };
    const item = { ...question, image: score(vector.image.map((hit) => hit.memoryId)), hybrid: score(hybrid.entries.map((entry) => entry.id)),
      durationMs: performance.now() - start, responseBytes: Buffer.byteLength(JSON.stringify(hybrid.response)), evidence: hybrid.response };
    report.retrieval.push(item); await save(); console.log(JSON.stringify({ stage: "image-query", id: question.id, imageRank: item.image.rank, hybridRank: item.hybrid.rank }));
  }
  if (process.argv.includes("--vision")) {
    const configured = config.providers[0]; if (!configured) throw new Error("Configure a vision model for --vision");
    // Enable capability only in the isolated process; successful calls verify image input support.
    const provider = { ...configured, model: { ...configured.model, supportsImages: true } };
    const models = await new ModelAccess({ ...config, providers: config.providers.map((item) => item === configured ? provider : item) }).get();
    const complete = models.completeSimple.bind(models);
    let payloadSeen = false;
    let requestImages: { sha256: string; bytes: number; mimeType: string }[] = [];
    models.completeSimple = (model, context, options) => complete(model, context, { ...options, onPayload(payload) {
      payloadSeen = true;
      const visit = (value: unknown) => {
        if (typeof value === "string" && value.startsWith("data:image/")) {
          const match = value.match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/);
          if (match) { const data = Buffer.from(match[2], "base64"); requestImages.push({ mimeType: match[1], bytes: data.length, sha256: hash(data) }); }
        } else if (value && typeof value === "object") {
          const item = value as Record<string, unknown>;
          if (imageDetail && item.type === "image_url" && item.image_url && typeof item.image_url === "object")
            (item.image_url as Record<string, unknown>).detail = imageDetail;
          if (imageDetail && item.type === "input_image") item.detail = imageDetail;
          for (const child of Object.values(value)) visit(child);
        }
      };
      visit(payload);
      // Retain only image digests. No keys, endpoint headers, prompt text or base64 in reports.
      return imageDetail ? payload : undefined;
    } });
    for (const item of images.filter((image) => image.split === split && image.vision && (!visionId || image.id === visionId))) {
      const start = performance.now(); const asset = assets.get(item.id)!; const photo = await preparePhoto(store.assetsDir, asset);
      payloadSeen = false; requestImages = [];
      report.modelCalls++;
      try {
        const result = await extractPhotoMemories(models, provider, { modelId: provider.model.id, thinkingLevel: "low", photo }, AbortSignal.timeout(130000));
        report.vision.push({ id: item.id, model: provider.model.name, ...result, durationMs: performance.now() - start,
          preparedImageHash: hash(photo.data), transformation: "EXIF-oriented, metadata stripped, JPEG, longest edge at most 1600",
          transport: { payloadSeen, images: requestImages, matchesPrepared: payloadSeen && requestImages.length === 1 && requestImages[0].sha256 === hash(photo.data) },
          contentReview: "pending; compare each claim to the frozen pixel rubric, not to a source caption or another model vote" });
        console.log(JSON.stringify({ stage: "vision", id: item.id, observations: result.entries.length }));
      } catch (error) {
        report.vision.push({ id: item.id, model: provider.model.name, error: error instanceof Error ? error.name : "VisionError", durationMs: performance.now() - start });
        console.log(JSON.stringify({ stage: "vision", id: item.id, failed: true }));
      }
      await save();
    }
  }
  report.completed = true; await save();
  console.log(JSON.stringify({ report: join(directory, "report.json"), images: images.length, evaluatedImages: images.filter((item) => item.split === split).length,
    modelCalls: report.modelCalls, pairs: report.pairs.length, queries: report.retrieval.length }));
} catch (error) {
  await save(); console.error(JSON.stringify({ error: error instanceof Error ? error.name : "EvaluationError", report: join(directory, "report.json") })); process.exitCode = 1;
} finally { await features.close(); store.close(); }
