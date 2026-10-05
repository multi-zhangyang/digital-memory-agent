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
  status: "queued" | "delivered" | "returned" | "handled";
  createdAt: string;
}

export interface AgentApproval {
  toolCallId?: string;
  consumedBy?: string;
  id: string;
  runId: string;
  title: string;
  detail: string;
  kind: "tool" | "confirm" | "input" | "select";
  options: string[];
  status: "pending" | "approved" | "denied";
  answer?: string;
  prefill?: string;
  placeholder?: string;
  expiresAt?: string;
  resolution?: "user" | "expired" | "cancelled";
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
  exposure?: "direct" | "deferred";
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
  kind?: string;
}

export interface ExtensionPresentation {
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;
  editor?: { text: string; revision: string; source?: "extension" | "user" };
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
  tools: Array<{ name: string; active: boolean; description: string; disabled?: boolean; exposure?: string }>;
  nodes: SessionNode[];
  skills: string[];
  prompts: string[];
  statuses: Record<string, string>;
  leafId?: string | null;
  presentation?: ExtensionPresentation;
  resources?: Array<{ name: string; kind: "skill" | "prompt" | "mcp"; state: "configured" | "loaded" | "error"; detail?: string }>;
}
