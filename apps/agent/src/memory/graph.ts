import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Asset, MemoryEntity, MemoryEntry, MemoryEvidence, MemoryObservation, MemorySpace, VideoFrame } from "@memory/contracts";
import type { ImageFeatures } from "../integrations/local-features.js";
import { evidenceOf } from "./values.js";
import { UserFacingError } from "../errors.js";

export type { MemoryEntity, MemoryObservation } from "@memory/contracts";
type EventRecord = { id: string; space: MemorySpace; version: number; title: string; mergedInto?: string; updatedAt: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();

/** Source observations are immutable. Entity/event grouping has its own revision history. */
export class MemoryGraph {
  constructor(private readonly db: DatabaseSync, private readonly invalidate: () => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_observations (
      id TEXT PRIMARY KEY, dedupKey TEXT NOT NULL UNIQUE, space TEXT NOT NULL, kind TEXT NOT NULL,
      assetId TEXT, sourceHash TEXT, processor TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_asset ON memory_observations(assetId,sourceHash,processor);
      CREATE TABLE IF NOT EXISTS memory_observation_links (memoryId TEXT NOT NULL,observationId TEXT NOT NULL REFERENCES memory_observations(id),
        firstVersion INTEGER NOT NULL,PRIMARY KEY(memoryId,observationId));
      CREATE INDEX IF NOT EXISTS observation_memories ON memory_observation_links(observationId,memoryId);
      CREATE TABLE IF NOT EXISTS memory_entities (id TEXT PRIMARY KEY,space TEXT NOT NULL,version INTEGER NOT NULL,personId TEXT,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_person ON memory_entities(personId,state);
      CREATE TABLE IF NOT EXISTS memory_entity_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,entityId TEXT NOT NULL REFERENCES memory_entities(id),
        observationId TEXT NOT NULL REFERENCES memory_observations(id),status TEXT NOT NULL,score REAL,
        active INTEGER NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS entity_active_observation ON memory_entity_links(observationId) WHERE active=1;
      CREATE INDEX IF NOT EXISTS entity_observations ON memory_entity_links(entityId,active,status);
      CREATE TABLE IF NOT EXISTS memory_events (id TEXT PRIMARY KEY,space TEXT NOT NULL,version INTEGER NOT NULL,mergedInto TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_event_links (eventId TEXT NOT NULL REFERENCES memory_events(id),memoryId TEXT NOT NULL,
        active INTEGER NOT NULL,PRIMARY KEY(eventId,memoryId));
      CREATE UNIQUE INDEX IF NOT EXISTS event_active_memory ON memory_event_links(memoryId) WHERE active=1;
      CREATE TABLE IF NOT EXISTS memory_graph_versions (id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,
        change TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(id,version));`);
    if (!db.prepare("SELECT version FROM migrations WHERE version=7").get()) {
      this.transaction(() => {
        for (const row of db.prepare("SELECT data FROM workspace_records WHERE kind='memory'").iterate())
          this.sync(undefined, JSON.parse(row.data as string));
        db.exec("INSERT INTO migrations VALUES (7)");
      });
    }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT memory_graph_write");
    try { const result = operation(); this.db.exec("RELEASE memory_graph_write"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO memory_graph_write; RELEASE memory_graph_write"); throw error; }
  }
  private changed(affectsFacts = true) {
    this.db.exec("UPDATE memory_meta SET revision=revision+1 WHERE id=1");
    if (affectsFacts) this.invalidate();
  }
  private history(id: string, kind: string, version: number, value: unknown, change: unknown) {
    this.db.prepare("INSERT INTO memory_graph_versions VALUES (?,?,?,?,?,?)").run(id, kind, version, JSON.stringify(value), JSON.stringify(change), now());
  }
  observation(id: string): MemoryObservation {
    const row = this.db.prepare("SELECT data FROM memory_observations WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "OBSERVATION_NOT_FOUND", "观察记录不存在");
    return JSON.parse(row.data);
  }
  private addObservation(key: string, input: Omit<MemoryObservation, "id" | "createdAt">) {
    const row = this.db.prepare("SELECT data FROM memory_observations WHERE dedupKey=?").get(key) as { data: string } | undefined;
    if (row) return JSON.parse(row.data) as MemoryObservation;
    const observation: MemoryObservation = { ...input, id: randomUUID(), createdAt: now() };
    this.db.prepare("INSERT INTO memory_observations VALUES (?,?,?,?,?,?,?,?)").run(observation.id, key, input.space, input.kind,
      input.assetId ?? null, input.evidence[0]?.sha256 ?? null, input.processor, JSON.stringify(observation));
    return observation;
  }
  sync(previous: MemoryEntry | undefined, memory: MemoryEntry) {
    const evidence = evidenceOf(memory);
    const existing = new Set((this.db.prepare("SELECT o.sourceHash FROM memory_observation_links l JOIN memory_observations o ON o.id=l.observationId WHERE l.memoryId=?")
      .all(memory.id) as { sourceHash: string | null }[]).map((row) => row.sourceHash));
    for (const reference of evidence) {
      const key = hash([memory.id, reference.type, reference.type === "asset" ? reference.assetId : reference.messageId,
        reference.sha256, reference.start, reference.end, reference.type === "asset" ? reference.visual?.region : null,
        ...(reference.type === "asset" && reference.video ? [reference.video.timestamp] : [])]);
      // A correction of a claim never overwrites the original processor observation.
      const original = !previous && memory.version > 1
        ? this.db.prepare("SELECT data FROM workspace_versions WHERE id=? ORDER BY version LIMIT 1").get(memory.id) as { data: string } | undefined : undefined;
      const source = original ? JSON.parse(original.data) as MemoryEntry : memory;
      const observation = this.addObservation(key, { space: memory.space || "personal", kind: "source",
        assetId: reference.type === "asset" ? reference.assetId : undefined, evidence: [reference],
        processor: source.ingestion ? `${source.ingestion.modelId}:extractor-${source.ingestion.extractorVersion}` : source.kind === "statement" ? "user-source" : "legacy-unrecorded",
        output: { title: source.title, content: source.content, kind: source.kind, uncertainty: source.uncertainty,
          originalMemoryVersion: source.version, review: source.status, provenance: existing.has(reference.sha256) ? "additional-range" : "source" } });
      this.db.prepare("INSERT OR IGNORE INTO memory_observation_links VALUES (?,?,?)").run(memory.id, observation.id, memory.version);
    }
    const link = this.db.prepare("SELECT eventId FROM memory_event_links WHERE memoryId=? AND active=1").get(memory.id) as { eventId: string } | undefined;
    if (memory.category === "event") {
      if (!link) {
        const event: EventRecord = { id: randomUUID(), space: memory.space || "personal", version: 1, title: memory.title, updatedAt: now() };
        this.saveEvent(event, { action: "from-memory", memoryId: memory.id, memoryVersion: memory.version });
        this.db.prepare("INSERT INTO memory_event_links VALUES (?,?,1)").run(event.id, memory.id);
      } else if (previous && previous.version !== memory.version) {
        const event = this.event(link.eventId);
        const members = (this.db.prepare("SELECT count(*) AS n FROM memory_event_links WHERE eventId=? AND active=1").get(event.id) as { n: number }).n;
        this.saveEvent({ ...event, version: event.version + 1, title: members === 1 ? memory.title : event.title, updatedAt: now() },
          { action: "memory-revision", memoryId: memory.id, memoryVersion: memory.version });
      }
    } else if (link) {
      this.db.prepare("UPDATE memory_event_links SET active=0 WHERE eventId=? AND memoryId=?").run(link.eventId, memory.id);
      const event = this.event(link.eventId);
      this.saveEvent({ ...event, version: event.version + 1, updatedAt: now() }, { action: "memory-category-changed", memoryId: memory.id });
    }
  }
  entity(id: string): MemoryEntity {
    const row = this.db.prepare("SELECT data FROM memory_entities WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "ENTITY_NOT_FOUND", "人物候选不存在");
    return JSON.parse(row.data);
  }
  private saveEntity(entity: MemoryEntity, change: unknown) {
    this.db.prepare("INSERT INTO memory_entities VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,personId=excluded.personId,state=excluded.state,data=excluded.data")
      .run(entity.id, entity.space, entity.version, entity.personId ?? null, entity.state, JSON.stringify(entity));
    this.history(entity.id, "entity", entity.version, entity, change);
    return entity;
  }
  private assignment(entityId: string, observationId: string, status: "candidate" | "confirmed", reason: string, score?: number) {
    this.db.prepare("UPDATE memory_entity_links SET active=0 WHERE observationId=? AND active=1").run(observationId);
    this.db.prepare("INSERT INTO memory_entity_links(entityId,observationId,status,score,active,reason,createdAt) VALUES (?,?,?,?,1,?,?)")
      .run(entityId, observationId, status, score ?? null, reason, now());
  }
  recordImage(asset: Asset, features: ImageFeatures, candidates: (vector: number[], excluded: string[]) => { entityId: string; similarity: number }[], video?: VideoFrame) {
    return this.transaction(() => {
      const evidence: MemoryEvidence[] = [{ type: "asset", assetId: asset.id, name: asset.name, sha256: asset.sha256, start: 0, end: asset.size, ...(video ? { video } : {}) }];
      const sourceKey = [asset.id, asset.sha256, features.fingerprint, ...(video ? [video.timestamp] : [])];
      const space = asset.memorySpace || "personal";
      this.addObservation(hash([...sourceKey, "metadata"]), { kind: "metadata", space,
        assetId: asset.id, evidence, processor: features.fingerprint, output: features.metadata });
      const entities: string[] = [];
      return features.faces.map((face, index) => {
        const observation = this.addObservation(hash([...sourceKey, "face", index, face.region]), {
          kind: "face", space, assetId: asset.id, evidence, processor: features.fingerprint,
          output: { region: face.region, detectionScore: face.detectionScore, quality: face.quality, coordinateSpace: features.coordinateSpace,
            ...(video ? { video } : {}) } });
        const linked = this.db.prepare("SELECT entityId FROM memory_entity_links WHERE observationId=? AND active=1").get(observation.id) as { entityId: string } | undefined;
        if (linked) { entities.push(linked.entityId); return { observationId: observation.id, entityId: linked.entityId, vector: face.vector }; }
        const matches = face.vector ? candidates(face.vector, entities) : [];
        const candidate = matches[0];
        // Deliberately a candidate association. This threshold is not an identity probability.
        const match = candidate && candidate.similarity >= 0.55 && (!matches[1] || candidate.similarity - matches[1].similarity >= 0.1) ? candidate : undefined;
        const entity = match ? this.entity(match.entityId) : this.saveEntity({ id: randomUUID(), space, version: 1, state: "unknown", updatedAt: now() },
          { action: "unknown-face", observationId: observation.id });
        this.assignment(entity.id, observation.id, "candidate", match ? "特征相似的候选关联，身份未确认" : "未知身份", match?.similarity);
        if (match) this.saveEntity({ ...entity, version: entity.version + 1, updatedAt: now() }, { action: "candidate-added", observationId: observation.id });
        entities.push(entity.id);
        this.changed(false);
        return { observationId: observation.id, entityId: entity.id, vector: face.vector };
      });
    });
  }
  private expected(entity: MemoryEntity, version: number) {
    if (entity.version !== version || entity.state === "merged") throw new UserFacingError(409, "VERSION_CONFLICT", "人物候选已更新，请刷新后重试");
  }
  identify(id: string, version: number, personId: string, reason: string) {
    if (!reason.trim()) throw new UserFacingError(400, "IDENTITY_EVIDENCE_REQUIRED", "请保留这次身份确认的依据");
    if (!this.db.prepare("SELECT 1 FROM memory_people WHERE id=?").get(personId)) throw new UserFacingError(404, "PERSON_NOT_FOUND", "已确认人物不存在");
    return this.transaction(() => {
      const entity = this.entity(id); this.expected(entity, version);
      if (entity.space !== "personal") throw new UserFacingError(400, "SPACE_MISMATCH", "示例候选不能关联个人身份");
      const links = this.db.prepare("SELECT observationId FROM memory_entity_links WHERE entityId=? AND active=1").all(id) as { observationId: string }[];
      for (const link of links) this.assignment(id, link.observationId, "confirmed", reason);
      const saved = this.saveEntity({ ...entity, version: entity.version + 1, state: "identified", personId, reason, updatedAt: now() }, { action: "user-identity", reason, personId });
      this.changed(); return saved;
    });
  }
  mergeEntities(inputs: { id: string; version: number }[], reason: string) {
    if (inputs.length < 2 || inputs.length > 20 || !reason.trim() || new Set(inputs.map((item) => item.id)).size !== inputs.length)
      throw new UserFacingError(400, "INVALID_MERGE", "请选择不同候选并记录合并依据");
    return this.transaction(() => {
      const entities = inputs.map((input) => { const entity = this.entity(input.id); this.expected(entity, input.version); return entity; });
      if (new Set(entities.map((entity) => entity.space)).size !== 1 || new Set(entities.flatMap((entity) => entity.personId ? [entity.personId] : [])).size > 1)
        throw new UserFacingError(409, "IDENTITY_CONFLICT", "候选空间或已确认身份冲突，不能直接合并");
      const target = entities[0];
      for (const source of entities.slice(1)) {
        for (const row of this.db.prepare("SELECT observationId,status,score FROM memory_entity_links WHERE entityId=? AND active=1").all(source.id) as { observationId: string; status: "candidate" | "confirmed"; score: number | null }[])
          this.assignment(target.id, row.observationId, row.status, reason, row.score ?? undefined);
        this.saveEntity({ ...source, state: "merged", mergedInto: target.id, version: source.version + 1, updatedAt: now() }, { action: "merge", targetId: target.id, reason });
      }
      const personId = entities.find((entity) => entity.personId)?.personId;
      const saved = this.saveEntity({ ...target, personId, state: personId ? "identified" : "unknown", version: target.version + 1, updatedAt: now() },
        { action: "merge", sourceIds: entities.slice(1).map((entity) => entity.id), reason });
      this.changed(); return saved;
    });
  }
  splitEntity(id: string, version: number, observationIds: string[], reason: string) {
    if (!observationIds.length || observationIds.length > 50 || !reason.trim()) throw new UserFacingError(400, "INVALID_SPLIT", "请选择要分离的观察并记录依据");
    return this.transaction(() => {
      const entity = this.entity(id); this.expected(entity, version);
      for (const observationId of observationIds)
        if (!this.db.prepare("SELECT 1 FROM memory_entity_links WHERE entityId=? AND observationId=? AND active=1").get(id, observationId))
          throw new UserFacingError(400, "INVALID_OBSERVATION", "观察不属于当前候选");
      const split = this.saveEntity({ id: randomUUID(), space: entity.space, version: 1, state: "unknown", reason, updatedAt: now() },
        { action: "split", sourceId: id, observationIds, reason });
      for (const observationId of observationIds) this.assignment(split.id, observationId, "candidate", reason);
      this.saveEntity({ ...entity, version: entity.version + 1, updatedAt: now() }, { action: "split", targetId: split.id, observationIds, reason });
      this.changed(); return split;
    });
  }
  event(id: string): EventRecord {
    const row = this.db.prepare("SELECT data FROM memory_events WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "EVENT_NOT_FOUND", "事件不存在");
    return JSON.parse(row.data);
  }
  private saveEvent(event: EventRecord, change: unknown) {
    this.db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,mergedInto=excluded.mergedInto,data=excluded.data")
      .run(event.id, event.space, event.version, event.mergedInto ?? null, JSON.stringify(event));
    this.history(event.id, "event", event.version, event, change);
    return event;
  }
  mergeEvents(inputs: { id: string; version: number }[], title: string, reason: string) {
    if (inputs.length < 2 || inputs.length > 20 || !title.trim() || !reason.trim() || new Set(inputs.map((item) => item.id)).size !== inputs.length)
      throw new UserFacingError(400, "INVALID_MERGE", "请选择不同事件并记录合并依据");
    return this.transaction(() => {
      const events = inputs.map((input) => {
        const event = this.event(input.id);
        if (event.version !== input.version || event.mergedInto) throw new UserFacingError(409, "VERSION_CONFLICT", "事件已更新");
        return event;
      });
      if (new Set(events.map((event) => event.space)).size !== 1) throw new UserFacingError(400, "SPACE_MISMATCH", "不能跨空间合并事件");
      const target = events[0];
      for (const event of events.slice(1)) {
        const ids = this.db.prepare("SELECT memoryId FROM memory_event_links WHERE eventId=? AND active=1").all(event.id) as { memoryId: string }[];
        this.db.prepare("UPDATE memory_event_links SET active=0 WHERE eventId=?").run(event.id);
        for (const { memoryId } of ids) this.db.prepare("INSERT INTO memory_event_links VALUES (?,?,1) ON CONFLICT(eventId,memoryId) DO UPDATE SET active=1").run(target.id, memoryId);
        this.saveEvent({ ...event, mergedInto: target.id, version: event.version + 1, updatedAt: now() }, { action: "merge", targetId: target.id, reason });
      }
      const saved = this.saveEvent({ ...target, title: title.trim(), version: target.version + 1, updatedAt: now() },
        { action: "merge", sourceIds: events.slice(1).map((event) => event.id), reason });
      this.changed(); return saved;
    });
  }
  splitEvent(id: string, version: number, memoryIds: string[], title: string, reason: string) {
    if (!memoryIds.length || memoryIds.length > 50 || !title.trim() || !reason.trim()) throw new UserFacingError(400, "INVALID_SPLIT", "请选择要分离的记忆并记录依据");
    return this.transaction(() => {
      const event = this.event(id);
      if (event.version !== version || event.mergedInto) throw new UserFacingError(409, "VERSION_CONFLICT", "事件已更新");
      for (const memoryId of memoryIds)
        if (!this.db.prepare("SELECT 1 FROM memory_event_links WHERE eventId=? AND memoryId=? AND active=1").get(id, memoryId))
          throw new UserFacingError(400, "INVALID_MEMORY", "记忆不属于当前事件");
      const split = this.saveEvent({ id: randomUUID(), space: event.space, version: 1, title: title.trim(), updatedAt: now() }, { action: "split", sourceId: id, memoryIds, reason });
      for (const memoryId of memoryIds) {
        this.db.prepare("UPDATE memory_event_links SET active=0 WHERE eventId=? AND memoryId=?").run(id, memoryId);
        this.db.prepare("INSERT INTO memory_event_links VALUES (?,?,1)").run(split.id, memoryId);
      }
      this.saveEvent({ ...event, version: event.version + 1, updatedAt: now() }, { action: "split", targetId: split.id, memoryIds, reason });
      this.changed(); return split;
    });
  }
  context(memory: MemoryEntry) {
    const observations = this.db.prepare("SELECT observationId AS id FROM memory_observation_links WHERE memoryId=? AND firstVersion<=? LIMIT 21").all(memory.id, memory.version) as { id: string }[];
    const entities = this.db.prepare(`SELECT DISTINCT e.id,e.version,e.personId,l.status AS association FROM memory_entities e
      JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1 JOIN memory_observations o ON o.id=l.observationId
      JOIN memory_evidence_index s ON s.assetId=o.assetId AND s.hash=o.sourceHash
        AND s.timestamp IS json_extract(o.data,'$.evidence[0].video.timestamp')
      WHERE s.memoryId=? AND e.state<>'merged' LIMIT 21`).all(memory.id) as unknown as { id: string; version: number; personId: string | null; association: string }[];
    const events = this.db.prepare("SELECT e.id,e.version FROM memory_event_links l JOIN memory_events e ON e.id=l.eventId WHERE l.memoryId=? AND l.active=1 AND e.mergedInto IS NULL").all(memory.id);
    return { observationIds: observations.slice(0, 20).map((row) => row.id), entities: entities.slice(0, 20).map((entity) => ({ ...entity,
      personId: entity.association === "confirmed" ? entity.personId : undefined })), events,
      truncated: observations.length > 20 || entities.length > 20 };
  }
  entityPage(space: MemorySpace, limit = 20, offset = 0, allowedAssetIds?: readonly string[]) {
    const usable = `l.active=1 AND a.memorySpace=? AND NOT EXISTS(SELECT 1 FROM memory_suppressions WHERE hash=a.sha256)
      ${allowedAssetIds ? "AND a.id IN (SELECT value FROM json_each(?))" : ""}`;
    const args = [space, ...(allowedAssetIds ? [JSON.stringify(allowedAssetIds)] : [])];
    const links = "memory_entity_links l JOIN memory_observations o ON o.id=l.observationId JOIN assets a ON a.id=o.assetId AND a.sha256=o.sourceHash";
    const visible = `e.space=? AND e.state<>'merged' AND EXISTS(SELECT 1 FROM ${links} WHERE l.entityId=e.id AND ${usable})`;
    const total = (this.db.prepare(`SELECT count(*) AS n FROM memory_entities e WHERE ${visible}`).get(space, ...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT e.data FROM memory_entities e WHERE ${visible} ORDER BY e.rowid DESC LIMIT ? OFFSET ?`)
      .all(space, ...args, Math.min(50, Math.max(1, limit)), Math.max(0, offset)) as { data: string }[];
    return { total, entities: rows.map((row) => {
      const entity = JSON.parse(row.data) as MemoryEntity;
      const count = (this.db.prepare(`SELECT count(*) AS n FROM ${links} WHERE l.entityId=? AND ${usable}`).get(entity.id, ...args) as { n: number }).n;
      const selected = this.db.prepare(`SELECT l.observationId,l.status,l.score,o.data FROM ${links}
        WHERE l.entityId=? AND ${usable} ORDER BY l.id LIMIT 8`).all(entity.id, ...args) as { observationId: string; status: string; score: number | null; data: string }[];
      const person = entity.personId ? this.db.prepare("SELECT data FROM memory_people WHERE id=?").get(entity.personId) as { data: string } | undefined : undefined;
      return { ...entity, personName: person ? JSON.parse(person.data).name as string : undefined,
        observationCount: count, observations: selected.map(({ data, ...link }) => ({ ...link, observation: JSON.parse(data) as MemoryObservation })) };
    }), nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
}
