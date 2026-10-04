import type { FastifyInstance } from "fastify";
import type { EvidenceSearch, FrameMemoryDraftInput, ImageRegion } from "@memory/contracts";
import type { Store } from "../store.js";
import type { TaskJobs } from "../harness/jobs.js";
import type { CapabilityRegistry } from "../harness/capability-registry.js";
import type { EvidenceService } from "../memory/evidence-service.js";
import { UserFacingError } from "../errors.js";
import type { AssetProcessingService } from "../memory/asset-processing-service.js";
import { MemoryDrafts } from "../memory/drafts.js";

export function registerProductRoutes(app: FastifyInstance, store: Store, jobs: TaskJobs, capabilities: CapabilityRegistry<{ name: string }>, evidence: EvidenceService, processing: AssetProcessingService) {
  const drafts = new MemoryDrafts(store);
  app.get("/api/capabilities", async () => capabilities.snapshot());
  app.get("/api/processing-policy", async () => ({ settings: store.memories.ledger.settings() }));
  app.post<{ Body: { requestId: string; assetIds: string[]; title?: string } }>("/api/asset-processing", { schema: { body: {
    type: "object", additionalProperties: false, required: ["requestId", "assetIds"], properties: {
      requestId: { type: "string", format: "uuid" }, assetIds: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: { type: "string", format: "uuid" } },
      title: { type: "string", minLength: 1, maxLength: 120 },
    },
  } } }, async (request, reply) => reply.code(202).send({ job: await processing.submit(request.body, { requestId: request.body.requestId, ownership: "library" }) }));
  app.get<{ Querystring: { kind?: string; status?: string; limit?: number; offset?: number } }>("/api/jobs", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: { kind: { type: "string", maxLength: 80 }, status: { type: "string", maxLength: 30 },
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 } },
  } } }, async (request) => {
    const { kind, status, limit = 40, offset = 0 } = request.query;
    const all = jobs.catalog().filter((job) => (!kind || job.kind === kind) && (!status || job.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    return { jobs: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null, coverage: "recent", deliveries: store.events.status() };
  });
  const params = { type: "object", required: ["kind", "id"], properties: { kind: { type: "string", pattern: "^[a-z-]+$" }, id: { type: "string", format: "uuid" } } };
  app.get<{ Params: { kind: string; id: string }; Querystring: { offset?: number; limit?: number; section?: "assets" | "entries" } }>("/api/jobs/:kind/:id", { schema: { params, querystring: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 }, section: { enum: ["assets", "entries"] } }, additionalProperties: false } } }, async (request) =>
    jobs.inspect(request.params.kind, request.params.id, request.query.offset, request.query.limit, request.query.section));
  for (const action of ["retry", "cancel"] as const) app.post<{ Params: { kind: string; id: string } }>(`/api/jobs/:kind/:id/${action}`, { schema: { params } }, async (request) => jobs.control(request.params.kind, request.params.id, action));
  app.get<{ Querystring: EvidenceSearch }>("/api/evidence", { schema: { querystring: { type: "object", additionalProperties: false,
    properties: { query: { type: "string", maxLength: 200 }, kind: { enum: ["text", "image", "video"] },
      personId: { type: "string", format: "uuid" }, entityId: { type: "string", format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 20 } } } } }, async (request) => evidence.search(request.query));
  const evidenceParams = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^(asset|frame|observation):[0-9a-f-]{36}$" } } };
  app.post<{ Params: { id: string }; Body: FrameMemoryDraftInput }>("/api/evidence/:id/drafts", { schema: {
    params: evidenceParams, body: { type: "object", additionalProperties: false, required: ["version", "viewSha256", "title", "content"], properties: {
      version: { type: "string", pattern: "^[0-9a-f]{64}$" }, viewSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      timestamp: { type: "number", minimum: 0, maximum: 7200 }, title: { type: "string", minLength: 1, maxLength: 120 },
      content: { type: "string", minLength: 1, maxLength: 4000 }, occurredAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    } },
  } }, async (request, reply) => {
    const { version, timestamp, viewSha256, title, content, occurredAt } = request.body;
    const read = await evidence.read(request.params.id, {}, { version, timestamp, image: true });
    if (read.source?.view?.sha256 !== viewSha256) throw new UserFacingError(409, "EVIDENCE_VIEW_CHANGED", "画面已改变，请重新读取后保存草稿");
    const source = read.hit.sources.find((value) => value.type === "asset");
    if (!source || source.type !== "asset") throw new UserFacingError(400, "ORIGINAL_REQUIRED", "请从原始画面保存草稿");
    const { type: _type, ...original } = source;
    const memory = await drafts.propose({ title, content, kind: "observation", sources: [original], occurredAt,
      category: occurredAt ? "event" : "fact" }, { actor: "user" });
    return reply.code(201).send({ memory });
  });
  app.get<{ Params: { id: string }; Querystring: { version?: string; offset?: number; limit?: number; timestamp?: number } }>("/api/evidence/:id", { schema: { params: evidenceParams, querystring: { type: "object", additionalProperties: false, properties: { version: { type: "string", maxLength: 64 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 4, maximum: 8000 }, timestamp: { type: "number", minimum: 0, maximum: 7200 } } } } }, async (request) => evidence.read(request.params.id, {}, request.query));
  app.get<{ Params: { id: string }; Querystring: Partial<ImageRegion> & { version?: string; view?: string; timestamp?: number } }>("/api/evidence/:id/preview", { schema: {
    params: evidenceParams, querystring: { type: "object", additionalProperties: false, properties: {
      version: { type: "string", pattern: "^[0-9a-f]{64}$" }, view: { type: "string", pattern: "^[0-9a-f]{64}$" },
      timestamp: { type: "number", minimum: 0, maximum: 7200 },
      x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
      width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    } },
  } }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { version, view, timestamp, ...rectangle } = request.query;
    const keys = Object.keys(rectangle);
    if (keys.length && keys.length !== 4) throw new UserFacingError(400, "INVALID_IMAGE_REGION", "请同时提供区域的 x、y、width 和 height");
    const result = await evidence.read(request.params.id, {}, { image: true, version, timestamp, region: keys.length ? rectangle as ImageRegion : undefined });
    if (!result.image) return reply.code(404).send({ error: { code: "NO_IMAGE", message: "此证据没有图片预览" } });
    if (view && result.source?.view?.sha256 !== view) throw new UserFacingError(409, "EVIDENCE_VIEW_CHANGED", "图片预处理结果已改变，请重新读取证据");
    return reply.type("image/jpeg").send(result.image);
  });
}
