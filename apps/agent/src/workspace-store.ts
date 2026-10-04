import { RecordStore, type StoredRecord } from "./storage/record-store.js";
import { MemoryRecords } from "./memory/records.js";
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
  MemoryEvidence,
} from "@memory/contracts";
import { UserFacingError } from "./harness/runtime.js";
import { MemoryQueryService } from "./memory/query-service.js";
import { MemoryLedger, combineEvidence, evidenceOf } from "./memory/ledger.js";
import { sourceFromRead } from "./memory/source-reads.js";

type RecordType = Run | Artifact | MemoryEntry | AssetCollection;
const now = () => new Date().toISOString();

export class WorkspaceStore extends RecordStore {
  readonly memory: MemoryLedger;
  readonly queries: MemoryQueryService;
  constructor(db: DatabaseSync, readonly memories = new MemoryRecords(db)) {
    super(db);
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversationId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_records_kind ON workspace_records(kind, conversationId);
      CREATE TABLE IF NOT EXISTS workspace_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_events_run ON run_events(runId, seq);
      CREATE TABLE IF NOT EXISTS run_record_refs (runId TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,recordId TEXT NOT NULL,version INTEGER NOT NULL,
        PRIMARY KEY(runId,kind,ordinal),UNIQUE(runId,kind,recordId,version));
      CREATE TABLE IF NOT EXISTS conversation_preferences (id TEXT PRIMARY KEY, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);`);
    this.memory = memories.ledger;
    this.queries = memories.queries;
  }
  recordRef(runId: string, kind: "memory" | "sample" | "source", id: string, version: number) {
    this.db.prepare(`INSERT OR IGNORE INTO run_record_refs SELECT ?,?,coalesce(max(ordinal),0)+1,?,?
      FROM run_record_refs WHERE runId=? AND kind=?`).run(runId, kind, id, version, runId, kind);
    const row = this.db.prepare("SELECT ordinal FROM run_record_refs WHERE runId=? AND kind=? AND recordId=? AND version=?")
      .get(runId, kind, id, version) as { ordinal: number };
    return ({ memory: "m", sample: "s", source: "e" }[kind]) + row.ordinal;
  }
  resolveRecordRef(runId: string, kind: "memory" | "sample", input: { id: string; version: number } | { ref: string; version?: number }) {
    if (!("ref" in input)) return { id: input.id, version: input.version };
    const prefix = kind === "memory" ? "m" : "s";
    const ordinal = input.ref.startsWith(prefix) && Number(input.ref.slice(1));
    const row = ordinal && Number.isSafeInteger(ordinal) && this.db.prepare("SELECT recordId AS id,version FROM run_record_refs WHERE runId=? AND kind=? AND ordinal=?")
      .get(runId, kind, ordinal) as { id: string; version: number } | undefined;
    if (!row) throw new UserFacingError(409, "REF_NOT_FOUND", "引用不属于本次任务，请重新检查记录并使用返回的 ref");
    if (input.version !== undefined && input.version !== row.version) throw new UserFacingError(409, "VERSION_CONFLICT", "引用版本不一致，请重新检查记录");
    return row;
  }
  override save<T extends StoredRecord>(kind: string, value: T): T {
    return kind === "memory" ? this.memories.save(kind, value) : super.save(kind, value);
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
    if (!input.text.trim() && !input.assetIds?.length)
      throw new UserFacingError(400, "EMPTY", "请输入任务内容或添加资料");
    const run: Run = {
      ...input,
      ...(!input.text.trim() ? { goal: "整理本次提交的图片和文字资料，检查处理覆盖与失败，保存带来源的整理结果；观察保持待核对。" } : {}),
      id: randomUUID(),
      conversationId,
      status: "queued",
      assetIds: [...new Set(input.assetIds || [])],
      scope: input.scope || "library",
      useMemory: input.useMemory !== false,
      captureMemory: input.captureMemory ?? this.memory.settings().capture === "graded",
      parts: [],
      sources: [],
      memoryIds: [],
      memoryEpoch: this.memory.epoch,
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
          ref.end === source.end &&
          ref.video?.timestamp === source.video?.timestamp &&
          ref.view?.sha256 === source.view?.sha256,
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
  resolveObservationSources(runId: string, assetIds: string[], sourceRefs?: string[] | null) {
    const run = this.get<Run>("run", runId)!;
    const reads = run.parts.flatMap((part) => {
      const source = sourceFromRead(part);
      return source && part.type === "tool" ? [{ toolCallId: part.toolCallId, source }] : [];
    });
    const selected = sourceRefs?.length ? sourceRefs.map((ref) => {
      const row = /^e[1-9][0-9]*$/.test(ref) && this.db.prepare("SELECT recordId FROM run_record_refs WHERE runId=? AND kind='source' AND ordinal=?")
        .get(runId, Number(ref.slice(1))) as { recordId: string } | undefined;
      const read = row && reads.find((value) => value.toolCallId === row.recordId);
      if (!read) throw new UserFacingError(409, "SOURCE_READ_REQUIRED", "请使用本轮原件读取返回的 sourceRef；检索结果不能作为画面读取依据");
      return read.source;
    }) : reads.filter(({ source }) => assetIds.includes(source.assetId)).map(({ source }) => source);
    if (assetIds.some((id) => !selected.some((source) => source.assetId === id)) || selected.some((source) => !assetIds.includes(source.assetId)))
      throw new UserFacingError(409, "SOURCE_READ_REQUIRED", "只能引用本次实际读取的资料；sourceAssetIds 须与选择的 sourceRefs 对应");
    if (!sourceRefs?.length && selected.some((source) => source.video) && selected.length > 1)
      throw new UserFacingError(409, "FRAME_SELECTION_REQUIRED", "视频已读取多个画面，请用 sourceRefs 选择支持这条记忆的画面，不要引用整轮画面");
    return selected;
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
      throw new UserFacingError(404, "NOT_FOUND", "结果不存在。新建结果请将 artifactId 和 version 设为 null 或省略；编辑前请读取现有结果的 ID 与版本。");
    return this.version(
      "artifact",
      {
        ...input,
        id: previous?.id || randomUUID(),
        version: (previous?.version || 0) + 1,
        memoryEpoch: this.memory.epoch,
        createdAt: previous?.createdAt || now(),
        updatedAt: now(),
      },
      input.version,
    );
  }
  recordRecall(runId: string, query: MemorySearch, entries: MemoryEntry[], durationMs: number) {
    const run = this.get<Run>("run", runId)!;
    const trace = { query, revision: this.memory.revision, at: now(), durationMs: Math.round(durationMs * 100) / 100,
      matches: entries.map((entry) => ({ id: entry.id, version: entry.version, evidence: evidenceOf(entry) })) };
    this.patchRun(runId, { memoryRevision: trace.revision, memoryEpoch: this.memory.epoch,
      memoryIds: [...new Set([...run.memoryIds, ...entries.map((entry) => entry.id)])],
      memoryTraces: [...(run.memoryTraces || []), trace].slice(-8) }, "recall");
    return trace;
  }
  createMemory(...args: Parameters<MemoryRecords["createMemory"]>) { return this.memories.createMemory(...args); }
  updateMemory(...args: Parameters<MemoryRecords["updateMemory"]>) { return this.memories.updateMemory(...args); }
  searchMemories(...args: Parameters<MemoryRecords["searchMemories"]>) { return this.memories.searchMemories(...args); }
  addMemoryEvidence(...args: Parameters<MemoryRecords["addMemoryEvidence"]>) { return this.memories.addMemoryEvidence(...args); }
  duplicateMemory(...args: Parameters<MemoryRecords["duplicateMemory"]>) { return this.memories.duplicateMemory(...args); }
  forgetMemory(...args: Parameters<MemoryRecords["forgetMemory"]>) { return this.memories.forgetMemory(...args); }
  memoryConflicts(...args: Parameters<MemoryRecords["memoryConflicts"]>) { return this.memories.memoryConflicts(...args); }
  resolveMemory(...args: Parameters<MemoryRecords["resolveMemory"]>) { return this.memories.resolveMemory(...args); }
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
