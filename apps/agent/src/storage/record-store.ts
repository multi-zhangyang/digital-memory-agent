import type { DatabaseSync } from "node:sqlite";
import { UserFacingError } from "../errors.js";

export interface StoredRecord { id: string; conversationId: string }
/** Shared SQLite record format; no session or memory lifecycle. */
export class RecordStore {
  constructor(protected readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversationId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_records_kind ON workspace_records(kind, conversationId);
      CREATE TABLE IF NOT EXISTS workspace_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, version));`);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT workspace_write");
    try {
      const result = operation();
      this.db.exec("RELEASE workspace_write");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO workspace_write; RELEASE workspace_write");
      throw error;
    }
  }
  get<T extends StoredRecord>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM workspace_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<T extends StoredRecord>(kind: string, conversationId?: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM workspace_records WHERE kind=? AND (? IS NULL OR conversationId=?) ORDER BY rowid",
        )
        .all(kind, conversationId ?? null, conversationId ?? null) as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  save<T extends StoredRecord>(kind: string, value: T): T {
    this.db.prepare("INSERT INTO workspace_records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(value.id, kind, value.conversationId, JSON.stringify(value));
    return value;
  }
  protected version<T extends StoredRecord & { version: number }>(
    kind: string,
    value: T,
    expected?: number,
  ) {
    const previous = this.get<T>(kind, value.id);
    if (previous && expected !== previous.version)
      throw new UserFacingError(
        409,
        "VERSION_CONFLICT",
        "内容已更新，请重新打开后再保存",
      );
    return this.transaction(() => {
      const saved = this.save(kind, value);
      this.db
        .prepare("INSERT INTO workspace_versions VALUES (?, ?, ?)")
        .run(saved.id, saved.version, JSON.stringify(saved));
      return saved;
    });
  }
  versions<T>(id: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM workspace_versions WHERE id=? ORDER BY version DESC",
        )
        .all(id) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
}
