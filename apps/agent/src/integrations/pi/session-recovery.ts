import { runToolCall } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Run } from "@memory/contracts";
import type { RuntimeEvent } from "../../harness/runtime.js";
import { UserFacingError } from "../../errors.js";
import { toolOutput } from "./tool-output.js";

const resultType = "digital-memory-resumed-tool";

/** Immutable recovery entries retain the original wait and the actual later result. */
export function resumedToolResults(manager: SessionManager) {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of manager.getBranch()) if (entry.type === "custom" && entry.customType === resultType) {
    const result = entry.data as ToolResultMessage;
    if (result?.role === "toolResult") results.set(result.toolCallId, result);
  }
  return results;
}

export async function resumeSessionTools(session: AgentSession, run: Run, approvedCalls: string[], signal: AbortSignal,
  receive: (event: RuntimeEvent) => void, waiting: () => boolean) {
  const save = (result: ToolResultMessage) => {
    session.sessionManager.appendCustomEntry(resultType, result);
    receive({ type: "tool-end", id: result.toolCallId, output: toolOutput(result), error: result.isError });
  };
  if (run.question?.answer && run.question.toolCallId) save({ role: "toolResult", toolCallId: run.question.toolCallId,
    toolName: "ask_user", content: [{ type: "text", text: JSON.stringify({ answer: run.question.answer }) }], isError: false, timestamp: Date.now() });
  for (const toolCallId of approvedCalls) {
    signal.throwIfAborted();
    const receipt = run.receipts?.find((item) => item.toolCallId === toolCallId);
    // An atomic business receipt wins even if the process stopped before Pi recorded its result.
    if (receipt) { save({ role: "toolResult", toolCallId, toolName: receipt.name, content: [{ type: "text", text: JSON.stringify(receipt.output) }], isError: false, timestamp: Date.now() }); continue; }
    const original = session.sessionManager.getEntries().slice().reverse().find((entry) => entry.type === "message" &&
      entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
    if (original?.type !== "message" || original.message.role !== "assistant")
      throw new UserFacingError(409, "RECOVERY_CALL_MISSING", "审批的原始工具调用不可用，请核对会话记录");
    const call = original.message.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
    if (call?.type !== "toolCall") throw new Error("Missing approved tool call");
    receive({ type: "tool-start", id: call.id, name: call.name, input: call.arguments });
    // Official Pi pipeline: arguments, disabled tools, permissions, sandbox and hooks all apply.
    const outcome = await runToolCall(call, { assistantMessage: original.message,
      tools: session.agent.state.tools, context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
      beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall, signal,
      onUpdate: (value) => receive({ type: "tool-update", id: call.id, output: toolOutput(value) }) });
    save({ ...outcome.result, role: "toolResult", toolCallId: call.id, toolName: call.name, isError: outcome.isError, timestamp: Date.now() });
    if (waiting()) break;
  }
}
