import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, Conversation, MemorySpace } from "@memory/contracts";
import { HarnessStore } from "./harness-store.js";
import { WorkspaceStore } from "./workspace-store.js";

type ConversationRow = Omit<Conversation, "running">;

export class Store {
  readonly db: DatabaseSync;
  readonly assetsDir: string;
  readonly sessionsDir: string;
  readonly workspaceDir: string;
  readonly work: WorkspaceStore;
  readonly harness: HarnessStore;

  constructor(readonly dataDir: string) {
    this.assetsDir = join(dataDir, "assets");
    this.sessionsDir = join(dataDir, "sessions");
    this.workspaceDir = join(dataDir, "workspace");
    for (const dir of [
      dataDir,
      this.assetsDir,
      this.sessionsDir,
      this.workspaceDir,
    ])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "memory.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);",
    );
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version = 1").get()
    ) {
      this.db.exec(
        "BEGIN; CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, modelId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL); CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, mimeType TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt TEXT NOT NULL); CREATE INDEX assets_created ON assets(createdAt); INSERT INTO migrations VALUES (1); COMMIT;",
      );
    }
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=2").get()
    ) {
      this.db.exec(
        "BEGIN; ALTER TABLE assets ADD COLUMN memorySpace TEXT NOT NULL DEFAULT 'personal'; CREATE INDEX assets_space_hash ON assets(memorySpace, sha256); INSERT INTO migrations VALUES (2); COMMIT;",
      );
    }
    this.work = new WorkspaceStore(this.db);
    this.harness = new HarnessStore(this.dataDir, this.db);
  }

  createConversation(): ConversationRow {
    const now = new Date().toISOString();
    const conversation: ConversationRow = {
      id: randomUUID(),
      title: "新的对话",
      modelId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)")
      .run(conversation.id, conversation.title, conversation.modelId, now, now);
    return conversation;
  }

  conversations(): ConversationRow[] {
    return this.db
      .prepare("SELECT * FROM conversations ORDER BY updatedAt DESC")
      .all() as unknown as ConversationRow[];
  }

  conversation(id: string): ConversationRow | undefined {
    return this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
  }

  touchConversation(id: string, modelId: string, title?: string) {
    this.db
      .prepare(
        "UPDATE conversations SET modelId = ?, title = COALESCE(?, title), updatedAt = ? WHERE id = ?",
      )
      .run(modelId, title || null, new Date().toISOString(), id);
  }

  addAsset(asset: Asset) {
    this.db
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        asset.id,
        asset.name,
        asset.mimeType,
        asset.kind,
        asset.size,
        asset.sha256,
        asset.createdAt,
        asset.memorySpace || "personal",
      );
  }

  assets(space: MemorySpace = "personal"): Asset[] {
    return this.db
      .prepare(
        "SELECT * FROM assets WHERE memorySpace=? ORDER BY createdAt DESC",
      )
      .all(space) as unknown as Asset[];
  }

  searchAssets(
    query: string,
    kind: string | undefined,
    limit: number,
    offset: number,
  ) {
    const where =
      " WHERE memorySpace='personal' AND instr(lower(name), lower(?)) > 0 AND (? IS NULL OR kind = ?)";
    const args = [query, kind ?? null, kind ?? null];
    const total = (
      this.db
        .prepare("SELECT count(*) AS count FROM assets" + where)
        .get(...args) as { count: number }
    ).count;
    const assets = this.db
      .prepare(
        "SELECT id, name, kind, mimeType, size, createdAt FROM assets" +
          where +
          " ORDER BY createdAt DESC LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset);
    return {
      assets,
      total,
      nextOffset:
        offset + assets.length < total ? offset + assets.length : null,
    };
  }

  asset(id: string): Asset | undefined {
    return this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as
      | Asset
      | undefined;
  }

  close() {
    this.db.close();
  }
}
