import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryEvidence } from "@memory/contracts";

export const contentHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const normalizeFact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
export const nameKey = (value: string) => value.normalize("NFKC").trim().toLowerCase();
export const evidenceOf = (memory: Pick<MemoryEntry, "evidence" | "sources">): MemoryEvidence[] =>
  memory.evidence || memory.sources.map((source) => ({ ...source, type: "asset" }));
