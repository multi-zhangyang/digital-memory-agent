import type { ToolInfo } from "./index.js";
export interface CapabilityStatus {
  id: string;
  label: string;
  tasks: string[];
  kind: "harness" | "service";
  implemented: boolean;
  configured: boolean;
  available: boolean;
  verification: "not-verified" | "protocol-tested" | "quality-evaluated";
  detail?: string;
  tools: string[];
}
export interface CapabilitySnapshot {
  profile: { id: string; version: number };
  capabilities: CapabilityStatus[];
  tools: ToolInfo[];
}
