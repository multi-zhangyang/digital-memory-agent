import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, EvidenceSearch, MemoryEntry, MemorySearch, MemorySpace } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { encoderFingerprint, type FeatureInfo, type ImageFeatures, type FeatureProcessor } from "../integrations/feature-provider.js";
import { MemoryVectors } from "./vectors.js";
import { contentHash, evidenceOf } from "./values.js";
import { UserFacingError } from "../errors.js";
import { inspectVideo, prepareVideoFrame, sampleVideo } from "./video-source.js";
import type { EvidenceScope } from "./evidence-index.js";

type Job = { memoryId: string; version: number; status: string; attempts: number };

/** Durable maintenance worker. Independent of Pi sessions and user polling; providers own inference. */
export class MemoryFeatureService {
  readonly vectors: MemoryVectors;
  private manifest?: FeatureInfo;
  private initializing?: Promise<void>;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private controller = new AbortController();
  private state: "not_configured" | "starting" | "ready" | "unavailable";
  constructor(private readonly store: MemoryData, private processor?: FeatureProcessor) {
    this.state = processor ? "starting" : "not_configured";
    this.vectors = new MemoryVectors(store.db);
    store.memories.transaction(() => {
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_feature_meta (id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_feature_jobs(memoryId TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,error TEXT,updatedAt TEXT NOT NULL,space TEXT NOT NULL DEFAULT 'personal');
      CREATE INDEX IF NOT EXISTS feature_pending ON memory_feature_jobs(status,memoryId);
      CREATE INDEX IF NOT EXISTS feature_pending_time ON memory_feature_jobs(status,updatedAt,memoryId);
      CREATE TABLE IF NOT EXISTS memory_asset_features(assetId TEXT PRIMARY KEY,sourceHash TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL);`);
    if (!store.db.prepare("PRAGMA table_info(memory_feature_jobs)").all().some((column) => column.name === "space")) {
      store.db.exec(`ALTER TABLE memory_feature_jobs ADD COLUMN space TEXT NOT NULL DEFAULT 'personal';
        UPDATE memory_feature_jobs SET space=coalesce((SELECT space FROM memory_read WHERE id=memoryId),'personal');`);
    }
    if (!store.db.prepare("PRAGMA table_info(memory_feature_jobs)").all().some((column) => column.name === "revision"))
      store.db.exec("ALTER TABLE memory_feature_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    const countsExist = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_feature_counts'").get();
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_feature_counts(space TEXT NOT NULL,status TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(space,status));
      CREATE TRIGGER IF NOT EXISTS feature_count_added AFTER INSERT ON memory_feature_jobs BEGIN
        INSERT INTO memory_feature_counts VALUES(new.space,new.status,1) ON CONFLICT(space,status) DO UPDATE SET n=n+1;
      END;
      CREATE TRIGGER IF NOT EXISTS feature_count_removed AFTER DELETE ON memory_feature_jobs BEGIN
        UPDATE memory_feature_counts SET n=n-1 WHERE space=old.space AND status=old.status;
      END;
      CREATE TRIGGER IF NOT EXISTS feature_count_changed AFTER UPDATE ON memory_feature_jobs WHEN old.space<>new.space OR old.status<>new.status BEGIN
        UPDATE memory_feature_counts SET n=n-1 WHERE space=old.space AND status=old.status;
        INSERT INTO memory_feature_counts VALUES(new.space,new.status,1) ON CONFLICT(space,status) DO UPDATE SET n=n+1;
      END;
      DROP TRIGGER IF EXISTS memory_feature_insert;
      DROP TRIGGER IF EXISTS memory_feature_update;
      CREATE TRIGGER memory_feature_insert AFTER INSERT ON memory_read BEGIN
        INSERT INTO memory_feature_jobs(memoryId,version,status,updatedAt,space) VALUES(new.id,new.version,'queued',datetime('now'),new.space)
        ON CONFLICT(memoryId) DO UPDATE SET revision=memory_feature_jobs.revision+1,version=new.version,space=new.space,status='queued',attempts=0,error=NULL,updatedAt=datetime('now');
      END;
      CREATE TRIGGER memory_feature_update AFTER UPDATE ON memory_read BEGIN
        INSERT INTO memory_feature_jobs(memoryId,version,status,updatedAt,space) VALUES(new.id,new.version,'queued',datetime('now'),new.space)
        ON CONFLICT(memoryId) DO UPDATE SET revision=memory_feature_jobs.revision+1,version=new.version,space=new.space,status='queued',attempts=0,error=NULL,updatedAt=datetime('now');
      END;
      DROP TRIGGER IF EXISTS memory_feature_remove;
      CREATE TRIGGER memory_feature_remove AFTER DELETE ON memory_read BEGIN
        UPDATE memory_feature_jobs SET status='cancelled',revision=revision+1,updatedAt=datetime('now') WHERE memoryId=old.id
          AND EXISTS(SELECT 1 FROM workspace_records WHERE id=old.id);
        DELETE FROM memory_feature_jobs WHERE memoryId=old.id AND NOT EXISTS(SELECT 1 FROM workspace_records WHERE id=old.id);
      END;`);
    if (!countsExist) store.db.exec("INSERT INTO memory_feature_counts SELECT space,status,count(*) FROM memory_feature_jobs GROUP BY space,status");
    store.db.exec(`INSERT OR IGNORE INTO memory_feature_jobs(memoryId,version,status,updatedAt,space) SELECT id,version,'queued',datetime('now'),space FROM memory_read;
      UPDATE memory_feature_jobs SET revision=revision+1,status='queued' WHERE status='running';`);
    // A read-model rebuild must retain job revisions: outbox identities outlive projections.
    store.db.exec(`DROP TRIGGER IF EXISTS memory_feature_progress;
      CREATE TRIGGER memory_feature_progress AFTER UPDATE ON memory_feature_jobs BEGIN
      INSERT INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('memory-index.changed',new.memoryId,CAST(new.revision AS TEXT),'{}',datetime('now'))
        ON CONFLICT(topic,aggregateId,revision) DO NOTHING;
      END;`);
    });
  }
  private namespace(space: MemorySpace | undefined, channel: "text" | "image" | "face") {
    return this.vectors.namespace(space || "personal", encoderFingerprint(this.manifest!, channel));
  }
  private hasVisual() { return !!(this.manifest?.encoders.image || this.manifest?.encoders.face); }
  private signal(signal?: AbortSignal) {
    return AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
  }
  async reconfigure(processor?: FeatureProcessor) {
    this.closed = true;
    this.state = "starting";
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
    await this.processor?.close();
    await this.initializing;
    await this.running;
    this.processor = processor;
    this.manifest = undefined;
    this.initializing = undefined;
    this.controller = new AbortController();
    this.closed = false;
    this.state = processor ? "starting" : "not_configured";
    this.store.db.exec("UPDATE memory_feature_jobs SET revision=revision+1,status='queued' WHERE status='running'");
    this.start();
  }
  start() {
    if (this.closed || !this.processor || this.timer) return;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  private async initialize() {
    if (this.manifest || !this.processor || this.closed) return;
    this.initializing ||= (async () => {
      try {
        const info = await this.processor!.info(this.controller.signal);
        this.controller.signal.throwIfAborted();
        const previous = this.store.db.prepare("SELECT fingerprint FROM memory_feature_meta WHERE id=1").get() as { fingerprint: string } | undefined;
        if (previous?.fingerprint !== info.fingerprint) this.store.memories.transaction(() => {
          this.store.db.exec("UPDATE memory_feature_jobs SET revision=revision+1,status='queued',attempts=0,error=NULL");
          this.store.db.prepare("INSERT INTO memory_feature_meta VALUES (1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint").run(info.fingerprint);
        });
        this.manifest = info;
        this.state = "ready";
        this.store.events.publish("features.model-changed", "features", info.fingerprint);
      } catch { this.state = "unavailable"; }
    })();
    await this.initializing;
  }
  wake() {
    if (this.closed || !this.processor || this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    await this.initialize();
    if (!this.manifest || this.closed) return;
    for (let batch = 0; batch < 16 && !this.closed; batch++) {
      const job = this.store.db.prepare("SELECT * FROM memory_feature_jobs WHERE status='queued' ORDER BY updatedAt,memoryId LIMIT 1").get() as Job | undefined;
      if (!job) return;
      this.store.db.prepare("UPDATE memory_feature_jobs SET revision=revision+1,status='running',attempts=attempts+1,error=NULL WHERE memoryId=? AND version=?").run(job.memoryId, job.version);
      try {
        await this.process(job);
      } catch (error) {
        if (this.closed) return;
        const code = error instanceof UserFacingError ? error.code : "FEATURE_PROCESSING_FAILED";
        this.store.db.prepare("UPDATE memory_feature_jobs SET revision=revision+1,status='failed',error=?,updatedAt=datetime('now') WHERE memoryId=? AND version=? AND status='running'")
          .run(code, job.memoryId, job.version);
      }
    }
  }
  private current(job: Job) {
    const state = this.store.db.prepare("SELECT version,status,forgotten,suppressed FROM memory_read WHERE id=?").get(job.memoryId) as
      { version: number; status: string; forgotten: number; suppressed: number } | undefined;
    return this.job(job.memoryId).status === "running" && state?.version === job.version && state.status !== "rejected" && !state.forgotten && !state.suppressed;
  }
  private async readImage(asset: Asset) {
    if (asset.kind !== "image" || !["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType) || asset.size > 20 * 1024 * 1024)
      throw new UserFacingError(400, "UNSUPPORTED_IMAGE", "特征处理仅支持 20 MB 内的 JPEG、PNG 和静态 WebP");
    let data: Buffer;
    try {
      const file = await open(join(this.store.assetsDir, asset.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== asset.size) throw new Error("changed");
        data = await file.readFile();
      } finally { await file.close(); }
    } catch { throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件不可用或已经改变"); }
    if (data.length !== asset.size || contentHash(data) !== asset.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件校验不一致");
    return data;
  }
  private async process(job: Job) {
    if (!this.current(job)) {
      this.store.memories.transaction(() => {
        this.vectors.remove(job.memoryId, "text");
        this.store.db.prepare("UPDATE memory_feature_jobs SET revision=revision+1,status='skipped',updatedAt=datetime('now') WHERE memoryId=? AND version=? AND status='running'").run(job.memoryId, job.version);
      });
      return;
    }
    const memory = this.store.memories.get<MemoryEntry>("memory", job.memoryId)!;
    const fingerprint = this.manifest!.fingerprint;
    const namespace = this.namespace(memory.space, "text");
    const text = [memory.title, memory.content, memory.place, ...(memory.people || [])].filter(Boolean).join("\n");
    // Index all bounded pieces rather than silently dropping the tail of a long memory.
    const pieces: string[] = [];
    for (let offset = 0; offset < text.length; offset += 400) pieces.push(text.slice(offset, offset + 480));
    if (this.manifest!.encoders.text && pieces.length > 64) throw new UserFacingError(413, "MEMORY_TOO_LONG", "记忆过长，需要先拆分后建立语义索引");
    const vectors: number[][] = [];
    for (let offset = 0; this.manifest!.encoders.text && offset < pieces.length; offset += 16) {
      const features = await this.processor!.embed(pieces.slice(offset, offset + 16), "passage", "text", this.controller.signal);
      if (features.fingerprint !== fingerprint || features.vectors.length !== pieces.slice(offset, offset + 16).length || features.truncated.some(Boolean))
        throw new UserFacingError(422, "FEATURE_COVERAGE_INCOMPLETE", "编码器没有完整处理记忆内容");
      vectors.push(...features.vectors);
    }
    const images: { asset: Asset; features: ImageFeatures }[] = [];
    const imageIds = [...new Set(evidenceOf(memory).flatMap((source) => source.type === "asset" ? [source.assetId] : []))];
    for (const id of this.hasVisual() ? imageIds : []) {
      const asset = this.store.asset(id);
      if (!asset || asset.kind !== "image" || asset.memorySpace !== (memory.space || "personal")) continue;
      if (!evidenceOf(memory).some((source) => source.type === "asset" && source.assetId === id && source.sha256 === asset.sha256))
        throw new UserFacingError(409, "SOURCE_CHANGED", "记忆引用的图片版本已改变");
      const cached = this.store.db.prepare("SELECT data FROM memory_asset_features WHERE assetId=? AND sourceHash=? AND fingerprint=?")
        .get(id, asset.sha256, fingerprint) as { data: string } | undefined;
      const features: ImageFeatures = cached ? JSON.parse(cached.data) : await this.processor!.image(await this.readImage(asset), asset.sha256, this.controller.signal);
      if (features.fingerprint !== fingerprint) throw new Error("Encoder changed");
      images.push({ asset, features });
    }
    this.controller.signal.throwIfAborted();
    this.store.memories.transaction(() => {
      if (!this.current(job)) return;
      this.vectors.remove(memory.id, "text", namespace);
      vectors.forEach((vector, segment) => this.vectors.put("text", namespace, memory.id, memory.version, vector, segment));
      for (const { asset, features } of images) {
        if (this.store.memories.ledger.sourceBlocked(asset.sha256)) continue;
        const faces = this.store.memories.ledger.graph.recordImage(asset, features, (vector, excluded) =>
          this.vectors.faceCandidates(encoderFingerprint(this.manifest!, "face"), vector, memory.space || "personal", asset.id, excluded));
        if (features.vector) this.vectors.put("image", this.namespace(asset.memorySpace, "image"), asset.id, 0, features.vector, 0, asset.sha256);
        for (const face of faces) if (face.vector) this.vectors.put("face", this.namespace(asset.memorySpace, "face"), face.observationId, 0, face.vector, 0, asset.sha256);
        this.store.db.prepare("INSERT INTO memory_asset_features VALUES (?,?,?,?) ON CONFLICT(assetId) DO UPDATE SET sourceHash=excluded.sourceHash,fingerprint=excluded.fingerprint,data=excluded.data")
          .run(asset.id, asset.sha256, fingerprint, JSON.stringify(features));
      }
      this.store.db.prepare("UPDATE memory_feature_jobs SET revision=revision+1,status='completed',error=NULL,updatedAt=datetime('now') WHERE memoryId=? AND version=? AND status='running'").run(memory.id, memory.version);
    });
  }
  async retrieve(input: MemorySearch, signal?: AbortSignal, includeImage = true) {
    await this.initialize();
    if (!this.manifest || !this.processor || !input.query?.trim()) return { text: [], image: [], status: this.state };
    signal = this.signal(signal);
    const info = this.manifest;
    const query = input.query.slice(0, 200);
    try {
      const text = info.encoders.text ? await this.processor.embed([query], "query", "text", signal) : undefined;
      const hasImages = includeImage && !!info.encoders.image && !!this.store.db.prepare("SELECT 1 FROM memory_vector_meta WHERE channel='image' AND namespace=? LIMIT 1")
        .get(this.vectors.namespace(input.space || "personal", encoderFingerprint(info, "image")));
      const image = hasImages ? (info.sharedQueryEmbedding && text ? text : await this.processor.embed([query], "query", "image_text", signal)) : undefined;
      signal.throwIfAborted();
      if ((text && text.fingerprint !== info.fingerprint) || (image && image.fingerprint !== info.fingerprint)) throw new Error("Encoder changed");
      return { text: text ? this.vectors.search("text", encoderFingerprint(info, "text"), text.vectors[0], input, this.store.memories.ledger.settings().timeZone) : [],
        image: image ? this.vectors.search("image", encoderFingerprint(info, "image"), image.vectors[0], input, this.store.memories.ledger.settings().timeZone) : [], status: "ready" as const };
    } catch { signal?.throwIfAborted(); return { text: [], image: [], status: "unavailable" as const }; }
  }
  async indexSource(asset: Asset, pieces: { text: string }[], current: () => boolean, signal: AbortSignal) {
    await this.initialize();
    if (!this.manifest || !this.processor) return { state: this.state, fingerprint: undefined };
    signal = this.signal(signal);
    const fingerprint = this.manifest.fingerprint;
    if (asset.kind === "video" && this.hasVisual()) return this.indexVideo(asset, fingerprint, current, signal);
    const namespace = this.namespace(asset.memorySpace, "text");
    const textVectors: number[][] = [];
    let image: ImageFeatures | undefined;
    if (asset.kind === "text" && this.manifest.encoders.text) for (let offset = 0; offset < pieces.length; offset += 16) {
      signal.throwIfAborted();
      const batch = pieces.slice(offset, offset + 16).map((piece) => piece.text);
      const result = await this.processor.embed(batch, "passage", "text", signal);
      if (result.fingerprint !== fingerprint || result.vectors.length !== batch.length || result.truncated.some(Boolean))
        throw new UserFacingError(422, "FEATURE_COVERAGE_INCOMPLETE", "编码器未完整处理原始资料");
      textVectors.push(...result.vectors);
    }
    if (asset.kind === "image" && this.hasVisual()) {
      const cached = this.store.db.prepare("SELECT data FROM memory_asset_features WHERE assetId=? AND sourceHash=? AND fingerprint=?").get(asset.id, asset.sha256, fingerprint) as { data: string } | undefined;
      image = cached ? JSON.parse(cached.data) : await this.processor.image(await this.readImage(asset), asset.sha256, signal);
      if (image!.fingerprint !== fingerprint) throw new Error("Encoder changed");
    }
    signal.throwIfAborted();
    this.store.memories.transaction(() => {
      if (!current() || this.store.memories.ledger.sourceBlocked(asset.sha256)) return;
      if (asset.kind === "text") {
        this.vectors.remove(asset.id, "source_text", namespace);
        textVectors.forEach((vector, segment) => this.vectors.put("source_text", namespace, asset.id, 0, vector, segment, asset.sha256));
      }
      if (image) {
        const faces = this.store.memories.ledger.graph.recordImage(asset, image, (vector, excluded) =>
          this.vectors.faceCandidates(encoderFingerprint(this.manifest!, "face"), vector, asset.memorySpace || "personal", asset.id, excluded));
        if (image.vector) this.vectors.put("image", this.namespace(asset.memorySpace, "image"), asset.id, 0, image.vector, 0, asset.sha256);
        for (const face of faces) if (face.vector) this.vectors.put("face", this.namespace(asset.memorySpace, "face"), face.observationId, 0, face.vector, 0, asset.sha256);
        this.store.db.prepare("INSERT INTO memory_asset_features VALUES (?,?,?,?) ON CONFLICT(assetId) DO UPDATE SET sourceHash=excluded.sourceHash,fingerprint=excluded.fingerprint,data=excluded.data")
          .run(asset.id, asset.sha256, fingerprint, JSON.stringify(image));
      }
    });
    return { state: "ready", fingerprint };
  }
  private async indexVideo(asset: Asset, fingerprint: string, current: () => boolean, signal: AbortSignal) {
    const info = await inspectVideo(this.store.assetsDir, asset, signal);
    const sample = sampleVideo(info, this.store.memories.ledger.settings().videoSampleInterval || 10);
    signal.throwIfAborted();
    if (!current()) return { state: "ready", fingerprint };
    const frames = this.store.memories.transaction(() => this.vectors.videoFrames.plan(asset, info, fingerprint, sample.interval, sample.timestamps));
    for (const frame of frames) {
      signal.throwIfAborted(); if (!current()) break;
      if (frame.status === "completed") continue;
      this.vectors.videoFrames.running(frame.id);
      try {
        const photo = await prepareVideoFrame(this.store.assetsDir, asset, frame.requestedTimestamp, { signal, info });
        const features = await this.processor!.image(photo.data, photo.sha256, signal);
        signal.throwIfAborted();
        if (features.fingerprint !== fingerprint) throw new Error("Encoder changed");
        this.store.memories.transaction(() => {
          if (!current()) return;
          const faces = this.store.memories.ledger.graph.recordImage(asset, features, (vector, excluded) =>
            this.vectors.faceCandidates(encoderFingerprint(this.manifest!, "face"), vector, asset.memorySpace || "personal", asset.id, excluded, photo.video.timestamp), photo.video);
          if (features.vector) this.vectors.put("image", this.namespace(asset.memorySpace, "image"), frame.id, 0, features.vector, 0, asset.sha256);
          for (const face of faces) if (face.vector) this.vectors.put("face", this.namespace(asset.memorySpace, "face"), face.observationId, 0, face.vector, 0, asset.sha256);
          this.vectors.videoFrames.complete(frame.id, photo.video, photo.view, features);
        });
      } catch (error) {
        signal.throwIfAborted();
        if (current()) this.vectors.videoFrames.failed(frame.id, error);
      }
    }
    const result = this.vectors.videoFrames.result(asset.id)!;
    return { state: "ready", fingerprint, failedFrames: result.failed };
  }
  async retrieveEvidence(input: EvidenceSearch, scope: EvidenceScope, signal?: AbortSignal) {
    await this.initialize();
    if (!this.manifest || !this.processor || !input.query?.trim()) return { text: [], image: [], status: this.state };
    signal = this.signal(signal);
    const info = this.manifest;
    try {
      const text = info.encoders.text ? await this.processor.embed([input.query.slice(0, 200)], "query", "text", signal) : undefined;
      const hasImages = input.kind !== "text" && !!info.encoders.image && !!this.store.db.prepare("SELECT 1 FROM memory_vector_meta WHERE channel='image' AND namespace=? LIMIT 1").get(this.vectors.namespace(input.space || "personal", encoderFingerprint(info, "image")));
      const image = hasImages ? (info.sharedQueryEmbedding && text ? text : await this.processor.embed([input.query.slice(0, 200)], "query", "image_text", signal)) : undefined;
      signal.throwIfAborted();
      if ((text && text.fingerprint !== info.fingerprint) || (image && image.fingerprint !== info.fingerprint)) throw new Error("Encoder changed");
      return { text: text ? [...this.vectors.searchEvidence("source_text", encoderFingerprint(info, "text"), text.vectors[0], input, scope),
        ...this.vectors.searchEvidence("text", encoderFingerprint(info, "text"), text.vectors[0], input, scope)] : [],
        image: image ? this.vectors.searchEvidence("image", encoderFingerprint(info, "image"), image.vectors[0], input, scope) : [], status: "ready" };
    } catch { signal?.throwIfAborted(); return { text: [], image: [], status: "unavailable" }; }
  }
  status(space: MemorySpace = "personal") {
    const counts = Object.fromEntries((this.store.db.prepare("SELECT status,n FROM memory_feature_counts WHERE space=?").all(space) as { status: string; n: number }[]).map((row) => [row.status, row.n]));
    return { state: this.state, models: this.manifest?.encoders, fingerprint: this.manifest?.fingerprint,
      jobs: { queued: counts.queued || 0, running: counts.running || 0, completed: counts.completed || 0, failed: counts.failed || 0, skipped: counts.skipped || 0, cancelled: counts.cancelled || 0 },
      device: this.manifest?.device, network: this.manifest?.network ?? false, identity: "candidate-association" as const };
  }
  retryFailed() {
    this.initializing = undefined;
    this.manifest = undefined;
    this.state = this.processor ? "starting" : "not_configured";
    this.store.db.exec("UPDATE memory_feature_jobs SET revision=revision+1,status='queued',error=NULL,attempts=0 WHERE status='failed'");
    this.wake();
    return this.status();
  }
  async idle() {
    if (!this.processor) return;
    do { this.wake(); await this.running; } while (this.manifest && !this.closed && this.store.db.prepare("SELECT 1 FROM memory_feature_jobs WHERE status='queued' LIMIT 1").get());
  }
  job(id: string) {
    const row = this.store.db.prepare("SELECT * FROM memory_feature_jobs WHERE memoryId=?").get(id) as
      { memoryId: string; version: number; status: string; revision: number; updatedAt: string; error: string | null } | undefined;
    if (!row) throw new UserFacingError(404, "JOB_NOT_FOUND", "记忆索引作业不存在");
    return row;
  }
  jobs(space: MemorySpace = "personal") {
    return (this.store.db.prepare("SELECT memoryId FROM memory_feature_jobs WHERE space=? ORDER BY updatedAt DESC LIMIT 100").all(space) as { memoryId: string }[]).map((row) => this.job(row.memoryId));
  }
  cancelJob(id: string) {
    this.job(id);
    this.store.db.prepare("UPDATE memory_feature_jobs SET status='cancelled',revision=revision+1,updatedAt=datetime('now') WHERE memoryId=?").run(id);
  }
  retryJob(id: string) {
    this.job(id);
    if (this.state === "unavailable") { this.initializing = undefined; this.manifest = undefined; }
    this.store.db.prepare("UPDATE memory_feature_jobs SET status='queued',revision=revision+1,attempts=0,error=NULL,updatedAt=datetime('now') WHERE memoryId=?").run(id);
    this.wake();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.processor?.close();
    await this.running;
    this.store.db.exec("UPDATE memory_feature_jobs SET revision=revision+1,status='queued' WHERE status='running'");
  }
}
