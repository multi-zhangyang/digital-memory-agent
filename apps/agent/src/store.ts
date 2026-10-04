import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, Conversation, MemorySpace } from "@memory/contracts";
import { HarnessStore } from "./harness-store.js";
import { MemoryRecords } from "./memory/records.js";
import { MemoryCommands } from "./memory/commands.js";
import { WorkspaceStore } from "./workspace-store.js";
import * as sqliteVec from "sqlite-vec";
import { EventOutbox } from "./storage/event-outbox.js";

type ConversationRow = Omit<Conversation, "running">;

export class Store {
  readonly db: DatabaseSync;
  readonly assetsDir: string;
  readonly sessionsDir: string;
  readonly workspaceDir: string;
  readonly work: WorkspaceStore;
  readonly memories: MemoryRecords;
  readonly memoryCommands: MemoryCommands;
  readonly harness: HarnessStore;
  readonly events: EventOutbox;

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
    this.db = new DatabaseSync(join(dataDir, "memory.sqlite"), { allowExtension: true });
    sqliteVec.load(this.db);
    this.db.enableLoadExtension(false);
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
    if (!this.db.prepare("SELECT version FROM migrations WHERE version=3").get() &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_records'").get()) {
      const backup = join(dataDir, "before-continuous-memory.sqlite");
      if (!existsSync(backup)) this.db.prepare("VACUUM INTO ?").run(backup);
    }
    if (!this.db.prepare("SELECT version FROM migrations WHERE version=4").get() &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_records'").get()) {
      const backup = join(dataDir, "before-memory-indexes.sqlite");
      if (!existsSync(backup)) this.db.prepare("VACUUM INTO ?").run(backup);
    }
    if (!this.db.prepare("SELECT version FROM migrations WHERE version=7").get() &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_records'").get()) {
      const backup = join(dataDir, "before-memory-graph.sqlite");
      if (!existsSync(backup)) this.db.prepare("VACUUM INTO ?").run(backup);
    }
    this.events = new EventOutbox(this.db);
    this.memories = new MemoryRecords(this.db, this.events);
    this.work = new WorkspaceStore(this.db, this.memories);
    this.harness = new HarnessStore(this.dataDir, this.db);
    this.memoryCommands = new MemoryCommands(this);
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

  addAsset(asset: Asset, options?: { processing: "requested" | "automatic" }) {
    this.memories.transaction(() => {
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
      this.events.publish("asset.added", asset.id, asset.sha256, { processing: options?.processing || "automatic" });
    });
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
      " WHERE memorySpace='personal' AND NOT EXISTS (SELECT 1 FROM memory_suppressions WHERE hash=assets.sha256) AND instr(lower(name), lower(?)) > 0 AND (? IS NULL OR kind = ?)";
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

  recordMemoryActivity(runId: string, patch: Partial<import("@memory/contracts").Run>, type: string) { this.work.patchRun(runId, patch, type); }
  recordSource(runId: string, source: import("@memory/contracts").SourceRef) { this.work.source(runId, source); }

  close() {
    this.db.close();
  }
}
