"use client";
import type { ChatMessage } from "@memory/contracts";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { ToolActivity } from "./tool-activity";
import { Markdown } from "./run-thread";
import { toolUI } from "@/lib/tool-ui";

/** Existing Pi history uses the same official components as current task events. */
export function LegacyMessages({ messages }: { messages: ChatMessage[] }) {
  return messages.map((message) => <Message key={message.id} from={message.role}><MessageContent>
    {message.parts?.length ? message.parts.map((part, index) => part.type === "tool" ? <ToolActivity key={index} part={toolUI(part)} />
      : part.type === "reasoning" ? <Reasoning key={index} defaultOpen={false}><ReasoningTrigger getThinkingMessage={() => "思考过程"} /><ReasoningContent>{part.text}</ReasoningContent></Reasoning>
      : <Markdown key={index} content={part.text || ""} />) : <Markdown content={message.text} />}
  </MessageContent></Message>);
}
