import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Asset, EvidenceSearch } from "@memory/contracts";
import { chineseBigrams, memoryTokens } from "./retrieval.js";

export type EvidenceScope = { allowedAssetIds?: readonly string[]; allowObservations?: boolean };
export function sourceIdentityFilter(input: EvidenceSearch, assetId: string, timestamp?: string) {
  if (!input.personId && !input.entityId) return { where: [], args: [] as SQLInputValue[] };
  return { where: [`EXISTS(SELECT 1 FROM memory_entities e JOIN memory_entity_links l ON l.entityId=e.id AND l.active=1
    JOIN memory_observations o ON o.id=l.observationId JOIN assets identity_asset ON identity_asset.id=o.assetId AND identity_asset.sha256=o.sourceHash
    WHERE e.state<>'merged' AND e.space=identity_asset.memorySpace AND o.assetId=${assetId}
    ${timestamp ? `AND json_extract(o.data,'$.evidence[0].video.timestamp') IS ${timestamp}` : ""}
    ${input.personId ? "AND e.personId=? AND e.state='identified' AND l.status='confirmed'" : ""}
    ${input.entityId ? "AND e.id=?" : ""})`], args: [input.personId, input.entityId].filter((value): value is string => !!value) };
}
export function assetEligibility(input: EvidenceSearch, scope: EvidenceScope = {}) {
  const where = ["a.memorySpace=?", "a.kind IN ('text','image','video')", "NOT EXISTS (SELECT 1 FROM memory_suppressions WHERE hash=a.sha256)"];
  const args: SQLInputValue[] = [input.space || "personal"];
  if (input.kind) { where.push("a.kind=?"); args.push(input.kind); }
  for (const ids of [input.assetIds, scope.allowedAssetIds]) if (ids) { where.push("a.id IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(ids)); }
  const identity = sourceIdentityFilter(input, "a.id"); where.push(...identity.where); args.push(...identity.args);
  if (scope.allowObservations === false && (input.personId || input.entityId)) where.push("0");
  return { where, args };
}
export function observationEligibility(input: EvidenceSearch, scope: EvidenceScope = {}) {
  const where = ["m.space=?", "m.status IN ('draft','confirmed')", "m.forgotten=0", "m.suppressed=0", "m.superseded=0"];
  const args: SQLInputValue[] = [input.space || "personal"];
  if (scope.allowObservations === false) where.push("0");
  // Only asset-derived observations belong in evidence search; message memory stays behind useMemory.
  where.push("EXISTS(SELECT 1 FROM memory_evidence_index s JOIN assets a ON a.id=s.assetId AND a.sha256=s.hash WHERE s.memoryId=m.id)");
  where.push("NOT EXISTS(SELECT 1 FROM memory_evidence_index s LEFT JOIN assets a ON a.id=s.assetId AND a.sha256=s.hash AND a.memorySpace=m.space WHERE s.memoryId=m.id AND a.id IS NULL)");
  for (const ids of [input.assetIds, scope.allowedAssetIds]) if (ids) {
    where.push("NOT EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id AND (s.assetId IS NULL OR s.assetId NOT IN (SELECT value FROM json_each(?))))"); args.push(JSON.stringify(ids));
  }
  if (input.kind) { where.push("EXISTS(SELECT 1 FROM memory_evidence_index s JOIN assets a ON a.id=s.assetId WHERE s.memoryId=m.id AND a.kind=?)"); args.push(input.kind); }
  const identity = sourceIdentityFilter(input, "s.assetId", "s.timestamp");
  if (identity.where.length) { where.push(`EXISTS(SELECT 1 FROM memory_evidence_index s WHERE s.memoryId=m.id AND ${identity.where.join(" AND ")})`); args.push(...identity.args); }
  return { where, args };
}
export function evidenceMatch(query: string) {
  return [...new Set([...memoryTokens(query), ...chineseBigrams(query)])].slice(0, 32).map((token) => '"' + token.replaceAll('"', '""') + '"').join(" OR ");
}
export class EvidenceIndex {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS evidence_chunks (
      id INTEGER PRIMARY KEY,assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,sourceHash TEXT NOT NULL,
      segment INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,text TEXT NOT NULL,UNIQUE(assetId,segment));
      CREATE INDEX IF NOT EXISTS evidence_asset_hash ON evidence_chunks(assetId,sourceHash);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(title,content,grams,tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS evidence_chunk_removed AFTER DELETE ON evidence_chunks BEGIN
        DELETE FROM evidence_fts WHERE rowid=old.id;
      END;`);
  }
  write(asset: Asset, text = "") {
    this.db.prepare("DELETE FROM evidence_chunks WHERE assetId=?").run(asset.id);
    const pieces: { text: string; start: number; end: number }[] = [];
    // Code points avoid breaking surrogate pairs; offsets refer to the original UTF-8 bytes.
    const chars = [...text]; let bytes = 0;
    if (!chars.length) pieces.push({ text: "", start: 0, end: asset.size });
    for (let index = 0; index < chars.length; index += 400) {
      const part = chars.slice(index, index + 400).join("");
      const end = bytes + Buffer.byteLength(part);
      pieces.push({ text: part, start: bytes, end }); bytes = end;
    }
    for (const [segment, piece] of pieces.entries()) {
      const row = this.db.prepare("INSERT INTO evidence_chunks(assetId,sourceHash,segment,start,end,text) VALUES (?,?,?,?,?,?) RETURNING id")
        .get(asset.id, asset.sha256, segment, piece.start, piece.end, piece.text) as { id: number };
      this.db.prepare("INSERT INTO evidence_fts(rowid,title,content,grams) VALUES (?,?,?,?)")
        .run(row.id, memoryTokens(asset.name).join(" "), memoryTokens(piece.text).join(" "), chineseBigrams(asset.name + " " + piece.text).join(" "));
    }
    return pieces;
  }
}
