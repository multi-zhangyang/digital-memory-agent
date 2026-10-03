import { randomUUID } from "node:crypto";
import type { AgentApproval, Run } from "@memory/contracts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
const readOnly = new Set([
  "read",
  "list_files",
  "search_files",
  "search_assets",
  "read_asset_text",
  "read_artifact",
  "search_memories",
  "web_search",
  "web_read",
  "tool_search",
]);
const local = new Set(["update_plan", "ask_user"]);
export async function requestApproval(
  store: Store,
  conversationId: string,
  input: Pick<AgentApproval, "title" | "detail" | "kind" | "options">,
  signal?: AbortSignal,
) {
  const run = store.work.activeRun(conversationId);
  if (!run) throw new Error("请从工作台启动任务");
  const approval = store.harness.save("approval", {
    ...input,
    id: randomUUID(),
    runId: run.id,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  });
  store.work.patchRun(run.id, { status: "waiting" }, "approval");
  while (true) {
    signal?.throwIfAborted();
    const latest = store.work.get<Run>("run", run.id)!;
    if (["stopped", "failed", "completed"].includes(latest.status))
      throw new Error("执行已结束");
    const answer = store.harness.get<AgentApproval>("approval", approval.id)!;
    if (answer.status !== "pending") {
      if (!store.harness.approvals(run.id).some((a) => a.status === "pending"))
        store.work.patchRun(run.id, { status: "running" }, "approval-resolved");
      return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
      if (local.has(event.toolName) || readOnly.has(event.toolName)) return;
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
      });
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
