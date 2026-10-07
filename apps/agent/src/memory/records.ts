import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemorySearch, MemoryEvidence } from "@memory/contracts";
import { RecordStore, type StoredRecord } from "../storage/record-store.js";
import { MemoryLedger, combineEvidence, evidenceOf } from "./ledger.js";
import { MemoryQueryService } from "./query-service.js";
import { UserFacingError } from "../errors.js";
import { EventOutbox } from "../storage/event-outbox.js";
const now = () => new Date().toISOString();

/** Owns memory writes, revisions and derived indexes independently of any Agent session. */
export class MemoryRecords extends RecordStore {
  readonly ledger: MemoryLedger;
  readonly queries: MemoryQueryService;
  constructor(db: DatabaseSync, events = new EventOutbox(db)) {
    super(db);
    this.ledger = new MemoryLedger(db, events);
    this.queries = new MemoryQueryService(db, this.ledger);
  }
  override save<T extends StoredRecord>(kind: string, value: T): T {
    if (kind !== "memory") return super.save(kind, value);
    const previous = this.get<MemoryEntry>(kind, value.id);
    const next = this.ledger.enrich(value as unknown as MemoryEntry);
    return this.transaction(() => {
      super.save(kind, next);
      this.ledger.changed(previous, next);
      if (previous && previous.version !== next.version) {
        const dependants = this.db.prepare(`SELECT DISTINCT r.id FROM workspace_records r,json_each(r.data,'$.derivedFrom') d
          WHERE r.kind='memory' AND r.id<>? AND json_extract(r.data,'$.status')='confirmed'
          AND json_extract(d.value,'$.id')=? AND json_extract(d.value,'$.version')<>?`).all(next.id, next.id, next.version) as { id: string }[];
        for (const dependant of dependants) this.invalidateDerivedMemory(dependant.id, "活动来源已改变，请重新核对活动内容");
      }
      return next as unknown as T;
    });
  }
  createMemory(
    input: Omit<MemoryEntry, "id" | "version" | "createdAt" | "updatedAt">,
  ) {
    if (this.ledger.suppressed(input)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "关联来源已停止取用，请先恢复记忆");
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
  invalidateDerivedMemory(id: string, reason: string) {
    const previous = this.get<MemoryEntry>("memory", id);
    if (!previous?.derivedFrom?.length || previous.status !== "confirmed") return previous;
    return this.version("memory", { ...previous, version: previous.version + 1, status: "draft", acceptedBy: undefined,
      editedBy: "agent", reason, uncertainty: reason, updatedAt: now() }, previous.version);
  }
  saveDerivedActivity(input: Pick<MemoryEntry, "title" | "content" | "occurredAt" | "place" | "sources" | "evidence"> &
    { members: { id: string; version: number }[]; previous?: MemoryEntry; reason: string }) {
    const { members, previous, ...values } = input;
    if (!members.length || members.some(({ id, version }) => this.get<MemoryEntry>("memory", id)?.version !== version))
      throw new UserFacingError(409, "SOURCE_CHANGED", "活动来源已更新，请重新核对");
    const entry = { ...values, status: "confirmed" as const, kind: "statement" as const, category: "event" as const,
      derivedFrom: members, acceptedBy: "user" as const, editedBy: "user" as const, uncertainty: "", people: [], personIds: [], space: "personal" as const };
    if (previous) return this.version("memory", { ...previous, ...entry, version: previous.version + 1, updatedAt: now() }, previous.version);
    return this.createMemory({ ...entry, conversationId: "activity", runId: "activity" });
  }
  /** Used by the independent capture service after exact-message evidence grading. */
  confirmCapturedProfile(id: string, version: number, ingestion: NonNullable<MemoryEntry["ingestion"]>) {
    const current = this.get<MemoryEntry>("memory", id);
    if (!current || current.version !== version || current.status !== "draft" || current.kind !== "statement" || current.category !== "profile" ||
      current.editedBy || current.supersededBy || current.forgottenAt || this.ledger.suppressed(current) || this.memoryConflicts(current).length)
      throw new UserFacingError(409, "CAPTURE_CHANGED", "偏好草稿已改变，不能自动确认为当前事实");
    return this.version("memory", { ...current, status: "confirmed", acceptedBy: "policy", ingestion,
      uncertainty: "", reason: undefined, version: current.version + 1, updatedAt: now() }, version);
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
        | "validity"
        | "personIds"
      >
    > & { attribute?: MemoryEntry["attribute"] | null },
    version: number,
    actor: "user" | "agent" = "user",
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
    if (previous.derivedFrom?.length && previous.place && patch.place && patch.place !== previous.place) {
      if (patch.title === undefined) next.title = previous.title.replaceAll(previous.place, patch.place);
      if (patch.content === undefined) next.content = previous.content.replaceAll(previous.place, patch.place);
    }
    next.editedBy = actor;
    if (actor === "agent") {
      if (previous.status !== "draft" || (patch.status && patch.status !== "draft"))
        throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "确认或修改个人事实需要用户明确指令");
      delete next.acceptedBy;
    } else if (patch.status === "confirmed" || patch.content !== undefined) next.acceptedBy = "user";
    if (next.status === "confirmed" && !next.forgottenAt && this.ledger.suppressed(next))
      throw new UserFacingError(409, "SOURCE_SUPPRESSED", "关联来源已停止取用，请先恢复记忆");
    for (const personId of next.personIds || []) this.ledger.person(personId);
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
    return this.queries.search({ ...filters, query, limit: Math.min(50, limit) });
  }
  addMemoryEvidence(id: string, evidence: MemoryEvidence[]) {
    const previous = this.get<MemoryEntry>("memory", id)!;
    if (previous.forgottenAt || this.ledger.suppressed(previous)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "记忆已停止取用");
    const combined = combineEvidence([...evidenceOf(previous), ...evidence]);
    if (combined.length === evidenceOf(previous).length) return previous;
    return this.version("memory", { ...previous, evidence: combined, version: previous.version + 1, updatedAt: now() }, previous.version);
  }
  duplicateMemory(input: Pick<MemoryEntry, "content" | "occurredAt" | "space" | "validity" | "attribute">) {
    return this.queries.duplicate(input);
  }
  forgetMemory(id: string, version: number, restore = false) {
    return this.transaction(() => {
      const previous = this.get<MemoryEntry>("memory", id);
      if (!previous || previous.version !== version) throw new UserFacingError(409, "VERSION_CONFLICT", "记忆已更新，请刷新后重试");
      if (restore === !previous.forgottenAt) return previous;
      if (restore) this.ledger.unblock(id); else this.ledger.block(previous);
      const next = { ...previous, forgottenAt: restore ? undefined : now(), reason: restore ? "用户恢复取用" : "用户停止取用，保留原文", version: version + 1, updatedAt: now() };
      if (restore && next.status === "confirmed" && this.memoryConflicts(next).length) {
        next.status = "draft";
        next.reason = "恢复后存在冲突，等待核对";
      }
      // Even a draft can have appeared in a previous conversation.
      if (previous.status !== "confirmed") this.ledger.invalidate();
      return this.version("memory", next, version);
    });
  }
  memoryConflicts(
    entry: Pick<MemoryEntry, "attribute" | "space" | "conflictsWith" | "validity"> & { id?: string },
    candidates?: MemoryEntry[],
  ): MemoryEntry[] {
    return this.queries.conflicts(entry, candidates);
  }
  resolveMemory(
    id: string,
    version: number,
    replace: { id: string; version: number }[],
    resolution: "correction" | "change" = "correction",
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
      if (current.forgottenAt || this.ledger.suppressed(current)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "请先恢复取用");
      if (resolution === "change" && !/^\d{4}-\d{2}-\d{2}$/.test(current.validity?.from || ""))
        throw new UserFacingError(400, "EFFECTIVE_DATE", "生活变化需要先填写新的生效日期");
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
            validity: resolution === "change" ? { ...previous.validity, precision: previous.validity?.precision || "day", to: new Date(Date.parse(current.validity!.from!) - 86400000).toISOString().slice(0, 10) } : previous.validity,
            reason: resolution === "change" ? "生活变化，保留历史事实" : "用户选择以新记录纠正",
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
          acceptedBy: "user",
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
}
