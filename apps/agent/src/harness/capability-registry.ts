import type { CapabilitySnapshot, CapabilityStatus, ToolInfo } from "@memory/contracts";
import { digitalMemoryProfile } from "./product-profile.js";

/** A single catalog drives execution registration and the workbench's availability display. */
export class CapabilityRegistry<T extends { name: string }> {
  constructor(private readonly contributions: { catalog: ToolInfo[]; create: (conversationId: string) => T[] }[], private readonly statuses: () => CapabilityStatus[]) {}
  tools(conversationId: string): T[] {
    const tools = this.contributions.flatMap((entry) => entry.create(conversationId));
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Duplicate capability tool");
    return tools;
  }
  catalog(): ToolInfo[] { return this.contributions.flatMap((entry) => entry.catalog); }
  snapshot(): CapabilitySnapshot {
    return { profile: { id: digitalMemoryProfile.id, version: digitalMemoryProfile.version }, capabilities: this.statuses(), tools: this.catalog() };
  }
}
