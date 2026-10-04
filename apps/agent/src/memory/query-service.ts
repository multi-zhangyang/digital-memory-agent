import type { DatabaseSync } from "node:sqlite";
import type { EvidenceMemoryContext, MemoryEntry, MemorySearch } from "@memory/contracts";
import type { MemoryLedger } from "./ledger.js";
import { budgetMemories, memoryContext, memoryEligibility, memorySpace, searchMemories } from "./retrieval.js";
import type { MemoryFeatureService } from "./feature-service.js";
import { UserFacingError } from "../errors.js";
import { MemoryCatalog } from "./catalog.js";
import { contentHash, nameKey, normalizeFact } from "./values.js";

type ConflictInput = Pick<MemoryEntry, "attribute" | "space" | "conflictsWith" | "validity"> & { id?: string };
export interface PendingMemoryConflict {
  pendingId: string;
  currentId: string;
  status: "待核对";
}
const memoryPolicy = "content、occurredAt 和 validity 是当前修订后的确认内容；evidence 仅定位保留的原始来源，不用于推翻用户纠正。supersededBy 表示历史事实，只可用于对应的过去时间。历史对话中的旧内容可能已纠正；如需更多个人信息，使用 search_memories，不能凭旧回答补全。记忆 id 不是人物 personId；查询用户本人不要填写 person 或 personId。本次 useMemory 为 false 时，不使用历史个人记忆回答。";

function identifiers(text: string) {
  // Whole ASCII identifiers also work next to Chinese text. Do not treat a year,
  // a common word, or a prefix of a longer identifier as an exact identifier hit.
  return new Set((text.normalize("NFKC").toLowerCase().match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) || [])
    .filter((token) => token.length >= 4 && token.length <= 64 && /[a-z]/.test(token) && /[0-9]/.test(token)));
}

/** Domain queries usable from HTTP, tools and jobs, without a model or Agent session. */
export class MemoryQueryService {
  readonly catalog: MemoryCatalog;
  features?: MemoryFeatureService;
  constructor(private readonly db: DatabaseSync, private readonly ledger: MemoryLedger) {
    this.catalog = new MemoryCatalog(db, ledger);
  }

  search(input: MemorySearch): MemoryEntry[] {
    if (input.personId) {
      try { this.ledger.person(input.personId); }
      catch { throw new UserFacingError(400, "INVALID_PERSON", "personId 必须来自已确认人物的 personIds，不能使用记忆 id；查询用户本人请省略 person 和 personId 后重试。"); }
    }
    return searchMemories(this.db, input, this.ledger.settings().timeZone);
  }

  recall(input: MemorySearch, maxBytes = 12000) {
    const limit = Math.max(1, Math.min(50, input.limit || 8));
    const candidates = this.search({ ...input, limit: limit + 1 });
    const entries = budgetMemories(candidates.slice(0, limit), maxBytes);
    return this.result(entries, candidates.length > entries.length, maxBytes);
  }

  /** Bound to the exact source page, with the same confirmation and suppression rules as fact recall. */
  forSource(source: { assetId: string; sha256: string; start: number; end: number }, allowedAssetIds?: readonly string[], maxBytes = 6000): EvidenceMemoryContext {
    const eligible = memoryEligibility({ includeHistorical: true }, this.ledger.settings().timeZone);
    const scope = allowedAssetIds ? "AND NOT EXISTS(SELECT 1 FROM memory_evidence_index e WHERE e.memoryId=m.id AND e.assetId IS NOT NULL AND e.assetId NOT IN (SELECT value FROM json_each(?)))" : "";
    const rows = this.db.prepare(`SELECT r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id
      WHERE ${eligible.where.join(" AND ")} AND m.superseded=0
      AND EXISTS(SELECT 1 FROM memory_evidence_index e WHERE e.memoryId=m.id AND e.assetId=? AND e.hash=? AND e.start<? AND e.end>?) ${scope}
      ORDER BY json_extract(r.data,'$.editedBy')='user' DESC,m.updatedAt DESC,m.id DESC LIMIT 51`)
      .all(...eligible.args, source.assetId, source.sha256, source.end, source.start, ...(allowedAssetIds ? [JSON.stringify(allowedAssetIds)] : [])) as { data: string }[];
    const result: EvidenceMemoryContext = { memories: rows.slice(0, 50).map((row) => {
      const entry = JSON.parse(row.data) as MemoryEntry;
      const { id, version, content, status, kind, category, occurredAt, validity, acceptedBy, editedBy, uncertainty } = entry;
      return { id, version, content, status, kind, category, occurredAt, validity, acceptedBy, editedBy, uncertainty };
    }), revision: this.ledger.revision, truncated: rows.length > 50,
      policy: "原文保留最初文字，仅供来源追溯。memories 是关联的当前确认版本；editedBy=user 表示用户已修订，回答个人事实以确认修订及其时间为准，不能用原文旧值推翻。未列全时用 inspect_memories 或 search_memories 继续核对。" };
    while (result.memories.length && Buffer.byteLength(JSON.stringify(result)) > Math.max(600, maxBytes)) {
      result.memories.pop(); result.truncated = true;
    }
    return result;
  }

