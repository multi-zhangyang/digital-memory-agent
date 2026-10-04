import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { MemoryCounts, MemoryEntry, MemoryPage, MemoryPageQuery, MemoryPeoplePage, MemoryPerson, MemorySpace } from "@memory/contracts";
import type { MemoryLedger } from "./ledger.js";
import { contentHash, nameKey } from "./values.js";
import { memoryDateFilter, memoryMatch, memoryPersonFilter } from "./retrieval.js";
import { UserFacingError } from "../errors.js";

type Cursor = { revision: number; query: string; sort: string | number; id: string };
const limitOf = (limit = 50) => Math.max(1, Math.min(50, limit));
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

/** Complete, paged enumeration for people and library views; never a Top-K recall. */
export class MemoryCatalog {
  constructor(private readonly db: DatabaseSync, private readonly ledger: MemoryLedger) {}

  private cursor(raw: string | undefined, query: string) {
    if (!raw) return;
    let cursor: Cursor;
    try {
      if (raw.length > 2000) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
      if (!cursor || typeof cursor.id !== "string" || !["string", "number"].includes(typeof cursor.sort) || cursor.query !== query || !Number.isInteger(cursor.revision)) throw new Error();
    } catch { throw new UserFacingError(400, "INVALID_CURSOR", "分页条件已改变，请重新读取列表"); }
    if (cursor.revision !== this.ledger.revision) throw new UserFacingError(409, "MEMORY_CURSOR_EXPIRED", "记忆已更新，请刷新列表");
    return cursor;
  }

