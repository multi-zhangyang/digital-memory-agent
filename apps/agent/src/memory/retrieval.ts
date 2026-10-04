import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, MemorySearch } from "@memory/contracts";
import { nameKey } from "./values.js";

export const memorySpace = (memory: Pick<MemoryEntry, "space">) =>
  memory.space || "personal";
// SQL aliases are internal constants. Apply suppression before ranking/limiting candidates.
export const activeMemorySources = (alias: string) => `NOT EXISTS (
  SELECT 1 FROM memory_read source_state WHERE source_state.id=${alias}.id AND source_state.suppressed=1)`;
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopwords = new Set([
  "我的",
  "记忆",
  "什么",
  "帮我",
  "一下",
  "知道",
  "记得",
  "哪些",
  "告诉",
  "现在",
  "之前",
  "哪里",
  "时候",
  "事情",
  "经历",
  "请问",
  "我们",
  "后来",
  "是否",
  "以及",
  "the",
  "what",
  "where",
  "when",
  "with",
  "was",
  "did",
  "you",
  "your",
]);

export function memoryTokens(text: string) {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize("NFKC").toLowerCase())]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment),
    ),
  ];
}
export function chineseBigrams(text: string) {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (let i = 0; i < chars.length - 1; i++)
      tokens.add(chars[i] + chars[i + 1]);
  }
  return [...tokens];
}
export function indexMemory(db: DatabaseSync, memory: MemoryEntry) {
  const row = db
    .prepare("SELECT rowid FROM workspace_records WHERE id=?")
    .get(memory.id) as { rowid: number };
  db.prepare("DELETE FROM memory_fts WHERE rowid=?").run(row.rowid);
  // All review states are searchable in the library. Agent queries enforce
  // current, confirmed, unsuppressed records before limiting candidates.
  const people = (memory.personIds || []).flatMap((id) => {
    const row = db
      .prepare("SELECT data FROM memory_people WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) return [];
    const person = JSON.parse(row.data);
    return [person.name, ...person.aliases];
  });
  const text = [
    memory.content,
    memory.place,
    ...(memory.people || []),
    ...people,
  ].join(" ");
  db.prepare(
    "INSERT INTO memory_fts(rowid,id,title,content,grams) VALUES (?,?,?,?,?)",
  ).run(
    row.rowid,
    memory.id,
    memoryTokens(memory.title).join(" "),
    memoryTokens(text).join(" "),
    chineseBigrams(memory.title + " " + text).join(" "),
  );
}

export function dateInZone(at = new Date(), timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function normalizeMemorySearch(
  options: MemorySearch,
  today = dateInZone(),
): MemorySearch {
  const next = { ...options };
  const query = next.query || "";
  const year = Number(today.slice(0, 4));
  const namedYear = query.match(/(20\d{2})年/);
  const relativeYear = query.includes("去年")
    ? year - 1
    : query.includes("前年")
      ? year - 2
      : query.includes("今年")
        ? year
        : undefined;
  const targetYear = namedYear ? Number(namedYear[1]) : relativeYear;
  if (!next.from && !next.to && targetYear !== undefined) {
    next.from = `${targetYear}-01-01`;
    next.to = `${targetYear}-12-31`;
  }
  if (
    next.from ||
    next.to ||
    /历史|以前|曾经|过去|从前|\b(?:before|previously|formerly|historical)\b/i.test(
      query,
    )
  )
    next.includeHistorical = true;
  return next;
}

export function searchMemories(
  db: DatabaseSync,
  input: MemorySearch,
  timeZone = "Asia/Shanghai",
): MemoryEntry[] {
  const today = dateInZone(new Date(), timeZone);
  const options = normalizeMemorySearch(input, today);
  const query = options.query?.trim() || "";
  const profileKey =
    !options.person &&
    !options.personId &&
    /我|my |where do i|what is my/i.test(query)
      ? /住|居住|居所|home|live/i.test(query)
        ? "home_city"
        : /名字|姓名|叫什么|my name/i.test(query)
          ? "name"
          : /公司|单位|employer/i.test(query)
            ? "employer"
            : /职业|做什么工作|occupation/i.test(query)
              ? "occupation"
              : undefined
      : undefined;
  const match = memoryMatch(query);
  const fullText = !!query && !profileKey;
  if (fullText && !match) return [];
  const eligible = memoryEligibility(options, timeZone);
  const where = eligible.where;
  const args: (string | number)[] = fullText ? [match, ...eligible.args] : eligible.args;
  if (profileKey) { where.push("m.attributeKey=?"); args.push(profileKey); }
  const rows = db.prepare(`SELECT r.data ${fullText ? ",bm25(memory_fts,0,3,1,0.35) AS rank" : ""}
    FROM ${fullText ? "memory_fts JOIN memory_read m ON m.id=memory_fts.id" : "memory_read m"}
    JOIN workspace_records r ON r.id=m.id
    WHERE ${fullText ? "memory_fts MATCH ? AND " : ""}${where.join(" AND ")}
    ORDER BY ${fullText ? "rank ASC," : ""}m.updatedAt DESC,m.id DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(51, options.limit || 8))) as { data: string }[];
  return rows.map((row) => JSON.parse(row.data));
}

export function memoryPersonFilter(options: Pick<MemorySearch, "person" | "personId">) {
  if (options.personId) return { sql: `m.id IN (SELECT memoryId FROM memory_person_links WHERE personId=? UNION
    SELECT s.memoryId FROM memory_entities e JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1 AND l.status='confirmed'
    JOIN memory_observations o ON o.id=l.observationId JOIN memory_evidence_index s ON s.assetId=o.assetId AND s.hash=o.sourceHash
      AND s.timestamp IS json_extract(o.data,'$.evidence[0].video.timestamp')
    WHERE e.personId=? AND e.state='identified')`, args: [options.personId, options.personId] };
  if (options.person) return {
    sql: `m.id IN (SELECT memoryId FROM memory_mentions WHERE name=? UNION
      SELECT l.memoryId FROM memory_person_aliases a JOIN memory_person_links l ON l.personId=a.personId WHERE a.name=? UNION
      SELECT s.memoryId FROM memory_person_aliases a JOIN memory_entities e ON e.personId=a.personId AND e.state='identified'
      JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1 AND l.status='confirmed'
      JOIN memory_observations o ON o.id=l.observationId JOIN memory_evidence_index s ON s.assetId=o.assetId AND s.hash=o.sourceHash
        AND s.timestamp IS json_extract(o.data,'$.evidence[0].video.timestamp') WHERE a.name=?)`,
    args: [nameKey(options.person), nameKey(options.person), nameKey(options.person)],
  };
}

/** Common eligibility applied inside every retrieval channel, before its candidate limit. */
export function memoryEligibility(input: MemorySearch, timeZone = "Asia/Shanghai") {
  const today = dateInZone(new Date(), timeZone);
  const options = normalizeMemorySearch(input, today);
  const where = ["m.status='confirmed'", "m.forgotten=0", "m.suppressed=0", "m.space=?"];
  where.push("NOT EXISTS (SELECT 1 FROM memory_evidence_index s JOIN assets a ON a.id=s.assetId WHERE s.memoryId=m.id AND a.sha256<>s.hash)");
  const args: (string | number)[] = [options.space || "personal"];
  if (!options.includeHistorical) {
    where.push("m.superseded=0", "(m.category='event' OR ((m.validTo IS NULL OR m.validTo>=?) AND (m.validFrom IS NULL OR m.validFrom<=?)))");
    args.push(today, today);
  }
  if (options.category) { where.push("m.category=?"); args.push(options.category); }
  if (options.eventId) { where.push("m.id IN (SELECT memoryId FROM memory_event_links WHERE eventId=? AND active=1)"); args.push(options.eventId); }
  const person = memoryPersonFilter(options);
  if (person) { where.push(person.sql); args.push(...person.args); }
  const dates = memoryDateFilter(options);
  where.push(...dates.where); args.push(...dates.args);
  return { options, where, args };
}
export function memoryDateFilter(options: Pick<MemorySearch, "from" | "to">) {
  const where: string[] = [], args: string[] = [];
  if (options.from) {
    where.push("coalesce(m.validTo,CASE WHEN m.category<>'event' AND m.validFrom IS NOT NULL THEN '9999-12-31' END,nullif(m.occurredAt,''),m.validFrom,'')>=?");
    args.push(options.from);
  }
  if (options.to) { where.push("coalesce(m.validFrom,nullif(m.occurredAt,''),'9999-12-31')<=?"); args.push(options.to); }
  return { where, args };
}

export function memoryMatch(query: string) {
  const words = memoryTokens(query)
    .filter(
      (word) => !stopwords.has(word) && (word.length > 1 || query.length === 1),
    )
    .slice(0, 24);
  const grams = chineseBigrams(query)
    .filter((word) => !stopwords.has(word))
    .slice(0, 48);
  // FTS syntax is constructed from escaped literal tokens, never user operators.
  const literal = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const clauses = [
    ...words.map((word) => `{title content} : ${literal(word)}`),
    ...grams.map((word) => `grams : ${literal(word)}`),
  ];
  return clauses.join(" OR ");
}

// Keep the original wording in the ledger/UI. It may contradict a later correction.
export function memoryContext(memory: MemoryEntry) {
  const {
    id,
    version,
    content,
    kind,
    category,
    occurredAt,
    validity,
    people,
    personIds,
    place,
    attribute,
    acceptedBy,
    editedBy,
    supersededBy,
    replaces,
    uncertainty,
  } = memory;
  const evidence =
    memory.evidence ||
    memory.sources.map((source) => ({ ...source, type: "asset" as const }));
  return {
    id,
    version,
    content,
    kind,
    category,
    occurredAt,
    validity,
    people,
    personIds,
    place,
    attribute,
    acceptedBy,
    editedBy,
    supersededBy,
    replaces,
    uncertainty,
    evidence: evidence.map(({ quote: _quote, ...reference }) => {
      if (reference.type !== "asset" || !reference.visual) return reference;
      const { name: _name, visual: originalVisual, ...locator } = reference;
      const { transcript: _transcript, ...visual } = originalVisual;
      return { ...locator, visual };
    }),
  };
}

export function budgetMemories(
  entries: MemoryEntry[],
  maxBytes = 12000,
): MemoryEntry[] {
  const result: MemoryEntry[] = [];
  let bytes = 2;
  for (const entry of entries) {
    if (result.some((value) => value.id === entry.id)) continue;
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + size > maxBytes) continue;
    result.push(entry);
    bytes += size;
  }
  return result;
}
