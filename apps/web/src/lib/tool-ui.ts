import type { ChatPart } from "@memory/contracts";
import type { ToolUIPart } from "ai";
export function toolUI(part: Extract<ChatPart, { type: "tool" }>): ToolUIPart {
  return {
    type: "tool-" + part.name,
    toolCallId: part.toolCallId,
    input: part.input,
    state:
      part.state === "running"
        ? "input-available"
        : part.state === "complete"
          ? "output-available"
          : "output-error",
    output: part.output,
    errorText: part.state === "interrupted" ? "已停止" : part.errorText,
  } as ToolUIPart;
}
