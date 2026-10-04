import type { ThinkingLevel } from "./models.js";
import type { SourceRef, VideoInfo } from "./assets.js";

export type MemoryStatus = "draft" | "confirmed" | "rejected";

export type MemorySpace = "personal" | "demo";

export type MemoryCategory = "profile" | "event" | "relationship" | "fact";

export interface MemoryAttribute {
  key: "name" | "home_city" | "occupation" | "employer";
  value: string;
}

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  status: MemoryStatus;
  kind: "statement" | "observation" | "inference";
  occurredAt: string;
  sources: SourceRef[];
  conversationId: string;
  runId: string;
  statement?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  space?: MemorySpace;
  category?: MemoryCategory;
  people?: string[];
  place?: string;
  uncertainty?: string;
  attribute?: MemoryAttribute;
  supersededBy?: string;
  replaces?: string[];
  ingestion?: {
    jobId: string;
    chunkId: string;
    modelId: string;
    extractorVersion: number;
  };
  evidence?: MemoryEvidence[];
  acceptedBy?: "user" | "policy";
  editedBy?: "user" | "agent";
  validity?: MemoryValidity;
  personIds?: string[];
  conflictsWith?: string[];
  forgottenAt?: string;
}

export type MemoryEvidence =
  | ({ type: "asset" } & SourceRef)
  | {
      type: "message";
      messageId: string;
      conversationId: string;
      runId: string;
      sha256: string;
      start: number;
      end: number;
      quote: string;
    };

export interface MemoryValidity {
  from?: string;
  to?: string;
  precision: "day" | "month" | "year" | "unknown";
  expression?: string;
}

export interface MemoryRetrievalTrace {
  query: MemorySearch;
  revision: number;
  at: string;
  durationMs: number;
  matches: { id: string; version: number; evidence: MemoryEvidence[] }[];
}

export interface MemorySettings {
  capture: "graded" | "off";
  timeZone: string;
  photoModelId?: string;
  videoModelId?: string;
  textModelId?: string;
  datasetModelId?: string;
  datasetReviewModelId?: string;
  intake?: "automatic" | "manual";
  automaticText?: boolean;
  automaticPhotos?: boolean;
  automaticVideos?: boolean;
  videoSampleInterval?: number;
  indexAssets?: boolean;
  processingVersion?: number;
}

export interface MemoryCaptureJob {
  id: string;
  conversationId: string;
  runId: string;
  messageId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  sourceHash: string;
  extractorVersion: number;
  status: "waiting" | "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  attempts: number;
  invalidResponseRetries?: number;
  recoveries: number;
  memoryIds: string[];
  reason?: string;
  error?: string;
  usage?: { input: number; output: number };
  createdAt: string;
  updatedAt: string;
  revision?: number;
}

export interface MemorySearch {
  query?: string;
  space?: MemorySpace;
  person?: string;
  personId?: string;
  eventId?: string;
  category?: MemoryCategory;
  from?: string;
  to?: string;
  includeHistorical?: boolean;
  limit?: number;
}

export interface MemoryPerson {
  id?: string;
  name: string;
  aliases?: string[];
  version?: number;
  memoryIds: string[];
  confirmedCount: number;
  memoryCount?: number;
}

export type MemoryView = "records" | "all" | "profile" | "timeline" | "draft" | "confirmed" | "rejected" | "forgotten";

export interface MemoryPageQuery {
  space?: MemorySpace;
  view?: MemoryView;
  query?: string;
  person?: string;
  personId?: string;
  from?: string;
  to?: string;
  conversationId?: string;
  limit?: number;
  cursor?: string;
}

export interface PageInfo {
  total: number;
  nextCursor: string | null;
  revision: number;
}

export interface MemoryPage extends PageInfo {
  memories: (MemoryEntry & { sourceSuppressed?: boolean })[];
}

export interface MemoryPeoplePage extends PageInfo {
  people: MemoryPerson[];
}

export interface MemoryCounts {
  total: number;
  confirmed: number;
  draft: number;
  rejected: number;
  forgotten: number;
}

export interface MemoryImportChunk {
  id: string;
  assetId: string;
  name: string;
  sha256: string;
  start: number;
  end: number;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  stage?: "read" | "extract" | "validate" | "save";
  attempts: number;
  memoryIds: string[];
  error?: string;
  usage?: { input: number; output: number };
  media?: "image" | "video";
  video?: VideoInfo & { timestamp: number; sampleInterval: number };
  reason?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  preparationFailed?: boolean;
}

export interface MemoryImportJob {
  id: string;
  title: string;
  space: MemorySpace;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  chunks: MemoryImportChunk[];
  createdAt: string;
  updatedAt: string;
  recoveries: number;
  mode?: "photos" | "auto";
  revision?: number;
  ownership?: "task" | "library";
  assets?: { assetId: string; name: string; sha256: string; duplicateOf?: string; video?: VideoInfo & { sampleInterval: number; frames: number; coverage: "sampled-frames" } }[];
}

export type ProcessingAssetResult = NonNullable<MemoryImportJob["assets"]>[number] & {
  status: "completed" | "reused" | "failed" | "pending" | "blocked";
  models: string[];
  observations: number;
  chunks: { total: number; completed: number; failed: number };
  error?: string;
  reason?: string;
};

export interface MemoryOverview {
  memories: MemoryPage["memories"];
  people: MemoryPerson[];
  jobs: MemoryImportJob[];
  conflicts: Record<string, string[]>;
  captures?: MemoryCaptureJob[];
  settings?: MemorySettings;
  revision?: number;
  pagination?: PageInfo;
  peoplePagination?: PageInfo;
  counts?: MemoryCounts;
  activeJobs?: boolean;
  features?: MemoryFeatureStatus;
}

export interface MemoryFeatureStatus {
  state: "not_configured" | "starting" | "ready" | "unavailable";
  jobs: { queued: number; running: number; completed: number; failed: number; skipped: number };
  models?: Record<"text" | "image" | "face", { id: string; revision: string; dimensions: number }>;
  fingerprint?: string;
  device?: "cpu";
  network: boolean;
  identity: "candidate-association";
}

export interface MemoryObservation {
  id: string;
  space: MemorySpace;
  kind: "source" | "face" | "metadata";
  assetId?: string;
  evidence: MemoryEvidence[];
  processor: string;
  output: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryEntity {
  id: string;
  space: MemorySpace;
  version: number;
  personId?: string;
  state: "unknown" | "identified" | "merged";
  mergedInto?: string;
  reason?: string;
  updatedAt: string;
}

export interface EntityObservation {
  observationId: string;
  status: "candidate" | "confirmed";
  score: number | null;
  observation: MemoryObservation;
}

export interface MemoryEntitySummary extends MemoryEntity {
  personName?: string;
  observationCount: number;
  observations: EntityObservation[];
}

export interface MemoryEntityPage extends PageInfo { entities: MemoryEntitySummary[] }
