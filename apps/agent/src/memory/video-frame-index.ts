import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Asset, ImageView, VideoFrame, VideoInfo, VideoSourceIndex } from "@memory/contracts";
import type { ImageFeatures } from "../integrations/local-features.js";
import { UserFacingError } from "../errors.js";

export interface IndexedVideoFrame {
  id: string;
  assetId: string;
  sourceHash: string;
  fingerprint: string;
  requestedTimestamp: number;
  timestamp: number | null;
  active: number;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  error: string | null;
  video: string | null;
  view: string | null;
  features: string | null;
}

/** Durable frame coverage and local feature receipts, separate from generated memories. */
export class VideoFrameIndex {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS video_index_plans (
      assetId TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,sourceHash TEXT NOT NULL,
      fingerprint TEXT NOT NULL,sampleInterval REAL NOT NULL,info TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_index_frames (
        id TEXT PRIMARY KEY,assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        sourceHash TEXT NOT NULL,fingerprint TEXT NOT NULL,requestedTimestamp REAL NOT NULL,timestamp REAL,
        active INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,
        video TEXT,view TEXT,features TEXT,UNIQUE(assetId,sourceHash,fingerprint,requestedTimestamp));
      CREATE INDEX IF NOT EXISTS video_frames_plan ON video_index_frames(assetId,active,requestedTimestamp);
      CREATE INDEX IF NOT EXISTS video_frames_source ON video_index_frames(assetId,sourceHash,timestamp);`);
  }
  plan(asset: Asset, info: VideoInfo, fingerprint: string, interval: number, timestamps: number[]) {
    this.db.prepare(`INSERT INTO video_index_plans VALUES(?,?,?,?,?,?) ON CONFLICT(assetId) DO UPDATE SET
      sourceHash=excluded.sourceHash,fingerprint=excluded.fingerprint,sampleInterval=excluded.sampleInterval,
      info=excluded.info,updatedAt=excluded.updatedAt`).run(asset.id, asset.sha256, fingerprint, interval, JSON.stringify(info), new Date().toISOString());
    this.db.prepare("UPDATE video_index_frames SET active=0 WHERE assetId=?").run(asset.id);
    for (const timestamp of timestamps) this.db.prepare(`INSERT INTO video_index_frames(id,assetId,sourceHash,fingerprint,requestedTimestamp,active,status)
      VALUES(?,?,?,?,?,1,'queued') ON CONFLICT(assetId,sourceHash,fingerprint,requestedTimestamp) DO UPDATE SET
      active=1,status=CASE WHEN video_index_frames.status='completed' THEN 'completed' ELSE 'queued' END,error=NULL`)
      .run(randomUUID(), asset.id, asset.sha256, fingerprint, timestamp);
    return this.frames(asset.id);
  }
  frames(assetId: string) {
    return this.db.prepare("SELECT * FROM video_index_frames WHERE assetId=? AND active=1 ORDER BY requestedTimestamp,id").all(assetId) as unknown as IndexedVideoFrame[];
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM video_index_frames WHERE id=?").get(id) as unknown as IndexedVideoFrame | undefined;
  }
  running(id: string) { this.db.prepare("UPDATE video_index_frames SET status='running',attempts=attempts+1,error=NULL WHERE id=?").run(id); }
  complete(id: string, video: VideoFrame, view: ImageView, features: ImageFeatures) {
    this.db.prepare("UPDATE video_index_frames SET status='completed',timestamp=?,video=?,view=?,features=?,error=NULL WHERE id=?")
      .run(video.timestamp, JSON.stringify(video), JSON.stringify(view), JSON.stringify(features), id);
  }
  failed(id: string, error: unknown) {
    this.db.prepare("UPDATE video_index_frames SET status='failed',error=? WHERE id=?")
      .run(error instanceof UserFacingError ? error.message : "此画面的本地索引未完成", id);
  }
  recover() { this.db.exec("UPDATE video_index_frames SET status='queued' WHERE status='running'"); }
  result(assetId: string, offset = 0, limit = 20): VideoSourceIndex | undefined {
    const plan = this.db.prepare("SELECT info,sampleInterval FROM video_index_plans WHERE assetId=?").get(assetId) as { info: string; sampleInterval: number } | undefined;
    if (!plan) return;
    const counts = this.db.prepare(`SELECT count(*) AS total,count(CASE WHEN status='completed' THEN 1 END) AS completed,
      count(CASE WHEN status='failed' THEN 1 END) AS failed FROM video_index_frames WHERE assetId=? AND active=1`).get(assetId) as { total: number; completed: number; failed: number };
    const selected = this.db.prepare(`SELECT id,assetId,requestedTimestamp,status,attempts,video,view,error FROM video_index_frames
      WHERE assetId=? AND active=1 ORDER BY requestedTimestamp,id LIMIT ? OFFSET ?`).all(assetId, limit, offset) as unknown as
      Pick<IndexedVideoFrame, "id" | "assetId" | "requestedTimestamp" | "status" | "attempts" | "video" | "view" | "error">[];
    return { video: JSON.parse(plan.info), sampleInterval: plan.sampleInterval, coverage: "sampled-frames", ...counts,
      frames: selected.map((frame) => ({ id: frame.id, assetId: frame.assetId, requestedTimestamp: frame.requestedTimestamp,
        status: frame.status, attempts: frame.attempts, ...(frame.video ? { video: JSON.parse(frame.video) } : {}),
        ...(frame.view ? { viewSha256: (JSON.parse(frame.view) as ImageView).sha256 } : {}), ...(frame.error ? { error: frame.error } : {}) })),
      nextOffset: offset + selected.length < counts.total ? offset + selected.length : null };
  }
}
