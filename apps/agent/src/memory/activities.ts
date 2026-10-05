import { randomUUID } from "node:crypto";
import type { ActivityChange, MemoryActivity, MemoryActivityDetail, MemoryEntry, MemoryEvidence } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { CommandContext, MemoryCommands } from "./commands.js";
import { combineEvidence, evidenceOf } from "./ledger.js";
import { UserFacingError } from "../errors.js";

const now = () => new Date().toISOString();
const ref = (row: { id: string; version: number }) => ({ id: row.id, version: row.version });

/** Bounded model-facing view. Full source records remain available in the inspector. */
export function activityToolView(activity: MemoryActivity) {
  return { ...activity, summary: activity.summary.slice(0, 1400), members: activity.members.slice(0, 12), memberTotal: activity.members.length,
    sourceTotal: activity.sources.length, sources: activity.sources.slice(0, 6).map((source) => source.type === "asset" ?
      { type: source.type, assetId: source.assetId, name: source.name, sha256: source.sha256, start: source.start, end: source.end,
        view: source.view, video: source.video } : source), issues: activity.issues.slice(0, 6),
    more: activity.members.length > 12 || activity.sources.length > 6 ? "用活动 id 分页读取来源记录；这里只列出部分引用。" : undefined };
}

/** Organization and its history are separate from confirmed facts and the event index. */
export class MemoryActivities {
  constructor(private readonly data: MemoryData, private readonly commands: MemoryCommands) {
    data.db.exec(`CREATE TABLE IF NOT EXISTS memory_activities(id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_activity_versions(id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS memory_activity_separations(leftId TEXT NOT NULL,rightId TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(leftId,rightId));
      CREATE TABLE IF NOT EXISTS memory_activity_members(activityId TEXT NOT NULL,memoryId TEXT NOT NULL,PRIMARY KEY(activityId,memoryId));
      CREATE INDEX IF NOT EXISTS activity_memory ON memory_activity_members(memoryId,activityId);
      CREATE INDEX IF NOT EXISTS activity_date ON memory_activities(json_extract(data,'$.occurredAt') DESC,json_extract(data,'$.updatedAt') DESC);`);
  }
  raw(id: string): MemoryActivity {
    const row = this.data.db.prepare("SELECT data FROM memory_activities WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "ACTIVITY_NOT_FOUND", "活动不存在");
    return JSON.parse(row.data);
  }
  available(memory: MemoryEntry, allowedAssetIds?: readonly string[]) {
    if ((memory.space || "personal") !== "personal" || memory.forgottenAt || memory.supersededBy || memory.status === "rejected" || this.data.memories.ledger.suppressed(memory)) return false;
    const sources = evidenceOf(memory);
    return sources.length > 0 && sources.every((source) => source.type === "asset" &&
      (!allowedAssetIds || allowedAssetIds.includes(source.assetId)) && this.data.asset(source.assetId)?.sha256 === source.sha256);
  }
  memories(activity: MemoryActivity, allowedAssetIds?: readonly string[]) {
    return activity.members.flatMap(({ id }) => {
      const memory = this.data.memories.get<MemoryEntry>("memory", id);
      return memory && this.available(memory, allowedAssetIds) ? [memory] : [];
    });
  }
  get(id: string, allowedAssetIds?: readonly string[]): MemoryActivity {
    const activity = this.raw(id);
    if (allowedAssetIds && activity.sources.some((source) => source.type !== "asset" || !allowedAssetIds.includes(source.assetId)))
      throw new UserFacingError(403, "SOURCE_SCOPE", "活动包含本次所选范围外的资料");
    const memories = this.memories(activity, allowedAssetIds);
    const stale = memories.length !== activity.members.length || memories.some((memory) => activity.members.find((m) => m.id === memory.id)?.version !== memory.version);
    // Out-of-date summaries must not be reused by the Agent as current evidence.
    return { ...activity, stale, ...(stale ? { title: "待重新核对的活动", summary: "", occurredAt: "", place: "", issues: ["活动依据已更新，请对照当前记录重新核对"],
      sources: combineEvidence(memories.flatMap(evidenceOf)), entityIds: this.entities(memories) } : {}) };
  }
  list(input: { query?: string; status?: MemoryActivity["status"]; assetIds?: readonly string[]; limit?: number; offset?: number } = {}, allowedAssetIds?: readonly string[]) {
    const clauses: string[] = [], values: (string | number)[] = [];
    if (input.status) { clauses.push("json_extract(a.data,'$.status')=?"); values.push(input.status); }
    else clauses.push("json_extract(a.data,'$.status') NOT IN ('rejected','superseded')");
    if (allowedAssetIds) { clauses.push("NOT EXISTS(SELECT 1 FROM json_each(a.data,'$.sources') s WHERE json_extract(s.value,'$.type')!='asset' OR json_extract(s.value,'$.assetId') NOT IN (SELECT value FROM json_each(?)))"); values.push(JSON.stringify(allowedAssetIds)); }
    if (input.assetIds?.length) { clauses.push("EXISTS(SELECT 1 FROM json_each(a.data,'$.sources') s WHERE json_extract(s.value,'$.assetId') IN (SELECT value FROM json_each(?)))"); values.push(JSON.stringify(input.assetIds)); }
    const query = input.query?.trim().toLowerCase();
    if (query) { clauses.push("instr(lower(json_extract(a.data,'$.title') || ' ' || json_extract(a.data,'$.summary') || ' ' || json_extract(a.data,'$.occurredAt') || ' ' || json_extract(a.data,'$.place')),?)>0"); values.push(query); }
    const offset = Math.max(0, input.offset || 0), limit = Math.min(50, Math.max(1, input.limit || 20));
    const where = clauses.join(" AND ");
    const total = (this.data.db.prepare(`SELECT count(*) AS n FROM memory_activities a WHERE ${where}`).get(...values) as { n: number }).n;
    const rows = this.data.db.prepare(`SELECT a.id FROM memory_activities a WHERE ${where} ORDER BY json_extract(a.data,'$.occurredAt') DESC,json_extract(a.data,'$.updatedAt') DESC,a.id LIMIT ? OFFSET ?`).all(...values, limit, offset) as { id: string }[];
    return { activities: rows.map((row) => this.get(row.id, allowedAssetIds)), total, nextOffset: offset + limit < total ? offset + limit : null };
  }
  related(memoryIds: string[], dates: string[] = [], allowedAssetIds?: readonly string[]) {
    const rows = this.data.db.prepare(`SELECT a.id FROM memory_activities a WHERE json_extract(a.data,'$.status') NOT IN ('rejected','superseded') AND
      (EXISTS(SELECT 1 FROM memory_activity_members m WHERE m.activityId=a.id AND m.memoryId IN (SELECT value FROM json_each(?))) OR
      json_extract(a.data,'$.occurredAt') IN (SELECT value FROM json_each(?))) ORDER BY
      (SELECT count(*) FROM memory_activity_members m WHERE m.activityId=a.id AND m.memoryId IN (SELECT value FROM json_each(?))) DESC,
      json_extract(a.data,'$.updatedAt') DESC LIMIT 60`).all(JSON.stringify(memoryIds), JSON.stringify(dates.filter(Boolean)), JSON.stringify(memoryIds)) as { id: string }[];
    return rows.flatMap(({ id }) => { const raw = this.raw(id);
      return allowedAssetIds && raw.sources.some((s) => s.type !== "asset" || !allowedAssetIds.includes(s.assetId)) ? [] : [this.get(id, allowedAssetIds)]; });
  }
  detail(id: string, allowedAssetIds?: readonly string[]): MemoryActivityDetail {
    const activity = this.get(id, allowedAssetIds);
    const memories = this.memories(activity, allowedAssetIds).map(({ id, version, title, content, status, occurredAt, uncertainty, sources }) =>
      ({ id, version, title, content, status, occurredAt, uncertainty, sources }));
    const history = (this.data.db.prepare("SELECT data FROM memory_activity_versions WHERE id=? ORDER BY version DESC LIMIT 20").all(id) as { data: string }[])
      .map(({ data }) => JSON.parse(data) as MemoryActivity)
      .filter((row) => this.memories(row, allowedAssetIds).length === row.members.length && row.sources.every((source) => source.type === "asset" && (!allowedAssetIds || allowedAssetIds.includes(source.assetId)) &&
        this.data.asset(source.assetId)?.sha256 === source.sha256 && !this.data.memories.ledger.sourceBlocked(source.sha256)));
    return { activity, memories, history };
  }
  current(ids: readonly string[], allowedAssetIds?: readonly string[]) {
    const pending = [...ids], seen = new Set<string>(), activities: MemoryActivity[] = [];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]; if (seen.has(id)) continue; seen.add(id);
      const raw = this.raw(id);
      if (allowedAssetIds && raw.sources.some((source) => source.type !== "asset" || !allowedAssetIds.includes(source.assetId))) continue;
      if (raw.status === "superseded") { pending.push(...(raw.replacementIds || (raw.replacedBy ? [raw.replacedBy] : []))); continue; }
      activities.push(this.get(id, allowedAssetIds));
    }
    return activities;
  }
  entities(memories: MemoryEntry[]) {
    const ids = [...new Set(memories.flatMap((m) => evidenceOf(m).flatMap((s) => s.type === "asset" ? [s.assetId] : [])))];
    return (this.data.db.prepare(`SELECT DISTINCT l.entityId FROM memory_entity_links l JOIN memory_observations o ON o.id=l.observationId
      WHERE l.active=1 AND o.assetId IN (SELECT value FROM json_each(?)) ORDER BY l.entityId LIMIT 30`).all(JSON.stringify(ids)) as { entityId: string }[]).map((row) => row.entityId);
  }
  save(activity: MemoryActivity, expected?: number) {
    return this.data.memories.transaction(() => {
      const row = this.data.db.prepare("SELECT version FROM memory_activities WHERE id=?").get(activity.id) as { version: number } | undefined;
      if ((row && row.version !== expected) || activity.version !== (row?.version || 0) + 1)
        throw new UserFacingError(409, "VERSION_CONFLICT", "活动已更新，请重新打开");
      const value = { ...activity, stale: undefined, updatedAt: now() };
      this.data.db.prepare("INSERT INTO memory_activities VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data")
        .run(value.id, value.version, JSON.stringify(value));
      this.data.db.prepare("INSERT INTO memory_activity_versions VALUES(?,?,?)").run(value.id, value.version, JSON.stringify(value));
      this.data.db.prepare("DELETE FROM memory_activity_members WHERE activityId=?").run(value.id);
      for (const member of value.members) this.data.db.prepare("INSERT INTO memory_activity_members VALUES(?,?)").run(value.id, member.id);
      this.data.events.publish("memory-activity.changed", value.id, value.version);
      return value;
    });
  }
  candidate(values: Pick<MemoryActivity, "title" | "summary" | "occurredAt" | "place" | "issues" | "reason">, memories: MemoryEntry[], modelId?: string): MemoryActivity {
    return { ...values, id: randomUUID(), version: 1, status: "candidate", members: memories.map(ref), sources: combineEvidence(memories.flatMap(evidenceOf)),
      entityIds: this.entities(memories), locked: false, modelId, createdAt: now(), updatedAt: now() };
  }
  separations(memoryIds?: string[]): [string, string][] {
    const rows = memoryIds ? this.data.db.prepare("SELECT leftId,rightId FROM memory_activity_separations WHERE leftId IN (SELECT value FROM json_each(?)) AND rightId IN (SELECT value FROM json_each(?))").all(JSON.stringify(memoryIds), JSON.stringify(memoryIds)) :
      this.data.db.prepare("SELECT leftId,rightId FROM memory_activity_separations").all();
    return (rows as { leftId: string; rightId: string }[]).map((r) => [r.leftId, r.rightId]);
  }
  private separate(a: string[], b: string[], reason: string) {
    for (const left of a) for (const right of b) if (left !== right) this.data.db.prepare("INSERT OR IGNORE INTO memory_activity_separations VALUES(?,?,?)").run(...[left, right].sort(), reason);
  }
  private invalidateFact(activity: MemoryActivity) {
    if (activity.eventMemoryId) this.data.memories.invalidateDerivedMemory(activity.eventMemoryId, "活动关联已变更，请重新确认活动内容");
  }
  rejected(memberIds: string[]) {
    const row = this.data.db.prepare(`SELECT id FROM memory_activities a WHERE json_extract(a.data,'$.status')='rejected' AND json_array_length(a.data,'$.members')=? AND
      NOT EXISTS(SELECT 1 FROM memory_activity_members m WHERE m.activityId=a.id AND m.memoryId NOT IN (SELECT value FROM json_each(?))) LIMIT 1`)
      .get(memberIds.length, JSON.stringify(memberIds)) as { id: string } | undefined;
    return row ? this.raw(row.id) : undefined;
  }
  change(input: ActivityChange, context: CommandContext) {
    if (context.actor !== "user") throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "活动确认与人工归组需由用户明确指定");
    if (!input.refs.length || input.refs.length > 20 || new Set(input.refs.map((r) => r.id)).size !== input.refs.length || !input.reason.trim())
      throw new UserFacingError(400, "INVALID_ACTIVITY_CHANGE", "请选择活动并说明修改依据");
    if (input.values && (!input.values.title.trim() || !input.values.summary.trim() || input.values.title.length > 120 || input.values.summary.length > 2000 || input.values.place.length > 120 ||
      (input.values.occurredAt && (!/^\d{4}-\d{2}-\d{2}$/.test(input.values.occurredAt) || !Number.isFinite(Date.parse(input.values.occurredAt)) || new Date(input.values.occurredAt).toISOString().slice(0, 10) !== input.values.occurredAt))))
      throw new UserFacingError(400, "INVALID_ACTIVITY", "请填写活动内容与有效日期，未知日期留空");
    return this.commands.execute(input.action, input, context, () => {
      const rows = input.refs.map(({ id, version }) => {
        const current = this.get(id, context.allowedAssetIds);
        if (current.version !== version || ["rejected", "superseded"].includes(current.status)) throw new UserFacingError(409, "VERSION_CONFLICT", "活动已更新或已停用，请重新打开");
        return current;
      });
      if (input.action !== "merge-activities" && rows.length !== 1) throw new UserFacingError(400, "INVALID_ACTIVITY_CHANGE", "此操作一次只处理一个活动");
      let output: MemoryActivity[];
      const first = rows[0];
      const factsBefore = rows.flatMap((row) => { const memory = row.eventMemoryId && this.data.memories.get<MemoryEntry>("memory", row.eventMemoryId); return memory ? [ref(memory)] : []; });
      if (input.action === "confirm-activity" || input.action === "correct-activity") {
        if (first.relatedActivityId) {
          const related = this.raw(first.relatedActivityId);
          if (!["rejected", "superseded"].includes(related.status) && related.members.some((m) => first.members.some((other) => other.id === m.id)))
            throw new UserFacingError(409, "ACTIVITY_OVERLAP", "此候选与已有活动共享记录，请先合并关联活动或拆分不同经历，避免重复确认同一活动");
        }
        const memories = this.memories(first, context.allowedAssetIds);
        if (!memories.length || memories.length !== first.members.length) throw new UserFacingError(409, "SOURCE_CHANGED", "活动来源已停用或移除，请先调整成员");
        if (first.stale && !input.values) throw new UserFacingError(409, "ACTIVITY_STALE", "请对照当前来源填写活动内容后再确认");
        if (input.values && first.place && input.values.place && input.values.place !== first.place &&
          [input.values.title, input.values.summary].some((text) => text.includes(first.place) && !text.includes(input.values!.place)))
          throw new UserFacingError(409, "ACTIVITY_CONTENT_CONFLICT", "地点变更后请同步更正标题和正文中的旧地点，避免回忆仍返回旧值");
        const next = { ...first, ...input.values, members: memories.map(ref), sources: combineEvidence(memories.flatMap(evidenceOf)), entityIds: this.entities(memories),
          version: first.version + 1, status: "confirmed" as const, locked: true, reason: input.reason, issues: [] };
        const previous = first.eventMemoryId && this.data.memories.get<MemoryEntry>("memory", first.eventMemoryId);
        const entry = this.data.memories.saveDerivedActivity({ title: next.title, content: next.summary, occurredAt: next.occurredAt, place: next.place,
          sources: [...new Map(memories.flatMap((m) => m.sources).map((s) => [JSON.stringify(s), s])).values()], evidence: next.sources,
          members: next.members, previous: previous || undefined, reason: input.reason });
        next.eventMemoryId = entry.id;
        // Reconfirming the same version is idempotent through the enclosing command receipt.
        output = [this.save(next, first.version)];
      } else if (input.action === "reject-activity") {
        this.separate(first.members.map((m) => m.id), first.members.map((m) => m.id), input.reason);
        this.invalidateFact(first);
        output = [this.save({ ...first, version: first.version + 1, status: "rejected", locked: true, reason: input.reason }, first.version)];
      } else if (input.action === "split-activity") {
        const selected = new Set(input.memoryIds || []);
        if (!selected.size || selected.size >= first.members.length || [...selected].some((id) => !first.members.some((m) => m.id === id)))
          throw new UserFacingError(400, "INVALID_SPLIT", "请选择活动中的部分记录进行拆分");
        const memories = this.memories(first, context.allowedAssetIds);
        if (memories.length !== first.members.length) throw new UserFacingError(409, "SOURCE_CHANGED", "来源已改变，请刷新活动");
        const groups = [memories.filter((m) => selected.has(m.id)), memories.filter((m) => !selected.has(m.id))];
        this.separate(groups[0].map((m) => m.id), groups[1].map((m) => m.id), input.reason);
        this.invalidateFact(first);
        output = groups.map((members) => this.save({ ...this.candidate({ title: members[0].title, summary: members.map((m) => m.content).join("\n").slice(0, 2000),
          occurredAt: new Set(members.map((m) => m.occurredAt)).size === 1 ? members[0].occurredAt : "", place: "", reason: input.reason, issues: ["拆分后请核对活动内容"] }, members), locked: true }));
        this.save({ ...first, version: first.version + 1, status: "superseded", locked: true, replacedBy: output[0].id, replacementIds: output.map((a) => a.id), reason: input.reason }, first.version);
      } else {
        if (rows.length < 2) throw new UserFacingError(400, "INVALID_MERGE", "请选择至少两个活动");
        if (rows.some((row) => this.memories(row, context.allowedAssetIds).length !== row.members.length))
          throw new UserFacingError(409, "SOURCE_CHANGED", "活动包含已停用或移除的来源，请先核对成员");
        const memories = [...new Map(rows.flatMap((r) => this.memories(r, context.allowedAssetIds)).map((m) => [m.id, m])).values()];
        if (!memories.length) throw new UserFacingError(409, "SOURCE_CHANGED", "活动已无可用来源");
        if (memories.length > 48) throw new UserFacingError(400, "ACTIVITY_LIMIT", "单个活动最多包含 48 条记录，请按具体活动分别整理");
        const next = this.candidate(input.values ? { ...input.values, reason: input.reason, issues: ["归组已调整，活动内容待确认"] } : {
          title: first.title, summary: memories.map((m) => m.content).join("\n").slice(0, 2000), occurredAt: "", place: "", reason: input.reason, issues: ["归组已调整，活动内容待确认"] }, memories);
        next.locked = true;
        // An explicit merge replaces earlier separation constraints for these members only.
        const ids = JSON.stringify(memories.map((m) => m.id));
        this.data.db.prepare("DELETE FROM memory_activity_separations WHERE leftId IN (SELECT value FROM json_each(?)) AND rightId IN (SELECT value FROM json_each(?))").run(ids, ids);
        output = [this.save(next)];
        for (const row of rows) { this.invalidateFact(row); this.save({ ...row, version: row.version + 1, status: "superseded", locked: true, replacedBy: next.id, replacementIds: [next.id], reason: input.reason }, row.version); }
      }
      this.data.memories.ledger.invalidate();
      const factIds = [...new Set([...factsBefore.map((m) => m.id), ...output.flatMap((a) => a.eventMemoryId ? [a.eventMemoryId] : [])])];
      const factsAfter = factIds.flatMap((id) => { const memory = this.data.memories.get<MemoryEntry>("memory", id); return memory ? [ref(memory)] : []; });
      return { before: [...rows.map(ref), ...factsBefore], after: [...output.map(ref), ...factsAfter], result: { activities: output } };
    });
  }
}
