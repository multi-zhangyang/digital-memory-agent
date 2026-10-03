import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  AssetCollection,
  MemoryEntry,
  MemorySearch,
  Run,
  RunEvent,
  RunInput,
  SourceRef,
} from "@memory/contracts";
import { UserFacingError } from "./runtime.js";
import { memorySpace, searchMemories } from "./memory-retrieval.js";

type RecordType = Run | Artifact | MemoryEntry | AssetCollection;
const now = () => new Date().toISOString();

export class WorkspaceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversationId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_records_kind ON workspace_records(kind, conversationId);
      CREATE TABLE IF NOT EXISTS workspace_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_events_run ON run_events(runId, seq);
      CREATE TABLE IF NOT EXISTS conversation_preferences (id TEXT PRIMARY KEY, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);`);
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
  get<T extends RecordType>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM workspace_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<T extends RecordType>(kind: string, conversationId?: string): T[] {
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
  save<T extends RecordType>(kind: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO workspace_records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, kind, value.conversationId, JSON.stringify(value));
    return value;
  }
  preferences(id: string) {
    const row = this.db
      .prepare(
        "SELECT pinned, archived FROM conversation_preferences WHERE id=?",
      )
      .get(id) as { pinned: number; archived: number } | undefined;
    return { pinned: !!row?.pinned, archived: !!row?.archived };
  }
  setPreferences(id: string, patch: { pinned?: boolean; archived?: boolean }) {
    const value = { ...this.preferences(id), ...patch };
    this.db
      .prepare(
        "INSERT INTO conversation_preferences VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pinned=excluded.pinned, archived=excluded.archived",
      )
      .run(id, Number(value.pinned), Number(value.archived));
  }
  createRun(conversationId: string, input: RunInput) {
    const run: Run = {
      ...input,
      id: randomUUID(),
      conversationId,
      status: "queued",
      assetIds: [...new Set(input.assetIds || [])],
      scope: input.scope || "library",
      useMemory: input.useMemory !== false,
      parts: [],
      sources: [],
      memoryIds: [],
      plan: [],
      cursor: 0,
      createdAt: now(),
    };
    return this.save("run", run);
  }
  activeRun(conversationId: string) {
    return this.list<Run>("run", conversationId).find(
      (run) => run.status === "running" || run.status === "waiting",
    );
  }
  event(runId: string, type: string, data: unknown): RunEvent {
    const createdAt = now();
    const result = this.db
      .prepare(
        "INSERT INTO run_events(runId,type,data,createdAt) VALUES (?,?,?,?)",
      )
      .run(runId, type, JSON.stringify(data), createdAt);
    return {
      seq: Number(result.lastInsertRowid),
      runId,
      type,
      data,
      createdAt,
    };
  }
  events(runId: string, after = 0): RunEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM run_events WHERE runId=? AND seq>? ORDER BY seq LIMIT 1000",
        )
        .all(runId, after) as {
        seq: number;
        runId: string;
        type: string;
        data: string;
        createdAt: string;
      }[]
    ).map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  patchRun(
    id: string,
    patch: Partial<Run>,
    type = "update",
    eventData?: unknown,
  ) {
    const current = this.get<Run>("run", id);
    if (!current) throw new UserFacingError(404, "NOT_FOUND", "任务不存在");
    return this.transaction(() => {
      const event = this.event(id, type, eventData ?? patch);
      return this.save("run", { ...current, ...patch, cursor: event.seq });
    });
  }
  source(runId: string, source: SourceRef) {
    const run = this.get<Run>("run", runId)!;
    if (
      !run.sources.some(
        (ref) =>
          ref.assetId === source.assetId &&
          ref.start === source.start &&
          ref.end === source.end,
      )
    )
      this.patchRun(runId, { sources: [...run.sources, source] }, "source");
  }
  resolveSources(runId: string, assetIds: string[]) {
    const run = this.get<Run>("run", runId)!;
    const refs = run.sources.filter((source) =>
      assetIds.includes(source.assetId),
    );
    if (assetIds.some((id) => !refs.some((ref) => ref.assetId === id)))
      throw new Error("只能引用本次实际读取过的资料，请先读取原文。");
    return refs;
  }
  private version<T extends Artifact | MemoryEntry>(
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
      this.save(kind, value);
      this.db
        .prepare("INSERT INTO workspace_versions VALUES (?, ?, ?)")
        .run(value.id, value.version, JSON.stringify(value));
      return value;
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
  writeArtifact(
    input: Pick<
      Artifact,
      "conversationId" | "runId" | "title" | "content" | "sources" | "author"
    > & { id?: string; version?: number },
  ) {
    const previous = input.id
      ? this.get<Artifact>("artifact", input.id)
      : undefined;
    if (
      input.id &&
      (!previous || previous.conversationId !== input.conversationId)
    )
      throw new UserFacingError(404, "NOT_FOUND", "结果不存在");
    return this.version(
      "artifact",
      {
        ...input,
        id: previous?.id || randomUUID(),
        version: (previous?.version || 0) + 1,
        createdAt: previous?.createdAt || now(),
        updatedAt: now(),
      },
      input.version,
    );
  }
  createMemory(
    input: Omit<MemoryEntry, "id" | "version" | "createdAt" | "updatedAt">,
  ) {
    if (input.status === "confirmed" && this.memoryConflicts(input).length)
      throw new UserFacingError(
        409,
        "MEMORY_CONFLICT",
        "与现有画像冲突，请先核对并选择替代记录",
      );
    return this.version("memory", {
      ...input,
      id: randomUUID(),
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  updateMemory(
    id: string,
    patch: Partial<
      Pick<
        MemoryEntry,
        | "title"
        | "content"
        | "status"
        | "occurredAt"
        | "reason"
        | "people"
        | "place"
        | "category"
        | "uncertainty"
      >
    > & { attribute?: MemoryEntry["attribute"] | null },
    version: number,
  ) {
    const previous = this.get<MemoryEntry>("memory", id);
    if (!previous) throw new UserFacingError(404, "NOT_FOUND", "记忆不存在");
    if (previous.version !== version)
      throw new UserFacingError(
        409,
        "VERSION_CONFLICT",
        "记忆已更新，请刷新后重试",
      );
    const next: MemoryEntry = {
      ...previous,
      ...patch,
      attribute:
        patch.attribute === null
          ? undefined
          : (patch.attribute ?? previous.attribute),
    };
    if (patch.content !== undefined && patch.content !== previous.content) {
      if (patch.attribute === undefined) next.attribute = undefined;
      if (patch.people === undefined) next.people = [];
      if (patch.place === undefined) next.place = "";
      next.reason = patch.reason || "用户纠正";
    }
    if (
      next.status === "confirmed" &&
      !next.supersededBy &&
      this.memoryConflicts(next).length
    )
      throw new UserFacingError(
        409,
        "MEMORY_CONFLICT",
        "与现有画像冲突，请先核对并选择替代记录",
      );
    return this.version(
      "memory",
      {
        ...next,
        version: previous.version + 1,
        updatedAt: now(),
      },
      version,
    );
  }
  searchMemories(
    query: string,
    limit = 8,
    filters: Omit<MemorySearch, "query" | "limit"> = {},
  ): MemoryEntry[] {
    return searchMemories(this.db, { ...filters, query, limit });
  }
  memoryConflicts(
    entry: Pick<MemoryEntry, "attribute" | "space"> & { id?: string },
    candidates?: MemoryEntry[],
  ): MemoryEntry[] {
    if (!entry.attribute) return [];
    const value = entry.attribute.value.trim().toLocaleLowerCase();
    return (candidates || this.list<MemoryEntry>("memory")).filter(
      (other) =>
        other.id !== entry.id &&
        memorySpace(other) === (entry.space || "personal") &&
        other.status === "confirmed" &&
        !other.supersededBy &&
        other.attribute?.key === entry.attribute!.key &&
        other.attribute.value.trim().toLocaleLowerCase() !== value,
    );
  }
  resolveMemory(
    id: string,
    version: number,
    replace: { id: string; version: number }[],
  ) {
    return this.transaction(() => {
      const current = this.get<MemoryEntry>("memory", id);
      if (!current || current.version !== version)
        throw new UserFacingError(
          409,
          "VERSION_CONFLICT",
          "记忆已更新，请刷新后重试",
        );
      const conflicts = this.memoryConflicts(current);
      if (
        !conflicts.length ||
        replace.length !== conflicts.length ||
        new Set(replace.map((ref) => ref.id)).size !== replace.length ||
        conflicts.some(
          (other) =>
            !replace.some(
              (ref) => ref.id === other.id && ref.version === other.version,
            ),
        )
      )
        throw new UserFacingError(
          409,
          "VERSION_CONFLICT",
          "冲突记录已改变，请刷新后重新核对",
        );
      for (const previous of conflicts)
        this.version(
          "memory",
          {
            ...previous,
            supersededBy: id,
            reason: "用户选择以新记录替代",
            version: previous.version + 1,
            updatedAt: now(),
          },
          previous.version,
        );
      return this.version(
        "memory",
        {
          ...current,
          status: "confirmed",
          supersededBy: undefined,
          replaces: [
            ...new Set([
              ...(current.replaces || []),
              ...conflicts.map((other) => other.id),
            ]),
          ],
          reason: "用户核对并替代旧记录",
          version: current.version + 1,
          updatedAt: now(),
        },
        version,
      );
    });
  }
  deleteConversation(id: string) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "DELETE FROM run_events WHERE runId IN (SELECT id FROM workspace_records WHERE kind='run' AND conversationId=?)",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM workspace_versions WHERE id IN (SELECT id FROM workspace_records WHERE kind='artifact' AND conversationId=?)",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM workspace_records WHERE conversationId=? AND kind IN ('run','artifact')",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM conversation_preferences WHERE id=?")
        .run(id);
      this.db.prepare("DELETE FROM conversations WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
