import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.js";
import type { MemoryOrganizationService } from "../memory/organization-service.js";
import type { TaskJobs } from "../harness/jobs.js";
import { commandRun, deliveredInstructions, memoryCommandContext, receiptSummary } from "./memory-command-context.js";
import { MemorySourceVerifier } from "../memory/source-verifier.js";
import { activityToolView } from "../memory/activities.js";

const uuid = Type.String({ format: "uuid" });
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
export const activityChangeSchema = Type.Object({
  action: Type.Union([Type.Literal("confirm-activity"), Type.Literal("correct-activity"), Type.Literal("reject-activity"), Type.Literal("merge-activities"), Type.Literal("split-activity")]),
  refs: Type.Array(Type.Object({ id: uuid, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
  values: Type.Optional(Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), summary: Type.String({ minLength: 1, maxLength: 2000 }),
    occurredAt: Type.String({ maxLength: 10 }), place: Type.String({ maxLength: 120 }) }, { additionalProperties: false })),
  memoryIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 48, uniqueItems: true })), reason: Type.String({ minLength: 1, maxLength: 800 }),
}, { additionalProperties: false });

export function createActivityTools(store: Store, organization: MemoryOrganizationService, jobs: TaskJobs, conversationId: string) {
  return [defineTool({ name: "organize_memories", label: "整理生活活动",
    description: "Organize photos/text into activities in a durable background job. Current user messages and answered questions are passed automatically; do not ask users to repeat them or create a text file. For an explicit request to add sources to an existing activity, query its current id and pass targetActivityId: its ID and text are preserved. Missing observations are processed first. New source observations stay unconfirmed. The harness delivers results; do not poll. Selected scope is enforced by the server.",
    parameters: Type.Object({ assetIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 200, uniqueItems: true })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), targetActivityId: Type.Optional(uuid) }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted(); const run = commandRun(store, conversationId, true);
      const assetIds = input.assetIds || run.assetIds;
      const questions = [...(run.questions || []), ...(run.question ? [run.question] : [])];
      const context = { messages: deliveredInstructions(run).map(({ id, text }) => ({ id, text,
        question: questions.find((q) => id === run.id + ":answer" + (q.id ? ":" + q.id : ""))?.text })),
        referenceTime: run.createdAt, timeZone: store.memories.ledger.settings().timeZone };
      const job = await organization.submit({ ...input, assetIds, context }, { requestId: createHash("sha256").update(JSON.stringify([run.id, "organize", [...new Set(assetIds)].sort(), input.targetActivityId, context])).digest("hex"),
        modelId: run.modelId, allowedAssetIds: run.scope === "selected" ? run.assetIds : undefined, ownership: run.scope === "library" ? "library" : "task" });
      const attached = jobs.attach(run.id, "memory-organization", job.id, toolCallId, job.ownership);
      return output({ job: attached, next: "等待后台完成事件，再检查活动、来源和疑点；候选归组不等于事实确认。" });
    } }),
    defineTool({ name: "query_memory_activities", label: "查看生活活动",
      description: "Find organized activities, including unconfirmed candidates, using a query or source filter. id opens current source records and versions for review. These results are not a complete count of real-world events. For confirmed event statistics use query_events. Candidate/stale activity summaries must not be stated as confirmed personal facts.",
      parameters: Type.Object({ id: Type.Optional(uuid), query: Type.Optional(Type.String({ maxLength: 200 })),
        assetIds: Type.Optional(Type.Array(uuid, { maxItems: 200, uniqueItems: true })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
      async execute(_id, input) {
        const run = commandRun(store, conversationId); const allowed = run.scope === "selected" ? run.assetIds : undefined;
        const result = input.id ? organization.activities.detail(input.id, allowed) : organization.activities.list({ ...input, limit: input.limit || 5 }, allowed);
        const activities = "activity" in result ? [result.activity] : result.activities;
        if ("activity" in result) {
          const offset = input.offset || 0, memories = result.memories.slice(offset, offset + (input.limit || 5)).map((m) => ({ ...m, content: m.content.slice(0, 1600),
            sources: m.sources.slice(0, 4).map(({ quote: _quote, visual: _visual, ...source }) => source) }));
          while (memories.length > 1 && Buffer.byteLength(JSON.stringify(memories)) > 9000) memories.pop();
          for (const memory of memories) for (const source of memory.sources) store.recordSource(run.id, source);
          return output({ activity: activityToolView(result.activity), memories, total: result.memories.length,
            nextOffset: offset + memories.length < result.memories.length ? offset + memories.length : null });
        }
        const views = activities.map(activityToolView);
        while (views.length > 1 && Buffer.byteLength(JSON.stringify(views)) > 12000) views.pop();
        for (const activity of views) for (const source of activity.sources) if (source.type === "asset") store.recordSource(run.id, source);
        const nextOffset = (input.offset || 0) + views.length;
        return output({ activities: views, total: result.total, nextOffset: nextOffset < result.total ? nextOffset : null });
      } }),
    defineTool({ name: "change_memory_activities", label: "核对生活活动",
      description: "Apply an explicit user instruction to confirm displayed activity content, correct it, reject a grouping, merge groups or split selected memoryIds. Read current activities/versions first. Confirming activity content does not confirm every underlying source observation or identify people. Preserve ambiguous fields. instructionQuote must be the actual current user message; an organize request is not consent to confirm facts.",
      parameters: Type.Object({ ...activityChangeSchema.properties, instructionQuote: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
      async execute(toolCallId, input, signal) {
        const run = commandRun(store, conversationId, true); const { instructionQuote, ...change } = input;
        const context = memoryCommandContext(store, run, toolCallId, change, "user", instructionQuote);
        if (["confirm-activity", "correct-activity"].includes(change.action)) {
          const verifier = new MemorySourceVerifier(store);
          for (const ref of change.refs) for (const memory of organization.activities.memories(organization.activities.get(ref.id, context.allowedAssetIds))) await verifier.verify(memory, signal);
        }
        signal?.throwIfAborted(); commandRun(store, conversationId, true);
        const receipt = organization.activities.change(change, context);
        return output({ command: receiptSummary(receipt), result: receipt.result });
      } }),
  ];
}
