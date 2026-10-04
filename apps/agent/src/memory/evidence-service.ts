import type { Asset, EvidenceHit, EvidenceRead, EvidenceSearch, EvidenceSearchResult, ImageRegion, ImageView, MemoryEntry, VideoFrame } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { MemoryFeatureService } from "./feature-service.js";
import { assetEligibility, evidenceMatch, EvidenceIndex, observationEligibility, sourceIdentityFilter, type EvidenceScope } from "./evidence-index.js";
import { evidenceOf } from "./values.js";
import { MemorySourceVerifier } from "./source-verifier.js";
import { readTextPage } from "./text-source.js";
import { preparePhoto, type PreparedPhoto } from "./photo-source.js";
import { inspectVideo, prepareVideoFrame } from "./video-source.js";
import { UserFacingError } from "../errors.js";
import { VideoFrameIndex } from "./video-frame-index.js";

function textPage(bytes: Buffer, offset = 0, limit = 6000) {
  const start = Math.max(0, Math.min(offset, bytes.length));
  if (start < bytes.length && (bytes[start] & 0xc0) === 0x80) throw new UserFacingError(400, "INVALID_OFFSET", "读取位置必须在 UTF-8 字符边界");
  let end = Math.min(bytes.length, start + Math.max(1, Math.min(limit, 8000)));
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === start && end < bytes.length) throw new UserFacingError(400, "INVALID_LIMIT", "读取长度不足一个字符");
  try { return { start, end, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end)) }; }
  catch { throw new UserFacingError(400, "INVALID_TEXT", "证据不是有效的 UTF-8 文字"); }
}

