import { createHash, randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryEvidence, MemorySpace } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { MemoryRecords } from "./records.js";
import { evidenceOf } from "./ledger.js";
import { validateValidity } from "./time.js";
import { UserFacingError } from "../errors.js";
import { requireObservationRead, type SourceInspection } from "./observation-review.js";
import { explicitPersonalStatement } from "../memory-capture-extraction.js";

export type MemoryRef = { id: string; version: number };
export type MemoryPatch = Parameters<MemoryRecords["updateMemory"]>[1];
export interface MemoryChange {
  action: "correct" | "confirm" | "reject" | "forget" | "restore" | "resolve";
  entries: (MemoryRef & { patch?: MemoryPatch })[];
  replace?: MemoryRef[];
  resolution?: "correction" | "change";
  reason: string;
}
export interface LinkChange {
  action: "link-person" | "unlink-person" | "identify" | "merge-people" | "split-person" | "merge-events" | "split-event";
  refs: MemoryRef[];
  personId?: string;
  name?: string;
  aliases?: string[];
  observationIds?: string[];
  memoryIds?: string[];
  title?: string;
  reason: string;
}
export interface CommandContext {
  actor: "user" | "agent";
  space?: MemorySpace;
  allowedAssetIds?: readonly string[];
  instruction?: Extract<MemoryEvidence, { type: "message" }>;
  runId?: string;
  requestKey?: string;
  sourceReads?: SourceInspection[];
  committed?: (receipt: CommandReceipt) => void;
}
export interface CommandReceipt {
  id: string;
  action: string;
  actor: "user" | "agent";
  runId?: string;
  instruction?: Extract<MemoryEvidence, { type: "message" }>;
  sourceReads?: SourceInspection[];
  before: MemoryRef[];
  after: MemoryRef[];
  epoch: number;
  affectedDatasets: string[];
  createdAt: string;
  result: unknown;
}

