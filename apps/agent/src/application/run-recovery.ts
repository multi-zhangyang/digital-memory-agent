import { createHash } from "node:crypto";
import type { Run, RunRecovery } from "@memory/contracts";
import type { Store } from "../store.js";
import { readOnlyTools } from "../permissions.js";

export function executionConfiguration(store: Store, run: Run) {
  const project = store.harness.project(store.harness.association(run.conversationId).projectId);
  return createHash("sha256").update(JSON.stringify({ project: { id: project.id, directory: project.directory, instructions: project.instructions,
    disabledTools: project.disabledTools, permissionMode: project.permissionMode }, modelId: run.modelId, permissionMode: run.permissionMode,
    scope: run.scope, assetIds: run.assetIds, resources: store.harness.settings.resources, mcp: store.harness.settings.mcp })).digest("hex");
}
export function recoveryState(store: Store, run: Run, reason: string): RunRecovery {
  const settled = new Set(run.receipts?.map((r) => r.toolCallId));
  const approvals = store.harness.approvals(run.id);
  const project = store.harness.project(store.harness.association(run.conversationId).projectId);
  const pendingToolIds = run.parts.flatMap((part) => part.type === "tool" && (["running", "interrupted"].includes(part.state) ||
    (part.state === "error" && (["write", "edit", "bash"].includes(part.name) || part.name.startsWith("mcp__")) &&
      (run.permissionMode || project.permissionMode) !== "read" && !project.disabledTools.includes(part.name) && !approvals.some((a) => a.toolCallId === part.toolCallId && a.status === "denied"))) &&
    !settled.has(part.toolCallId) && !["ask_user", "update_plan"].includes(part.name) && !readOnlyTools.has(part.name) &&
    !approvals.some((a) => a.kind === "tool" && a.toolCallId === part.toolCallId && !a.consumedBy) ? [part.toolCallId] : []);
  const changed = run.checkpoint && run.checkpoint.configuration !== executionConfiguration(store, run);
  return { state: changed ? "blocked" : pendingToolIds.length ? "review" : "ready", reason: changed ? "执行配置已改变，请核对当前权限和模型后继续" : reason,
    attempts: run.recovery?.attempts || 0, pendingToolIds, decisions: run.recovery?.decisions };
}
