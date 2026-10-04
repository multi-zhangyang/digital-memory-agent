import type { MemoryData } from "./data.js";
import type { MemoryEntry, MemorySearch } from "@memory/contracts";
import { memoryEligibility, memoryMatch } from "./retrieval.js";
import { contentHash, evidenceOf } from "./values.js";
import { UserFacingError } from "../errors.js";

export type EventQuery = MemorySearch & { cursor?: string; mode?: "list" | "count" };

/** Enumeration and counts over recorded events. Relevance Top-K is never used as a total. */
export class MemoryEvents {
  constructor(private readonly store: MemoryData) {}
  query(input: EventQuery, maxBytes = 12000) {
    const ledger = this.store.memories.ledger;
    const resolved = this.store.memories.queries.resolvePerson(input);
    if (resolved.resolution?.status === "ambiguous") return { events: [], total: null, nextCursor: null,
      revision: ledger.revision, personResolution: resolved.resolution, coverage: { kind: "recorded-events", complete: false, reason: "人物名称不唯一" } };
    const options = { ...resolved.input, category: "event" as const };
    const { where, args } = memoryEligibility(options, ledger.settings().timeZone);
    where.push("m.superseded=0", "l.active=1", "e.mergedInto IS NULL");
    if (options.query?.trim()) {
      const match = memoryMatch(options.query);
      if (match) { where.push("m.id IN (SELECT id FROM memory_fts WHERE memory_fts MATCH ?)"); args.push(match); }
      else where.push("0");
    }
    const source = "memory_events e JOIN memory_event_links l ON l.eventId=e.id JOIN memory_read m ON m.id=l.memoryId";
    const conditions = where.join(" AND ");
    const total = (this.store.db.prepare(`SELECT count(DISTINCT e.id) AS n FROM ${source} WHERE ${conditions}`).get(...args) as { n: number }).n;
    const fingerprint = contentHash(JSON.stringify({ ...options, cursor: undefined, limit: undefined, mode: undefined }));
    let after = "";
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (cursor.query !== fingerprint || typeof cursor.id !== "string") throw new Error();
        if (cursor.revision !== ledger.revision) throw new UserFacingError(409, "MEMORY_CURSOR_EXPIRED", "事件已更新，请重新读取列表");
        after = cursor.id;
      } catch (error) { if (error instanceof UserFacingError) throw error; throw new UserFacingError(400, "INVALID_CURSOR", "事件分页条件无效"); }
    }
    const limit = Math.max(1, Math.min(20, input.limit || 8));
    const listingSource = !options.query && !options.person && !options.personId && !options.from && !options.to
      ? "memory_events e CROSS JOIN memory_event_links l ON l.eventId=e.id CROSS JOIN memory_read m ON m.id=l.memoryId" : source;
    const rows = input.mode === "count" || !total ? [] : this.store.db.prepare(`SELECT e.id,e.data,count(*) AS matchedMemories FROM ${listingSource}
      WHERE ${conditions} AND e.id>? GROUP BY e.id ORDER BY e.id LIMIT ?`).all(...args, after, limit + 1) as { id: string; data: string; matchedMemories: number }[];
    const events = rows.slice(0, limit).map((row) => {
      const memories = (this.store.db.prepare(`SELECT r.data FROM memory_events e CROSS JOIN memory_event_links l ON l.eventId=e.id
        CROSS JOIN memory_read m ON m.id=l.memoryId CROSS JOIN workspace_records r ON r.id=m.id
        WHERE e.id=? AND ${conditions} ORDER BY m.occurredAt,m.id LIMIT 4`).all(row.id, ...args) as { data: string }[])
        .map((entry) => JSON.parse(entry.data) as MemoryEntry);
      return { ...JSON.parse(row.data) as { id: string; version: number; title: string }, matchedMemories: row.matchedMemories,
        evidenceTruncated: row.matchedMemories > 3, memories: memories.slice(0, 3).map((memory) => ({ id: memory.id, version: memory.version,
          occurredAt: memory.occurredAt, validity: memory.validity, place: memory.place, personIds: memory.personIds, people: memory.people,
          uncertainty: memory.uncertainty, evidence: evidenceOf(memory).slice(0, 3).map((evidence) => evidence.type === "asset"
            ? { type: "asset", assetId: evidence.assetId, sha256: evidence.sha256, start: evidence.start, end: evidence.end }
            : { type: "message", messageId: evidence.messageId, sha256: evidence.sha256, start: evidence.start, end: evidence.end }) })) };
    });
    const space = options.space || "personal";
    const assets = this.store.db.prepare(`SELECT count(*) AS total,sum(EXISTS(SELECT 1 FROM memory_observations o WHERE o.assetId=a.id AND o.sourceHash=a.sha256 AND o.kind='source')) AS withExtractedClaims
      FROM assets a WHERE a.memorySpace=?`).get(space) as { total: number; withExtractedClaims: number | null };
    const undated = this.store.db.prepare(`SELECT count(DISTINCT l.eventId) AS n FROM memory_read m CROSS JOIN memory_event_links l ON l.memoryId=m.id
      WHERE l.active=1 AND m.space=? AND m.status='confirmed' AND m.forgotten=0 AND m.suppressed=0 AND m.superseded=0
      AND m.occurredAt='' AND m.validFrom IS NULL AND m.validTo IS NULL`).get(space) as { n: number };
    const response = { events, total, revision: ledger.revision, personResolution: resolved.resolution, nextCursor: null as string | null,
      coverage: { kind: "recorded-events", complete: true, query: input.query ? "keyword-filter" : "structured-filter",
        undatedEventsInSpace: undated.n, assets: { total: assets.total, withExtractedClaims: assets.withExtractedClaims || 0 },
        scope: "仅统计已确认、可取用的事件记录；未整理资料和日期未知的记录不能据此断言实际经历总数。" } };
    while (events.length > 1 && Buffer.byteLength(JSON.stringify(response)) > Math.max(1500, maxBytes) - 600) events.pop();
    // Keep an event summary so even one event with very large metadata can advance the cursor.
    if (events.length && Buffer.byteLength(JSON.stringify(response)) > Math.max(1500, maxBytes) - 600) {
      events[0].memories = []; events[0].evidenceTruncated = true;
      const first = events[0];
      events[0] = { id: first.id, version: first.version, title: first.title.slice(0, 120), matchedMemories: first.matchedMemories,
        memories: [], evidenceTruncated: true };
    }
    if (rows.length > events.length && events.length) response.nextCursor = Buffer.from(JSON.stringify({ query: fingerprint, revision: ledger.revision, id: events.at(-1)!.id })).toString("base64url");
    return response;
  }
}
