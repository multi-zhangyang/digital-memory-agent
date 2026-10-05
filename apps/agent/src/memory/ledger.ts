import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryEvidence,
  MemoryPerson,
  MemorySettings,
  Run,
} from "@memory/contracts";
import { indexMemory } from "./retrieval.js";
import { UserFacingError } from "../errors.js";
import { MemoryReadModel } from "./read-model.js";
import { MemoryGraph } from "./graph.js";
import { contentHash, evidenceOf } from "./values.js";
import { EventOutbox } from "../storage/event-outbox.js";
export { contentHash, evidenceOf, normalizeFact } from "./values.js";

export function messageEvidence(
  run: Run,
  quote: string,
  messageId = run.id,
  text = run.text,
): MemoryEvidence {
  const index = text.indexOf(quote);
  if (index < 0 || !quote.trim())
    throw new UserFacingError(
      422,
      "INVALID_EVIDENCE",
      "记忆引句无法在原始消息中找到",
    );
  const start = Buffer.byteLength(text.slice(0, index));
  return {
    type: "message",
    messageId,
    runId: run.id,
    conversationId: run.conversationId,
    sha256: contentHash(text),
    start,
    end: start + Buffer.byteLength(quote),
    quote,
  };
}
export function combineEvidence(entries: MemoryEvidence[]) {
  return [
    ...new Map(
      entries.map((entry) => [
        JSON.stringify([
          entry.type,
          entry.type === "message" ? entry.messageId : entry.assetId,
          entry.sha256,
          entry.start,
          entry.end,
          entry.type === "asset" ? entry.visual : undefined,
          entry.type === "asset" ? entry.video : undefined,
        ]),
        entry,
      ]),
    ).values(),
  ];
}

