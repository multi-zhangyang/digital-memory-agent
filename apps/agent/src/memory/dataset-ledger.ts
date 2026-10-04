import type { SQLInputValue } from "node:sqlite";
import type { DatasetAuditJob, DatasetSampleSelection, DatasetScope, MemoryDataset, MemoryEntry, MemorySpace, TrainingSample } from "@memory/contracts";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryData } from "./data.js";
import { memoryEligibility } from "./retrieval.js";
import { UserFacingError } from "../errors.js";
import { normalizeFact } from "./values.js";
import { validateReviewedSample, type SampleChange, type SampleReviewContext, type SampleReviewReceipt } from "./dataset-review.js";
import { sampleTimeQuality } from "./dataset-time-review.js";
import { DatasetPairings } from "./dataset-pairing.js";

export type DatasetInput = { datasetId: string; ordinal: number; memoryId: string; memoryVersion: number; data: string; status: string; reason: string | null };
type DatasetRow = { id: string; requestKey: string; status: MemoryDataset["status"]; revision: number; stale: number; data: string };
const now = () => new Date().toISOString();

/** Immutable input manifests and explicit dependency invalidation, independently of any Agent. */
export class DatasetLedger {
  readonly pairings: DatasetPairings;
  constructor(private readonly store: MemoryData) {
    this.pairings = new DatasetPairings(store);
    const db = store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS memory_datasets (
      id TEXT PRIMARY KEY,requestKey TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,stale INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dataset_jobs_status ON memory_datasets(status,id);
      CREATE TABLE IF NOT EXISTS dataset_inputs (
        datasetId TEXT NOT NULL REFERENCES memory_datasets(id),ordinal INTEGER NOT NULL,memoryId TEXT NOT NULL,memoryVersion INTEGER NOT NULL,
        data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,PRIMARY KEY(datasetId,ordinal),UNIQUE(datasetId,memoryId));
      CREATE INDEX IF NOT EXISTS dataset_input_pending ON dataset_inputs(datasetId,status,ordinal);
      CREATE TABLE IF NOT EXISTS dataset_unique_content (datasetId TEXT NOT NULL,contentKey TEXT NOT NULL,memoryId TEXT NOT NULL,PRIMARY KEY(datasetId,contentKey));
      CREATE TABLE IF NOT EXISTS dataset_input_counts (datasetId TEXT NOT NULL,status TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(datasetId,status));
      CREATE TRIGGER IF NOT EXISTS dataset_input_added AFTER INSERT ON dataset_inputs BEGIN
        INSERT INTO dataset_input_counts VALUES(new.datasetId,new.status,1) ON CONFLICT(datasetId,status) DO UPDATE SET n=n+1;
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_input_state AFTER UPDATE OF status ON dataset_inputs WHEN old.status<>new.status BEGIN
        UPDATE dataset_input_counts SET n=n-1 WHERE datasetId=old.datasetId AND status=old.status;
        INSERT INTO dataset_input_counts VALUES(new.datasetId,new.status,1) ON CONFLICT(datasetId,status) DO UPDATE SET n=n+1;
      END;
      CREATE TABLE IF NOT EXISTS dataset_input_dependencies (
        datasetId TEXT NOT NULL,memoryId TEXT NOT NULL,kind TEXT NOT NULL,parentId TEXT NOT NULL,parentVersion TEXT NOT NULL,
        PRIMARY KEY(datasetId,memoryId,kind,parentId,parentVersion));
      CREATE INDEX IF NOT EXISTS dataset_dependencies_parent ON dataset_input_dependencies(kind,parentId,parentVersion,datasetId);
      CREATE TABLE IF NOT EXISTS dataset_samples (
        id TEXT PRIMARY KEY,datasetId TEXT NOT NULL REFERENCES memory_datasets(id),version INTEGER NOT NULL,status TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dataset_sample_page ON dataset_samples(datasetId,id);
      CREATE TABLE IF NOT EXISTS dataset_sample_versions (id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS dataset_review_commands (id TEXT PRIMARY KEY,requestKey TEXT NOT NULL UNIQUE,payloadHash TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_sample_views (runId TEXT NOT NULL,sampleId TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(runId,sampleId,version));
      CREATE TABLE IF NOT EXISTS dataset_audits (
        id TEXT PRIMARY KEY,datasetId TEXT NOT NULL REFERENCES memory_datasets(id),requestKey TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dataset_audits_dataset ON dataset_audits(datasetId);
      CREATE TABLE IF NOT EXISTS dataset_audit_inputs (
        jobId TEXT NOT NULL REFERENCES dataset_audits(id),ordinal INTEGER NOT NULL,memoryId TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,result TEXT,
        PRIMARY KEY(jobId,ordinal));
      CREATE TABLE IF NOT EXISTS dataset_audit_views (jobId TEXT NOT NULL REFERENCES dataset_audits(id),sampleId TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(jobId,sampleId,version));
      CREATE TRIGGER IF NOT EXISTS dataset_sample_version_insert AFTER INSERT ON dataset_samples BEGIN
        INSERT INTO dataset_sample_versions VALUES(new.id,new.version,new.data);
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_sample_version_update AFTER UPDATE OF version ON dataset_samples WHEN old.version<>new.version BEGIN
        INSERT INTO dataset_sample_versions VALUES(new.id,new.version,new.data);
      END;
      CREATE TABLE IF NOT EXISTS dataset_sample_dependencies (
        sampleId TEXT NOT NULL REFERENCES dataset_samples(id),kind TEXT NOT NULL,parentId TEXT NOT NULL,parentVersion TEXT NOT NULL,
        PRIMARY KEY(sampleId,kind,parentId,parentVersion));
      CREATE INDEX IF NOT EXISTS sample_dependency_parent ON dataset_sample_dependencies(kind,parentId,parentVersion,sampleId);
      CREATE TABLE IF NOT EXISTS dataset_sample_counts (datasetId TEXT NOT NULL,status TEXT NOT NULL,stale INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(datasetId,status,stale));
      CREATE TRIGGER IF NOT EXISTS dataset_sample_added AFTER INSERT ON dataset_samples BEGIN
        INSERT INTO dataset_sample_counts VALUES(new.datasetId,new.status,new.stale,1) ON CONFLICT(datasetId,status,stale) DO UPDATE SET n=n+1;
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_sample_state AFTER UPDATE OF status,stale ON dataset_samples WHEN old.status<>new.status OR old.stale<>new.stale BEGIN
        UPDATE dataset_sample_counts SET n=n-1 WHERE datasetId=old.datasetId AND status=old.status AND stale=old.stale;
        INSERT INTO dataset_sample_counts VALUES(new.datasetId,new.status,new.stale,1) ON CONFLICT(datasetId,status,stale) DO UPDATE SET n=n+1;
      END;
      CREATE TABLE IF NOT EXISTS dataset_invalidations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,datasetId TEXT NOT NULL,kind TEXT NOT NULL,parentId TEXT NOT NULL,previousVersion TEXT NOT NULL,
        currentVersion TEXT NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(datasetId,kind,parentId,previousVersion,currentVersion,reason));
      CREATE INDEX IF NOT EXISTS dataset_invalidations_job ON dataset_invalidations(datasetId,seq);
      CREATE TABLE IF NOT EXISTS memory_model_versions (id TEXT PRIMARY KEY,data TEXT NOT NULL,affected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_dataset_links (modelId TEXT NOT NULL REFERENCES memory_model_versions(id),datasetId TEXT NOT NULL REFERENCES memory_datasets(id),PRIMARY KEY(modelId,datasetId));
      CREATE INDEX IF NOT EXISTS model_datasets_dataset ON model_dataset_links(datasetId,modelId);
      CREATE TRIGGER IF NOT EXISTS dataset_dependency_invalidated AFTER INSERT ON dataset_invalidations BEGIN
        UPDATE memory_datasets SET stale=1,revision=revision+1,
          status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END WHERE id=new.datasetId;
        UPDATE dataset_samples SET stale=1 WHERE datasetId=new.datasetId AND id IN (
          SELECT sampleId FROM dataset_sample_dependencies WHERE kind=new.kind AND parentId=new.parentId AND parentVersion=new.previousVersion);
        UPDATE memory_model_versions SET affected=1 WHERE id IN (SELECT modelId FROM model_dataset_links WHERE datasetId=new.datasetId);
      END;
      INSERT OR IGNORE INTO migrations VALUES (8);`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS dataset_outbox_insert AFTER INSERT ON memory_datasets BEGIN
      INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('memory-dataset.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'));
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_outbox_update AFTER UPDATE ON memory_datasets BEGIN
      INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('memory-dataset.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'));
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_audit_outbox_insert AFTER INSERT ON dataset_audits BEGIN
      INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('dataset-audit.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'));
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_audit_outbox_update AFTER UPDATE ON dataset_audits BEGIN
      INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES('dataset-audit.changed',new.id,CAST(new.revision AS TEXT),'{}',datetime('now'));
      END;`);
    const invalidate = (table: string, name: string, kind: string, id: string, version: string, condition: string) => db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${name} AFTER UPDATE ON ${table} BEGIN
        INSERT OR IGNORE INTO dataset_invalidations(datasetId,kind,parentId,previousVersion,currentVersion,reason,createdAt)
          SELECT DISTINCT d.datasetId,d.kind,d.parentId,d.parentVersion,${version},'dependency-changed',datetime('now')
          FROM dataset_input_dependencies d WHERE d.kind='${kind}' AND d.parentId=${id} AND (${condition});
      END;`);
    invalidate("memory_read", "dataset_memory_changed", "memory", "new.id", "CAST(new.version AS TEXT)",
      "d.parentVersion<>CAST(new.version AS TEXT) OR new.status<>'confirmed' OR new.forgotten=1 OR new.suppressed=1 OR new.superseded=1");
    invalidate("memory_entities", "dataset_entity_changed", "entity", "new.id", "CAST(new.version AS TEXT)", "d.parentVersion<>CAST(new.version AS TEXT)");
    invalidate("memory_events", "dataset_event_changed", "event", "new.id", "CAST(new.version AS TEXT)", "d.parentVersion<>CAST(new.version AS TEXT)");
    invalidate("memory_people", "dataset_person_changed", "person", "new.id", "CAST(json_extract(new.data,'$.version') AS TEXT)", "d.parentVersion<>CAST(json_extract(new.data,'$.version') AS TEXT)");
    invalidate("assets", "dataset_asset_changed", "asset", "new.id", "new.sha256", "d.parentVersion<>new.sha256");
    db.exec(`CREATE TRIGGER IF NOT EXISTS dataset_asset_deleted AFTER DELETE ON assets BEGIN
      INSERT OR IGNORE INTO dataset_invalidations(datasetId,kind,parentId,previousVersion,currentVersion,reason,createdAt)
        SELECT DISTINCT datasetId,kind,parentId,parentVersion,'deleted','source-deleted',datetime('now') FROM dataset_input_dependencies
        WHERE kind='asset' AND parentId=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_message_deleted AFTER DELETE ON workspace_records WHEN old.kind='run' BEGIN
        INSERT OR IGNORE INTO dataset_invalidations(datasetId,kind,parentId,previousVersion,currentVersion,reason,createdAt)
          SELECT DISTINCT datasetId,kind,parentId,parentVersion,'deleted','message-deleted',datetime('now') FROM dataset_input_dependencies
          WHERE kind='message-run' AND parentId=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS dataset_message_changed AFTER UPDATE ON workspace_records WHEN new.kind='run' AND EXISTS(SELECT 1 FROM dataset_input_dependencies WHERE kind='message-run' AND parentId=new.id) AND
        (json_extract(old.data,'$.text') IS NOT json_extract(new.data,'$.text') OR
         json_extract(old.data,'$.question.answer') IS NOT json_extract(new.data,'$.question.answer') OR
         (SELECT json_group_array(json_object('id',json_extract(value,'$.id'),'text',json_extract(value,'$.text'))) FROM json_each(old.data,'$.interventions')) IS NOT
         (SELECT json_group_array(json_object('id',json_extract(value,'$.id'),'text',json_extract(value,'$.text'))) FROM json_each(new.data,'$.interventions'))) BEGIN
        INSERT OR IGNORE INTO dataset_invalidations(datasetId,kind,parentId,previousVersion,currentVersion,reason,createdAt)
          SELECT DISTINCT datasetId,kind,parentId,parentVersion,'changed','message-content-changed',datetime('now') FROM dataset_input_dependencies
          WHERE kind='message-run' AND parentId=new.id;
      END;`);
    db.exec("UPDATE memory_datasets SET status='queued',revision=revision+1 WHERE status='running' AND stale=0");
  }
  find(requestKey: string) {
    const row = this.store.db.prepare("SELECT id FROM memory_datasets WHERE requestKey=?").get(requestKey) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }
  get(id: string): MemoryDataset {
    const row = this.store.db.prepare("SELECT * FROM memory_datasets WHERE id=?").get(id) as DatasetRow | undefined;
    if (!row) throw new UserFacingError(404, "DATASET_NOT_FOUND", "数据集不存在");
    const data = JSON.parse(row.data) as MemoryDataset;
    const audit = this.store.db.prepare("SELECT data,status,revision FROM dataset_audits WHERE datasetId=? ORDER BY rowid DESC LIMIT 1").get(id) as
      { data: string; status: DatasetAuditJob["status"]; revision: number } | undefined;
    const counts = Object.fromEntries((this.store.db.prepare("SELECT status,n FROM dataset_input_counts WHERE datasetId=?").all(id) as { status: string; n: number }[]).map((item) => [item.status, item.n]));
    const samples = this.store.db.prepare("SELECT coalesce(sum(n),0) AS total,coalesce(sum(n*stale),0) AS stale,coalesce(sum(n*(status='ready' AND stale=0)),0) AS ready,coalesce(sum(n*(status='review' AND stale=0)),0) AS review,coalesce(sum(n*(status='excluded' AND stale=0)),0) AS excluded FROM dataset_sample_counts WHERE datasetId=?").get(id) as { total: number; stale: number; ready: number; review: number; excluded: number };
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { ...data, audit: audit && { ...JSON.parse(audit.data) as DatasetAuditJob, status: audit.status, revision: audit.revision }, status: row.status, revision: row.revision, stale: !!row.stale,
      sampleCounts: { ready: samples.ready, review: samples.review, excluded: samples.excluded },
      error: row.stale ? "依赖记录已经修订，需要从当前版本重新构建" : data.error,
      counts: { total, processed: total - (counts.pending || 0), ready: counts.ready || 0, review: counts.review || 0,
        excluded: counts.excluded || 0, failed: counts.failed || 0, samples: samples.total, staleSamples: samples.stale } };
  }
  list(space: MemorySpace = "personal", limit = 30) {
    const rows = this.store.db.prepare("SELECT id FROM memory_datasets WHERE json_extract(data,'$.space')=? ORDER BY rowid DESC LIMIT ?").all(space, Math.min(50, Math.max(1, limit))) as { id: string }[];
    return rows.map(({ id }) => this.get(id));
  }
  patch(id: string, patch: Partial<MemoryDataset>) {
    const current = this.get(id);
    const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now() };
    if (current.stale) { next.stale = true; next.status = current.status; }
    this.store.db.prepare("UPDATE memory_datasets SET status=?,revision=?,data=? WHERE id=?").run(next.status, next.revision, JSON.stringify({ ...next, audit: undefined }), id);
    return this.get(id);
  }
  freeze(input: { requestKey: string; title: string; space: MemorySpace; scope: DatasetScope; format: MemoryDataset["format"];
    generation?: MemoryDataset["generation"]; allowedAssetIds?: readonly string[] }) {
    const previous = this.find(input.requestKey); if (previous) return previous;
    const eligible = memoryEligibility({ ...input.scope, space: input.space, includeHistorical: true }, this.store.memories.ledger.settings().timeZone);
    eligible.where.push("m.superseded=0");
    const args: SQLInputValue[] = eligible.args;
    if (input.scope.memoryIds) { eligible.where.push("m.id IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(input.scope.memoryIds)); }
    if (input.scope.assetIds) { eligible.where.push("m.id IN (SELECT memoryId FROM memory_evidence_index WHERE assetId IN (SELECT value FROM json_each(?)))"); args.push(JSON.stringify(input.scope.assetIds)); }
    if (input.allowedAssetIds) {
      eligible.where.push("EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id)",
        "NOT EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id AND (s.assetId IS NULL OR s.assetId NOT IN (SELECT value FROM json_each(?))))");
      args.push(JSON.stringify(input.allowedAssetIds));
    }
    return this.store.memories.transaction(() => {
      const id = randomUUID();
      const data = { id, title: input.title, space: input.space, scope: input.scope, format: input.format, policy: "grounded-v1",
        ...(input.generation ? { generation: input.generation, usage: { calls: 0, input: 0, output: 0 } } : {}),
        ledgerRevision: this.store.memories.ledger.revision, createdAt: now(), updatedAt: now() };
      this.store.db.prepare("INSERT INTO memory_datasets VALUES (?,?, 'queued',1,0,?)").run(id, input.requestKey, JSON.stringify(data));
      this.store.db.prepare(`INSERT INTO dataset_inputs(datasetId,ordinal,memoryId,memoryVersion,data)
        SELECT ?,row_number() OVER (ORDER BY m.id),m.id,m.version,r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id WHERE ${eligible.where.join(" AND ")}`)
        .run(id, ...args);
      if (!(this.store.db.prepare("SELECT 1 FROM dataset_inputs WHERE datasetId=? LIMIT 1").get(id))) throw new UserFacingError(422, "EMPTY_DATASET", "这个范围内还没有可用的确认记忆");
      this.store.db.prepare("INSERT INTO dataset_input_dependencies SELECT datasetId,memoryId,'memory',memoryId,CAST(memoryVersion AS TEXT) FROM dataset_inputs WHERE datasetId=?").run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies
        SELECT i.datasetId,i.memoryId,'message-run',json_extract(e.value,'$.runId'),json_extract(e.value,'$.sha256')
        FROM dataset_inputs i,json_each(i.data,'$.evidence') e WHERE i.datasetId=? AND json_extract(e.value,'$.type')='message'`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies SELECT i.datasetId,i.memoryId,'asset',s.assetId,s.hash FROM dataset_inputs i
        JOIN memory_evidence_index s ON s.memoryId=i.memoryId WHERE i.datasetId=? AND s.assetId IS NOT NULL`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies SELECT i.datasetId,i.memoryId,'event',e.id,CAST(e.version AS TEXT) FROM dataset_inputs i
        JOIN memory_event_links l ON l.memoryId=i.memoryId AND l.active=1 JOIN memory_events e ON e.id=l.eventId WHERE i.datasetId=?`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies SELECT i.datasetId,i.memoryId,'entity',e.id,CAST(e.version AS TEXT) FROM dataset_inputs i
        JOIN memory_evidence_index s ON s.memoryId=i.memoryId JOIN memory_observations o ON o.assetId=s.assetId AND o.sourceHash=s.hash
        JOIN memory_entity_links l ON l.observationId=o.id AND l.active=1 JOIN memory_entities e ON e.id=l.entityId WHERE i.datasetId=?`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies SELECT i.datasetId,i.memoryId,'person',p.id,CAST(json_extract(p.data,'$.version') AS TEXT) FROM dataset_inputs i
        JOIN memory_person_links l ON l.memoryId=i.memoryId JOIN memory_people p ON p.id=l.personId WHERE i.datasetId=?`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies SELECT d.datasetId,d.memoryId,'person',p.id,CAST(json_extract(p.data,'$.version') AS TEXT) FROM dataset_input_dependencies d
        JOIN memory_entities e ON e.id=d.parentId JOIN memory_people p ON p.id=e.personId WHERE d.datasetId=? AND d.kind='entity'`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies
        SELECT d.datasetId,d.memoryId,'memory-command',v.commandId,'1' FROM dataset_input_dependencies d
        JOIN memory_command_versions v ON v.recordId=d.parentId AND v.version<=CAST(d.parentVersion AS INTEGER)
        WHERE d.datasetId=? AND d.kind IN ('memory','person','entity','event')`).run(id);
      this.store.db.prepare(`INSERT OR IGNORE INTO dataset_input_dependencies
        SELECT d.datasetId,d.memoryId,'message-run',json_extract(c.data,'$.instruction.runId'),json_extract(c.data,'$.instruction.sha256')
        FROM dataset_input_dependencies d JOIN memory_commands c ON c.id=d.parentId
        WHERE d.datasetId=? AND d.kind='memory-command' AND json_extract(c.data,'$.instruction.type')='message'`).run(id);
      return this.get(id);
    });
  }
  inputPage(id: string, after = 0, limit = 50) {
    return this.store.db.prepare("SELECT * FROM dataset_inputs WHERE datasetId=? AND ordinal>? ORDER BY ordinal LIMIT ?").all(id, after, Math.max(1, Math.min(100, limit))) as DatasetInput[];
  }
  pending(id: string) {
    return this.store.db.prepare("SELECT * FROM dataset_inputs WHERE datasetId=? AND status='pending' ORDER BY ordinal LIMIT 1").get(id) as DatasetInput | undefined;
  }
  inputState(input: DatasetInput, status: string, reason?: string) {
    this.store.db.prepare("UPDATE dataset_inputs SET status=?,reason=? WHERE datasetId=? AND ordinal=?").run(status, reason ?? null, input.datasetId, input.ordinal);
  }
  saveSample(sample: TrainingSample) {
    this.store.db.prepare("INSERT OR IGNORE INTO dataset_samples(id,datasetId,version,status,stale,data) VALUES (?,?,?,?,0,?)")
      .run(sample.id, sample.datasetId, sample.version, sample.status, JSON.stringify(sample));
    this.store.db.prepare(`INSERT OR IGNORE INTO dataset_sample_dependencies SELECT ?,kind,parentId,parentVersion FROM dataset_input_dependencies
      WHERE datasetId=? AND memoryId IN (SELECT value FROM json_each(?))`).run(sample.id, sample.datasetId, JSON.stringify(sample.memoryRefs.map((ref) => ref.id)));
  }
  private sampleSelection(selection: DatasetSampleSelection) {
    const where: string[] = [], args: SQLInputValue[] = [];
    if (selection.view && selection.view !== "all") { where.push("status=?"); args.push(selection.view); }
    if (selection.sampleIds) { where.push("id IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(selection.sampleIds)); }
    return { sql: where.length ? " AND " + where.join(" AND ") : "", args };
  }
  sampleCount(id: string, selection: DatasetSampleSelection = {}) {
    const filter = this.sampleSelection(selection);
    return Number(this.store.db.prepare("SELECT count(*) AS n FROM dataset_samples WHERE datasetId=?" + filter.sql).get(id, ...filter.args)!.n);
  }
  samples(id: string, after = "", limit = 20, selection: DatasetSampleSelection = {}) {
    const filter = this.sampleSelection(selection);
    const rows = this.store.db.prepare("SELECT data,stale,status,version FROM dataset_samples WHERE datasetId=? AND id>?" + filter.sql + " ORDER BY id LIMIT ?")
      .all(id, after, ...filter.args, Math.max(1, Math.min(100, limit))) as { data: string; stale: number; status: TrainingSample["status"]; version: number }[];
    return rows.map((row) => {
      const sample = { ...JSON.parse(row.data) as TrainingSample, stale: !!row.stale, status: row.status, version: row.version };
      return { ...sample, quality: { version: 1 as const, issues: [
        ...sampleTimeQuality(sample, this.sampleSources(sample)).issues, ...this.pairings.quality(sample),
      ] } };
    });
  }
  sampleSources(sample: TrainingSample): MemoryEntry[] {
    return sample.memoryRefs.map((ref) => {
      const row = this.store.db.prepare("SELECT data FROM dataset_inputs WHERE datasetId=? AND memoryId=? AND memoryVersion=?").get(sample.datasetId, ref.id, ref.version) as { data: string } | undefined;
      if (!row) throw new UserFacingError(409, "SOURCE_CHANGED", "样本来源版本已改变");
      return JSON.parse(row.data) as MemoryEntry;
    });
  }
  invalidateSource(id: string, kind: string, parentId: string, reason: string) {
    this.store.db.prepare(`INSERT OR IGNORE INTO dataset_invalidations(datasetId,kind,parentId,previousVersion,currentVersion,reason,createdAt)
      SELECT DISTINCT datasetId,kind,parentId,parentVersion,'unavailable',?,datetime('now') FROM dataset_input_dependencies
      WHERE datasetId=? AND kind=? AND parentId=?`).run(reason, id, kind, parentId);
  }
  invalidations(id: string, after = 0, limit = 20) {
    return this.store.db.prepare("SELECT seq,kind,parentId,previousVersion,currentVersion,reason,createdAt FROM dataset_invalidations WHERE datasetId=? AND seq>? ORDER BY seq LIMIT ?")
      .all(id, after, Math.min(100, limit));
  }
  review(id: string, refs: { id: string; version: number }[], reason: string) {
    this.changeSamples(id, refs.map((ref) => ({ ...ref, action: "approve" })), reason, { actor: "user" });
    return this.get(id);
  }
  changeSamples(id: string, changes: SampleChange[], reason: string, context: SampleReviewContext): SampleReviewReceipt {
    if (!reason.trim()) throw new UserFacingError(400, "REVIEW_REASON_REQUIRED", "请填写核对依据");
    if (!changes.length || changes.length > 50 || new Set(changes.map((change) => change.id)).size !== changes.length) throw new UserFacingError(400, "INVALID_REFS", "请选择 1 至 50 条不同的样本");
    const requestKey = context.requestKey || randomUUID();
    const payloadHash = createHash("sha256").update(JSON.stringify([id, changes, reason, context.actor, context.runId,
      ...(context.actor === "processor" ? [context.jobId, context.modelId, context.protocolVersion] : []),
    ])).digest("hex");
    const previousCommand = this.store.db.prepare("SELECT data,payloadHash FROM dataset_review_commands WHERE requestKey=?").get(requestKey) as { data: string; payloadHash: string } | undefined;
    if (previousCommand) {
      if (previousCommand.payloadHash !== payloadHash) throw new UserFacingError(409, "COMMAND_CONFLICT", "此请求标识已经用于其他样本修订");
      return JSON.parse(previousCommand.data) as SampleReviewReceipt;
    }
    return this.store.memories.transaction(() => {
      const job = this.get(id);
      if (job.stale) throw new UserFacingError(409, "DATASET_STALE", "依赖记录已改变，请重新构建");
      if (context.actor !== "processor" && this.store.db.prepare("SELECT 1 FROM dataset_audits WHERE datasetId=? AND status IN ('queued','running') LIMIT 1").get(id))
        throw new UserFacingError(409, "AUDIT_BUSY", "样本核验中，请等待结束或先取消核验作业");
      if (context.actor === "processor" && (!context.jobId || !this.store.db.prepare(`SELECT 1 FROM dataset_audits
        WHERE id=? AND datasetId=? AND status='running' AND json_extract(data,'$.modelId')=?`).get(context.jobId, id, context.modelId || "")))
        throw new UserFacingError(409, "REVIEW_JOB_UNAVAILABLE", "核验作业已停止，不能提交样本审阅");
      if (job.status !== "completed" && !(context.actor === "processor" && job.status === "queued"))
        throw new UserFacingError(409, "DATASET_BUSY", "请等待构建完成后核对样本");
      const modified: TrainingSample[] = [];
      for (const change of changes) {
        if (context.actor === "agent" && (!context.runId || !this.store.db.prepare("SELECT 1 FROM dataset_sample_views WHERE runId=? AND sampleId=? AND version=?").get(context.runId, change.id, change.version)))
          throw new UserFacingError(409, "REVIEW_NOT_INSPECTED", "请先在本次任务中读取当前样本及冻结来源，再进行核对");
        if (context.actor === "processor" && !this.store.db.prepare("SELECT 1 FROM dataset_audit_views WHERE jobId=? AND sampleId=? AND version=?").get(context.jobId!, change.id, change.version))
          throw new UserFacingError(409, "REVIEW_NOT_INSPECTED", "核验处理器没有读取当前样本版本");
        const row = this.store.db.prepare("SELECT data,status,version,stale FROM dataset_samples WHERE id=? AND datasetId=?").get(change.id, id) as
          { data: string; status: string; version: number; stale: number } | undefined;
        if (!row || row.version !== change.version || row.stale) throw new UserFacingError(409, "VERSION_CONFLICT", "样本已更新，请重新读取");
        const previous = JSON.parse(row.data) as TrainingSample;
        const reviewReason = (change.reason || reason).trim().slice(0, 1000);
        if (change.evaluationOf && (previous.intendedUse !== "evaluation" || change.action !== "revise"))
          throw new UserFacingError(400, "INVALID_CHANGE", "修改训练题关联请对评测样本使用 revise 操作");
        if (change.evaluationOf) {
          const training = this.pairings.get(id, change.evaluationOf.id);
          if (!training || training.version !== change.evaluationOf.version || training.stale)
            throw new UserFacingError(409, "VERSION_CONFLICT", "关联训练题已更新，请重新读取");
        }
        if (change.action === "approve" && ((change.question !== undefined && change.question !== previous.question) || (change.answer !== undefined && change.answer !== previous.answer)))
          throw new UserFacingError(400, "INVALID_CHANGE", "approve 只能批准原样本；修改问答请使用 revise 操作");
        const sample: TrainingSample = { ...previous,
          question: change.action === "revise" ? change.question ?? previous.question : previous.question,
          answer: change.action === "revise" ? change.answer ?? previous.answer : previous.answer,
          ...(change.evaluationOf ? { evaluationOf: change.evaluationOf } : {}),
          status: change.action === "exclude" ? "excluded" : change.action === "defer" ? "review" : "ready", version: row.version + 1,
          authority: ["exclude", "defer"].includes(change.action) ? "unreviewed" : context.actor === "user" ? "user-confirmed" : context.actor === "processor" ? "processor-reviewed" : "agent-reviewed",
          review: { actor: context.actor, runId: context.runId, jobId: context.jobId, modelId: context.modelId,
            protocolVersion: context.protocolVersion, reason: reviewReason, createdAt: now() },
          checks: [...previous.checks.filter((check) => check !== "question-semantics-require-review" && check !== "evaluation-pair-require-review"),
            ...(change.action === "defer" ? ["question-semantics-require-review"] : []), `${context.actor}-review: ${reviewReason.slice(0, 500)}`] };
        if (sample.status === "ready") {
          const memories = this.sampleSources(sample);
          validateReviewedSample(sample, memories);
          sample.quality = sampleTimeQuality(sample, memories);
          sample.checks = [...sample.checks.filter((check) => check !== "time-grounding-v1"), "time-grounding-v1"];
        }
        modified.push(sample);
      }
      // Validate the final batch, so training and evaluation variants can be revised together.
      const questionKeys = new Map<string, string[]>();
      const replacements = new Map(modified.map((sample) => [sample.id, sample]));
      const propagated: NonNullable<SampleReviewReceipt["propagated"]> = [];
      for (const training of modified.filter((sample) => sample.intendedUse === "training")) {
        const previousTraining = this.pairings.get(id, training.id)!;
        const semanticChange = training.question !== previousTraining.question || training.answer !== previousTraining.answer || training.status !== "ready";
        for (const row of this.store.db.prepare(`SELECT id,data,version FROM dataset_samples WHERE datasetId=?
          AND json_extract(data,'$.evaluationOf.id')=?`).iterate(id, training.id)) {
          const previous = JSON.parse(String(row.data)) as TrainingSample;
          const explicit = replacements.get(String(row.id));
          if (explicit && explicit.evaluationOf?.id !== training.id) continue;
          if (explicit) { explicit.evaluationOf = { id: training.id, version: training.version }; continue; }
          const needsReview = (semanticChange || previous.evaluationOf?.version !== previousTraining.version) && previous.status !== "excluded";
          const sample: TrainingSample = { ...previous, version: Number(row.version) + 1,
            evaluationOf: { id: training.id, version: training.version },
            ...(needsReview ? { status: "review", authority: "unreviewed", review: undefined,
              checks: [...previous.checks.filter((check) => !/^(user|agent|processor)-review:/.test(check)), "evaluation-pair-require-review"] } : {}),
          };
          replacements.set(sample.id, sample);
          propagated.push({ id: sample.id, previousVersion: Number(row.version), version: sample.version, action: needsReview ? "require-review" : "rebind" });
        }
      }
      const resolve = (sampleId: string) => replacements.get(sampleId) || this.pairings.get(id, sampleId);
      for (const sample of modified) if (sample.intendedUse === "evaluation" && sample.status === "ready") {
        const training = sample.evaluationOf && resolve(sample.evaluationOf.id);
        if (training && replacements.has(training.id)) sample.evaluationOf = { id: training.id, version: training.version };
        if (training && context.actor === "agent") {
          const inspected = this.pairings.get(id, training.id)!;
          if (!context.runId || !this.store.db.prepare("SELECT 1 FROM dataset_sample_views WHERE runId=? AND sampleId=? AND version=?")
            .get(context.runId, inspected.id, inspected.version))
            throw new UserFacingError(409, "REVIEW_NOT_INSPECTED", "请先读取关联训练题的当前版本，比较所考事实后再核对评测题");
        }
        if (training && context.actor === "processor") {
          const inspected = this.pairings.get(id, training.id)!;
          if (!this.store.db.prepare("SELECT 1 FROM dataset_audit_views WHERE jobId=? AND sampleId=? AND version=?")
            .get(context.jobId!, inspected.id, inspected.version))
            throw new UserFacingError(409, "REVIEW_NOT_INSPECTED", "核验处理器没有读取关联训练题的当前版本");
        }
        this.pairings.assertReviewed(sample, resolve);
      }
      for (const row of this.store.db.prepare("SELECT id,data FROM dataset_samples WHERE datasetId=? ORDER BY id").iterate(id)) {
        const sample = replacements.get(String(row.id)) || JSON.parse(String(row.data)) as TrainingSample;
        if (sample.status === "excluded") continue;
        const key = normalizeFact(sample.question);
        const matches = questionKeys.get(key) || [];
        matches.push(sample.id); questionKeys.set(key, matches);
      }
      if ([...questionKeys.values()].some((ids) => ids.length > 1 && ids.some((sampleId) => replacements.get(sampleId)?.status === "ready")))
        throw new UserFacingError(422, "DUPLICATE_QUESTION", "训练和评测问法重复，请修订或排除重复题");
      for (const sample of replacements.values()) this.store.db.prepare("UPDATE dataset_samples SET version=?,status=?,data=? WHERE id=?")
        .run(sample.version, sample.status, JSON.stringify(sample), sample.id);
      for (const memoryId of new Set([...replacements.values()].flatMap((sample) => sample.memoryRefs.map((ref) => ref.id)))) {
        const counts = this.store.db.prepare(`SELECT sum(s.status='review') AS review,sum(s.status='ready') AS ready
          FROM dataset_samples s JOIN dataset_sample_dependencies d ON d.sampleId=s.id WHERE s.datasetId=? AND d.kind='memory' AND d.parentId=?`).get(id, memoryId) as { review: number; ready: number };
        this.store.db.prepare("UPDATE dataset_inputs SET status=?,reason=? WHERE datasetId=? AND memoryId=?")
          .run(counts.review ? "review" : counts.ready ? "ready" : "excluded", counts.review || counts.ready ? null : "样本核验后全部排除", id, memoryId);
      }
      this.patch(id, { status: "queued", files: undefined });
      const receipt: SampleReviewReceipt = { id: randomUUID(), datasetId: id, actor: context.actor, runId: context.runId, jobId: context.jobId, modelId: context.modelId, reason,
        before: changes.map(({ id, version }) => ({ id, version })), after: modified.map(({ id, version, status }) => ({ id, version, status })),
        ...(propagated.length ? { propagated } : {}), createdAt: now() };
      this.store.db.prepare("INSERT INTO dataset_review_commands VALUES(?,?,?,?)").run(receipt.id, requestKey, payloadHash, JSON.stringify(receipt));
      return receipt;
    });
  }
  dependencies(id: string, memoryId: string) {
    return this.store.db.prepare("SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=? AND memoryId=? ORDER BY kind,parentId").all(id, memoryId);
  }
}
