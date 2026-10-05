import type { MemoryEvidence, MemoryEntry } from "./memory.js";

/** A reversible organization view. Confirmation applies to the displayed activity, not every source claim. */
export interface MemoryActivity {
  id: string;
  version: number;
  title: string;
  summary: string;
  occurredAt: string;
  place: string;
  status: "candidate" | "confirmed" | "rejected" | "superseded";
  members: { id: string; version: number }[];
  sources: MemoryEvidence[];
  entityIds: string[];
  issues: string[];
  reason: string;
  modelId?: string;
  eventMemoryId?: string;
  relatedActivityId?: string;
  replacedBy?: string;
  replacementIds?: string[];
  stale?: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryActivityDetail {
  activity: MemoryActivity;
  memories: Pick<MemoryEntry, "id" | "version" | "title" | "content" | "status" | "occurredAt" | "uncertainty" | "sources">[];
  history: MemoryActivity[];
}

export interface ActivityChange {
  action: "confirm-activity" | "correct-activity" | "reject-activity" | "merge-activities" | "split-activity";
  refs: { id: string; version: number }[];
  values?: { title: string; summary: string; occurredAt: string; place: string };
  memoryIds?: string[];
  reason: string;
}
