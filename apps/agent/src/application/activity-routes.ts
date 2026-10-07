import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ActivityChange, MemoryActivity, Run } from "@memory/contracts";
import type { MemoryOrganizationService } from "../memory/organization-service.js";
import { activityChangeSchema } from "./activity-tools.js";
import { MemorySourceVerifier } from "../memory/source-verifier.js";
import type { Store } from "../store.js";
import { UserFacingError } from "../errors.js";

const uuid = { type: "string", format: "uuid" };
const params = { type: "object", properties: { id: uuid }, required: ["id"], additionalProperties: false };
export function registerActivityRoutes(app: FastifyInstance, store: Store, organization: MemoryOrganizationService) {
  app.get<{ Params: { id: string } }>("/api/runs/:id/activities", { schema: { params } }, async (request) => {
    const run = store.work.get<Run>("run", request.params.id);
    if (!run) throw new UserFacingError(404, "NOT_FOUND", "任务不存在");
    const ids = [...new Set([...(run.jobs || []).filter((job) => job.kind === "memory-organization").flatMap((job) => organization.job(job.id).activityIds),
      ...organization.activities.related(store.memoryCommands.receipts(run.id).flatMap((receipt) => receipt.after.map((ref) => ref.id)), [], run.scope === "selected" ? run.assetIds : undefined).map((a) => a.id),
      ...store.memoryCommands.receipts(run.id).flatMap((receipt) => ((receipt.result as { activities?: MemoryActivity[] })?.activities || []).map((a) => a.id))])];
    const activities = organization.activities.current(ids, run.scope === "selected" ? run.assetIds : undefined);
    return { activities: activities.slice(0, 20), total: activities.length };
  });
  app.get<{ Querystring: { query?: string; status?: MemoryActivity["status"]; assetId?: string; offset?: number; limit?: number } }>("/api/memory-activities", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 200 },
      status: { enum: ["candidate", "confirmed", "rejected", "superseded"] }, assetId: uuid,
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } } } },
  }, async (request) => organization.activities.list({ ...request.query, assetIds: request.query.assetId ? [request.query.assetId] : undefined }));
  app.get<{ Params: { id: string } }>("/api/memory-activities/:id", { schema: { params } }, async (request) => organization.activities.detail(request.params.id));
  app.post<{ Body: { assetIds: string[]; requestId: string; targetActivityId?: string; description?: string } }>("/api/memory-organization", { schema: { body: {
    type: "object", additionalProperties: false, required: ["assetIds", "requestId"], properties: { assetIds: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: uuid }, requestId: uuid,
      targetActivityId: uuid, description: { type: "string", maxLength: 12000 } },
  } } }, async (request) => organization.submit({ assetIds: request.body.assetIds, targetActivityId: request.body.targetActivityId,
    context: request.body.description?.trim() ? { messages: [{ id: request.body.requestId, text: request.body.description }],
      referenceTime: new Date().toISOString(),
      timeZone: store.memories.ledger.settings().timeZone } : undefined }, { requestId: request.body.requestId, ownership: "library" }));
  app.post<{ Params: { id: string }; Body: ActivityChange }>("/api/memory-activities/:id/commands", { schema: { params, body: activityChangeSchema } }, async (request) => {
    // Keep the real submitted form as instruction provenance; no assistant-authored confirmation.
    if (request.body.refs[0]?.id !== request.params.id) throw new UserFacingError(400, "ACTIVITY_MISMATCH", "活动与修改请求不一致");
    const text = JSON.stringify(request.body);
    if (["confirm-activity", "correct-activity"].includes(request.body.action)) {
      const verifier = new MemorySourceVerifier(store);
      for (const ref of request.body.refs) for (const memory of organization.activities.memories(organization.activities.get(ref.id))) await verifier.verify(memory);
    }
    return store.memories.transaction(() => organization.activities.change(request.body, { actor: "user", space: "personal",
      instruction: store.memoryCommands.recordForm(randomUUID(), text) }));
  });
}