  page(input: MemoryPageQuery & { ids?: readonly string[]; assetIds?: readonly string[]; allowedAssetIds?: readonly string[]; maxBytes?: number } = {}): MemoryPage {
    const options = { space: input.space || "personal", view: input.view || "records", query: input.query?.trim() || "",
      person: input.person || "", personId: input.personId || "", from: input.from || "", to: input.to || "", conversationId: input.conversationId || "",
      ids: input.ids && [...input.ids].sort(), assetIds: input.assetIds && [...input.assetIds].sort(), allowedAssetIds: input.allowedAssetIds && [...input.allowedAssetIds].sort() };
    const fingerprint = contentHash(JSON.stringify(options));
    const cursor = this.cursor(input.cursor, fingerprint);
    const where = ["m.space=?"], args: SQLInputValue[] = [options.space];
    let source = "memory_read m";
    const view = options.view;
    if (view === "forgotten") where.push("(m.forgotten=1 OR m.suppressed=1)");
    else if (view !== "records") {
      where.push("m.forgotten=0", "m.suppressed=0");
      if (["all", "profile", "timeline"].includes(view)) where.push("m.status<>'rejected'");
      if (["all", "profile"].includes(view)) where.push("m.superseded=0");
      if (view === "profile") where.push("m.category='profile'", "m.status='confirmed'");
      if (["draft", "confirmed", "rejected"].includes(view)) { where.push("m.status=?"); args.push(view); }
    }
    if (options.query) {
      const match = memoryMatch(options.query);
      if (match) {
        // Start with text matches. A space-first plan scans the entire library
        // even when the text index contains only one matching ID.
        source = "(SELECT id FROM memory_fts WHERE memory_fts MATCH ?) hits CROSS JOIN memory_read m ON m.id=hits.id";
        args.unshift(match);
      } else where.push("0");
    }
    const person = memoryPersonFilter(options);
    if (person) { where.push(person.sql); args.push(...person.args); }
    const dates = memoryDateFilter(options);
    where.push(...dates.where); args.push(...dates.args);
    if (options.conversationId) { where.push("m.conversationId=?"); args.push(options.conversationId); }
    if (options.ids) { where.push("m.id IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(options.ids)); }
    if (options.assetIds) {
      where.push("EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id AND s.assetId IN (SELECT value FROM json_each(?)))"); args.push(JSON.stringify(options.assetIds));
    }
    if (options.allowedAssetIds) {
      where.push("EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id)",
        "NOT EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id AND (s.assetId IS NULL OR s.assetId NOT IN (SELECT value FROM json_each(?))))");
      args.push(JSON.stringify(options.allowedAssetIds));
    }
    const wholeView = !options.query && !options.person && !options.personId && !options.from && !options.to && !options.conversationId && !options.ids && !options.assetIds && !options.allowedAssetIds;
    const total = (this.db.prepare(`SELECT ${wholeView ? "coalesce(sum(records),0)" : "count(*)"} AS total
      FROM ${wholeView ? "memory_count_buckets m" : source} WHERE ${where.join(" AND ")}`).get(...args) as { total: number }).total;
    const sort = view === "timeline" ? "sortTime" : "updatedAt";
    if (cursor) { where.push(`(m.${sort},m.id)<(?,?)`); args.push(cursor.sort, cursor.id); }
    const rows = this.db.prepare(`SELECT r.data,m.${sort} AS sort,m.id,m.suppressed FROM ${source}
      JOIN workspace_records r ON r.id=m.id WHERE ${where.join(" AND ")} ORDER BY m.${sort} DESC,m.id DESC LIMIT ?`)
      .all(...args, limitOf(input.limit) + 1) as { data: string; sort: string; id: string; suppressed: number }[];
    const selected = rows.slice(0, limitOf(input.limit));
    if (input.maxBytes) while (selected.length > 1 && selected.reduce((n, row) => n + Buffer.byteLength(row.data), 0) > input.maxBytes) selected.pop();
    const last = selected.at(-1);
    return { memories: selected.map((row) => ({ ...JSON.parse(row.data) as MemoryEntry, ...(row.suppressed ? { sourceSuppressed: true } : {}) })), total,
      revision: this.ledger.revision, nextCursor: rows.length > selected.length && last ? encode({ revision: this.ledger.revision, query: fingerprint, sort: last.sort, id: last.id }) : null };
  }

  counts(space: MemorySpace = "personal") {
    return this.db.prepare(`SELECT coalesce(sum(records),0) AS total,
      coalesce(sum(records*(status='confirmed' AND forgotten=0 AND superseded=0 AND suppressed=0)),0) AS confirmed,
      coalesce(sum(records*(status='draft' AND forgotten=0 AND superseded=0 AND suppressed=0)),0) AS draft,
      coalesce(sum(records*(status='rejected' AND forgotten=0 AND suppressed=0)),0) AS rejected,
      coalesce(sum(records*(forgotten=1 OR suppressed=1)),0) AS forgotten FROM memory_count_buckets WHERE space=?`).get(space) as unknown as MemoryCounts;
  }

  lookup(ids: string[]): MemoryEntry[] {
    if (ids.length > 50) throw new UserFacingError(400, "LIMIT", "一次最多读取 50 条记忆");
    const rows = this.db.prepare("SELECT data FROM workspace_records WHERE kind='memory' AND id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }

  people(input: { space?: MemorySpace; query?: string; cursor?: string; limit?: number } = {}): MemoryPeoplePage {
    const space = input.space || "personal", query = nameKey(input.query || "");
    const fingerprint = contentHash(JSON.stringify(["people", space, query]));
    const cursor = this.cursor(input.cursor, fingerprint);
    const args: SQLInputValue[] = [space];
    const conditions = ["c.space=?"];
    if (query) {
      conditions.push("((c.personId IS NULL AND instr(substr(c.key,6),?)>0) OR EXISTS(SELECT 1 FROM memory_person_aliases a WHERE a.personId=c.personId AND instr(a.name,?)>0))");
      args.push(query, query);
    }
    const total = (this.db.prepare(`SELECT count(*) AS total FROM memory_person_catalog c WHERE ${conditions.join(" AND ")}`).get(...args) as { total: number }).total;
    if (cursor) { conditions.push("(c.memoryCount<? OR (c.memoryCount=? AND c.key>?))"); args.push(cursor.sort, cursor.sort, cursor.id); }
    const rows = this.db.prepare(`SELECT c.*,p.data FROM memory_person_catalog c LEFT JOIN memory_people p ON p.id=c.personId
      WHERE ${conditions.join(" AND ")} ORDER BY c.memoryCount DESC,c.key LIMIT ?`)
      .all(...args, limitOf(input.limit) + 1) as { key: string; personId: string | null; name: string; data: string | null; memoryCount: number; confirmedCount: number }[];
    const selected = rows.slice(0, limitOf(input.limit)), last = selected.at(-1);
    const people = selected.map((row): MemoryPerson => {
      const person = row.data ? JSON.parse(row.data) as MemoryPerson : { name: row.name };
      const refs = this.db.prepare(`SELECT memoryId FROM memory_person_members WHERE space=? AND key=? ORDER BY updatedAt DESC,memoryId DESC LIMIT 50`)
        .all(space, row.key) as { memoryId: string }[];
      return { ...person, memoryIds: refs.map((ref) => ref.memoryId), confirmedCount: row.confirmedCount, memoryCount: row.memoryCount };
    });
    return { people, total, revision: this.ledger.revision, nextCursor: rows.length > selected.length && last ? encode({ query: fingerprint, revision: this.ledger.revision, sort: last.memoryCount, id: last.key }) : null };
  }
}
