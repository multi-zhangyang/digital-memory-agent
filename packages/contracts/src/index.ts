export type ProviderId = string;
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ModelProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";
export interface ConnectionSettings {
  enabled: boolean;
  baseUrl: string;
  modelName: string;
  protocol: ModelProtocol;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
}
export interface ConnectionUpdate extends ConnectionSettings {
  apiKey?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  supportsImages: boolean;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
}

export interface ProviderStatus extends ConnectionSettings {
  id: ProviderId;
  name: string;
  configured: boolean;
  missing: string[];
  hasApiKey: boolean;
}

export interface ModelConfiguration {
  models: ModelInfo[];
  providers: ProviderStatus[];
}

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
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "notice"; text: string; state: "running" | "complete" | "error" }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      input: unknown;
      state: "running" | "complete" | "error" | "interrupted";
      output?: unknown;
      errorText?: string;
      parentToolCallId?: string;
      startedAt?: string;
      finishedAt?: string;
    };

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

export type AssetKind = "image" | "video" | "text" | "file";

export interface Asset {
  id: string;
  name: string;
  mimeType: string;
  kind: AssetKind;
  size: number;
  sha256: string;
  createdAt: string;
  memorySpace?: MemorySpace;
}

export interface AppHealth {
  status: "ok";
  capabilities: {
    chat: boolean;
    assets: true;
    memory: boolean;
    people: false;
    training: false;
  };
}

export interface ApiError {
  error: { code: string; message: string };
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";
export interface SourceRef {
  assetId: string;
  name: string;
  sha256: string;
  start: number;
  end: number;
  quote?: string;
}
export interface PlanStep {
  title: string;
  status: "pending" | "running" | "completed";
}
export interface RunInput {
  text: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  assetIds?: string[];
  fileReferences?: ProjectFileReference[];
  scope?: "selected" | "library";
  useMemory?: boolean;
  retryOf?: string;
  permissionMode?: PermissionMode;
}
export interface Run extends RunInput {
  id: string;
  conversationId: string;
  status: RunStatus;
  assetIds: string[];
  scope: "selected" | "library";
  useMemory: boolean;
  parts: ChatPart[];
  sources: SourceRef[];
  memoryIds: string[];
  plan: PlanStep[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cursor: number;
  interventions?: RunIntervention[];
  entryId?: string;
  changes?: FileChange[];
  question?: { text: string; options: string[]; answer?: string };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    context: number;
  };
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
  createdAt: string;
  updatedAt: string;
}
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
}
export interface MemorySearch {
  query?: string;
  space?: MemorySpace;
  person?: string;
  category?: MemoryCategory;
  from?: string;
  to?: string;
  includeHistorical?: boolean;
  limit?: number;
}
export interface MemoryPerson {
  name: string;
  memoryIds: string[];
  confirmedCount: number;
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
}
export interface MemoryOverview {
  memories: MemoryEntry[];
  people: MemoryPerson[];
  jobs: MemoryImportJob[];
  conflicts: Record<string, string[]>;
}
export interface WorkspaceDetail {
  conversation: Conversation;
  runs: Run[];
  assets: Asset[];
  artifacts: Artifact[];
  memories: MemoryEntry[];
  legacyMessages: ChatMessage[];
}
export interface AssetCollection {
  id: string;
  title: string;
  assetIds: string[];
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionMode = "read" | "ask" | "auto";
export interface Project {
  id: string;
  name: string;
  directory: string;
  directoryKind: "managed" | "local";
  available: boolean;
  instructions: string;
  permissionMode: PermissionMode;
  disabledTools: string[];
  network: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DirectoryEntry {
  name: string;
  path: string;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  shortcuts: DirectoryEntry[];
  host: string;
  canOpen: boolean;
  total: number;
  nextOffset: number | null;
}
export interface ProjectFile {
  path: string;
  size: number;
  directory: boolean;
  modifiedAt: string;
}
export interface ProjectFileReference {
  path: string;
  runId?: string;
}
export interface FileRevision {
  path: string;
  hash: string;
  content: string | null;
  size: number;
}
export interface FileChange {
  path: string;
  before: FileRevision | null;
  after: FileRevision | null;
  status: "added" | "modified" | "deleted";
}
export interface RunIntervention {
  mode?: "steer" | "followUp";
  id: string;
  text: string;
  status: "queued" | "delivered" | "returned";
  createdAt: string;
}
export interface AgentApproval {
  id: string;
  runId: string;
  title: string;
  detail: string;
  kind: "tool" | "confirm" | "input" | "select";
  options: string[];
  status: "pending" | "approved" | "denied";
  answer?: string;
  createdAt: string;
}
export interface AgentResource {
  id: string;
  kind: "skill" | "prompt";
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}
export interface McpConnection {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string;
  command: string;
  args: string[];
  enabled: boolean;
  hasSecrets?: boolean;
}
export interface HarnessSettings {
  search: { enabled: boolean; configured: boolean };
  resources: AgentResource[];
  mcp: McpConnection[];
  autoCompaction: boolean;
  retry: boolean;
  sandbox: { available: boolean; kind: string };
}
export interface SessionNode {
  id: string;
  parentId: string | null;
  role: string;
  text: string;
  createdAt: string;
  active: boolean;
}
export interface SessionState {
  sessionId: string;
  modelId?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  context: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  tools: Array<{ name: string; active: boolean; description: string }>;
  nodes: SessionNode[];
  skills: string[];
  prompts: string[];
  statuses: Record<string, string>;
}
