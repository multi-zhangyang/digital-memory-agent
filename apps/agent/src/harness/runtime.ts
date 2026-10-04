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
}

export type RuntimeEvent =
  | { type: "text" | "reasoning"; delta: string }
  | { type: "notice"; text: string; state: "running" | "complete" | "error" }
  | { type: "tool-update"; id: string; output: unknown }
  | { type: "queue"; texts: readonly string[]; followUp: readonly string[] }
  | {
      type: "tool-start";
      id: string;
      name: string;
      input: unknown;
      parentToolCallId?: string;
    }
  | { type: "tool-end"; id: string; output: unknown; error: boolean }
  | { type: "usage"; usage: NonNullable<Run["usage"]> };

export interface AgentRuntime {
  state?(conversationId: string, modelId: string): Promise<SessionState>;
  steer?(
    conversationId: string,
    text: string,
    mode?: "steer" | "followUp",
  ): Promise<void>;
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
