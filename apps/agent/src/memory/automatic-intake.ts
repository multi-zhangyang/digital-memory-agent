import type { Asset, TaskJob } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { AssetProcessingService } from "./asset-processing-service.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import { UserFacingError } from "../errors.js";

type Intake = { id: string; assetId: string; sourceHash: string; policyVersion: number; state: "queued" | "blocked" | "submitted" | "skipped" | "failed" | "cancelled"; jobId: string | null; error: string | null; revision: number; updatedAt: string };

/** Only new intake events authorize automatic external processing. Existing libraries are never bulk uploaded by migration. */
export class AutomaticIntake {
  private running?: Promise<void>;
  private closed = false;
  private readonly subscriptions: (() => void)[];
  private readonly listeners = new Set<(id: string) => void>();
  constructor(private readonly data: MemoryData, private readonly processing: AssetProcessingService, private readonly blocked: () => boolean = () => false) {
    data.db.exec(`CREATE TABLE IF NOT EXISTS asset_intake (
      id TEXT PRIMARY KEY,assetId TEXT NOT NULL UNIQUE,sourceHash TEXT NOT NULL,policyVersion INTEGER NOT NULL,
      state TEXT NOT NULL,jobId TEXT,error TEXT,revision INTEGER NOT NULL DEFAULT 1,updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS asset_intake_state ON asset_intake(state,id);
      CREATE TRIGGER IF NOT EXISTS asset_intake_added AFTER INSERT ON asset_intake BEGIN
        INSERT INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('asset-intake.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'))
          ON CONFLICT(topic,aggregateId,revision) DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_intake_progress AFTER UPDATE ON asset_intake BEGIN
        INSERT INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('asset-intake.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'))
          ON CONFLICT(topic,aggregateId,revision) DO NOTHING;
      END;`);
    this.subscriptions = [
      data.events.subscribe("memory.automatic-intake", ["asset.added"], (event) => {
        const asset = data.asset(event.aggregateId);
        if (!asset || (asset.memorySpace || "personal") !== "personal") return;
        const permitted = event.payload.processing !== "requested" && this.allowed(asset);
        data.db.prepare("INSERT OR IGNORE INTO asset_intake(id,assetId,sourceHash,policyVersion,state,updatedAt) VALUES (?,?,?,?,?,?)")
          .run(asset.id, asset.id, asset.sha256, data.memories.ledger.settings().processingVersion || 1, permitted ? "queued" : "skipped", new Date().toISOString());
        this.wake();
      }),
      data.events.subscribe("memory.intake-policy", ["processing.policy-changed", "processing.configuration-changed"], () => {
        data.db.exec("UPDATE asset_intake SET state='queued',error=NULL,revision=revision+1,updatedAt=datetime('now') WHERE state='blocked'");
        this.wake();
      }),
    ];
  }
  private allowed(asset: Asset) {
    const policy = this.data.memories.ledger.settings();
    return policy.intake === "automatic" && ((asset.kind === "text" && policy.automaticText !== false) || (asset.kind === "image" && policy.automaticPhotos !== false) ||
      (asset.kind === "video" && policy.automaticVideos === true));
  }
  private get(id: string) {
    const row = this.data.db.prepare("SELECT * FROM asset_intake WHERE id=?").get(id) as Intake | undefined;
    if (!row) throw new UserFacingError(404, "JOB_NOT_FOUND", "资料接收记录不存在");
    return row;
  }
  private patch(id: string, state: Intake["state"], error: string | null = null, jobId: string | null = null) {
    this.data.memories.transaction(() => {
      this.data.db.prepare("UPDATE asset_intake SET state=?,error=?,jobId=coalesce(?,jobId),revision=revision+1,updatedAt=? WHERE id=?")
        .run(state, error, jobId, new Date().toISOString(), id);
    });
    for (const listener of this.listeners) listener(id);
  }
  wake() {
    if (this.closed || this.running || this.blocked()) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    while (!this.closed && !this.blocked()) {
      const row = this.data.db.prepare("SELECT * FROM asset_intake WHERE state='queued' ORDER BY updatedAt,id LIMIT 1").get() as Intake | undefined;
      if (!row) return;
      try {
        const asset = this.data.asset(row.assetId);
        if (!asset || asset.sha256 !== row.sourceHash) throw new UserFacingError(409, "SOURCE_CHANGED", "原始资料不存在或版本已改变");
        if (!this.allowed(asset) || this.data.memories.ledger.sourceBlocked(asset.sha256)) { this.patch(row.id, "skipped"); continue; }
        const job = await this.processing.submit({ assetIds: [asset.id] }, { requestId: `intake:${asset.id}:${row.sourceHash}:${row.policyVersion}`, ownership: "library" });
        // The user may cancel intake while the processor is preparing the job.
        if (this.get(row.id).state === "cancelled") this.processing.driver().cancel(job.id);
        else this.patch(row.id, "submitted", null, job.id);
      } catch (error) {
        if (this.get(row.id).state === "cancelled") continue;
        const unavailable = error instanceof UserFacingError && ["PROCESSOR_UNAVAILABLE", "MODEL_UNAVAILABLE"].includes(error.code);
        this.patch(row.id, unavailable ? "blocked" : "failed", error instanceof UserFacingError ? error.message : "资料自动处理未完成，可重试");
      }
    }
  }
  driver(): TaskJobDriver {
    const get = (id: string): Omit<TaskJob, "kind" | "toolCallId"> => {
      const row = this.get(id);
      return { id, title: "接收资料 · " + (this.data.asset(row.assetId)?.name || "原件已移除"), revision: row.revision, ownership: "library", updatedAt: row.updatedAt,
        status: row.state === "blocked" ? "queued" : row.state === "submitted" ? "completed" : row.state,
        blockedReason: row.error || undefined, progress: { total: 1, completed: Number(["submitted", "skipped"].includes(row.state)), failed: Number(row.state === "failed") } };
    };
    return { get,
      list: () => (this.data.db.prepare("SELECT id FROM asset_intake WHERE state NOT IN ('submitted','skipped') ORDER BY updatedAt DESC LIMIT 100").all() as { id: string }[]).map(({ id }) => get(id)),
      result: (id) => this.get(id),
      cancel: (id) => { const row = this.get(id); if (row.jobId) this.processing.driver().cancel(row.jobId); this.patch(id, "cancelled"); },
      retry: (id) => { const row = this.get(id); if (row.jobId) this.processing.driver().retry?.(row.jobId); else { this.patch(id, "queued"); this.wake(); } },
      subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
    };
  }
  async idle() { this.wake(); await this.running; }
  async close() { this.closed = true; await this.running; for (const unsubscribe of this.subscriptions) unsubscribe(); }
}
