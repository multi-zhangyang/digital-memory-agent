import type { RuntimePromptOptions } from "./runtime.js";

export interface ContextMessage {
  customType: string;
  content: string;
  details: Record<string, unknown>;
}

/** Product policy supplies evidence and validity; the execution adapter owns Pi operations. */
export interface RuntimeContextPolicy {
  readonly messageType: string;
  readonly volatileTools: readonly string[];
  readonly expiredMessage: string;
  reset(conversationId: string, options?: RuntimePromptOptions): ContextMessage | undefined;
  validate(conversationId: string): void;
  replacement?(conversationId: string): Promise<{ toolCallId: string; content: string } | undefined>;
  completion?(conversationId: string, options?: RuntimePromptOptions): Promise<{ feedback: ContextMessage; code: string; message: string } | undefined>;
  prepare(conversationId: string, text: string, model: { contextWindow: number; maxTokens: number }, options?: RuntimePromptOptions): Promise<ContextMessage | undefined>;
}
