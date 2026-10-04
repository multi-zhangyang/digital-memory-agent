import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryEntry, MemoryPerson } from "@memory/contracts";
import { contentHash, evidenceOf, nameKey, normalizeFact } from "./values.js";
import { indexMemory } from "./retrieval.js";

/** Rebuildable indexes. workspace_records and workspace_versions remain canonical. */
export class MemoryReadModel {
  private readonly statements = new Map<string, StatementSync>();
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_read (
      id TEXT PRIMARY KEY REFERENCES workspace_records(id) ON DELETE CASCADE,
      space TEXT NOT NULL,status TEXT NOT NULL,category TEXT NOT NULL,version INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,sortTime TEXT NOT NULL,occurredAt TEXT NOT NULL,
      validFrom TEXT,validTo TEXT,validityKey TEXT NOT NULL,
      forgotten INTEGER NOT NULL,superseded INTEGER NOT NULL,suppressed INTEGER NOT NULL,
      contentKey TEXT NOT NULL,attributeKey TEXT,attributeValue TEXT,attributeFactKey TEXT,
      conversationId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_read_updated ON memory_read(space,updatedAt DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_read_status ON memory_read(space,status,updatedAt DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_read_time ON memory_read(space,sortTime DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_read_content ON memory_read(space,contentKey,occurredAt,validityKey);
      CREATE INDEX IF NOT EXISTS memory_read_attribute ON memory_read(space,attributeKey,attributeFactKey);
      CREATE INDEX IF NOT EXISTS memory_read_conversation ON memory_read(conversationId,updatedAt DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_read_unknown_time ON memory_read(space,id) WHERE occurredAt='' AND validFrom IS NULL AND validTo IS NULL
        AND status='confirmed' AND forgotten=0 AND suppressed=0 AND superseded=0;
      CREATE TABLE IF NOT EXISTS memory_count_buckets (
        space TEXT NOT NULL,status TEXT NOT NULL,category TEXT NOT NULL,forgotten INTEGER NOT NULL,superseded INTEGER NOT NULL,
        suppressed INTEGER NOT NULL,records INTEGER NOT NULL,PRIMARY KEY(space,status,category,forgotten,superseded,suppressed));
      CREATE TRIGGER IF NOT EXISTS memory_count_added AFTER INSERT ON memory_read BEGIN
        INSERT INTO memory_count_buckets VALUES(new.space,new.status,new.category,new.forgotten,new.superseded,new.suppressed,1)
        ON CONFLICT(space,status,category,forgotten,superseded,suppressed) DO UPDATE SET records=records+1;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_count_removed AFTER DELETE ON memory_read BEGIN
        UPDATE memory_count_buckets SET records=records-1 WHERE space=old.space AND status=old.status AND category=old.category
          AND forgotten=old.forgotten AND superseded=old.superseded AND suppressed=old.suppressed;
        DELETE FROM memory_count_buckets WHERE records=0;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_count_changed AFTER UPDATE ON memory_read
        WHEN (old.space,old.status,old.category,old.forgotten,old.superseded,old.suppressed)<>
          (new.space,new.status,new.category,new.forgotten,new.superseded,new.suppressed) BEGIN
        UPDATE memory_count_buckets SET records=records-1 WHERE space=old.space AND status=old.status AND category=old.category
          AND forgotten=old.forgotten AND superseded=old.superseded AND suppressed=old.suppressed;
        DELETE FROM memory_count_buckets WHERE records=0;
        INSERT INTO memory_count_buckets VALUES(new.space,new.status,new.category,new.forgotten,new.superseded,new.suppressed,1)
        ON CONFLICT(space,status,category,forgotten,superseded,suppressed) DO UPDATE SET records=records+1;
      END;
      CREATE TABLE IF NOT EXISTS memory_evidence_index (
        memoryId TEXT NOT NULL REFERENCES memory_read(id) ON DELETE CASCADE,position INTEGER NOT NULL,
        hash TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,assetId TEXT,
        PRIMARY KEY(memoryId,position));
      CREATE INDEX IF NOT EXISTS memory_evidence_hash ON memory_evidence_index(hash,start,end,memoryId);
      CREATE INDEX IF NOT EXISTS memory_evidence_asset ON memory_evidence_index(assetId,memoryId);
      CREATE TABLE IF NOT EXISTS memory_person_links (
        memoryId TEXT NOT NULL REFERENCES memory_read(id) ON DELETE CASCADE,personId TEXT NOT NULL,
        PRIMARY KEY(memoryId,personId));
      CREATE INDEX IF NOT EXISTS memory_person_link_person ON memory_person_links(personId,memoryId);
      CREATE TABLE IF NOT EXISTS memory_mentions (
        memoryId TEXT NOT NULL REFERENCES memory_read(id) ON DELETE CASCADE,name TEXT NOT NULL,display TEXT NOT NULL,
        PRIMARY KEY(memoryId,name));
      CREATE INDEX IF NOT EXISTS memory_mention_name ON memory_mentions(name,memoryId);
      CREATE TABLE IF NOT EXISTS memory_person_aliases (
        personId TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,name TEXT NOT NULL,
        PRIMARY KEY(personId,name));
      CREATE INDEX IF NOT EXISTS memory_alias_name ON memory_person_aliases(name,personId);
      CREATE TABLE IF NOT EXISTS memory_conflict_links (
        memoryId TEXT NOT NULL REFERENCES memory_read(id) ON DELETE CASCADE,currentId TEXT NOT NULL,
        PRIMARY KEY(memoryId,currentId));
      CREATE INDEX IF NOT EXISTS memory_conflict_current ON memory_conflict_links(currentId,memoryId);
      CREATE TABLE IF NOT EXISTS memory_person_catalog (
        space TEXT NOT NULL,key TEXT NOT NULL,personId TEXT,name TEXT NOT NULL,
        memoryCount INTEGER NOT NULL,confirmedCount INTEGER NOT NULL,PRIMARY KEY(space,key));
      CREATE INDEX IF NOT EXISTS memory_person_catalog_count ON memory_person_catalog(space,memoryCount DESC,key);
      CREATE TABLE IF NOT EXISTS memory_person_members (
        memoryId TEXT NOT NULL REFERENCES memory_read(id) ON DELETE CASCADE,key TEXT NOT NULL,space TEXT NOT NULL,
        personId TEXT,name TEXT NOT NULL,confirmed INTEGER NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(memoryId,key));
      CREATE INDEX IF NOT EXISTS memory_person_members_page ON memory_person_members(space,key,updatedAt DESC,memoryId DESC);
      CREATE TRIGGER IF NOT EXISTS memory_person_member_added AFTER INSERT ON memory_person_members BEGIN
        INSERT INTO memory_person_catalog VALUES(new.space,new.key,new.personId,new.name,1,new.confirmed)
        ON CONFLICT(space,key) DO UPDATE SET memoryCount=memoryCount+1,confirmedCount=confirmedCount+new.confirmed;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_person_member_removed AFTER DELETE ON memory_person_members BEGIN
        UPDATE memory_person_catalog SET memoryCount=memoryCount-1,confirmedCount=confirmedCount-old.confirmed WHERE space=old.space AND key=old.key;
        DELETE FROM memory_person_catalog WHERE space=old.space AND key=old.key AND memoryCount=0 AND personId IS NULL;
      END;`);
    if (!db.prepare("PRAGMA table_info(memory_evidence_index)").all().some((column) => column.name === "timestamp")) {
      db.exec("ALTER TABLE memory_evidence_index ADD COLUMN timestamp REAL");
      for (const row of db.prepare("SELECT id,data FROM workspace_records WHERE kind='memory'").iterate()) {
        for (const [position, source] of evidenceOf(JSON.parse(row.data as string) as MemoryEntry).entries())
          if (source.type === "asset" && source.video) db.prepare("UPDATE memory_evidence_index SET timestamp=? WHERE memoryId=? AND position=?")
            .run(source.video.timestamp, row.id as string, position);
      }
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=4").get()) {
      this.rebuild();
      db.exec("INSERT INTO migrations VALUES(4)");
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=5").get()) {
      db.exec("SAVEPOINT people_projection");
      try {
        db.exec("DELETE FROM memory_person_members; DELETE FROM memory_person_catalog;");
        for (const row of db.prepare("SELECT data FROM memory_people").iterate()) this.person(JSON.parse(row.data as string));
        this.refreshPeople();
        db.exec("INSERT INTO migrations VALUES(5); RELEASE people_projection");
      } catch (error) { db.exec("ROLLBACK TO people_projection; RELEASE people_projection"); throw error; }
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=6").get()) {
      db.exec(`SAVEPOINT count_projection;
        DELETE FROM memory_count_buckets;
        INSERT INTO memory_count_buckets SELECT space,status,category,forgotten,superseded,suppressed,count(*) FROM memory_read
          GROUP BY space,status,category,forgotten,superseded,suppressed;
        INSERT INTO migrations VALUES(6); RELEASE count_projection;`);
    }
  }

  index(memory: MemoryEntry) {
    this.statement(`INSERT INTO memory_read VALUES (${Array(19).fill("?").join(",")})
      ON CONFLICT(id) DO UPDATE SET space=excluded.space,status=excluded.status,category=excluded.category,version=excluded.version,
      updatedAt=excluded.updatedAt,sortTime=excluded.sortTime,occurredAt=excluded.occurredAt,validFrom=excluded.validFrom,
      validTo=excluded.validTo,validityKey=excluded.validityKey,forgotten=excluded.forgotten,superseded=excluded.superseded,
      contentKey=excluded.contentKey,attributeKey=excluded.attributeKey,attributeValue=excluded.attributeValue,
      attributeFactKey=excluded.attributeFactKey,conversationId=excluded.conversationId`).run(
        memory.id, memory.space || "personal", memory.status, memory.category || "fact", memory.version,
        memory.updatedAt, memory.validity?.from || memory.occurredAt || memory.createdAt, memory.occurredAt,
        memory.validity?.from ?? null, memory.validity?.to ?? null, JSON.stringify(memory.validity) ?? "",
        Number(!!memory.forgottenAt), Number(!!memory.supersededBy), 0, contentHash(normalizeFact(memory.content)),
        memory.attribute?.key ?? null, memory.attribute ? nameKey(memory.attribute.value) : null,
        memory.attribute ? contentHash(normalizeFact(memory.attribute.value)) : null, memory.conversationId,
      );
    for (const table of ["memory_evidence_index", "memory_person_links", "memory_mentions", "memory_conflict_links"])
      this.statement(`DELETE FROM ${table} WHERE memoryId=?`).run(memory.id);
    for (const [position, source] of evidenceOf(memory).entries())
      this.statement("INSERT INTO memory_evidence_index(memoryId,position,hash,start,end,assetId,timestamp) VALUES(?,?,?,?,?,?,?)")
        .run(memory.id, position, source.sha256, source.start, source.end, source.type === "asset" ? source.assetId : null, source.type === "asset" ? source.video?.timestamp ?? null : null);
    for (const id of new Set(memory.personIds || [])) this.statement("INSERT INTO memory_person_links VALUES(?,?)").run(memory.id, id);
    for (const name of memory.people || []) this.statement("INSERT OR IGNORE INTO memory_mentions VALUES(?,?,?)").run(memory.id, nameKey(name), name);
    for (const id of new Set(memory.conflictsWith || [])) this.statement("INSERT INTO memory_conflict_links VALUES(?,?)").run(memory.id, id);
    this.statement(`UPDATE memory_read SET suppressed=${this.suppressionSql()} WHERE id=?`).run(memory.id);
    this.refreshPeople(memory.id);
  }

  person(person: MemoryPerson) {
    this.statement("DELETE FROM memory_person_aliases WHERE personId=?").run(person.id!);
    for (const name of new Set([person.name, ...(person.aliases || [])].map(nameKey)))
      this.statement("INSERT INTO memory_person_aliases VALUES(?,?)").run(person.id!, name);
    this.statement(`INSERT INTO memory_person_catalog VALUES('personal',?,?,?,0,0)
      ON CONFLICT(space,key) DO UPDATE SET name=excluded.name`).run("id:" + person.id!, person.id!, person.name);
  }

  refreshPeople(memoryId?: string) {
    this.statement("DELETE FROM memory_person_members" + (memoryId ? " WHERE memoryId=?" : "")).run(...(memoryId ? [memoryId] : []));
    const valid = "m.forgotten=0 AND m.superseded=0 AND m.suppressed=0 AND m.status<>'rejected'" + (memoryId ? " AND m.id=?" : "");
    this.statement(`INSERT INTO memory_person_members
      SELECT m.id,'id:'||p.id,m.space,p.id,json_extract(p.data,'$.name'),m.status='confirmed',m.updatedAt
      FROM memory_read m JOIN memory_person_links l ON l.memoryId=m.id JOIN memory_people p ON p.id=l.personId
      WHERE m.space='personal' AND ${valid}`).run(...(memoryId ? [memoryId] : []));
    this.statement(`INSERT INTO memory_person_members
      SELECT m.id,'name:'||n.name,m.space,NULL,n.display,m.status='confirmed',m.updatedAt FROM memory_read m JOIN memory_mentions n ON n.memoryId=m.id
      WHERE ${valid} AND NOT EXISTS(SELECT 1 FROM memory_person_links l JOIN memory_person_aliases a ON a.personId=l.personId
        WHERE l.memoryId=m.id AND a.name=n.name AND m.space='personal')`).run(...(memoryId ? [memoryId] : []));
  }

  private suppressionSql() {
    return `EXISTS(SELECT 1 FROM memory_evidence_index e JOIN memory_suppressions s
      ON s.hash=e.hash AND s.start<e.end AND s.end>e.start WHERE e.memoryId=memory_read.id)`;
  }
  refreshSuppression(hashes: string[]) {
    for (const hash of new Set(hashes)) {
      const changed = this.statement(`UPDATE memory_read SET suppressed=${this.suppressionSql()}
        WHERE id IN (SELECT memoryId FROM memory_evidence_index WHERE hash=?) AND suppressed<>${this.suppressionSql()} RETURNING id`).all(hash);
      for (const row of changed) this.refreshPeople(row.id as string);
    }
  }
  rebuild() {
    this.db.exec("SAVEPOINT memory_projection");
    try {
      this.db.exec("DELETE FROM memory_read; DELETE FROM memory_person_aliases; DELETE FROM memory_fts;");
      for (const row of this.db.prepare("SELECT data FROM memory_people").iterate()) this.person(JSON.parse(row.data as string));
      for (const row of this.db.prepare("SELECT data FROM workspace_records WHERE kind='memory'").iterate()) {
        const memory = JSON.parse(row.data as string) as MemoryEntry;
        this.index(memory);
        indexMemory(this.db, memory);
      }
      this.db.exec("RELEASE memory_projection");
    } catch (error) {
      this.db.exec("ROLLBACK TO memory_projection; RELEASE memory_projection");
      throw error;
    }
  }
}