  resolvePerson(input: MemorySearch) {
    if (input.space === "demo") return { input, resolution: undefined };
    if (input.personId) { this.ledger.person(input.personId); return { input, resolution: undefined }; }
    let name = input.person?.trim();
    if (!name && input.query && !/我的名字|我的姓名|我叫什么|my name/i.test(input.query)) {
      const aliases = this.db.prepare("SELECT DISTINCT name FROM memory_person_aliases WHERE length(name)>=2 AND instr(?,name)>0 ORDER BY length(name) DESC LIMIT 8")
        .all(nameKey(input.query)) as { name: string }[];
      if (aliases.length && aliases.every((row) => aliases[0].name.includes(row.name))) name = aliases[0].name;
    }
    if (!name) return { input, resolution: undefined };
    const rows = this.db.prepare("SELECT DISTINCT p.data FROM memory_person_aliases a JOIN memory_people p ON p.id=a.personId WHERE a.name=? LIMIT 9")
      .all(nameKey(name)) as { data: string }[];
    const people = rows.map((row) => JSON.parse(row.data) as { id: string; name: string; aliases: string[] });
    const candidates = people.slice(0, 8).map(({ id, name: label, aliases }) => ({ personId: id, name: label, aliases,
      context: (this.db.prepare(`SELECT r.data FROM memory_person_links l JOIN memory_read m ON m.id=l.memoryId JOIN workspace_records r ON r.id=m.id
        WHERE l.personId=? AND m.status='confirmed' AND m.forgotten=0 AND m.superseded=0 AND m.suppressed=0 ORDER BY m.updatedAt DESC LIMIT 2`)
        .all(id) as { data: string }[]).map((row) => { const entry = JSON.parse(row.data) as MemoryEntry; return { memoryId: entry.id, version: entry.version, content: entry.content.slice(0, 240) }; }) }));
    // A name-only request is an entity filter; captions need not repeat a confirmed person's name.
    const query = input.query && nameKey(input.query) === nameKey(name) ? undefined : input.query;
    return { input: people.length === 1 ? { ...input, query, person: undefined, personId: people[0].id } : { ...input, person: name },
      resolution: { name, status: people.length === 1 ? "resolved" as const : people.length ? "ambiguous" as const : "unidentified" as const, candidates, truncated: people.length > 8 } };
  }

