import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatPart, ChatPartPosition, ExecutionEvent } from "@memory/contracts";
import { toolOutput } from "./tool-output.js";

type PiEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** Translate presentation only; AgentSession continues to own every execution decision. */
export class PiTranscript {
  private turnId = randomUUID();
  private assistantId = "";
  private userId = "";
  private initial = true;
  private readonly calls = new Map<string, ChatPartPosition>();
  private readonly completed: { message: unknown; id: string; initial: boolean }[] = [];
  constructor(private readonly session: AgentSession, private readonly receive: (event: ExecutionEvent) => void,
    private readonly inputId: string, private readonly hasInitialInput: boolean) {}

  flush() {
    if (!this.completed.length) return;
    // Pi emits message_end before appending it. Resolve the entry at the next event/settle.
    const entries = this.session.sessionManager.getEntries();
    for (let index = this.completed.length - 1; index >= 0; index--) {
      const pending = this.completed[index];
      const entry = entries.find((entry) => entry.type === "message" && entry.message === pending.message);
      if (!entry) continue;
      this.receive({ type: "message-entry", id: pending.id, entryId: entry.id, initial: pending.initial });
      this.completed.splice(index, 1);
    }
  }

  event(event: PiEvent) {
    this.flush();
    if (event.type === "turn_start") {
      this.turnId = randomUUID();
      this.receive({ type: "phase", phase: "generating" });
    }
    if (event.type === "message_start" && (event.message.role === "assistant" || event.message.role === "user")) {
      const initial = event.message.role === "user" && this.initial && this.hasInitialInput;
      const id = initial ? this.inputId : randomUUID();
      if (event.message.role === "assistant") this.assistantId = id;
      else { this.userId = id; this.initial = false; }
      this.receive({ type: "message-start", id, role: event.message.role, turnId: this.turnId, initial,
        ...(event.message.role === "user" ? { text: typeof event.message.content === "string" ? event.message.content : event.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") } : {}),
      });
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!("contentIndex" in update)) return;
      const index = update.contentIndex;
      const position = { id: this.assistantId + ":" + index, messageId: this.assistantId, turnId: this.turnId, contentIndex: index };
      if (update.type === "text_delta" || update.type === "thinking_delta")
        this.receive({ type: update.type === "text_delta" ? "text" : "reasoning", ...position, delta: update.delta });
      if (["toolcall_start", "toolcall_delta", "toolcall_end"].includes(update.type)) {
        const part = update.partial.content[index];
        if (part?.type === "toolCall" && part.id) {
          this.calls.set(part.id, position);
          this.receive({ type: "tool-input", ...position, id: part.id, name: part.name, input: part.arguments });
        }
      }
    }
    if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "user")) {
      const message = event.message;
      const id = message.role === "assistant" ? this.assistantId : this.userId;
      if (!id) return;
      this.completed.push({ message, id, initial: id === this.inputId });
      const parts: ChatPart[] = message.role === "assistant" ? message.content.flatMap((part, index): ChatPart[] => {
        const position = { id: id + ":" + index, messageId: id, turnId: this.turnId, contentIndex: index };
        if (part.type === "text") return [{ ...position, type: "text", text: part.text }];
        if (part.type === "thinking") return [{ ...position, type: "reasoning", text: part.thinking }];
        if (part.type === "toolCall") {
          this.calls.set(part.id, position);
          return [{ ...position, id: part.id, type: "tool", toolCallId: part.id, name: part.name, input: part.arguments, state: "input" }];
        }
        return [];
      }) : [];
      this.receive({ type: "message-end", id, parts, state: message.role === "assistant" && message.stopReason === "error" ? "error"
        : message.role === "assistant" && message.stopReason === "aborted" ? "interrupted" : "complete" });
    }
    if (event.type === "tool_execution_start") {
      this.receive({ type: "phase", phase: "tools" });
      this.receive({ type: "tool-start", ...(this.calls.get(event.toolCallId) || (event.parentToolCallId ? this.calls.get(event.parentToolCallId) : undefined)),
        id: event.toolCallId, name: event.toolName, input: event.args, parentToolCallId: event.parentToolCallId });
    }
    if (event.type === "tool_execution_update") this.receive({ type: "tool-update", id: event.toolCallId, output: toolOutput(event.partialResult) });
    if (event.type === "tool_execution_end") this.receive({ type: "tool-end", id: event.toolCallId, output: toolOutput(event.result), error: event.isError });
    if (event.type === "agent_settled") { this.flush(); this.receive({ type: "phase", phase: "settled" }); }
  }
}