export class MemoryLedger {
  onInvalidate?: () => void;
  readonly read: MemoryReadModel;
  readonly graph: MemoryGraph;
  constructor(private readonly db: DatabaseSync, private readonly events = new EventOutbox(db)) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,title,content,grams,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS memory_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,epoch INTEGER NOT NULL,settings TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_meta VALUES (1,0,0,'{"capture":"graded","timeZone":"Asia/Shanghai"}');
      CREATE TABLE IF NOT EXISTS memory_people (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_suppressions (memoryId TEXT NOT NULL,hash TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(memoryId,hash,start,end));
      CREATE INDEX IF NOT EXISTS memory_suppressions_hash ON memory_suppressions(hash);
      CREATE TABLE IF NOT EXISTS memory_session_epochs (id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,recall INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS memory_capture_jobs (id TEXT PRIMARY KEY,messageId TEXT NOT NULL,extractorVersion INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(messageId,extractorVersion));
      CREATE INDEX IF NOT EXISTS memory_capture_status ON memory_capture_jobs(json_extract(data,'$.status'));`);
    if (!db.prepare("SELECT version FROM migrations WHERE version=3").get()) {
      db.exec("SAVEPOINT memory_migration");
      try {
        for (const row of db
          .prepare("SELECT data FROM workspace_records WHERE kind='memory'")
          .iterate()) {
          const memory = this.enrich(JSON.parse(row.data as string));
          db.prepare("UPDATE workspace_records SET data=? WHERE id=?").run(
            JSON.stringify(memory),
            memory.id,
          );
          indexMemory(db, memory);
        }
        db.exec("INSERT INTO migrations VALUES (3); RELEASE memory_migration");
      } catch (error) {
        db.exec("ROLLBACK TO memory_migration; RELEASE memory_migration");
        throw error;
      }
    }
    this.read = new MemoryReadModel(db);
    this.graph = new MemoryGraph(db, () => this.invalidate());
  }
  get revision() {
    return (
      this.db.prepare("SELECT revision FROM memory_meta WHERE id=1").get() as {
        revision: number;
      }
    ).revision;
  }
  get epoch() {
    return (
      this.db.prepare("SELECT epoch FROM memory_meta WHERE id=1").get() as {
        epoch: number;
      }
    ).epoch;
  }
  settings(): MemorySettings {
    return { intake: "automatic", automaticText: true, automaticPhotos: true, automaticVideos: false, videoSampleInterval: 10, indexAssets: true, processingVersion: 1, ...JSON.parse(
      (
        this.db
          .prepare("SELECT settings FROM memory_meta WHERE id=1")
          .get() as { settings: string }
      ).settings,
    ) };
  }
  setSettings(patch: Partial<MemorySettings>) {
    const settings = { ...this.settings(), ...patch, processingVersion: (this.settings().processingVersion || 1) + 1 };
    try {
      new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
    } catch {
      throw new UserFacingError(400, "TIME_ZONE", "请输入有效的时区名称");
    }
    this.db.exec("SAVEPOINT processing_policy");
    try {
      this.db.prepare("UPDATE memory_meta SET settings=? WHERE id=1").run(JSON.stringify(settings));
      this.events.publish("processing.policy-changed", "personal", settings.processingVersion);
      this.db.exec("RELEASE processing_policy");
    } catch (error) { this.db.exec("ROLLBACK TO processing_policy; RELEASE processing_policy"); throw error; }
    return settings;
  }
  enrich(memory: MemoryEntry): MemoryEntry {
    const next = {
      ...memory,
      evidence: evidenceOf(memory),
      acceptedBy:
        memory.acceptedBy ||
        (memory.status === "confirmed" ? ("user" as const) : undefined),
    };
    if (!next.evidence.length && memory.statement && memory.runId) {
      const row = this.db
        .prepare("SELECT data FROM workspace_records WHERE kind='run' AND id=?")
        .get(memory.runId) as { data: string } | undefined;
      if (row) {
        try {
          next.evidence = [
            messageEvidence(JSON.parse(row.data), memory.statement),
          ];
        } catch {
          /* Legacy unverifiable statements remain unlinked. */
        }
      }
    }
    return next;
  }
  changed(previous: MemoryEntry | undefined, memory: MemoryEntry) {
    this.read.index(memory);
    indexMemory(this.db, memory);
    this.graph.sync(previous, memory);
    this.db.exec("UPDATE memory_meta SET revision=revision+1 WHERE id=1");
    this.events.publish("memory.changed", memory.id, memory.version);
    const affectsContext =
      previous?.space !== "demo" &&
      previous !== undefined && previous.status !== "rejected" &&
      JSON.stringify([
        previous.content,
        previous.status,
        previous.forgottenAt,
        previous.supersededBy,
        previous.validity,
        previous.personIds,
        previous.occurredAt,
        previous.category,
        previous.attribute,
        previous.people,
        previous.place,
        previous.kind,
        previous.uncertainty,
      ]) !==
        JSON.stringify([
          memory.content,
          memory.status,
          memory.forgottenAt,
          memory.supersededBy,
          memory.validity,
          memory.personIds,
          memory.occurredAt,
          memory.category,
          memory.attribute,
          memory.people,
          memory.place,
          memory.kind,
          memory.uncertainty,
        ]);
    if (affectsContext) this.invalidate();
  }
  invalidate() {
    this.db.exec("UPDATE memory_meta SET epoch=epoch+1 WHERE id=1");
    const epoch = this.epoch;
    this.events.publish("memory.invalidated", "personal", epoch, { epoch });
    queueMicrotask(() => {
      if (this.onInvalidate && this.epoch >= epoch) this.onInvalidate();
    });
  }
  sessionEpoch(id: string) {
    return this.db
      .prepare("SELECT epoch,recall FROM memory_session_epochs WHERE id=?")
      .get(id) as { epoch: number; recall: number } | undefined;
  }
  setSessionEpoch(id: string, recall: boolean) {
    this.db
      .prepare(
        "INSERT INTO memory_session_epochs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,recall=excluded.recall",
      )
      .run(id, this.epoch, Number(recall));
  }
  block(memory: MemoryEntry) {
    for (const source of evidenceOf(memory))
      this.db
        .prepare("INSERT OR IGNORE INTO memory_suppressions VALUES (?,?,?,?)")
        .run(memory.id, source.sha256, source.start, source.end);
    this.read.refreshSuppression(evidenceOf(memory).map((source) => source.sha256));
  }
  unblock(id: string) {
    const hashes = this.db.prepare("SELECT hash FROM memory_suppressions WHERE memoryId=?").all(id) as { hash: string }[];
    this.db.prepare("DELETE FROM memory_suppressions WHERE memoryId=?").run(id);
    this.read.refreshSuppression(hashes.map((row) => row.hash));
  }
  sourceBlocked(
    hash: string,
    start = 0,
    end = Number.MAX_SAFE_INTEGER,
  ): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM memory_suppressions WHERE hash=? AND start<? AND end>? LIMIT 1",
      )
      .get(hash, end, start);
  }
  suppressed(memory: Pick<MemoryEntry, "sources" | "evidence">) {
    return evidenceOf(memory).some((source) =>
      this.sourceBlocked(source.sha256, source.start, source.end),
    );
  }
  people(): MemoryPerson[] {
    return (
      this.db
        .prepare("SELECT data FROM memory_people ORDER BY rowid")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  person(id: string): MemoryPerson {
    const row = this.db
      .prepare("SELECT data FROM memory_people WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "人物不存在");
    return JSON.parse(row.data);
  }
  savePerson(input: {
    id?: string;
    version?: number;
    name: string;
    aliases: string[];
  }): MemoryPerson {
    this.db.exec("SAVEPOINT memory_person_write");
    try {
      const previous = input.id ? this.person(input.id) : undefined;
      if (previous && previous.version !== input.version)
        throw new UserFacingError(
          409,
          "VERSION_CONFLICT",
          "人物已更新，请刷新后重试",
        );
      const person: MemoryPerson = {
        id: previous?.id || randomUUID(),
        name: input.name.trim(),
        aliases: [
          ...new Set(
            input.aliases
              .map((name) => name.trim())
              .filter((name) => !!name && name !== input.name.trim()),
          ),
        ],
        memoryIds: [],
        confirmedCount: 0,
        version: (previous?.version || 0) + 1,
      };
      this.db
        .prepare(
          "INSERT INTO memory_people VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(person.id!, JSON.stringify(person));
      this.read.person(person);
      for (const row of this.db
        .prepare(
          "SELECT r.data FROM memory_person_links l JOIN workspace_records r ON r.id=l.memoryId WHERE l.personId=?",
        )
        .iterate(person.id!)) {
        const memory = JSON.parse(row.data as string) as MemoryEntry;
        indexMemory(this.db, memory);
        this.read.refreshPeople(memory.id);
      }
      this.db.exec("UPDATE memory_meta SET revision=revision+1 WHERE id=1");
      if (previous) this.invalidate();
      this.db.exec("RELEASE memory_person_write");
      return person;
    } catch (error) {
      this.db.exec("ROLLBACK TO memory_person_write; RELEASE memory_person_write");
      throw error;
    }
  }
  rebuild() {
    this.read.rebuild();
  }
}
