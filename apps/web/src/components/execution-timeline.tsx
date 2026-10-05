"use client";

import { memo, type ReactNode } from "react";
import type { ChatPart, Run } from "@memory/contracts";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import { ToolActivity } from "./tool-activity";
import { Markdown } from "./markdown";
import { RunJobs } from "./run-jobs";
import { toolUI } from "@/lib/tool-ui";
import { isActive } from "@/lib/workbench";

type Group = { id: string; role: "user" | "assistant"; parts: ChatPart[]; marker?: Extract<ChatPart, { type: "message" }> };

export function transcriptGroups(parts: ChatPart[]): Group[] {
  const groups: Group[] = [];
  let group: Group | undefined;
  for (const part of parts) {
    if (part.type === "message") {
      if (part.initial) { group = undefined; continue; }
      group = { id: part.id!, role: part.role, marker: part, parts: [] };
      groups.push(group);
      continue;
    }
    if (!group || (part.messageId && group.id !== part.messageId)) {
      group = groups.find((item) => item.id === part.messageId);
      if (!group) { group = { id: part.messageId || "legacy-" + groups.length, role: "assistant", parts: [] }; groups.push(group); }
    }
    group.parts.push(part);
  }
  return groups;
}

const TimelinePart = memo(function TimelinePart({ part, streaming, children }: { part: ChatPart; streaming: boolean; children?: ReactNode }) {
  if (part.type === "text") return part.text ? <Markdown content={part.text} /> : null;
  if (part.type === "reasoning") return part.text ? <Reasoning isStreaming={streaming} defaultOpen={false}>
    <ReasoningTrigger getThinkingMessage={(active) => active ? "思考中" : "思考过程"} />
    <ReasoningContent>{part.text}</ReasoningContent>
  </Reasoning> : null;
  if (part.type === "notice") return <Checkpoint data-state={part.state}>
    <CheckpointIcon /><CheckpointTrigger disabled>{part.text}</CheckpointTrigger>
  </Checkpoint>;
  if (part.type === "tool") return <div className="flex min-w-0 flex-col gap-2" data-tool-call-id={part.toolCallId}>
    <ToolActivity part={toolUI(part)} />{children}
  </div>;
  return null;
});

export const ExecutionTimeline = memo(function ExecutionTimeline({ run, activeEntryIds }: { run: Run; activeEntryIds?: string[] }) {
  const branch = activeEntryIds && new Set(activeEntryIds);
  const groups = transcriptGroups(run.parts).filter((group) => !branch || !group.marker?.entryId || branch.has(group.marker.entryId));
  const active = isActive(run);
  const tools = groups.flatMap((group) => group.parts.filter((part): part is Extract<ChatPart, { type: "tool" }> => part.type === "tool"));
  const toolIds = new Set(tools.map((part) => part.toolCallId));
  const nested = new Map<string, typeof tools>();
  for (const tool of tools) if (tool.parentToolCallId) nested.set(tool.parentToolCallId, [...(nested.get(tool.parentToolCallId) || []), tool]);
  const renderPart = (part: ChatPart, index: number, streaming: boolean, ancestors = new Set<string>()): ReactNode => {
    if (part.type === "tool" && ancestors.has(part.toolCallId)) return null;
    const lineage = part.type === "tool" ? new Set([...ancestors, part.toolCallId]) : ancestors;
    return <TimelinePart key={part.id || (part.type === "tool" ? part.toolCallId : index)} part={part} streaming={streaming}>
      {part.type === "tool" && <>
        {(nested.get(part.toolCallId) || []).map((child, i) => <div key={child.id || child.toolCallId} className={ancestors.size < 2 ? "ml-4 border-l pl-4" : "border-l pl-2"}>
          {renderPart(child, i, active, lineage)}
        </div>)}
        <RunJobs jobs={(run.jobs || []).filter((job) => job.toolCallId === part.toolCallId)} />
      </>}
    </TimelinePart>;
  };
  return <div className="flex min-w-0 flex-col gap-6" data-testid="execution-timeline">
    {groups.map((group) => <Message key={group.id} from={group.role} className="max-w-full" data-message-id={group.id}>
      <MessageContent className="flex w-full min-w-0 flex-col gap-4">
        {group.role === "user" && group.marker?.text && <p className="whitespace-pre-wrap">{group.marker.text}</p>}
        {group.parts.filter((part) => part.type !== "tool" || !part.parentToolCallId || !toolIds.has(part.parentToolCallId)).map((part, index) =>
          renderPart(part, index, active && group.marker?.state === "streaming" && part === group.parts.at(-1)))}
      </MessageContent>
    </Message>)}
  </div>;
});
