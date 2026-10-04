import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Run } from "@memory/contracts";
import type { Store } from "../store.js";
import type { PiHost } from "../integrations/pi/host.js";
import { prepareResources } from "./pi-resources.js";
import { digitalMemoryProfile } from "../harness/product-profile.js";
import { TaskContextPolicy } from "./task-context.js";

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
    tools,
    settled: (runId, entryId, queued) => {
      const run = store.work.get<Run>("run", runId);
      if (!run) return;
      const remaining = { steer: queued.steering.length, followUp: queued.followUp.length };
      const interventions = run.interventions?.slice().reverse().map((item) => {
        if (item.status !== "queued") return item;
        const key = item.mode || "steer";
        const returned = remaining[key] > 0;
        if (returned) remaining[key]--;
        return { ...item, status: returned ? "returned" as const : "delivered" as const };
      }).reverse();
      store.work.patchRun(runId, { entryId, interventions }, "session");
    },
  };
}
