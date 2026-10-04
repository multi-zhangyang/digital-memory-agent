import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, TaskJob } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { MemoryFeatureService } from "./feature-service.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import { EvidenceIndex } from "./evidence-index.js";
import { contentHash } from "./values.js";
import { UserFacingError } from "../errors.js";

export async function readSource(data: Pick<MemoryData, "assetsDir">, asset: Asset, maxBytes: number) {
  if (asset.size > maxBytes) throw new UserFacingError(413, "SOURCE_TOO_LARGE", "原件超出本次读取范围，请先拆分资料");
  const file = await open(join(data.assetsDir, asset.id), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== asset.size) throw new UserFacingError(409, "SOURCE_CHANGED", "原件已经改变");
    const bytes = await file.readFile();
    if (contentHash(bytes) !== asset.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "原件校验不一致");
    return bytes;
  } finally { await file.close(); }
}
type SourceJob = { assetId: string; sourceHash: string; status: TaskJob["status"] | "skipped"; revision: number; error: string | null; fingerprint: string | null; updatedAt: string };

/** Raw source indexes exist independently of generated observations and confirmation state. */
export class AssetIndexService {
  private readonly index: EvidenceIndex;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly controller = new AbortController();
  private readonly unsubscribe: () => void;
  constructor(private readonly data: MemoryData, private readonly features: MemoryFeatureService) {
    this.index = new EvidenceIndex(data.db);
    data.db.exec(`CREATE TABLE IF NOT EXISTS asset_index_jobs (
      assetId TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,sourceHash TEXT NOT NULL,status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,error TEXT,fingerprint TEXT,updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS asset_index_status ON asset_index_jobs(status,updatedAt);
      CREATE TRIGGER IF NOT EXISTS asset_index_added AFTER INSERT ON assets BEGIN
        INSERT INTO asset_index_jobs(assetId,sourceHash,status,updatedAt) VALUES(new.id,new.sha256,'queued',datetime('now'));
      END;
      CREATE TRIGGER IF NOT EXISTS asset_index_changed AFTER UPDATE OF sha256 ON assets WHEN new.sha256<>old.sha256 BEGIN
        UPDATE asset_index_jobs SET sourceHash=new.sha256,status='queued',revision=revision+1,fingerprint=NULL,error=NULL,updatedAt=datetime('now') WHERE assetId=new.id;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_index_progress AFTER UPDATE ON asset_index_jobs BEGIN
        INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('asset-index.changed',new.assetId,CAST(new.revision AS TEXT),'{}',datetime('now'));
      END;
      INSERT OR IGNORE INTO asset_index_jobs(assetId,sourceHash,status,updatedAt) SELECT id,sha256,'queued',datetime('now') FROM assets;
      UPDATE asset_index_jobs SET status='queued',revision=revision+1 WHERE status='running';`);
    data.db.exec(`CREATE TRIGGER IF NOT EXISTS video_frame_index_progress AFTER UPDATE ON video_index_frames BEGIN
      UPDATE asset_index_jobs SET revision=revision+1,updatedAt=datetime('now') WHERE assetId=new.assetId;
    END;`);
    if (features.status().state !== "not_configured") data.db.exec("UPDATE asset_index_jobs SET status='queued',revision=revision+1 WHERE status='completed' AND fingerprint IS NULL");
    features.vectors.videoFrames.recover();
    this.refreshVideoPolicy();
    this.unsubscribe = data.events.subscribe("memory.asset-index-policy", ["processing.policy-changed", "features.model-changed"], (event) => {
      if (event.topic === "features.model-changed") data.db.prepare("UPDATE asset_index_jobs SET status='queued',revision=revision+1 WHERE status IN ('completed','running','failed') AND fingerprint IS NOT ?").run(event.revision);
      else this.refreshVideoPolicy();
      this.wake();
    });
  }
  private refreshVideoPolicy() {
    this.data.db.exec(`UPDATE asset_index_jobs SET status='queued',revision=revision+1 WHERE status IN ('completed','running','failed') AND assetId IN (
      SELECT p.assetId FROM video_index_plans p WHERE p.sampleInterval<>max(
        coalesce((SELECT json_extract(settings,'$.videoSampleInterval') FROM memory_meta WHERE id=1),10),coalesce(json_extract(p.info,'$.videoDuration'),json_extract(p.info,'$.duration'))/119))`);
  }
  start() { if (this.timer || this.closed) return; this.timer = setInterval(() => this.wake(), 500); this.timer.unref(); this.wake(); }
  wake() { if (this.closed || this.running || !this.data.memories.ledger.settings().indexAssets) return; this.running = this.drain().finally(() => { this.running = undefined; }); }
  private get(id: string) {
    const row = this.data.db.prepare("SELECT * FROM asset_index_jobs WHERE assetId=?").get(id) as SourceJob | undefined;
    if (!row) throw new UserFacingError(404, "JOB_NOT_FOUND", "原件索引任务不存在");
    return row;
  }
  private patch(id: string, status: SourceJob["status"], error: string | null = null, fingerprint: string | null = null) {
    this.data.db.prepare("UPDATE asset_index_jobs SET status=?,error=?,fingerprint=coalesce(?,fingerprint),revision=revision+1,updatedAt=? WHERE assetId=?")
      .run(status, error, fingerprint, new Date().toISOString(), id);
  }
  private async drain() {
    for (let count = 0; count < 16 && !this.closed && this.data.memories.ledger.settings().indexAssets; count++) {
      const job = this.data.db.prepare("SELECT * FROM asset_index_jobs WHERE status='queued' ORDER BY updatedAt,assetId LIMIT 1").get() as SourceJob | undefined;
      if (!job) return;
      const asset = this.data.asset(job.assetId);
      if (!asset || !["text", "image", "video"].includes(asset.kind) || this.data.memories.ledger.sourceBlocked(asset.sha256)) { this.patch(job.assetId, "skipped"); continue; }
      this.patch(job.assetId, "running");
      const current = () => !!this.data.memories.ledger.settings().indexAssets && this.data.asset(asset.id)?.sha256 === job.sourceHash
        && this.get(asset.id).status === "running" && !this.data.memories.ledger.sourceBlocked(job.sourceHash);
      try {
        const bytes = asset.kind === "text" ? await readSource(this.data, asset, 256 * 1024) : undefined;
        const text = bytes ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : "";
        if (text.includes("\0")) throw new UserFacingError(400, "INVALID_TEXT", "原件不是可索引的 UTF-8 文字");
        if (!current() || this.closed) continue;
        const pieces = this.data.memories.transaction(() => this.index.write(asset, text));
        const result = await this.features.indexSource(asset, pieces, current, this.controller.signal);
        if (current() && !this.closed) this.patch(asset.id, "failedFrames" in result && result.failedFrames ? "failed" : "completed",
          "failedFrames" in result && result.failedFrames ? `${result.failedFrames} 个画面的本地索引未完成` : result.state === "unavailable" ? "本地语义处理不可用，已建立关键词索引" : null, result.fingerprint || null);
      } catch (error) {
        if (this.closed) return;
        if (current()) this.patch(job.assetId, "failed", error instanceof UserFacingError ? error.message : "原件索引未完成，可重试");
      } finally {
        if (!this.closed && this.get(job.assetId).status === "running") {
          if (this.data.memories.ledger.sourceBlocked(job.sourceHash)) this.patch(job.assetId, "skipped");
          else if (!this.data.memories.ledger.settings().indexAssets) this.patch(job.assetId, "queued");
        }
      }
    }
  }
  driver(): TaskJobDriver {
    const get = (id: string): Omit<TaskJob, "kind" | "toolCallId"> => {
      const job = this.get(id);
      const video = this.features.vectors.videoFrames.result(id);
      return { id, title: "索引原件 · " + (this.data.asset(id)?.name || "原件已移除"), ownership: "library", status: job.status,
        actions: ["queued", "running"].includes(job.status) ? ["cancel"] : ["retry"],
        revision: job.revision, blockedReason: job.error || (!this.data.memories.ledger.settings().indexAssets && job.status === "queued" ? "索引维护已关闭" : undefined), updatedAt: job.updatedAt,
        progress: video ? { total: video.total, completed: video.completed, failed: video.failed }
          : { total: 1, completed: Number(["completed", "skipped"].includes(job.status)), failed: Number(job.status === "failed") } };
    };
    return { get, list: () => (this.data.db.prepare("SELECT j.assetId FROM asset_index_jobs j JOIN assets a ON a.id=j.assetId WHERE a.memorySpace='personal' ORDER BY j.updatedAt DESC LIMIT 100").all() as { assetId: string }[]).map((row) => get(row.assetId)),
      result: (id, offset, limit) => ({ ...this.get(id), ...this.features.vectors.videoFrames.result(id, offset, limit) }), cancel: (id) => { this.get(id); this.patch(id, "cancelled"); }, retry: (id) => {
        this.get(id); if (this.features.status().state === "unavailable") this.features.retryFailed(); this.patch(id, "queued"); this.wake();
      }, subscribe: () => () => {} };
  }
  async idle() { do { this.wake(); await this.running; } while (!this.closed && this.data.memories.ledger.settings().indexAssets && this.data.db.prepare("SELECT 1 FROM asset_index_jobs WHERE status='queued' LIMIT 1").get()); }
  async close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); this.controller.abort(); await this.running; this.data.db.exec("UPDATE asset_index_jobs SET status='queued',revision=revision+1 WHERE status='running'"); }
}