/** The same versioned commands serve direct UI actions and delegated Agent actions. */
export class MemoryCommands {
  constructor(private readonly data: MemoryData) {
    data.db.exec(`CREATE TABLE IF NOT EXISTS memory_commands (
      id TEXT PRIMARY KEY,requestKey TEXT NOT NULL UNIQUE,runId TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_commands_run ON memory_commands(runId);
      CREATE TABLE IF NOT EXISTS memory_command_versions (
        commandId TEXT NOT NULL REFERENCES memory_commands(id),recordId TEXT NOT NULL,version INTEGER NOT NULL,
        PRIMARY KEY(commandId,recordId,version));
      CREATE INDEX IF NOT EXISTS memory_commands_record ON memory_command_versions(recordId,version);
      CREATE TABLE IF NOT EXISTS memory_command_messages(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL,runId TEXT NOT NULL,text TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_command_versions SELECT c.id,json_extract(v.value,'$.id'),json_extract(v.value,'$.version')
        FROM memory_commands c,json_each(c.data,'$.after') v;`);
  }
  recordForm(id: string, text: string): Extract<MemoryEvidence, { type: "message" }> {
    const messageId = "form:" + id;
    this.data.db.prepare("INSERT INTO memory_command_messages VALUES(?,?,?,?)").run(messageId, "activity-form", "activity-form", text);
    return { type: "message", messageId, conversationId: "activity-form", runId: "activity-form",
      sha256: createHash("sha256").update(text).digest("hex"), start: 0, end: Buffer.byteLength(text), quote: text };
  }
  memory(id: string, context: CommandContext, version?: number) {
    const entry = this.data.memories.get<MemoryEntry>("memory", id);
    if (!entry || (context.space && (entry.space || "personal") !== context.space))
      throw new UserFacingError(404, "NOT_FOUND", "记忆不存在或不属于当前空间");
    if (version !== undefined && entry.version !== version) throw new UserFacingError(409, "VERSION_CONFLICT", "记录已更新，请重新读取当前版本");
    if (context.allowedAssetIds) {
      const sources = evidenceOf(entry);
      if (!sources.length || sources.some((source) => source.type !== "asset" || !context.allowedAssetIds!.includes(source.assetId)))
        throw new UserFacingError(403, "SOURCE_SCOPE", "记录包含本次所选资料范围外的来源");
    }
    return entry;
  }
  private verifyPatch(patch: MemoryPatch) {
    if (patch.content !== undefined && (!patch.content.trim() || patch.content.length > 12000)) throw new UserFacingError(400, "INVALID_CONTENT", "记忆正文应为非空且不超过 12000 字符");
    if (patch.occurredAt && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.occurredAt) || Number.isNaN(Date.parse(patch.occurredAt)) || new Date(patch.occurredAt).toISOString().slice(0, 10) !== patch.occurredAt))
      throw new UserFacingError(400, "INVALID_DATE", "请使用有效的 YYYY-MM-DD 日期；未知时间留空");
    if (patch.validity && !validateValidity(patch.validity)) throw new UserFacingError(400, "INVALID_DATE", "请检查有效时间范围");
  }
  execute(action: string, input: unknown, context: CommandContext, operation: () => { before: MemoryRef[]; after: MemoryRef[]; result: unknown }): CommandReceipt {
    const requestKey = context.requestKey || randomUUID();
    const payloadHash = createHash("sha256").update(JSON.stringify([action, input, context.actor, context.instruction, context.allowedAssetIds])).digest("hex");
    const existing = this.data.db.prepare("SELECT data FROM memory_commands WHERE requestKey=?").get(requestKey) as { data: string } | undefined;
    if (existing) {
      const saved = JSON.parse(existing.data) as CommandReceipt & { payloadHash: string };
      if (saved.payloadHash !== payloadHash) throw new UserFacingError(409, "COMMAND_CONFLICT", "此请求标识已用于另一项变更");
      return saved;
    }
    return this.data.memories.transaction(() => {
      const hasDatasets = this.data.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dataset_invalidations'").get();
      const start = hasDatasets ? (this.data.db.prepare("SELECT coalesce(max(seq),0) AS seq FROM dataset_invalidations").get() as { seq: number }).seq : 0;
      const { before, after, result } = operation();
      const affectedDatasets = hasDatasets ?
        (this.data.db.prepare("SELECT DISTINCT datasetId FROM dataset_invalidations WHERE seq>?").all(start) as { datasetId: string }[]).map((row) => row.datasetId) : [];
      const receipt: CommandReceipt = { id: randomUUID(), action, actor: context.actor, runId: context.runId, instruction: context.instruction,
        ...(context.sourceReads?.length ? { sourceReads: context.sourceReads } : {}),
        before, after, result, affectedDatasets, epoch: this.data.memories.ledger.epoch, createdAt: new Date().toISOString() };
      this.data.db.prepare("INSERT INTO memory_commands VALUES (?,?,?,?)").run(receipt.id, requestKey, context.runId ?? null, JSON.stringify({ ...receipt, payloadHash }));
      for (const ref of after) this.data.db.prepare("INSERT OR IGNORE INTO memory_command_versions VALUES(?,?,?)").run(receipt.id, ref.id, ref.version);
      context.committed?.(receipt);
      return receipt;
    });
  }
  /** Compatibility entry for the direct editor, including its combined edit/status form. */
  update(ref: MemoryRef, patch: MemoryPatch, context: CommandContext) {
    this.verifyPatch(patch);
    return this.execute("update-memory", { ref, patch }, context, () => {
      const before = this.memory(ref.id, context, ref.version);
      if (context.actor === "agent") requireObservationRead(before, context.sourceReads);
      const memory = this.data.memories.updateMemory(ref.id, patch, ref.version, context.actor);
      return { before: [{ id: before.id, version: before.version }], after: [{ id: memory.id, version: memory.version }], result: { memories: [memory] } };
    });
  }
  receipts(runId: string, limit = 20): CommandReceipt[] {
    return (this.data.db.prepare("SELECT data FROM memory_commands WHERE runId=? ORDER BY rowid DESC LIMIT ?").all(runId, Math.min(50, limit)) as { data: string }[])
      .map((row) => JSON.parse(row.data) as CommandReceipt);
  }
  change(input: MemoryChange, context: CommandContext): CommandReceipt {
    if (!input.entries.length || input.entries.length > 50 || new Set(input.entries.map((ref) => ref.id)).size !== input.entries.length)
      throw new UserFacingError(400, "INVALID_REFS", "请选择 1 至 50 条不同的记录");
    if (!input.reason.trim()) throw new UserFacingError(400, "REASON_REQUIRED", "请说明变更依据");
    if (context.actor === "agent" && input.action !== "correct") throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "此操作需要用户明确指令");
    return this.execute(input.action, input, context, () => {
      const previous = input.entries.map((ref) => this.memory(ref.id, context, ref.version));
      for (const ref of input.replace || []) this.memory(ref.id, context, ref.version);
      if (!["restore", "forget"].includes(input.action) && previous.some((entry) => entry.forgottenAt || this.data.memories.ledger.suppressed(entry)))
        throw new UserFacingError(409, "SOURCE_SUPPRESSED", "记忆已停止取用，请先根据用户指令恢复");
      if (context.actor === "agent") for (const entry of previous) requireObservationRead(entry, context.sourceReads);
      const memories = input.entries.map((ref) => {
        if (input.action === "correct") {
          const patch = ref.patch || {};
          if (!Object.keys(patch).length) throw new UserFacingError(400, "EMPTY_PATCH", "请提供需要修订的字段");
          if (patch.status) throw new UserFacingError(400, "SEPARATE_CONFIRMATION", "正文修订与确认应分别执行");
          this.verifyPatch(patch);
          const entry = previous.find((entry) => entry.id === ref.id)!;
          // A direct correction of the user's own profile is fresh user evidence, including
          // when the original capture only produced a draft. Pixel observations stay drafts.
          const ownProfile = context.actor === "user" && !!context.instruction && patch.content !== undefined &&
            entry.status === "draft" && entry.kind === "statement" && (patch.category || entry.category) === "profile" &&
            !(patch.uncertainty ?? entry.uncertainty) && evidenceOf(entry).some((source) => source.type === "message" && explicitPersonalStatement(source.quote, source.quote)) &&
            explicitPersonalStatement(context.instruction.quote, context.instruction.quote);
          return this.data.memories.updateMemory(ref.id, { ...patch, ...(ownProfile ? { status: "confirmed" as const } : {}), reason: input.reason }, ref.version, context.actor);
        }
        if (input.action === "forget" || input.action === "restore") return this.data.memories.forgetMemory(ref.id, ref.version, input.action === "restore");
        if (input.action === "resolve") {
          if (input.entries.length !== 1) throw new UserFacingError(400, "INVALID_REFS", "每次解决一个冲突组");
          return this.data.memories.resolveMemory(ref.id, ref.version, input.replace || [], input.resolution);
        }
        const patch = input.action === "confirm" ? ref.patch || {} : {};
        this.verifyPatch(patch);
        return this.data.memories.updateMemory(ref.id, { ...patch, status: input.action === "confirm" ? "confirmed" : "rejected", reason: input.reason }, ref.version, "user");
      });
      const replaced = input.action === "resolve" ? (input.replace || []) : [];
      return { before: [...previous.map(({ id, version }) => ({ id, version })), ...replaced],
        after: [...memories, ...replaced.map((ref) => this.memory(ref.id, context))].map(({ id, version }) => ({ id, version })), result: { memories } };
    });
  }
  private entity(id: string, version: number, context: CommandContext) {
    const graph = this.data.memories.ledger.graph;
    const entity = graph.entity(id);
    if (entity.version !== version || (context.space && entity.space !== context.space)) throw new UserFacingError(409, "VERSION_CONFLICT", "人物候选已更新或不在当前空间");
    const sources = this.data.db.prepare(`SELECT o.assetId,o.sourceHash FROM memory_entity_links l JOIN memory_observations o ON o.id=l.observationId WHERE l.entityId=? AND l.active=1`).all(id) as { assetId: string; sourceHash: string }[];
    if (sources.some((source) => (context.allowedAssetIds && !context.allowedAssetIds.includes(source.assetId)) || this.data.memories.ledger.sourceBlocked(source.sourceHash)))
      throw new UserFacingError(403, "SOURCE_SCOPE", "人物候选包含范围外或已停用的来源");
    return entity;
  }
  private event(ref: MemoryRef, context: CommandContext) {
    const event = this.data.db.prepare("SELECT version,space FROM memory_events WHERE id=? AND mergedInto IS NULL").get(ref.id) as { version: number; space: string } | undefined;
    if (!event || event.version !== ref.version || (context.space && event.space !== context.space)) throw new UserFacingError(409, "VERSION_CONFLICT", "事件已更新或不在当前空间");
    const links = this.data.db.prepare("SELECT memoryId FROM memory_event_links WHERE eventId=? AND active=1").all(ref.id) as { memoryId: string }[];
    for (const link of links) {
      const memory = this.memory(link.memoryId, context);
      if (memory.forgottenAt || this.data.memories.ledger.suppressed(memory)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "事件包含已停用来源");
    }
  }
  person(input: { id?: string; version?: number; name: string; aliases: string[]; entries?: MemoryRef[]; unlink?: MemoryRef[] }, context: CommandContext) {
    if (context.actor !== "user" || !input.name.trim()) throw new UserFacingError(400, "PERSON_REQUIRED", "请提供用户明确的人物称呼");
    return this.execute("save-person", input, context, () => {
      const refs = [...(input.entries || []), ...(input.unlink || [])];
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length) throw new UserFacingError(400, "INVALID_REFS", "请选择不同的记忆");
      const entries = refs.map((ref) => this.memory(ref.id, context, ref.version));
      if (entries.some((entry) => entry.forgottenAt || this.data.memories.ledger.suppressed(entry))) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "关联记忆已停止取用");
      const person = this.data.memories.ledger.savePerson(input);
      const memories = entries.map((entry) => this.data.memories.updateMemory(entry.id, {
        personIds: input.entries?.some((ref) => ref.id === entry.id) ? [...new Set([...(entry.personIds || []), person.id!])] : (entry.personIds || []).filter((id) => id !== person.id),
      }, entry.version));
      return { before: [...refs, ...(input.id && input.version ? [{ id: input.id, version: input.version }] : [])],
        after: [...memories.map(({ id, version }) => ({ id, version })), { id: person.id!, version: person.version! }], result: { person } };
    });
  }
  links(input: LinkChange, context: CommandContext): CommandReceipt {
    if (context.actor !== "user") throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "身份与事件关联需要用户明确依据");
    if (!input.refs.length || input.refs.length > 50 || new Set(input.refs.map((ref) => ref.id)).size !== input.refs.length || !input.reason.trim())
      throw new UserFacingError(400, "INVALID_REFS", "请提供不同的当前记录与关联依据");
    if (["split-person", "split-event"].includes(input.action) && input.refs.length !== 1) throw new UserFacingError(400, "INVALID_REFS", "每次拆分一个组");
    if (context.instruction && [input.name, ...(input.aliases || [])].some((name) => name && !context.instruction!.quote.includes(name)))
      throw new UserFacingError(403, "IDENTITY_EVIDENCE_REQUIRED", "新增人物称呼和别名必须来自用户的明确原话");
    return this.execute(input.action, input, context, () => {
      const graph = this.data.memories.ledger.graph;
      let result: unknown;
      if (input.action === "link-person" || input.action === "unlink-person") {
        const memories = input.refs.map((ref) => this.memory(ref.id, context, ref.version));
        if (memories.some((entry) => entry.forgottenAt || this.data.memories.ledger.suppressed(entry))) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "关联记忆已停止取用");
        if (!input.personId && (input.action === "unlink-person" || !input.name?.trim())) throw new UserFacingError(400, "PERSON_REQUIRED", "请提供已知人物或明确称呼");
        const person = input.personId ? this.data.memories.ledger.person(input.personId) : this.data.memories.ledger.savePerson({ name: input.name || "", aliases: input.aliases || [] });
        result = { person, memories: memories.map((entry) => this.data.memories.updateMemory(entry.id, {
          personIds: input.action === "link-person" ? [...new Set([...(entry.personIds || []), person.id!])] : (entry.personIds || []).filter((id) => id !== person.id), reason: input.reason,
        }, entry.version)) };
      } else if (input.action === "merge-events" || input.action === "split-event") {
        for (const ref of input.refs) this.event(ref, context);
        for (const id of input.memoryIds || []) this.memory(id, context);
        result = input.action === "merge-events" ? graph.mergeEvents(input.refs, input.title || "", input.reason)
          : graph.splitEvent(input.refs[0].id, input.refs[0].version, input.memoryIds || [], input.title || "", input.reason);
      } else {
        for (const ref of input.refs) this.entity(ref.id, ref.version, context);
        if (input.action === "identify") {
          if (input.refs.length !== 1) throw new UserFacingError(400, "INVALID_REFS", "每次关联一个已明确的人物候选组");
          if (!input.personId && !input.name?.trim()) throw new UserFacingError(400, "PERSON_REQUIRED", "请提供已知人物或明确称呼");
          const person = input.personId ? this.data.memories.ledger.person(input.personId) : this.data.memories.ledger.savePerson({ name: input.name || "", aliases: input.aliases || [] });
          result = graph.identify(input.refs[0].id, input.refs[0].version, person.id!, input.reason);
        } else if (input.action === "merge-people") result = graph.mergeEntities(input.refs, input.reason);
        else result = graph.splitEntity(input.refs[0].id, input.refs[0].version, input.observationIds || [], input.reason);
      }
      const changed = input.refs.map((ref) => {
        if (input.action === "link-person" || input.action === "unlink-person") return this.memory(ref.id, context);
        if (input.action.includes("event")) return this.data.db.prepare("SELECT id,version FROM memory_events WHERE id=?").get(ref.id) as MemoryRef;
        return graph.entity(ref.id);
      });
      if (result && typeof result === "object" && "id" in result && "version" in result && !changed.some((ref) => ref.id === result.id))
        changed.push(result as MemoryRef);
      return { before: input.refs, after: changed.map(({ id, version }) => ({ id, version })), result };
    });
  }
}