export class EvidenceService {
  private readonly frames: VideoFrameIndex;
  constructor(private readonly data: MemoryData, private readonly features?: MemoryFeatureService) { new EvidenceIndex(data.db); this.frames = new VideoFrameIndex(data.db); }
  private hit(id: string, input: EvidenceSearch, scope: EvidenceScope, channels: EvidenceHit["channels"] = []): EvidenceHit | undefined {
    const [type, key] = id.split(":");
    if (type === "frame") {
      const eligible = assetEligibility(input, scope), identity = sourceIdentityFilter(input, "a.id", "f.timestamp");
      const row = this.data.db.prepare(`SELECT f.id FROM video_index_frames f JOIN assets a ON a.id=f.assetId AND a.sha256=f.sourceHash
        WHERE f.id=? AND f.active=1 AND f.status='completed' AND ${[...eligible.where, ...identity.where].join(" AND ")}`).get(key, ...eligible.args, ...identity.args);
      const frame = row && this.frames.get(key);
      if (!frame?.video || !frame.view) return;
      const asset = this.data.asset(frame.assetId)!, video = JSON.parse(frame.video) as VideoFrame, view = JSON.parse(frame.view) as ImageView;
      return { id, type: "frame", assetId: asset.id, title: asset.name, excerpt: "", version: asset.sha256, status: "source", authority: "raw-source", channels,
        sources: [{ type: "asset", assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, video,
          visual: { width: view.width, height: view.height, previewSha256: view.sha256 } }] };
    }
    if (type === "asset") {
      const eligible = assetEligibility(input, scope);
      const asset = this.data.db.prepare(`SELECT a.* FROM assets a WHERE a.id=? AND ${eligible.where.join(" AND ")}`).get(key, ...eligible.args) as Asset | undefined;
      if (!asset) return;
      const match = evidenceMatch(input.query || "");
      const chunk = (match ? this.data.db.prepare(`SELECT c.start,c.end,c.text FROM evidence_fts f JOIN evidence_chunks c ON c.id=f.rowid
        WHERE evidence_fts MATCH ? AND c.assetId=? AND c.sourceHash=? ORDER BY bm25(evidence_fts) LIMIT 1`).get(match, key, asset.sha256)
        : this.data.db.prepare("SELECT start,end,text FROM evidence_chunks WHERE assetId=? AND sourceHash=? ORDER BY segment LIMIT 1").get(key, asset.sha256)) as { start: number; end: number; text: string } | undefined;
      return { id, type: "asset", assetId: asset.id, title: asset.name, excerpt: chunk?.text.slice(0, 400) || "", version: asset.sha256, status: "source", authority: "raw-source", channels,
        sources: [{ type: "asset", assetId: asset.id, name: asset.name, sha256: asset.sha256, start: chunk?.start || 0, end: chunk?.end || asset.size }] };
    }
    if (type === "observation") {
      const eligible = observationEligibility(input, scope);
      const row = this.data.db.prepare(`SELECT r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id WHERE m.id=? AND ${eligible.where.join(" AND ")}`).get(key, ...eligible.args) as { data: string } | undefined;
      if (!row) return;
      const memory = JSON.parse(row.data) as MemoryEntry;
      // Keep original quotations in the ledger. Search returns bounded locators, not old assertions.
      const sources = evidenceOf(memory).flatMap((source) => source.type === "asset" ? [{ type: "asset" as const, assetId: source.assetId,
        name: source.name.slice(0, 240), sha256: source.sha256, start: source.start, end: source.end,
        ...(source.video ? { video: source.video } : {}),
        ...(source.visual ? { visual: { width: source.visual.width, height: source.visual.height, previewSha256: source.visual.previewSha256, region: source.visual.region } } : {}) }] : []);
      return { id, type: "observation", memoryId: memory.id, title: memory.content.slice(0, 80), excerpt: memory.content.slice(0, 600), version: memory.version, status: memory.status,
        kind: memory.kind, uncertainty: memory.uncertainty?.slice(0, 400),
        authority: memory.status === "confirmed" ? "confirmed" : "unverified", sources: sources.slice(0, 8), sourcesTruncated: sources.length > 8, channels };
    }
  }
  async search(input: EvidenceSearch, scope: EvidenceScope = {}, signal?: AbortSignal): Promise<EvidenceSearchResult> {
    if (input.personId && !this.data.db.prepare("SELECT 1 FROM memory_people WHERE id=?").get(input.personId))
      throw new UserFacingError(400, "INVALID_PERSON", "请使用已确认人物的 ID");
    if (input.entityId && this.data.memories.ledger.graph.entity(input.entityId).space !== (input.space || "personal"))
      throw new UserFacingError(403, "SOURCE_SCOPE", "人物候选不在本次空间内");
    const query = input.query?.trim().slice(0, 200) || "";
    const limit = Math.max(1, Math.min(input.limit || 12, 20));
    const asset = assetEligibility(input, scope), observation = observationEligibility(input, scope);
    const match = evidenceMatch(query);
    const raw = match ? this.data.db.prepare(`SELECT c.assetId FROM evidence_fts f JOIN evidence_chunks c ON c.id=f.rowid JOIN assets a ON a.id=c.assetId AND a.sha256=c.sourceHash
      WHERE evidence_fts MATCH ? AND ${asset.where.join(" AND ")} ORDER BY bm25(evidence_fts) LIMIT 100`).all(match, ...asset.args) as { assetId: string }[] : [];
    const names = this.data.db.prepare(`SELECT a.id FROM assets a WHERE ${asset.where.join(" AND ")} AND instr(lower(a.name),lower(?))>0 ORDER BY a.createdAt DESC LIMIT 40`).all(...asset.args, query) as { id: string }[];
    const observations = match ? this.data.db.prepare(`SELECT m.id FROM memory_fts f JOIN memory_read m ON m.id=f.id WHERE memory_fts MATCH ? AND ${observation.where.join(" AND ")} ORDER BY bm25(memory_fts) LIMIT 60`).all(match, ...observation.args) as { id: string }[] : [];
    const identity = sourceIdentityFilter(input, "a.id", "f.timestamp");
    const matchingFrames = this.data.db.prepare(`SELECT f.id FROM video_index_frames f JOIN assets a ON a.id=f.assetId AND a.sha256=f.sourceHash
      WHERE f.active=1 AND f.status='completed' AND ${[...asset.where, ...identity.where].join(" AND ")}
      AND instr(lower(a.name),lower(?))>0 ORDER BY a.createdAt DESC,f.timestamp LIMIT 40`).all(...asset.args, ...identity.args, query) as { id: string }[];
    const keyword = [...new Set([...raw.map((row) => "asset:" + row.assetId), ...matchingFrames.map((row) => "frame:" + row.id),
      ...names.map((row) => "asset:" + row.id), ...observations.map((row) => "observation:" + row.id)])];
    const semantic = await this.features?.retrieveEvidence({ ...input, query }, scope, signal) || { text: [], image: [], status: "not_configured" };
    signal?.throwIfAborted();
    const scored = new Map<string, { score: number; channels: EvidenceHit["channels"] }>();
    const add = (ids: string[], channel: EvidenceHit["channels"][number], weight: number) => ids.forEach((id, rank) => {
      const item = scored.get(id) || { score: 0, channels: [] };
      item.score += weight / (40 + rank); if (!item.channels.includes(channel)) item.channels.push(channel); scored.set(id, item);
    });
    add(keyword, "keyword", 1.2); add(semantic.text.filter((hit) => hit.similarity > 0.2).map((hit) => hit.id), "text", 1); add(semantic.image.filter((hit) => hit.similarity > 0.05).map((hit) => hit.id), "image", 0.9);
    const hits: EvidenceHit[] = [];
    for (const [id, score] of [...scored].sort((a, b) => b[1].score - a[1].score)) {
      const hit = this.hit(id, input, scope, score.channels); // Recheck scope, suppression and version after model I/O.
      if (hit) hits.push(hit);
      if (hits.length >= limit) break;
    }
    const result: EvidenceSearchResult = { hits, revision: this.data.memories.ledger.revision, truncated: scored.size > hits.length,
      retrieval: { channels: ["keyword", ...(semantic.status === "ready" ? ["text" as const] : []), ...(semantic.image.length ? ["image" as const] : [])], status: semantic.status, relevance: "candidate-evidence" } };
    while (Buffer.byteLength(JSON.stringify(result)) > 14000 && result.hits.length) { result.hits.pop(); result.truncated = true; }
    return result;
  }
  async read(id: string, scope: EvidenceScope = {}, options: { version?: string | number; offset?: number; limit?: number; image?: boolean; timestamp?: number; region?: ImageRegion | null; signal?: AbortSignal } = {}): Promise<EvidenceRead & { image?: Buffer }> {
    options.signal?.throwIfAborted();
    const hit = this.hit(id, { space: "personal" }, scope);
    if (!hit) throw new UserFacingError(404, "EVIDENCE_UNAVAILABLE", "证据不在当前范围内或已停止取用");
    if (options.version !== undefined && hit.type !== "observation" && (typeof options.version !== "string" || !/^[a-f0-9]{64}$/.test(options.version)))
      throw new UserFacingError(400, "INVALID_EVIDENCE_VERSION", "asset 原件版本须为 task assets.version 或 search_evidence 返回的 SHA-256 字符串，不能填写数字版本；未知时可省略 version");
    if (options.version !== undefined && String(hit.version) !== String(options.version)) throw new UserFacingError(409, "EVIDENCE_CHANGED", "证据版本已更新，请重新检索");
    if (hit.type === "observation") {
      if (options.region) throw new UserFacingError(400, "IMAGE_SOURCE_REQUIRED", "局部读取需要使用观察对应的 asset 原图 ID，不能裁剪文字观察");
      const memory = this.data.memories.get<MemoryEntry>("memory", hit.memoryId!)!;
      await new MemorySourceVerifier(this.data).verify(memory, options.signal);
      options.signal?.throwIfAborted();
      const latest = this.hit(id, { space: "personal" }, scope);
      if (!latest || latest.version !== memory.version) throw new UserFacingError(409, "EVIDENCE_CHANGED", "证据已改变，请重新读取");
      const bytes = Buffer.from(memory.content);
      const page = textPage(bytes, options.offset, options.limit);
      return { hit: latest, verification: "source-links", observation: { memoryId: memory.id, version: memory.version, ...page }, nextOffset: page.end < bytes.length ? page.end : null };
    }
    const asset = this.data.asset(hit.assetId!)!;
    const indexedTime = hit.type === "frame" && hit.sources[0].type === "asset" ? hit.sources[0].video?.requestedTimestamp : undefined;
    if (indexedTime !== undefined && options.timestamp !== undefined && options.timestamp !== indexedTime)
      throw new UserFacingError(400, "FRAME_TIME_MISMATCH", "此 frame ID 指向固定画面；其他时间请使用 asset ID");
    if (asset.kind !== "video" && options.timestamp !== undefined) throw new UserFacingError(400, "VIDEO_SOURCE_REQUIRED", "时间点只适用于视频原件");
    if (asset.kind === "image" || asset.kind === "video") {
      const video = asset.kind === "video" ? await inspectVideo(this.data.assetsDir, asset, options.signal) : undefined;
      const photo: PreparedPhoto & { view: ImageView; video?: VideoFrame } = video ? await prepareVideoFrame(this.data.assetsDir, asset, options.timestamp ?? indexedTime ?? 0, { region: options.region || undefined, signal: options.signal, info: video })
        : await preparePhoto(this.data.assetsDir, asset, options.region || undefined);
      options.signal?.throwIfAborted();
      this.assertCurrent(id, hit, scope);
      const source = hit.sources[0];
      if (source.type === "asset") {
        source.view = photo.view;
        if (photo.video) source.video = photo.video;
        source.visual = { width: photo.width, height: photo.height, previewSha256: photo.sha256,
          ...(photo.view.region ? { region: photo.view.region } : {}) };
      }
      const query = new URLSearchParams({ version: asset.sha256, view: photo.sha256 });
      if (photo.video) query.set("timestamp", String(photo.video.requestedTimestamp));
      if (options.region) for (const [key, value] of Object.entries(options.region)) query.set(key, String(value));
      return { hit, verification: "asset-hash", source: { assetId: asset.id, sha256: asset.sha256, start: 0, end: asset.size, view: photo.view,
        ...(photo.video ? { video: photo.video } : {}),
        previewUrl: `/api/evidence/${encodeURIComponent(id)}/preview?${query}` }, ...(video ? { video } : {}), ...(options.image ? { image: photo.data } : {}) };
    }
    if (options.region) throw new UserFacingError(400, "IMAGE_SOURCE_REQUIRED", "只有静态图片支持局部读取");
    if (asset.kind !== "text") throw new UserFacingError(400, "UNSUPPORTED_EVIDENCE", "当前证据读取支持文字和静态图片");
    const { start, end, text, nextOffset } = await readTextPage(this.data, asset, options);
    options.signal?.throwIfAborted();
    this.assertCurrent(id, hit, scope);
    hit.sources = [{ type: "asset", assetId: asset.id, name: asset.name, sha256: asset.sha256, start, end }];
    const source = { assetId: asset.id, sha256: asset.sha256, start, end, text };
    return { hit, verification: "asset-hash", source, nextOffset,
      ...(scope.allowObservations === false ? {} : { memoryContext: this.data.memories.queries.forSource(source, scope.allowedAssetIds) }) };
  }
  private assertCurrent(id: string, hit: EvidenceHit, scope: EvidenceScope) {
    const current = this.hit(id, { space: "personal" }, scope);
    if (!current || current.version !== hit.version) throw new UserFacingError(409, "EVIDENCE_CHANGED", "原始证据已经改变，请重新检索");
  }
}
