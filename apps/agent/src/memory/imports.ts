import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  Asset,
  MemoryEntry,
  MemoryImportJob,
  MemoryImportChunk,
  MemorySpace,
  ThinkingLevel,
} from "@memory/contracts";
import type { AppConfig } from "../config.js";
import { projectRoot } from "../config.js";
import type { MemoryData } from "./data.js";
import { UserFacingError } from "../errors.js";
import type { MemoryProcessors } from "./processors.js";
import {
  EXTRACTOR_VERSION,
  type ExtractedMemory,
} from "../memory-extraction.js";
import { preparePhoto, type PreparedPhoto } from "./photo-source.js";
import { PHOTO_EXTRACTOR_VERSION, type PhotoObservation } from "../photo-extraction.js";
import { processingModel } from "./processing-policy.js";
import { inspectVideo, prepareVideoFrame, sampleVideo, VIDEO_EXTRACTOR_VERSION } from "./video-source.js";

type ImportCandidate = Omit<MemoryEntry, "id" | "version" | "createdAt" | "updatedAt">;

const now = () => new Date().toISOString();
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const done = (chunk: MemoryImportChunk) =>
  chunk.status === "completed" || chunk.status === "skipped";
const validDate = (value: string) =>
  !value ||
  (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value).toISOString().slice(0, 10) === value);
export interface MemoryImportInput {
  requestId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  space?: MemorySpace;
  title?: string;
  assetIds?: string[];
  records?: { name: string; text: string }[];
  demo?: boolean;
  mode?: "photos" | "auto";
  ownership?: "task" | "library";
  /** Internal service policy. Legacy explicit imports retain their single selected model. */
  models?: Partial<Record<"text" | "image" | "video", string>>;
}

