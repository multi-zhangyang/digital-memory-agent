import type {
  ChatMessage,
  Run,
  ThinkingLevel,
  SessionState,
} from "@memory/contracts";

export interface RuntimePromptOptions {
  runId: string;
  thinkingLevel?: ThinkingLevel;
  notification?: { id: string; content: unknown };
  recovery?: { id: string; run: Run };
}

export type RuntimeEvent = import("@memory/contracts").ExecutionEvent;

export interface AgentRuntime {
  state?(conversationId: string, modelId: string): Promise<SessionState>;
  activeEntries?(conversationId: string): Promise<string[]>;
  steer?(
    conversationId: string,
    text: string,
    mode?: "steer" | "followUp",
  ): Promise<"queued" | "handled" | void>;
  clearQueue?(conversationId: string): Promise<{ steering: string[]; followUp: string[] }>;
  navigate?(conversationId: string, modelId: string, entryId: string): Promise<{ cancelled: boolean; editorText?: string }>;
  compact?(
    conversationId: string,
    modelId: string,
    instructions?: string,
  ): Promise<void>;
  fork?(
    conversationId: string,
    targetId: string,
    entryId?: string,
  ): Promise<void>;
  history(conversationId: string): Promise<ChatMessage[]>;
  prompt(
    conversationId: string,
    modelId: string,
    text: string,
    onEvent: (event: RuntimeEvent) => void,
    options?: RuntimePromptOptions,
  ): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  close(): Promise<void>;
  testConnection?(providerId: string): Promise<{ ok: true; latencyMs: number }>;
}

export { UserFacingError } from "../errors.js";
