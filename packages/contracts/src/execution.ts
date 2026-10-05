import type { ChatPart, ChatPartPosition, Run } from "./workspace.js";

/** Presentation events retain Pi message/content identity. They never schedule work. */
export type PartEvent =
  | ({ type: "text"; delta: string } & ChatPartPosition)
  | ({ type: "reasoning"; delta: string } & ChatPartPosition)
  | { type: "message-start"; id: string; role: "user" | "assistant"; turnId: string; text?: string; initial?: boolean }
  | { type: "message-end"; id: string; parts: ChatPart[]; state: "complete" | "error" | "interrupted" }
  | { type: "message-entry"; id: string; entryId: string; initial?: boolean }
  | { type: "notice"; id?: string; text: string; state: "running" | "complete" | "error" }
  | ({ type: "tool-input"; id: string; name: string; input: unknown } & ChatPartPosition)
  | ({ type: "tool-start"; id: string; name: string; input: unknown; parentToolCallId?: string; stepId?: string; startedAt?: string } & ChatPartPosition)
  | { type: "tool-update"; id: string; output: unknown }
  | { type: "tool-end"; id: string; output: unknown; error: boolean; state?: "complete" | "error" | "interrupted"; finishedAt?: string };

export type ExecutionEvent = PartEvent
  | { type: "queue"; texts: readonly string[]; followUp: readonly string[]; cleared?: boolean }
  | { type: "phase"; phase: NonNullable<Run["phase"]> }
  | { type: "usage"; usage: NonNullable<Run["usage"]> };

const partTypes = new Set(["text", "reasoning", "message-start", "message-end", "message-entry", "notice", "tool-input", "tool-start", "tool-update", "tool-end"]);
export function isPartEventType(type: string): type is PartEvent["type"] { return partTypes.has(type); }

/** Shared immutable projection for durable snapshots and SSE replay. */
export function applyPartEvent(previous: ChatPart[], event: PartEvent): ChatPart[] {
  const parts = previous.slice();
  const update = (index: number, value: ChatPart) => { if (index < 0) parts.push(value); else parts[index] = value; };
  if (event.type === "message-start") {
    update(parts.findIndex((part) => part.type === "message" && part.id === event.id), {
      type: "message", id: event.id, messageId: event.id, turnId: event.turnId,
      role: event.role, text: event.text, initial: event.initial, state: "streaming",
    });
  } else if (event.type === "message-entry") {
    return parts.map((part) => part.messageId === event.id ? { ...part, entryId: event.entryId } : part);
  } else if (event.type === "message-end") {
    const marker = parts.findIndex((part) => part.type === "message" && part.id === event.id);
    if (marker < 0) return parts;
    const start = parts[marker];
    if (start.type !== "message") return parts;
    parts[marker] = { ...start, state: event.state };
    if (start.role === "user") return parts;
    const old = new Map(parts.filter((part) => part.messageId === event.id && part.type !== "message").map((part) => [part.id, part]));
    const completed = event.parts.map((part): ChatPart => {
      const known = old.get(part.id) || (part.type === "tool" ? parts.find((p) => p.type === "tool" && p.toolCallId === part.toolCallId) : undefined);
      return part.type === "tool" && known?.type === "tool"
        ? { ...known, ...part, state: known.state, output: known.output, errorText: known.errorText }
        : part;
    });
    const retained = parts.filter((part) => part.type === "message" || part.messageId !== event.id || (part.type === "tool" && !!part.parentToolCallId));
    retained.splice(retained.findIndex((part) => part.type === "message" && part.id === event.id) + 1, 0, ...completed);
    return retained;
  } else if (event.type === "text" || event.type === "reasoning") {
    const index = event.id ? parts.findIndex((part) => part.id === event.id) : parts.length - 1;
    const old = parts[index];
    if (old?.type === event.type && (!event.id || old.id === event.id)) parts[index] = { ...old, text: old.text + event.delta };
    else parts.push({ type: event.type, text: event.delta, id: event.id, messageId: event.messageId, turnId: event.turnId, contentIndex: event.contentIndex });
  } else if (event.type === "notice") {
    const index = event.id ? parts.findIndex((p) => p.type === "notice" && p.id === event.id)
      : event.state !== "running" ? parts.map((p, i) => p.type === "notice" && !p.id && p.state === "running" ? i : -1).reduce((a, b) => Math.max(a, b), -1) : -1;
    update(index, { ...event });
  } else if (event.type === "tool-input" || event.type === "tool-start") {
    const index = parts.findIndex((part) => part.type === "tool" && part.toolCallId === event.id);
    const old = parts[index];
    const running = event.type === "tool-start";
    update(index, { ...(old?.type === "tool" ? old : {}), type: "tool", id: event.id, toolCallId: event.id,
      name: event.name, input: event.input, state: running ? "running" : "input",
      ...(event.messageId ? { messageId: event.messageId, turnId: event.turnId, contentIndex: event.contentIndex } : {}),
      ...(running ? { parentToolCallId: event.parentToolCallId, stepId: event.stepId, startedAt: event.startedAt } : {}),
    });
  } else {
    const index = parts.findIndex((part) => part.type === "tool" && part.toolCallId === event.id);
    const part = parts[index];
    if (part?.type !== "tool") return parts;
    parts[index] = event.type === "tool-update" ? { ...part, output: event.output } : {
      ...part, output: event.output, state: event.state || (event.error ? "error" : "complete"),
      finishedAt: event.finishedAt, errorText: event.error ? (typeof event.output === "string" ? event.output : "工具执行失败") : undefined,
    };
  }
  return parts;
}