export class MemoryImports {
  private readonly listeners = new Set<(id: string) => void>();
  private worker?: Promise<void>;
  private controller?: AbortController;
  private activeId?: string;
  private closing = false;
  private preparing = 0;
  private creation: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: MemoryData,
    private readonly config: AppConfig,
    private readonly processors: () => MemoryProcessors,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS memory_import_jobs (id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_extractions (key TEXT PRIMARY KEY, memoryIds TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_import_status ON memory_import_jobs(json_extract(data,'$.status'));`);
    while (true) {
      const row = store.db.prepare("SELECT id FROM memory_import_jobs WHERE json_extract(data,'$.status')='running' LIMIT 1").get() as { id: string } | undefined;
      if (!row) break;
      const job = this.job(row.id);
      job.recoveries++;
      job.status = job.recoveries > 3 ? "failed" : "queued";
      for (const chunk of job.chunks)
        if (chunk.status === "running") {
          chunk.status = job.recoveries > 3 ? "failed" : "pending";
          chunk.error =
            job.recoveries > 3 ? "多次重启中断，请手动重试" : undefined;
        }
      this.save(job);
    }
  }
  jobs(space?: MemorySpace, limit = 1000): MemoryImportJob[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM memory_import_jobs WHERE (? IS NULL OR json_extract(data,'$.space')=?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(space ?? null, space ?? null, Math.max(1, Math.min(1000, limit))) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  job(id: string): MemoryImportJob {
    const row = this.store.db
      .prepare("SELECT data FROM memory_import_jobs WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "导入任务不存在");
    return JSON.parse(row.data);
  }
  private save(job: MemoryImportJob) {
    job.updatedAt = now();
    job.revision = (job.revision || 0) + 1;
    this.store.memories.transaction(() => {
    this.store.db
      .prepare("UPDATE memory_import_jobs SET data=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
    this.store.events.publish("memory-import.changed", job.id, job.revision!, {});
    });
    queueMicrotask(() => { for (const listener of this.listeners) listener(job.id); });
    return job;
  }
  subscribe(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  busy() {
    return (
      this.preparing > 0 ||
      !!this.activeId ||
      !!this.store.db.prepare("SELECT 1 FROM memory_import_jobs WHERE json_extract(data,'$.status') IN ('queued','running') LIMIT 1").get()
    );
  }
  private nextQueued(): MemoryImportJob | undefined {
    const row = this.store.db.prepare("SELECT data FROM memory_import_jobs WHERE json_extract(data,'$.status')='queued' ORDER BY rowid LIMIT 1").get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private async read(asset: Asset) {
    if (asset.kind !== "text" || asset.size > 256 * 1024)
      throw new UserFacingError(
        400,
        "INVALID_TEXT",
        "当前支持每份不超过 256 KB 的 UTF-8 文字资料",
      );
    let buffer: Buffer;
    try {
      buffer = await readFile(join(this.store.assetsDir, asset.id));
    } catch {
      throw new UserFacingError(
        409,
        "SOURCE_MISSING",
        "原始资料已丢失，请重新导入",
      );
    }
    if (hash(buffer) !== asset.sha256 || buffer.length !== asset.size)
      throw new UserFacingError(
        409,
        "SOURCE_CHANGED",
        "原始资料校验不一致，请重新导入",
      );
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer);
      if (text.includes("\0") || !text.trim())
        throw new Error("Empty or binary source");
      return { text, buffer };
    } catch {
      throw new UserFacingError(
        400,
        "INVALID_TEXT",
        "请使用非空的 UTF-8 文本文件",
      );
    }
  }
  create(input: MemoryImportInput): Promise<MemoryImportJob> {
    this.preparing++;
    const promise = this.creation
      .then(() => this.prepare(input))
      .finally(() => {
        this.preparing--;
      });
    this.creation = promise.catch(() => undefined);
    return promise;
  }
  private async assetChunks(asset: Asset, modelId: string, photo: boolean, thinkingLevel?: ThinkingLevel): Promise<MemoryImportChunk[]> {
    if (this.store.memories.ledger.sourceBlocked(asset.sha256)) return [{ id: randomUUID(), assetId: asset.id, name: asset.name,
      sha256: asset.sha256, start: 0, end: asset.size, status: "skipped", attempts: 0, memoryIds: [], modelId,
      ...(photo ? { media: "image" } : {}), reason: photo ? "关联照片已停止取用，未发送给模型" : "关联资料已停止取用，未发送给模型" }];
    const provider = this.config.providers.find((item) => item.model.id === modelId);
    if (!provider) throw new UserFacingError(400, "MODEL_UNAVAILABLE", "此类资料的处理模型未配置，请配置后重试");
    const base = { assetId: asset.id, name: asset.name, sha256: asset.sha256, status: "pending" as const, attempts: 0, memoryIds: [], modelId,
      thinkingLevel: provider.model.reasoning ? thinkingLevel || provider.model.thinkingLevel : "off" as const };
    if (asset.kind === "video") {
      if (!provider.model.supportsImages || !this.processors().extractPhotoMemories) throw new UserFacingError(400, "VISION_UNAVAILABLE", "视频画面整理需要支持图片输入的模型");
      const info = await inspectVideo(this.store.assetsDir, asset);
      const sample = sampleVideo(info, this.store.memories.ledger.settings().videoSampleInterval || 10);
      return sample.timestamps.map((timestamp) => ({ ...base, id: randomUUID(), start: 0, end: asset.size, media: "video",
        video: { timestamp, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, sampleInterval: sample.interval } }));
    }
    if (photo) {
      if (!provider.model.supportsImages || !this.processors().extractPhotoMemories) throw new UserFacingError(400, "VISION_UNAVAILABLE", "照片处理需要支持图片输入的模型");
      await preparePhoto(this.store.assetsDir, asset);
      return [{ ...base, id: randomUUID(), start: 0, end: asset.size, media: "image" }];
    }
    if (!this.processors().extractMemories) throw new UserFacingError(400, "MODEL_UNAVAILABLE", "当前运行时不支持文字提取");
    const { text } = await this.read(asset);
    const chunks: MemoryImportChunk[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + 2200, text.length);
      if (end < text.length) {
        const paragraph = text.lastIndexOf("\n", end);
        if (paragraph > offset + 1100) end = paragraph + 1;
        else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      if (text.slice(offset, end).trim()) chunks.push({ ...base, id: randomUUID(),
        start: Buffer.byteLength(text.slice(0, offset)), end: Buffer.byteLength(text.slice(0, end)) });
      offset = end;
    }
    return chunks;
  }
  private async prepare(input: MemoryImportInput): Promise<MemoryImportJob> {
    const existing = this.store.db
      .prepare("SELECT data FROM memory_import_jobs WHERE requestId=?")
      .get(input.requestId) as { data: string } | undefined;
    if (existing) return JSON.parse(existing.data);
    if (this.closing)
      throw new UserFacingError(503, "CLOSING", "服务正在关闭，请稍后重试");
    const provider = this.config.providers.find(
      (item) => item.model.id === input.modelId,
    );
    if (!provider || (!input.models && !(input.mode === "photos" ? this.processors().extractPhotoMemories : this.processors().extractMemories)))
      throw new UserFacingError(
        400,
        "MODEL_UNAVAILABLE",
        "请先在设置中配置可用模型",
      );
    const space = input.demo ? "demo" : input.space || "personal";
    if (input.mode === "photos" && (!provider.model.supportsImages || input.demo || input.records?.length))
      throw new UserFacingError(400, "VISION_UNAVAILABLE", "照片导入需要支持图片输入的模型，并且只能选择图片资料");
    let records = input.records || [];
    if (input.demo) {
      if (records.length || input.assetIds?.length)
        throw new UserFacingError(
          400,
          "INVALID_REQUEST",
          "示例导入不能混入其他资料",
        );
      records = await Promise.all(
        ["01-profile.md", "02-walk.md", "03-move.md", "04-uncertain.md"].map(
          async (name) => ({
            name,
            text: await readFile(
              join(projectRoot, "examples/experiences", name),
              "utf8",
            ),
          }),
        ),
      );
    }
    const assets = [...new Set(input.assetIds || [])].map((id) => {
      const asset = this.store.asset(id);
      if (!asset || (asset.memorySpace || "personal") !== space)
        throw new UserFacingError(
          400,
          "INVALID_SOURCE",
          "所选资料不存在或不属于这个记忆空间",
        );
      return asset;
    });
    const created: Asset[] = [];
    try {
      for (const record of records) {
        if (
          !record.name.trim() ||
          !record.text.trim() ||
          Buffer.byteLength(record.text) > 256 * 1024
        )
          throw new UserFacingError(
            400,
            "INVALID_TEXT",
            "请填写标题与非空文字，每份不超过 256 KB",
          );
        const sha256 = hash(record.text);
        const previous = [...this.store.assets(space), ...created].find(
          (asset) => asset.sha256 === sha256 && asset.kind === "text",
        );
        if (previous) {
          assets.push(previous);
          continue;
        }
        const asset: Asset = {
          id: randomUUID(),
          name: record.name.trim().slice(0, 200),
          kind: "text",
          mimeType: "text/plain",
          size: Buffer.byteLength(record.text),
          sha256,
          createdAt: now(),
          memorySpace: space,
        };
        await writeFile(join(this.store.assetsDir, asset.id), record.text, {
          mode: 0o600,
          flag: "wx",
        });
        created.push(asset);
        assets.push(asset);
      }
      const unique = [
        ...new Map(assets.map((asset) => [asset.sha256, asset])).values(),
      ];
      if (!unique.length || unique.length > (input.mode === "auto" ? 200 : 20))
        throw new UserFacingError(
          400,
          "IMPORT_LIMIT",
          input.mode === "auto" ? "每批请选择 1 至 200 份资料" : "每批请选择 1 至 20 份资料",
        );
      const chunks: MemoryImportChunk[] = [];
      for (const asset of unique) {
        const modelId = input.models ? input.models[asset.kind as "image" | "text" | "video"] || "" : input.modelId;
        try {
          chunks.push(...await this.assetChunks(asset, modelId, input.mode === "photos" || (input.mode === "auto" && asset.kind === "image"), input.thinkingLevel));
        } catch (error) {
          if (!input.models) throw error;
          chunks.push({ id: randomUUID(), assetId: asset.id, name: asset.name, sha256: asset.sha256,
            start: 0, end: asset.size, ...(["image", "video"].includes(asset.kind) ? { media: asset.kind as "image" | "video" } : {}),
            status: "failed", attempts: 0, memoryIds: [], modelId, preparationFailed: true,
            error: error instanceof UserFacingError ? error.message : "无法准备这份资料，请检查原件后重试" });
        }
      }
      if (chunks.length > (input.mode === "auto" ? 512 : 32))
        throw new UserFacingError(
          400,
          "IMPORT_LIMIT",
          input.mode === "auto" ? "本批超过 512 个处理片段，请缩小所选范围" : "本批超过 32 个处理片段，请分批导入",
        );
      const job: MemoryImportJob = {
        id: randomUUID(),
        title:
          input.title?.trim() ||
          (input.demo
            ? "林舟的经历 · 虚构示例"
            : unique[0].name +
              (unique.length > 1 ? ` 等 ${unique.length} 份` : "")),
        space,
        modelId: input.modelId,
        thinkingLevel: provider.model.reasoning
          ? input.thinkingLevel || provider.model.thinkingLevel
          : "off",
        status: "queued",
        chunks,
        assets: [...new Map(assets.map((asset) => [asset.id, asset])).values()].map((asset) => ({ assetId: asset.id, name: asset.name, sha256: asset.sha256,
          ...(unique.find((item) => item.sha256 === asset.sha256)!.id !== asset.id ? { duplicateOf: unique.find((item) => item.sha256 === asset.sha256)!.id } : {}),
          ...this.videoCoverage(chunks.filter((chunk) => chunk.assetId === unique.find((item) => item.sha256 === asset.sha256)!.id)) })),
        recoveries: 0,
        ...(input.mode ? { mode: input.mode } : {}),
        revision: 0,
        ownership: input.ownership || "library",
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.memories.transaction(() => {
        for (const asset of created) this.store.addAsset(asset, { processing: "requested" });
        this.store.db
          .prepare("INSERT INTO memory_import_jobs VALUES (?,?,?)")
          .run(job.id, input.requestId, JSON.stringify(job));
        this.store.events.publish("memory-import.changed", job.id, 0);
      });
      this.wake();
      return job;
    } catch (error) {
      await Promise.all(
        created.map((asset) =>
          rm(join(this.store.assetsDir, asset.id), { force: true }),
        ),
      );
      throw error;
    }
  }
  wake() {
    if (this.worker || this.closing) return;
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.worker = undefined;
        if (!this.closing && this.nextQueued())
          this.wake();
      });
  }
  private receiptKey(job: MemoryImportJob, chunk: MemoryImportChunk) {
    return hash(
      JSON.stringify([
        job.space,
        chunk.sha256,
        chunk.start,
        chunk.end,
        ...(chunk.media === "video" ? ["video", VIDEO_EXTRACTOR_VERSION, chunk.video?.timestamp] : chunk.media === "image" ? ["photo", PHOTO_EXTRACTOR_VERSION] : [EXTRACTOR_VERSION]),
      ]),
    );
  }
  private videoCoverage(chunks: MemoryImportChunk[]) {
    const video = chunks.find((chunk) => chunk.video)?.video;
    return video ? { video: { duration: video.duration, width: video.width, height: video.height, hasAudio: video.hasAudio,
      sampleInterval: video.sampleInterval,
      frames: chunks.length, coverage: "sampled-frames" as const } } : {};
  }
  private candidates(
    job: MemoryImportJob,
    chunk: MemoryImportChunk,
    text: string,
    entries: ExtractedMemory[],
  ): ImportCandidate[] {
    return entries.map((entry) => {
      const index = text.indexOf(entry.quote);
      if (
        index < 0 ||
        !entry.quote.trim() ||
        !validDate(entry.occurredAt) ||
        (entry.kind === "inference" && !entry.uncertainty.trim()) ||
        (entry.attribute &&
          (entry.category !== "profile" ||
            !text.includes(entry.attribute.value) ||
            !/[\p{L}\p{N}]/u.test(entry.attribute.value))) ||
        entry.people.some((name) => !text.includes(name))
      )
        throw new UserFacingError(
          422,
          "INVALID_EVIDENCE",
          "候选的引句、日期或人物无法通过原文校验，请重试或修订原始记录",
        );
      const start = chunk.start + Buffer.byteLength(text.slice(0, index));
      return {
        title: entry.title,
        content: entry.content,
        status: "draft" as const,
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        space: job.space,
        category: entry.category,
        people: [...new Set(entry.people)],
        place: entry.place,
        uncertainty: entry.uncertainty,
        attribute: entry.attribute || undefined,
        sources: [
          {
            assetId: chunk.assetId,
            name: chunk.name,
            sha256: chunk.sha256,
            start,
            end: start + Buffer.byteLength(entry.quote),
            quote: entry.quote,
          },
        ],
        conversationId: "",
        runId: "",
        ingestion: {
          jobId: job.id,
          chunkId: chunk.id,
          modelId: chunk.modelId ?? job.modelId,
          extractorVersion: EXTRACTOR_VERSION,
        },
      };
    });
  }
  private photoCandidates(job: MemoryImportJob, chunk: MemoryImportChunk, photo: PreparedPhoto & { video?: import("@memory/contracts").VideoFrame }, entries: PhotoObservation[]): ImportCandidate[] {
    return entries.map((entry) => ({
      title: entry.title, content: entry.content, status: "draft", kind: entry.kind,
      occurredAt: "", category: "fact", people: [], space: job.space,
      uncertainty: entry.uncertainty, conversationId: "", runId: "",
      sources: [{ assetId: chunk.assetId, name: chunk.name, sha256: chunk.sha256, start: 0, end: chunk.end,
        ...(photo.video ? { video: photo.video } : {}),
        visual: { width: photo.width, height: photo.height, previewSha256: photo.sha256,
          ...(entry.region ? { region: entry.region } : {}), ...(entry.visibleText ? { transcript: entry.visibleText } : {}) } }],
      ingestion: { jobId: job.id, chunkId: chunk.id, modelId: chunk.modelId ?? job.modelId, extractorVersion: photo.video ? VIDEO_EXTRACTOR_VERSION : PHOTO_EXTRACTOR_VERSION },
    }));
  }
  private async drain() {
    while (!this.closing) {
      let job = this.nextQueued();
      if (!job) return;
      this.activeId = job.id;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      job.status = "running";
      this.save(job);
      try {
        for (let index = 0; index < job.chunks.length; index++) {
          signal.throwIfAborted();
          job = this.job(job.id);
          let chunk = job.chunks[index];
          if (done(chunk) || chunk.status === "failed") continue;
          chunk.status = "running";
          chunk.stage = "read";
          chunk.error = undefined;
          chunk.reason = undefined;
          this.save(job);
          try {
            const asset = this.store.asset(chunk.assetId);
            if (!asset)
              throw new UserFacingError(
                409,
                "SOURCE_MISSING",
                "原始资料已丢失，请重新导入",
              );
            if (
              asset.sha256 !== chunk.sha256 ||
              (asset.memorySpace || "personal") !== job.space
            )
              throw new UserFacingError(
                409,
                "SOURCE_CHANGED",
                "资料与导入记录不一致，请重新导入",
              );
            if (chunk.preparationFailed) {
              const prepared = await this.assetChunks(asset, chunk.modelId ?? job.modelId, chunk.media === "image");
              if (job.chunks.length - 1 + prepared.length > 512) throw new UserFacingError(400, "IMPORT_LIMIT", "重试后超过 512 个片段，请缩小批次");
              signal.throwIfAborted();
              job.chunks.splice(index, 1, ...prepared);
              for (const source of job.assets || []) if ((source.duplicateOf || source.assetId) === asset.id) Object.assign(source, this.videoCoverage(prepared));
              chunk = job.chunks[index];
              chunk.status = "running";
              this.save(job);
            }
            const photo = chunk.media === "video" ? await prepareVideoFrame(this.store.assetsDir, asset, chunk.video!.timestamp, { signal, info: chunk.video })
              : chunk.media === "image" ? await preparePhoto(this.store.assetsDir, asset) : undefined;
            const text = photo ? "" : (await this.read(asset)).buffer.subarray(chunk.start, chunk.end).toString("utf8");
            signal.throwIfAborted();
            if (this.store.memories.ledger.sourceBlocked(chunk.sha256, chunk.start, chunk.end)) {
              chunk.status = "skipped";
              chunk.stage = undefined;
              chunk.memoryIds = [];
              chunk.reason = photo ? "关联照片已停止取用，未发送给模型" : "关联资料已停止取用，未发送给模型";
              this.save(job);
              continue;
            }
            const key = this.receiptKey(job, chunk);
            const receipt = this.store.db
              .prepare("SELECT memoryIds FROM memory_extractions WHERE key=?")
              .get(key) as { memoryIds: string } | undefined;
            if (receipt) {
              chunk.memoryIds = JSON.parse(receipt.memoryIds);
              chunk.status = "skipped";
              chunk.stage = undefined;
              this.save(job);
              continue;
            }
            chunk.stage = "extract";
            chunk.attempts++;
            this.save(job);
            const runtime = this.processors();
            let candidates: ImportCandidate[];
            let usage: { input: number; output: number };
            if (photo) {
              if (!runtime.extractPhotoMemories) throw new UserFacingError(400, "VISION_UNAVAILABLE", "当前运行时不支持照片提取");
              const result = await runtime.extractPhotoMemories({ modelId: chunk.modelId ?? job.modelId, thinkingLevel: chunk.thinkingLevel ?? job.thinkingLevel, photo }, signal);
              candidates = this.photoCandidates(job, chunk, photo, result.entries);
              usage = result.usage;
            } else {
              if (!runtime.extractMemories) throw new UserFacingError(400, "MODEL_UNAVAILABLE", "当前运行时不支持记忆提取");
              const result = await runtime.extractMemories({ modelId: chunk.modelId ?? job.modelId, thinkingLevel: chunk.thinkingLevel ?? job.thinkingLevel, name: chunk.name, text }, signal);
              candidates = this.candidates(job, chunk, text, result.entries);
              usage = result.usage;
            }
            signal.throwIfAborted();
            chunk.stage = "validate";
            chunk.usage = usage;
            this.save(job);
            chunk.stage = "save";
            this.save(job);
            this.store.memories.transaction(() => {
              signal.throwIfAborted();
              const fingerprints = new Set<string>();
              chunk.memoryIds = candidates
                .filter((value) => {
                  if (this.store.memories.ledger.suppressed(value)) return false;
                  const fingerprint = hash(
                    JSON.stringify([
                      value.category,
                      value.content.trim(),
                      value.sources[0].quote,
                      value.sources[0].visual,
                      value.sources[0].video,
                    ]),
                  );
                  if (fingerprints.has(fingerprint)) return false;
                  fingerprints.add(fingerprint);
                  return true;
                })
                .map((candidate) => {
                  const existing = this.store.memories.duplicateMemory(candidate);
                  // A new photo still needs review even when its caption matches an accepted fact.
                  const duplicate = existing && (!photo || (existing.status === "draft" && existing.kind === candidate.kind)) ? existing : undefined;
                  return duplicate ? this.store.memories.addMemoryEvidence(duplicate.id, candidate.sources.map((source) => ({ ...source, type: "asset" as const }))).id : this.store.memories.createMemory(candidate).id;
                });
              this.store.db
                .prepare("INSERT INTO memory_extractions VALUES (?,?,?)")
                .run(key, JSON.stringify(chunk.memoryIds), now());
              chunk.status = "completed";
              chunk.stage = undefined;
              this.save(job!);
            });
          } catch (error) {
            if (signal.aborted) throw error;
            chunk.status = "failed";
            chunk.stage = undefined;
            chunk.error =
              error instanceof UserFacingError
                ? error.message
                : "处理失败，请检查模型配置后重试此段";
            this.save(job);
          }
        }
        job = this.job(job.id);
        job.status = job.chunks.some((chunk) => chunk.status === "failed")
          ? "failed"
          : "completed";
        this.save(job);
      } catch {
        job = this.job(job.id);
        if (job.status !== "cancelled")
          job.status = this.closing ? "queued" : "failed";
        for (const chunk of job.chunks)
          if (chunk.status === "running") {
            chunk.status =
              this.closing || job.status === "cancelled" ? "pending" : "failed";
            chunk.stage = undefined;
            chunk.error =
              chunk.status === "failed"
                ? "处理意外中断，可重试未完成部分"
                : undefined;
          }
        this.save(job);
      } finally {
        this.activeId = undefined;
        this.controller = undefined;
      }
    }
  }
  cancel(id: string) {
    const job = this.job(id);
    if (job.status !== "queued" && job.status !== "running") return job;
    job.status = "cancelled";
    this.save(job);
    if (this.activeId === id) this.controller?.abort();
    return job;
  }
  retry(id: string, assetIds?: readonly string[]) {
    const job = this.job(id);
    if (this.activeId === id)
      throw new UserFacingError(
        409,
        "IMPORT_BUSY",
        "正在停止当前片段，请稍后重试",
      );
    if (job.status !== "failed" && job.status !== "cancelled")
      throw new UserFacingError(409, "IMPORT_BUSY", "当前任务无需重试");
    if (job.mode !== "auto" &&
      !this.config.providers.some(
        (provider) => provider.model.id === job.modelId,
      )
    )
      throw new UserFacingError(
        400,
        "MODEL_UNAVAILABLE",
        "原模型未配置，请恢复配置或新建导入",
      );
    job.status = "queued";
    job.recoveries = 0;
    const selected = assetIds && new Set(assetIds.map((assetId) => job.assets?.find((asset) => asset.assetId === assetId)?.duplicateOf || assetId));
    if (assetIds?.some((assetId) => !(job.assets || job.chunks).some((asset) => asset.assetId === assetId))) throw new UserFacingError(400, "SOURCE_SCOPE", "所选资料不在这个作业中");
    for (const chunk of job.chunks)
      if (!done(chunk) && (!selected || selected.has(chunk.assetId))) {
        if (job.mode === "auto") {
          try {
            const model = processingModel(this.config, this.store.memories.ledger.settings(), chunk.media === "image" ? "photo" : chunk.media || "text", chunk.modelId || job.modelId).model;
            chunk.modelId = model.id; chunk.thinkingLevel = model.reasoning ? model.thinkingLevel : "off";
          } catch { chunk.modelId = ""; }
        }
        chunk.status = "pending";
        chunk.error = undefined;
        chunk.stage = undefined;
      }
    this.save(job);
    this.wake();
    return job;
  }
  async close() {
    this.closing = true;
    this.controller?.abort();
    await this.creation;
    await this.worker;
  }
}
