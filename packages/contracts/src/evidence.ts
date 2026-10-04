import type { MemoryEntry, MemoryEvidence, MemorySpace, MemoryStatus } from "./memory.js";
import type { ImageView, VideoInfo, VideoFrame } from "./assets.js";

export interface EvidenceSearch {
  query?: string;
  space?: MemorySpace;
  kind?: "image" | "text" | "video";
  assetIds?: string[];
  personId?: string;
  entityId?: string;
  limit?: number;
}
export interface EvidenceHit {
  id: string;
  type: "asset" | "frame" | "observation";
  title: string;
  excerpt: string;
  assetId?: string;
  memoryId?: string;
  kind?: MemoryEntry["kind"];
  uncertainty?: string;
  version: string | number;
  status: "source" | MemoryStatus;
  authority: "raw-source" | "unverified" | "confirmed";
  sources: MemoryEvidence[];
  sourcesTruncated?: boolean;
  channels: ("keyword" | "text" | "image")[];
}
export interface EvidenceSearchResult {
  hits: EvidenceHit[];
  retrieval: { channels: ("keyword" | "text" | "image")[]; status: string; relevance: "candidate-evidence" };
  revision: number;
  truncated: boolean;
}
export interface EvidenceRead {
  hit: EvidenceHit;
  source?: { assetId: string; sha256: string; start: number; end: number; text?: string; previewUrl?: string; view?: ImageView; video?: VideoFrame };
  video?: VideoInfo;
  observation?: { memoryId: string; version: number; start: number; end: number; text: string };
  nextOffset?: number | null;
  verification: "asset-hash" | "source-links";
  memoryContext?: EvidenceMemoryContext;
}

export interface FrameMemoryDraftInput {
  version: string;
  viewSha256: string;
  timestamp?: number;
  title: string;
  content: string;
  occurredAt?: string;
}

/** Current confirmed interpretations stay separate from the unchanged original bytes. */
export interface EvidenceMemoryContext {
  memories: Pick<MemoryEntry, "id" | "version" | "content" | "status" | "kind" | "category" | "occurredAt" | "validity" | "acceptedBy" | "editedBy" | "uncertainty">[];
  revision: number;
  truncated: boolean;
  policy: string;
}

export interface VideoIndexFrame {
  id: string;
  assetId: string;
  requestedTimestamp: number;
  video?: VideoFrame;
  viewSha256?: string;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  error?: string;
}

export interface VideoSourceIndex {
  video: VideoInfo;
  sampleInterval: number;
  coverage: "sampled-frames";
  frames: VideoIndexFrame[];
  total: number;
  completed: number;
  failed: number;
  nextOffset: number | null;
}