  async recallAsync(input: MemorySearch, maxBytes = 12000, signal?: AbortSignal) {
    const resolved = this.resolvePerson(input);
    if (resolved.resolution?.status === "ambiguous") return this.result([], false, maxBytes, {
      personResolution: resolved.resolution, retrieval: { channels: [], status: "needs_disambiguation" },
    });
    const options = resolved.input;
    // A long description between "find" and "photo" still requests image recall.
    // Keep it within one sentence so an unrelated later sentence cannot switch channels.
    const visual = (!options.category || options.category === "fact") && /哪[一几]?[张幅]|(?:找|搜索|寻找)[^。！？?\n]{0,200}(?:照片|图片|图像)|(?:照片|图片|图像)(?:中|里|上|的左|的右|的背景)|画面|图中|图里|\b(?:photo|picture|image)\b/i.test(options.query || "");
    const features = await this.features?.retrieve(options, signal, visual);
    const keyword = this.search({ ...options, limit: 50 });
    const ranked = new Map<string, { score: number; channels: string[] }>();
    const semantic = features?.status === "ready" && !!features.text.length;
    const channels = [
      { name: "keyword", weight: semantic ? 0.05 : 1, ids: keyword.map((entry) => entry.id) },
      { name: "text", weight: visual && features?.image.length ? 0.2 : 1, ids: (features?.text || []).map((hit) => hit.memoryId) },
      { name: "image", weight: visual ? 1 : 0, ids: (features?.image || []).map((hit) => hit.memoryId) },
    ];
    for (const channel of channels.filter((channel) => channel.weight > 0)) channel.ids.forEach((id, rank) => {
      const previous = ranked.get(id) || { score: 0, channels: [] };
      // Reciprocal ranks combine order, never incompatible similarity scores or probabilities.
      // Preserve a strong semantic hit when weak lexical matches are common.
      // An image's two representations must not count as two independent votes for a text question.
      previous.score += channel.weight / (10 + rank + 1); previous.channels.push(channel.name); ranked.set(id, previous);
    });
    const eligible = memoryEligibility(options, this.ledger.settings().timeZone);
    const current = (this.db.prepare(`SELECT r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id
      WHERE m.id IN (SELECT value FROM json_each(?)) AND ${eligible.where.join(" AND ")}`)
      .all(JSON.stringify([...ranked.keys()]), ...eligible.args) as { data: string }[]).map((row) => JSON.parse(row.data) as MemoryEntry);
    const queryIdentifiers = [...identifiers(options.query || "")].slice(0, 8);
    const exact = new Map(current.map((entry) => {
      // Rank only the bounded, eligible current records. Original evidence,
      // statements and storage IDs must not revive a corrected identifier.
      const tokens = queryIdentifiers.length ? identifiers([entry.title, entry.content, entry.attribute?.value].join(" ")) : new Set<string>();
      return [entry.id, queryIdentifiers.filter((token) => tokens.has(token)).length];
    }));
    current.sort((a, b) => exact.get(b.id)! - exact.get(a.id)! || ranked.get(b.id)!.score - ranked.get(a.id)!.score || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const limit = Math.max(1, Math.min(50, input.limit || 8));
    const entries = budgetMemories(current.slice(0, limit), maxBytes);
    return this.result(entries, current.length > entries.length, maxBytes, {
      personResolution: resolved.resolution,
      retrieval: { status: features?.status || "not_configured", channels: channels.filter((channel) => channel.ids.length && channel.weight > 0).map((channel) => channel.name),
        ranking: visual ? "visual-weighted-ranks" : "text-weighted-ranks", relevance: "candidate-evidence", index: this.features?.status(options.space).jobs,
        identifierPriority: queryIdentifiers.length ? { requested: queryIdentifiers.length, matchingCandidates: [...exact.values()].filter(Boolean).length } : undefined },
    });
  }

  async forTaskAsync(query: string, options: { enabled: boolean; maxBytes: number }, signal?: AbortSignal) {
    if (!options.enabled) return this.forTask(query, options);
    const recalled = await this.recallAsync({ query: query.slice(0, 200), limit: 8 }, options.maxBytes, signal);
    const unique = [...new Map([...this.search({ category: "profile", limit: 4 }), ...recalled.entries].map((entry) => [entry.id, entry])).values()];
    const entries = budgetMemories(unique, options.maxBytes);
    const recall = this.result(entries, recalled.response.coverage.truncated || unique.length > entries.length, options.maxBytes,
      { personResolution: recalled.response.personResolution, retrieval: recalled.response.retrieval });
    return { ...recall, context: { confirmedMemories: recall.response.memories,
      conflicts: recall.response.pendingConflicts.map(({ pendingId, currentId, status }) => ({ id: pendingId, conflictsWith: currentId, status })),
      memoryCoverage: recall.response.coverage, personResolution: recall.response.personResolution, retrieval: recall.response.retrieval, memoryPolicy } };
  }

  forTask(query: string, options: { enabled: boolean; maxBytes: number }) {
    const candidates = options.enabled ? [
      ...this.search({ category: "profile", limit: 4 }),
      ...this.search({ query: query.slice(0, 200), limit: 8 }),
    ] : [];
    const unique = [...new Map(candidates.map((entry) => [entry.id, entry])).values()];
    const entries = budgetMemories(unique, options.maxBytes);
    const recall = this.result(entries, unique.length > entries.length, options.maxBytes);
    return {
      ...recall,
      context: {
        confirmedMemories: recall.response.memories,
        conflicts: recall.response.pendingConflicts.map(({ pendingId, currentId, status }) => ({ id: pendingId, conflictsWith: currentId, status })),
        memoryCoverage: recall.response.coverage,
        memoryPolicy,
      },
    };
  }

  private result(input: MemoryEntry[], truncated: boolean, maxBytes: number, extra: {
    personResolution?: ReturnType<MemoryQueryService["resolvePerson"]>["resolution"];
    retrieval?: { channels: string[]; status: string; ranking?: string; relevance?: string; index?: ReturnType<MemoryFeatureService["status"]>["jobs"];
      identifierPriority?: { requested: number; matchingCandidates: number } };
  } = {}) {
    const entries = [...input];
    const pending = this.pendingConflicts(entries);
    const response = {
        memories: entries.map((entry) => ({ ...memoryContext(entry), links: this.ledger.graph.context(entry) })),
        revision: this.ledger.revision,
        pendingConflicts: pending.items,
        coverage: { kind: "ranked" as const, truncated, conflictsTruncated: pending.truncated },
        ...extra,
    };
    // Bound the complete model payload, including conflict metadata and evidence locators.
    const budget = Math.max(256, maxBytes);
    while (Buffer.byteLength(JSON.stringify(response)) > budget) {
      if (response.pendingConflicts.length) {
        response.pendingConflicts.pop();
        response.coverage.conflictsTruncated = true;
      } else if (entries.length) {
        entries.pop();
        response.memories.pop();
        response.coverage.truncated = true;
      } else if (response.personResolution?.candidates.length) {
        response.personResolution.candidates.pop(); response.personResolution.truncated = true;
      } else if (response.retrieval) { delete response.retrieval; response.coverage.truncated = true;
      } else if (response.personResolution) { delete response.personResolution; response.coverage.truncated = true;
      } else break;
    }
    return { entries, response };
  }

  conflicts(entry: ConflictInput, candidates?: MemoryEntry[]): MemoryEntry[] {
    if (!entry.attribute && !entry.conflictsWith?.length) return [];
    const rows = candidates || (this.db.prepare(`SELECT r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id
      WHERE m.space=? AND m.status='confirmed' AND m.forgotten=0 AND m.superseded=0 AND m.suppressed=0
      AND m.id IN (SELECT id FROM memory_read WHERE space=? AND attributeKey=? UNION SELECT value FROM json_each(?))`).all(
        entry.space || "personal", entry.space || "personal", entry.attribute?.key ?? null,
        JSON.stringify(entry.conflictsWith || [])) as { data: string }[]).map((row) => JSON.parse(row.data) as MemoryEntry);
    const value = entry.attribute ? nameKey(entry.attribute.value) : undefined;
    return rows.filter((other) => other.id !== entry.id && memorySpace(other) === (entry.space || "personal")
      && other.status === "confirmed" && !other.forgottenAt && !other.supersededBy && !this.ledger.suppressed(other)
      && !(entry.validity?.from && other.validity?.to && other.validity.to < entry.validity.from)
      && !(entry.validity?.to && other.validity?.from && entry.validity.to < other.validity.from)
      && ((!!entry.attribute && other.attribute?.key === entry.attribute.key && nameKey(other.attribute.value) !== value)
        || (!!entry.conflictsWith?.includes(other.id) && !(entry.attribute && other.attribute?.key === entry.attribute.key && nameKey(other.attribute.value) === value))));
  }

  duplicate(input: Pick<MemoryEntry, "content" | "occurredAt" | "space" | "validity" | "attribute">) {
    const attribute = input.attribute && !input.occurredAt && !input.validity?.from && !input.validity?.to ? input.attribute : undefined;
    const row = this.db.prepare(`SELECT r.data FROM workspace_records r JOIN memory_read m ON m.id=r.id
      WHERE m.forgotten=0 AND m.superseded=0 AND m.suppressed=0 AND m.status<>'rejected'
      AND m.id IN (
        SELECT id FROM memory_read WHERE space=? AND contentKey=? AND occurredAt=? AND validityKey=?
        UNION SELECT id FROM memory_read WHERE space=? AND attributeKey=? AND attributeFactKey=?
      ) ORDER BY r.rowid LIMIT 1`).get(input.space || "personal", contentHash(normalizeFact(input.content)), input.occurredAt,
        JSON.stringify(input.validity) ?? "", input.space || "personal", attribute?.key ?? null,
        attribute ? contentHash(normalizeFact(attribute.value)) : null) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as MemoryEntry : undefined;
  }

  pendingConflicts(entries: MemoryEntry[]) {
    if (!entries.length) return { items: [] as PendingMemoryConflict[], truncated: false };
    const rows = this.db.prepare(`WITH current AS (SELECT * FROM memory_read WHERE id IN (SELECT value FROM json_each(?))), pairs AS (
      SELECT p.id AS pendingId,c.id AS currentId FROM current c JOIN memory_read p ON p.space=c.space AND p.attributeKey=c.attributeKey AND p.attributeValue<>c.attributeValue
      UNION
      SELECT p.id,c.id FROM current c JOIN memory_conflict_links l ON l.currentId=c.id JOIN memory_read p ON p.id=l.memoryId
      WHERE NOT coalesce(p.attributeKey=c.attributeKey AND p.attributeValue=c.attributeValue,0)
    ) SELECT pairs.pendingId,pairs.currentId FROM pairs JOIN memory_read p ON p.id=pairs.pendingId JOIN memory_read c ON c.id=pairs.currentId
      WHERE p.space=c.space AND p.status='draft' AND c.status='confirmed' AND p.forgotten=0 AND c.forgotten=0
      AND p.superseded=0 AND c.superseded=0 AND p.suppressed=0 AND c.suppressed=0
      AND (p.validFrom IS NULL OR c.validTo IS NULL OR c.validTo>=p.validFrom)
      AND (p.validTo IS NULL OR c.validFrom IS NULL OR c.validFrom<=p.validTo)
      ORDER BY p.updatedAt DESC,p.id DESC,c.id LIMIT 51`).all(JSON.stringify(entries.map((entry) => entry.id))) as { pendingId: string; currentId: string }[];
    return { items: rows.slice(0, 50).map((row) => ({ ...row, status: "待核对" as const })), truncated: rows.length > 50 };
  }
}
