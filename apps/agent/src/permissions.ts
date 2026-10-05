import { randomUUID } from "node:crypto";
import type { AgentApproval, Run } from "@memory/contracts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
export const readOnlyTools = new Set([
  "read",
  "list_files",
  "search_files",
  "search_assets",
  "read_asset_text",
  "read_artifact",
  "search_memories",
  "inspect_memories",
  "inspect_dataset",
  "deliver_dataset",
  "search_evidence",
  "read_evidence",
  "inspect_source_people",
  "query_events",
  "query_memory_activities",
  "read_job_result",
  "web_search",
  "web_read",
  "tool_search",
]);
const local = new Set(["update_plan", "ask_user"]);
export async function requestApproval(
  store: Store,
  conversationId: string,
  input: Pick<AgentApproval, "title" | "detail" | "kind" | "options" | "prefill" | "placeholder" | "expiresAt">,
  signal?: AbortSignal,
  toolCallId?: string,
) {
  const run = store.work.activeRun(conversationId);
  if (!run) throw new Error("请从工作台启动任务");
  signal?.throwIfAborted();
  const previous = store.harness.approvals(run.id).find((a) => a.kind === input.kind && a.title === input.title && a.detail === input.detail &&
    JSON.stringify(a.options) === JSON.stringify(input.options) && a.prefill === input.prefill && a.placeholder === input.placeholder &&
    (input.kind !== "tool" || a.toolCallId === toolCallId) && !a.consumedBy);
  if (previous) {
    if (previous.status !== "pending") return store.harness.save("approval", { ...previous, consumedBy: toolCallId || previous.id });
    return previous;
  }
  const approval = store.harness.save("approval", {
    ...input,
    id: randomUUID(),
    runId: run.id,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    toolCallId: toolCallId || (() => { const part = run.parts.slice().reverse().find((part) => part.type === "tool" && part.state === "running"); return part?.type === "tool" ? part.toolCallId : undefined; })(),
  });
  store.work.patchRun(run.id, { status: "waiting", waitingFor: "approval" }, "approval");
  return approval;
}
export function permissionExtension(
  store: Store,
  conversationId: string,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const project = store.harness.project(
        store.harness.association(conversationId).projectId,
      );
      const run = store.work.activeRun(conversationId);
      const mode = run?.permissionMode || project.permissionMode;
      if (project.disabledTools.includes(event.toolName))
        return { block: true, reason: "此工具已被禁用" };
      if (run?.memoryEpoch !== undefined && run.memoryEpoch !== store.memories.ledger.epoch)
        return { block: true, reason: "记忆已更新，禁止使用旧上下文继续操作" };
      if (run?.waitingFor && ["user", "approval", "recovery"].includes(run.waitingFor))
        return { block: true, reason: "任务等待用户处理，请在恢复后继续" };
      if (run?.recovery?.decisions?.some((decision) => decision.action === "skip" && run.parts.some((part) => part.type === "tool" && part.toolCallId === decision.toolCallId && part.name === event.toolName)))
        return { block: true, reason: "该工具的中断结果未核实，用户选择本次任务跳过；不能自动重复操作" };
      if (local.has(event.toolName) || readOnlyTools.has(event.toolName)) return;
      if (!run)
        return {
          block: true,
          reason: "请通过任务工作台执行操作，以便保留权限和文件变更记录",
        };
      if (mode === "read")
        return {
          block: true,
          reason: "当前为只读模式，不允许修改文件、执行脚本或调用外部 MCP 工具",
        };
      if (mode === "auto") return;
      const answer = await requestApproval(store, conversationId, {
        title: event.toolName,
        detail: JSON.stringify(event.input, null, 2).slice(0, 12000),
        kind: "tool",
        options: [],
      }, undefined, event.toolCallId);
      if (answer.status === "pending") return { block: true, reason: "等待用户审批后继续" };
      if (answer.status !== "approved")
        return { block: true, reason: "用户拒绝了本次工具调用，请调整方案" };
    });
    // Shell escape commands from prompt templates must not bypass the registered sandboxed bash tool.
    pi.on("user_bash", async () => ({
      result: {
        output: "请通过 bash 工具执行命令",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    }));
  };
}
