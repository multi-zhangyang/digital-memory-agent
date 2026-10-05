import { describe, expect, it } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { applyPartEvent, isPartEventType } from "@memory/contracts/execution";
import type { ChatPart, ExecutionEvent, PartEvent } from "@memory/contracts";
import { PiTranscript } from "../src/integrations/pi/transcript.js";
import { sessionTree } from "../src/integrations/pi/session-tree.js";

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "openai-completions",
  provider: "fixture", model: "fixture", timestamp: Date.now(), stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

describe("Pi presentation adapter (protocol fixtures, no model quality claims)", () => {
  it("reconciles missing text deltas from message_end and resolves actual Pi entry IDs after append", () => {
    const manager = SessionManager.inMemory();
    let parts: ChatPart[] = [];
    const events: ExecutionEvent[] = [];
    const transcript = new PiTranscript({ sessionManager: manager } as AgentSession, (event) => {
      events.push(event); if (isPartEventType(event.type)) parts = applyPartEvent(parts, event as PartEvent);
    }, "run:input", true);
    const user = { role: "user" as const, content: "协议测试", timestamp: Date.now() };
    transcript.event({ type: "message_start", message: user });
    transcript.event({ type: "message_end", message: user });
    const userId = manager.appendMessage(user);
    const message = assistant([{ type: "text", text: "完整的最终回答" }]);
    transcript.event({ type: "message_start", message });
    transcript.event({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完整", partial: message } });
    transcript.event({ type: "message_end", message });
    const assistantId = manager.appendMessage(message);
    transcript.flush();
    expect(parts.filter((part) => part.type === "text")).toMatchObject([{ text: "完整的最终回答", entryId: assistantId }]);
    expect(parts[0]).toMatchObject({ id: "run:input", entryId: userId, initial: true, state: "complete" });
    expect(events.filter((event) => event.type === "message-entry")).toHaveLength(2);
  });

  it("keeps parallel calls, partial arguments, nested output and final snapshots on their own identities", () => {
    let parts: ChatPart[] = [];
    const emit = (event: PartEvent) => { parts = applyPartEvent(parts, event); };
    emit({ type: "message-start", id: "a", role: "assistant", turnId: "turn" });
    emit({ type: "tool-input", id: "first", messageId: "a", name: "read", input: { path: "par" }, contentIndex: 0 });
    emit({ type: "tool-input", id: "second", messageId: "a", name: "bash", input: {}, contentIndex: 1 });
    emit({ type: "tool-input", id: "first", messageId: "a", name: "read", input: { path: "partial.md" }, contentIndex: 0 });
    emit({ type: "tool-start", id: "first", messageId: "a", name: "read", input: { path: "partial.md" } });
    emit({ type: "tool-start", id: "second", messageId: "a", name: "bash", input: { command: "example" } });
    emit({ type: "tool-start", id: "nested", messageId: "a", parentToolCallId: "second", name: "nested", input: {} });
    emit({ type: "tool-update", id: "second", output: "partial stdout" });
    emit({ type: "tool-end", id: "nested", output: "nested result", error: false });
    emit({ type: "tool-end", id: "second", output: "final stdout", error: false });
    emit({ type: "tool-end", id: "first", output: "file contents", error: false });
    emit({ type: "message-end", id: "a", state: "complete", parts: [
      { type: "tool", id: "first", toolCallId: "first", messageId: "a", name: "read", input: { path: "partial.md" }, state: "input" },
      { type: "tool", id: "second", toolCallId: "second", messageId: "a", name: "bash", input: { command: "example" }, state: "input" },
    ] });
    const tools = parts.filter((part) => part.type === "tool");
    expect(tools.map((part) => part.toolCallId)).toEqual(["first", "second", "nested"]);
    expect(tools.map((part) => part.output)).toEqual(["file contents", "final stdout", "nested result"]);
    expect(tools.every((part) => part.state === "complete")).toBe(true);
    expect(tools[2].parentToolCallId).toBe("second");
  });

  it("retains filtered intermediate parents and identifies only the selected native branch", () => {
    const manager = SessionManager.inMemory();
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    manager.appendCustomMessageEntry("private-context", "hidden", false);
    const first = manager.appendMessage(assistant([{ type: "text", text: "first" }]));
    manager.branch(root);
    const second = manager.appendMessage(assistant([{ type: "text", text: "second" }]));
    expect(sessionTree(manager)).toMatchObject([
      { id: root, parentId: null, active: true },
      { id: first, parentId: root, active: false },
      { id: second, parentId: root, active: true },
    ]);
  });
});
