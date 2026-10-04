import type { DatabaseSync } from "node:sqlite";
import type { Asset, MemorySpace, Run, SourceRef } from "@memory/contracts";
import type { MemoryRecords } from "./records.js";
import type { EventOutbox } from "../storage/event-outbox.js";

/** Storage and optional activity ports. Business workers never own or create Pi sessions. */
export interface MemoryData {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly assetsDir: string;
  readonly memories: MemoryRecords;
  readonly events: EventOutbox;
  asset(id: string): Asset | undefined;
  assets(space?: MemorySpace): Asset[];
  addAsset(asset: Asset, options?: { processing: "requested" | "automatic" }): void;
  recordMemoryActivity?(runId: string, patch: Partial<Run>, type: string): void;
  recordSource?(runId: string, source: SourceRef): void;
}
