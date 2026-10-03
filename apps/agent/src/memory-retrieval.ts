import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, MemorySearch } from "@memory/contracts";

export const memorySpace = (memory: MemoryEntry) => memory.space || "personal";
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
]);

export function searchMemories(
  db: DatabaseSync,
  options: MemorySearch,
): MemoryEntry[] {
  const query = options.query?.trim() || "";
  const words = [
    ...new Set(
      [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(query)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment.toLowerCase())
        .filter(
          (word) =>
            !stopwords.has(word) && (word.length > 1 || query.length === 1),
        ),
    ),
  ].slice(0, 24);
  if (query && !words.length) return [];
  const searchable =
    "lower(json_extract(data,'$.title') || ' ' || json_extract(data,'$.content') || ' ' || coalesce(json_extract(data,'$.people'),'') || ' ' || coalesce(json_extract(data,'$.place'),''))";
  const score = words.length
    ? words.map(() => `(instr(${searchable}, ?) > 0)`).join(" + ")
    : "0";
  const where = [
    "kind='memory'",
    "json_extract(data,'$.status')='confirmed'",
    "coalesce(json_extract(data,'$.space'),'personal')=?",
  ];
  const args: (string | number)[] = [...words, options.space || "personal"];
  if (!options.includeHistorical)
    where.push("json_extract(data,'$.supersededBy') IS NULL");
  if (options.category) {
    where.push("json_extract(data,'$.category')=?");
    args.push(options.category);
  }
  if (options.person) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.people')) WHERE lower(value)=lower(?))",
    );
    args.push(options.person);
  }
  if (options.from) {
    where.push("json_extract(data,'$.occurredAt')>=?");
    args.push(options.from);
  }
  if (options.to) {
    where.push(
      "json_extract(data,'$.occurredAt')<=? AND json_extract(data,'$.occurredAt')<>''",
    );
    args.push(options.to);
  }
  if (words.length) where.push("score > 0");
  const rows = db
    .prepare(
      `SELECT data, (${score}) AS score FROM workspace_records WHERE ${where.join(" AND ")} ORDER BY score DESC, json_extract(data,'$.updatedAt') DESC, rowid DESC LIMIT ?`,
    )
    .all(...args, Math.max(1, Math.min(50, options.limit || 8))) as {
    data: string;
  }[];
  return rows.map((row) => JSON.parse(row.data));
}

// The budget covers the serialized payload, including evidence and metadata.
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
