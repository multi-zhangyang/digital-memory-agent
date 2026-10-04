import type { ExtensionFactory, ExtensionUIContext, PromptTemplate, Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RuntimeContextPolicy } from "../../harness/context-policy.js";

/** The application supplies policy and capabilities; this port contains no business storage. */
export interface PiHost {
  readonly sessionsDir: string;
  readonly systemPrompt: string;
  readonly context: RuntimeContextPolicy;
  project(conversationId: string): { directory: string; instructions: string; disabledTools: string[] };
  settings(): { retry: boolean; autoCompaction: boolean };
  resources(conversationId: string, statuses: Record<string, string>): Promise<{
    skills: Skill[];
    prompts: PromptTemplate[];
    agentsFiles: Array<{ path: string; content: string }>;
    ui: ExtensionUIContext;
    extensions: ExtensionFactory[];
  }>;
  tools(conversationId: string): ToolDefinition[];
  settled(runId: string, entryId: string | undefined, queued: { steering: string[]; followUp: string[] }): void;
}
