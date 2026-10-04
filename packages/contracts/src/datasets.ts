import type { TaskJob } from "./workspace.js";
import type { MemoryCategory, MemoryEvidence, MemorySpace } from "./memory.js";

export interface DatasetScope {
  memoryIds?: string[];
  assetIds?: string[];
  category?: MemoryCategory;
  personId?: string;
  eventId?: string;
  from?: string;
  to?: string;
}

export interface DatasetSampleSelection {
  view?: "all" | "review" | "ready" | "excluded";
  sampleIds?: string[];
}

export interface MemoryDataset {
  id: string;
  title: string;
  space: MemorySpace;
  status: TaskJob["status"];
  revision: number;
  format: "qa" | "narrative" | "mixed";
  policy: "grounded-v1";
  scope: DatasetScope;
  ledgerRevision: number;
  generation?: { strategy: "model"; modelId: string; version: number };
  audit?: DatasetAuditJob;
  usage?: { calls: number; input: number; output: number };
  rebuild?: {
    datasetId: string;
    revision: number;
    reuseSamples: boolean;
    addedMemories: number;
    removedMemories: number;
    updatedMemories: number;
    unchangedMemories: number;
    reusedMemories: number;
    reusedSamples: number;
  };
  stale: boolean;
  counts: { total: number; processed: number; ready: number; review: number; excluded: number; failed: number;
    samples: number; staleSamples: number };
  sampleCounts?: { ready: number; review: number; excluded: number };
  files?: Record<"training" | "review" | "manifest", { sha256: string; bytes: number }> &
    Partial<Record<"evaluation", { sha256: string; bytes: number }>>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingSample {
  id: string;
  datasetId: string;
  version: number;
  kind: "qa" | "narrative" | "combination";
  question: string;
  answer: string;
  status: "ready" | "review" | "excluded";
  stale: boolean;
  memoryRefs: { id: string; version: number }[];
  evidence: MemoryEvidence[];
  checks: string[];
  authority: "user-confirmed" | "policy-accepted" | "agent-reviewed" | "processor-reviewed" | "unreviewed";
  review?: { actor: "user" | "agent" | "processor"; reason: string; runId?: string; jobId?: string; modelId?: string; protocolVersion?: number; createdAt: string };
  intendedUse: "training" | "evaluation";
  evaluationOf?: { id: string; version: number };
  generation?: { modelId: string; version: number };
  quality?: SampleTimeQuality;
  reusedFrom?: { datasetId: string; sampleId: string; version: number };
}

export interface DatasetRebuildInput {
  datasetId: string;
  revision: number;
  requestKey: string;
}

export interface DatasetAuditJob {
  id: string;
  datasetId: string;
  datasetRevision: number;
  title: string;
  modelId: string;
  protocolVersion: number;
  mode: "pending" | "all";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  revision: number;
  counts: { total: number; processed: number; approved: number; revised: number; excluded: number; deferred: number; failed: number; retained: number; unsupported: number };
  usage: { calls: number; input: number; output: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetAuditDecision {
  id: string;
  previousVersion: number;
  version?: number;
  question: string;
  action: "approve" | "revise" | "exclude" | "defer";
  reason: string;
  status: "applied" | "failed";
  error?: string;
  followUp?: { version: number; status: "ready" | "review" | "excluded"; actor: "user" | "agent" | "processor"; reason: string };
}

export interface SampleTimeQuality {
  version: 1;
  issues: { code: string; severity: "blocking" | "review"; message: string; memoryId?: string }[];
}
