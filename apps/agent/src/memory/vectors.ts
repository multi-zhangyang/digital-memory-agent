import type { DatabaseSync } from "node:sqlite";
import type { EvidenceSearch, MemorySearch, MemorySpace } from "@memory/contracts";
import { memoryEligibility } from "./retrieval.js";
import { assetEligibility, observationEligibility, sourceIdentityFilter, type EvidenceScope } from "./evidence-index.js";
import { VideoFrameIndex } from "./video-frame-index.js";

export type VectorChannel = "text" | "image" | "face" | "source_text";
const channels: VectorChannel[] = ["text", "image", "face", "source_text"];
type VectorRow = { id: number; subjectId: string; sourceHash: string | null; version: number; distance: number };
export type VectorHit = { memoryId: string; similarity: number };

export function vectorBytes(vector: number[], size: number) {
  if (vector.length !== size || vector.some((value) => !Number.isFinite(value))) throw new Error("Invalid feature vector");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error("Empty feature vector");
  return new Uint8Array(new Float32Array(vector.map((value) => value / norm)).buffer);
}

/** Native filtered exact KNN. Stored features never enter the main Agent's context. */
export class MemoryVectors {
  readonly videoFrames: VideoFrameIndex;
  constructor(private readonly db: DatabaseSync) {
    this.videoFrames = new VideoFrameIndex(db);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_vector_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,namespace TEXT NOT NULL,
      subjectId TEXT NOT NULL,version INTEGER NOT NULL,segment INTEGER NOT NULL,sourceHash TEXT,
      UNIQUE(channel,namespace,subjectId,segment));
      CREATE INDEX IF NOT EXISTS vectors_subject ON memory_vector_meta(subjectId,channel);
      CREATE INDEX IF NOT EXISTS vectors_namespace ON memory_vector_meta(namespace,channel);`);
    if (!db.prepare("PRAGMA table_info(memory_vector_meta)").all().some((column) => column.name === "dimensions")) {
      db.exec("ALTER TABLE memory_vector_meta ADD COLUMN dimensions INTEGER");
    }
    for (const channel of channels) {
      const size = this.legacySize(channel);
      if (size) db.prepare("UPDATE memory_vector_meta SET dimensions=? WHERE channel=? AND dimensions IS NULL").run(size, channel);
    }
  }
  private legacySize(channel: VectorChannel) {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`memory_vectors_${channel}`) as { sql: string } | undefined;
    return Number(row?.sql.match(/embedding\s+float\[(\d+)\]/i)?.[1]) || undefined;
  }
  private table(channel: VectorChannel, size: number) {
    if (!channels.includes(channel) || !Number.isInteger(size) || size < 1 || size > 8192) throw new Error("Invalid vector dimensions");
    if (this.legacySize(channel) === size) return `memory_vectors_${channel}`;
    const name = `memory_vectors_${channel}_${size}`;
    // Do not cache DDL: an enclosing transaction can roll it back.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
      id INTEGER PRIMARY KEY,embedding float[${size}] distance_metric=cosine,namespace TEXT PARTITION KEY)`);
    return name;
  }
  namespace(space: MemorySpace, fingerprint: string) { return `${space}:${fingerprint}`; }
  put(channel: VectorChannel, namespace: string, subjectId: string, version: number, vector: number[], segment = 0, sourceHash?: string) {
    const data = vectorBytes(vector, vector.length), table = this.table(channel, vector.length);
    if (this.db.prepare("SELECT 1 FROM memory_vector_meta WHERE channel=? AND namespace=? AND dimensions<>? LIMIT 1").get(channel, namespace, vector.length))
      throw new Error("Vector space dimensions changed without a new fingerprint");
    this.db.prepare(`INSERT INTO memory_vector_meta(channel,namespace,subjectId,version,segment,sourceHash,dimensions) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(channel,namespace,subjectId,segment) DO UPDATE SET version=excluded.version,sourceHash=excluded.sourceHash`)
      .run(channel, namespace, subjectId, version, segment, sourceHash ?? null, vector.length);
    const { id } = this.db.prepare("SELECT id FROM memory_vector_meta WHERE channel=? AND namespace=? AND subjectId=? AND segment=?")
      .get(channel, namespace, subjectId, segment) as { id: number };
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(BigInt(id));
    this.db.prepare(`INSERT INTO ${table}(id,embedding,namespace) VALUES (?,?,?)`).run(BigInt(id), data, namespace);
  }
  remove(subjectId: string, channel: VectorChannel, namespace?: string) {
    const rows = this.db.prepare("SELECT id,dimensions FROM memory_vector_meta WHERE subjectId=? AND channel=? AND (? IS NULL OR namespace=?)")
      .all(subjectId, channel, namespace ?? null, namespace ?? null) as { id: number; dimensions: number }[];
    for (const { id, dimensions } of rows) this.db.prepare(`DELETE FROM ${this.table(channel, dimensions)} WHERE id=?`).run(BigInt(id));
    this.db.prepare("DELETE FROM memory_vector_meta WHERE subjectId=? AND channel=? AND (? IS NULL OR namespace=?)")
      .run(subjectId, channel, namespace ?? null, namespace ?? null);
  }
  search(channel: "text" | "image", fingerprint: string, vector: number[], input: MemorySearch, timeZone: string): VectorHit[] {
    const namespace = this.namespace(input.space || "personal", fingerprint);
    const eligible = memoryEligibility(input, timeZone);
    const join = channel === "text" ? "JOIN memory_read m ON m.id=v.subjectId AND m.version=v.version"
      : `LEFT JOIN video_index_frames f ON f.id=v.subjectId AND f.sourceHash=v.sourceHash AND f.active=1 AND f.status='completed'
        JOIN assets a ON a.id=coalesce(f.assetId,v.subjectId) AND a.sha256=v.sourceHash
        JOIN memory_evidence_index s ON s.assetId=a.id AND s.hash=v.sourceHash AND s.timestamp IS f.timestamp JOIN memory_read m ON m.id=s.memoryId`;
    const rows = this.db.prepare(`SELECT meta.id,meta.subjectId,meta.sourceHash,meta.version,knn.distance FROM
      (SELECT id,distance FROM ${this.table(channel, vector.length)} WHERE embedding MATCH ? AND k=? AND namespace=?
        AND id IN (SELECT v.id FROM memory_vector_meta v ${join} WHERE v.namespace=? AND v.channel=? AND ${eligible.where.join(" AND ")})) knn
      JOIN memory_vector_meta meta ON meta.id=knn.id ORDER BY knn.distance,meta.id`)
      .all(vectorBytes(vector, vector.length), BigInt(200), namespace, namespace, channel, ...eligible.args) as VectorRow[];
    const hits = new Map<string, number>();
    for (const row of rows) {
      const ids = channel === "text" ? [{ id: row.subjectId }] : this.db.prepare(`SELECT DISTINCT m.id FROM memory_evidence_index s
        JOIN memory_read m ON m.id=s.memoryId LEFT JOIN video_index_frames f ON f.id=? AND f.active=1 AND f.status='completed'
        WHERE s.assetId=coalesce(f.assetId,?) AND s.timestamp IS f.timestamp AND s.hash=? AND ${eligible.where.join(" AND ")} ORDER BY m.updatedAt DESC LIMIT 51`)
        .all(row.subjectId, row.subjectId, row.sourceHash, ...eligible.args) as { id: string }[];
      for (const { id } of ids) if (!hits.has(id)) hits.set(id, 1 - row.distance);
    }
    return [...hits].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([memoryId, similarity]) => ({ memoryId, similarity }));
  }
  faceCandidates(fingerprint: string, vector: number[], space: MemorySpace, assetId: string, excluded: string[], timestamp?: number) {
    const rows = this.db.prepare(`SELECT l.entityId,1-min(vec_distance_cosine(v.embedding,?)) AS similarity FROM ${this.table("face", vector.length)} v
      JOIN memory_vector_meta meta ON meta.id=v.id JOIN memory_observations o ON o.id=meta.subjectId
      JOIN assets a ON a.id=o.assetId AND a.sha256=o.sourceHash
      JOIN memory_entity_links l ON l.observationId=o.id AND l.active=1
      JOIN memory_entities e ON e.id=l.entityId AND e.state<>'merged'
      WHERE v.namespace=? AND (o.assetId<>? OR (? IS NOT NULL AND json_extract(o.data,'$.evidence[0].video.timestamp') IS NOT ?))
      AND e.space=? AND e.id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM memory_suppressions WHERE hash=a.sha256)
      GROUP BY l.entityId ORDER BY similarity DESC,l.entityId LIMIT 3`)
      .all(vectorBytes(vector, vector.length), this.namespace(space, fingerprint), assetId, timestamp ?? null, timestamp ?? null, space, JSON.stringify(excluded)) as { entityId: string; similarity: number }[];
    return rows;
  }
  searchEvidence(channel: "text" | "source_text" | "image", fingerprint: string, vector: number[], input: EvidenceSearch, scope: EvidenceScope = {}) {
    const namespace = this.namespace(input.space || "personal", fingerprint);
    const isMemory = channel === "text";
    const eligible = isMemory ? observationEligibility(input, scope) : assetEligibility(input, scope);
    const isImage = channel === "image";
    if (isImage) {
      const identity = sourceIdentityFilter(input, "a.id", "f.timestamp");
      eligible.where.push(...identity.where); eligible.args.push(...identity.args);
    }
    const join = isMemory ? "JOIN memory_read m ON m.id=v.subjectId AND m.version=v.version"
      : isImage ? `LEFT JOIN video_index_frames f ON f.id=v.subjectId AND f.sourceHash=v.sourceHash AND f.active=1 AND f.status='completed'
        JOIN assets a ON a.id=coalesce(f.assetId,v.subjectId) AND a.sha256=v.sourceHash`
        : "JOIN assets a ON a.id=v.subjectId AND a.sha256=v.sourceHash";
    const rows = this.db.prepare(`SELECT meta.subjectId,knn.distance FROM
      (SELECT id,distance FROM ${this.table(channel, vector.length)} WHERE embedding MATCH ? AND k=? AND namespace=?
        AND id IN (SELECT v.id FROM memory_vector_meta v ${join} WHERE v.channel=? AND v.namespace=? AND ${eligible.where.join(" AND ")})) knn
      JOIN memory_vector_meta meta ON meta.id=knn.id ORDER BY knn.distance,meta.id`)
      .all(vectorBytes(vector, vector.length), BigInt(100), namespace, channel, namespace, ...eligible.args) as { subjectId: string; distance: number }[];
    const hits = new Map<string, { id: string; similarity: number }>();
    for (const row of rows) if (!hits.has(row.subjectId)) {
      const frame = isImage ? this.videoFrames.get(row.subjectId) : undefined;
      hits.set(row.subjectId, { id: `${isMemory ? "observation" : frame ? "frame" : "asset"}:${row.subjectId}`, similarity: 1 - row.distance });
    }
    return [...hits.values()];
  }
}
