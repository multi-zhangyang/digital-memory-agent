import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Run } from "@memory/contracts";
import type { Store } from "../store.js";
import type { PiHost } from "../integrations/pi/host.js";
import { prepareResources } from "./pi-resources.js";
import { digitalMemoryProfile } from "../harness/product-profile.js";
import { TaskContextPolicy } from "./task-context.js";
import { extensionPresentation } from "./extension-ui.js";

export function createPiHost(store: Store, tools: (id: string) => ToolDefinition[]): PiHost {
  return {
    sessionsDir: store.sessionsDir,
    systemPrompt: digitalMemoryProfile.systemPrompt,
    context: new TaskContextPolicy(store),
    project: (id) => {
      const project = store.harness.project(store.harness.association(id).projectId);
      return { ...project, directory: store.harness.root(project.id) };
    },
    settings: () => store.harness.settings,
    resources: (id, statuses) => prepareResources(store, id, statuses),
    presentation: (id) => extensionPresentation(store, id),
    resourceStates: (id) => {
      const statuses = extensionPresentation(store, id).statuses;
      return [
        ...store.harness.settings.resources.map((resource) => ({ name: resource.name, kind: resource.kind,
          state: "configured" as const, detail: resource.enabled ? undefined : "已停用" })),
        ...store.harness.settings.mcp.map((server) => ({ name: server.name, kind: "mcp" as const,
          state: statuses["mcp:" + server.name] ? "error" as const : "configured" as const,
          detail: !server.enabled ? "已停用" : statuses["mcp:" + server.name] || (server.exposure === "deferred" ? "按需发现" : "直接加载") })),
      ];
    },
    tools,
    waiting: (runId) => ["user", "approval", "recovery"].includes(store.work.get<Run>("run", runId)?.waitingFor || ""),
    resumableTools: (runId) => store.harness.approvals(runId).flatMap((approval) =>
      approval.kind === "tool" && approval.status !== "pending" && !approval.consumedBy && approval.toolCallId ? [approval.toolCallId] : []),
    checkpoint: (runId, entryId) => {
      const run = store.work.get<Run>("run", runId);
      if (run?.checkpoint) store.work.patchRun(runId, { entryId, checkpoint: { ...run.checkpoint, entryId, savedAt: new Date().toISOString() } }, "checkpoint");
    },
    recovered: (runId, interventionIds) => {
      const run = store.work.get<Run>("run", runId);
      if (run) store.work.patchRun(runId, { interventions: run.interventions?.map((item) => interventionIds.includes(item.id) ? { ...item, status: "delivered" } : item) }, "queue-restored");
    },
    settled: (runId, entryId, queued) => {
      const run = store.work.get<Run>("run", runId);
      if (!run) return;
      const remaining = { steer: queued.steering.length, followUp: queued.followUp.length };
      const interventions = run.interventions?.slice().reverse().map((item) => {
        if (item.status !== "queued") return item;
        if (run.waitingFor) return item;
        const key = item.mode || "steer";
        const returned = remaining[key] > 0;
        if (returned) remaining[key]--;
        return { ...item, status: returned && run.waitingFor ? "queued" as const : returned ? "returned" as const : "delivered" as const };
      }).reverse();
      store.work.patchRun(runId, { entryId, interventions }, "session");
    },
  };
}
