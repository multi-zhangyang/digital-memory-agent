import type { ThinkingLevel } from "./models.js";
import type { Asset, SourceRef } from "./assets.js";
import type { FileChange, PermissionMode, ProjectFileReference, RunIntervention } from "./harness.js";
import type { MemoryEntry, MemoryRetrievalTrace } from "./memory.js";

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  projectId?: string;
  parentId?: string;
  pinned?: boolean;
  archived?: boolean;
  status?: RunStatus;
  waitingFor?: "jobs" | "user" | "approval" | "recovery" | null;
}

export interface ChatPartPosition {
  id?: string;
  messageId?: string;
  turnId?: string;
  entryId?: string;
  contentIndex?: number;
}

export type ChatPart = ChatPartPosition & (
  | { type: "message"; role: "user" | "assistant"; text?: string; state: "streaming" | "complete" | "error" | "interrupted"; initial?: boolean }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "notice"; text: string; state: "running" | "complete" | "error" }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      input: unknown;
      state: "input" | "running" | "complete" | "error" | "interrupted";
      output?: unknown;
      errorText?: string;
      parentToolCallId?: string;
      stepId?: string;
      startedAt?: string;
      finishedAt?: string;
    });

export interface ToolInfo {
  name: string;
  label: string;
  access: "read" | "write";
  group?: "assets" | "memory" | "workspace";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  status: "complete" | "interrupted" | "error";
  parts?: ChatPart[];
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";

export interface PlanStep {
  id?: string;
  title: string;
  status: "pending" | "running" | "completed";
  resultIds?: string[];
}

export interface RunRecovery {
  state: "ready" | "review" | "blocked";
  reason: string;
  attempts: number;
  pendingToolIds: string[];
  decisions?: { toolCallId: string; action: "skip" | "retry" }[];
}
export interface RunCheckpoint {
  version: 1;
  configuration: string;
  entryId?: string;
  savedAt: string;
}

export interface RunInput {
  text: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  assetIds?: string[];
  fileReferences?: ProjectFileReference[];
  scope?: "selected" | "library";
  useMemory?: boolean;
  captureMemory?: boolean;
  retryOf?: string;
  permissionMode?: PermissionMode;
}

export interface Run extends RunInput {
  /** Harness default for attachment-only requests; never treated as the user's words. */
  goal?: string;
  id: string;
  conversationId: string;
  status: RunStatus;
  assetIds: string[];
  scope: "selected" | "library";
  useMemory: boolean;
  parts: ChatPart[];
  presentationVersion?: 2;
  phase?: "generating" | "tools" | "compacting" | "retrying" | "settled";
  stopRequestedAt?: string;
  inputEntryId?: string;
  extensionUI?: import("./harness.js").ExtensionPresentation;
  /** A response-only window into a run; never persisted as execution state. */
  window?: { start: number; end: number };
  sources: SourceRef[];
  memoryIds: string[];
  memoryRevision?: number;
  memoryEpoch?: number;
  memoryContextReset?: { toolCallId: string; epoch: number; commandId: string };
  memoryTraces?: MemoryRetrievalTrace[];
  captureJobIds?: string[];
  jobs?: TaskJob[];
  waitingFor?: "jobs" | "user" | "approval" | "recovery" | null;
  checkpoint?: RunCheckpoint;
  recovery?: RunRecovery;
  receipts?: { toolCallId: string; name: string; output: unknown }[];
  jobNotification?: { id: string; content: unknown };
  plan: PlanStep[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cursor: number;
  interventions?: RunIntervention[];
  entryId?: string;
  changes?: FileChange[];
  question?: { id?: string; toolCallId?: string; text: string; options: string[]; answer?: string };
  questions?: NonNullable<Run["question"]>[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    context: number;
  };
}

export interface TaskJob {
  id: string;
  kind: string;
  toolCallId: string;
  title: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  revision: number;
  progress: { completed: number; total: number; failed: number };
  coverage?: { total: number; completed: number; reused: number; failed: number; pending: number; blocked: number };
  updatedAt: string;
  ownership?: "task" | "library";
  blockedReason?: string;
  actions?: ("retry" | "cancel")[];
}

export interface RunEvent {
  seq: number;
  runId: string;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface Artifact {
  id: string;
  conversationId: string;
  runId: string;
  title: string;
  content: string;
  sources: SourceRef[];
  version: number;
  author: "agent" | "user";
  memoryEpoch?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDetail {
  presentation?: import("./harness.js").ExtensionPresentation;
  conversation: Conversation;
  runs: Run[];
  assets: Asset[];
  artifacts: Artifact[];
  memories: MemoryEntry[];
  legacyMessages: ChatMessage[];
  page?: { before: string | null; hasMore: boolean };
  activeEntryIds?: string[];
}

export interface AssetCollection {
  id: string;
  title: string;
  assetIds: string[];
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}
