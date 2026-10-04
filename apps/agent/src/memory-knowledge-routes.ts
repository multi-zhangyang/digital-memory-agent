import type { FastifyInstance } from "fastify";
import type { MemorySpace } from "@memory/contracts";
import type { Store } from "./store.js";
import type { MemoryFeatureService } from "./memory/feature-service.js";
import { MemoryEvents, type EventQuery } from "./memory/events.js";
import { UserFacingError } from "./harness/runtime.js";
import { preparePhoto } from "./memory/photo-source.js";
import { prepareVideoFrame } from "./memory/video-source.js";
import type { VideoFrame } from "@memory/contracts";
import sharp from "sharp";
import { memoryEligibility } from "./memory/retrieval.js";
import type { MemoryEntry } from "@memory/contracts";

const uuid = { type: "string", format: "uuid" };
const version = { type: "integer", minimum: 1 };
const reason = { type: "string", minLength: 1, maxLength: 500 };
const params = { type: "object", properties: { id: uuid }, required: ["id"], additionalProperties: false };
const refs = { type: "array", minItems: 2, maxItems: 20, items: { type: "object", required: ["id", "version"], properties: { id: uuid, version }, additionalProperties: false } };
const list = { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: uuid };

export function registerKnowledgeRoutes(app: FastifyInstance, store: Store, features: MemoryFeatureService, events: MemoryEvents) {
  const graph = store.work.memory.graph;
  app.get("/api/memory-features", async () => features.status());
  app.post("/api/memory-features/retry", async () => features.retryFailed());
  app.get<{ Params: { id: string } }>("/api/memory-observations/:id", { schema: { params } }, async (request) => graph.observation(request.params.id));
  app.get<{ Params: { id: string } }>("/api/memory-observations/:id/preview", { schema: { params } }, async (request, reply) => {
    const observation = graph.observation(request.params.id);
    const asset = observation.assetId && store.asset(observation.assetId);
    if (observation.kind !== "face" || !asset || observation.evidence[0]?.sha256 !== asset.sha256)
      throw new UserFacingError(409, "SOURCE_CHANGED", "人物观察的原件已改变或不可用");
    if (store.memories.ledger.sourceBlocked(asset.sha256)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "原件已停止取用");
    const video = observation.output.video as VideoFrame | undefined;
    const photo = asset.kind === "video" && video ? await prepareVideoFrame(store.assetsDir, asset, video.requestedTimestamp) : await preparePhoto(store.assetsDir, asset);
    const region = observation.output.region as { x: number; y: number; width: number; height: number };
    if (!region || Object.values(region).some((value) => !Number.isFinite(value))) throw new UserFacingError(422, "INVALID_REGION", "人物区域不可用");
    const left = Math.max(0, Math.min(photo.width - 1, Math.floor(region.x * photo.width)));
    const top = Math.max(0, Math.min(photo.height - 1, Math.floor(region.y * photo.height)));
    const data = await sharp(photo.data).extract({ left, top, width: Math.max(1, Math.min(photo.width - left, Math.ceil(region.width * photo.width))),
      height: Math.max(1, Math.min(photo.height - top, Math.ceil(region.height * photo.height))) }).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).jpeg().toBuffer();
    if (store.memories.ledger.sourceBlocked(asset.sha256)) throw new UserFacingError(409, "SOURCE_SUPPRESSED", "原件已停止取用");
    reply.header("Cache-Control", "private, no-store");
    return reply.type("image/jpeg").send(data);
  });
  app.get<{ Querystring: { space?: MemorySpace; limit?: number; cursor?: string } }>("/api/memory-entities", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { space: { enum: ["personal", "demo"] },
      limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string", maxLength: 2000 } } } },
  }, async (request) => {
    const space = request.query.space || "personal", revision = store.work.memory.revision;
    let offset = 0;
    if (request.query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString());
        if (cursor.space !== space || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
        if (cursor.revision !== revision) throw new UserFacingError(409, "MEMORY_CURSOR_EXPIRED", "人物关联已更新，请刷新列表");
        offset = cursor.offset;
      } catch (error) { if (error instanceof UserFacingError) throw error; throw new UserFacingError(400, "INVALID_CURSOR", "人物分页条件无效"); }
    }
    const page = graph.entityPage(space, request.query.limit, offset);
    return { ...page, revision, nextCursor: page.nextOffset === null ? null : Buffer.from(JSON.stringify({ revision, space, offset: page.nextOffset })).toString("base64url") };
  });
  app.get<{ Params: { id: string }; Querystring: { offset?: number; revision: number } }>("/api/memory-entities/:id/observations", {
    schema: { params, querystring: { type: "object", required: ["revision"], additionalProperties: false,
      properties: { offset: { type: "integer", minimum: 0 }, revision: { type: "integer", minimum: 0 } } } },
  }, async (request) => {
    const entity = graph.entity(request.params.id);
    if (request.query.revision !== entity.version) throw new UserFacingError(409, "MEMORY_CURSOR_EXPIRED", "人物候选已更新，请重新打开");
    const offset = request.query.offset || 0;
    const rows = store.db.prepare(`SELECT l.observationId,l.status,l.score,o.data FROM memory_entity_links l JOIN memory_observations o ON o.id=l.observationId
      JOIN assets a ON a.id=o.assetId AND a.sha256=o.sourceHash
      WHERE l.entityId=? AND l.active=1 AND a.memorySpace=? AND NOT EXISTS(SELECT 1 FROM memory_suppressions WHERE hash=a.sha256)
      ORDER BY l.id LIMIT 51 OFFSET ?`).all(entity.id, entity.space, offset) as { observationId: string; status: string; score: number | null; data: string }[];
    const selected = rows.slice(0, 50);
    return { observations: selected.map(({ data, ...link }) => ({ ...link, observation: JSON.parse(data) })), nextOffset: rows.length > 50 ? offset + 50 : null };
  });
  app.post<{ Params: { id: string }; Body: { version: number; personId?: string; name?: string; reason: string } }>("/api/memory-entities/:id/identify", {
    schema: { params, body: { type: "object", required: ["version", "reason"], properties: { version, personId: uuid, name: { type: "string", minLength: 1, maxLength: 80 }, reason },
      oneOf: [{ required: ["personId"], not: { required: ["name"] } }, { required: ["name"], not: { required: ["personId"] } }], additionalProperties: false } },
  }, async (request) => store.memoryCommands.links({ action: "identify", refs: [{ id: request.params.id, version: request.body.version }],
    personId: request.body.personId, name: request.body.name, reason: request.body.reason }, { actor: "user" }).result);
  app.post<{ Body: { entities: { id: string; version: number }[]; reason: string } }>("/api/memory-entities/merge", {
    schema: { body: { type: "object", required: ["entities", "reason"], properties: { entities: refs, reason }, additionalProperties: false } },
  }, async (request) => store.memoryCommands.links({ action: "merge-people", refs: request.body.entities, reason: request.body.reason }, { actor: "user" }).result);
  app.post<{ Params: { id: string }; Body: { version: number; observationIds: string[]; reason: string } }>("/api/memory-entities/:id/split", {
    schema: { params, body: { type: "object", required: ["version", "observationIds", "reason"], properties: { version, observationIds: list, reason }, additionalProperties: false } },
  }, async (request) => store.memoryCommands.links({ action: "split-person", refs: [{ id: request.params.id, version: request.body.version }],
    observationIds: request.body.observationIds, reason: request.body.reason }, { actor: "user" }).result);
  app.get<{ Querystring: EventQuery }>("/api/memory-events", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      space: { enum: ["personal", "demo"] }, query: { type: "string", maxLength: 200 }, person: { type: "string", maxLength: 80 }, personId: uuid, eventId: uuid,
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      mode: { enum: ["list", "count"] }, cursor: { type: "string", maxLength: 2000 }, limit: { type: "integer", minimum: 1, maximum: 20 },
    } } },
  }, async (request) => events.query(request.query));
  app.post<{ Body: { events: { id: string; version: number }[]; title: string; reason: string } }>("/api/memory-events/merge", {
    schema: { body: { type: "object", required: ["events", "title", "reason"], properties: { events: refs, title: { type: "string", minLength: 1, maxLength: 120 }, reason }, additionalProperties: false } },
  }, async (request) => store.memoryCommands.links({ action: "merge-events", refs: request.body.events, title: request.body.title, reason: request.body.reason }, { actor: "user" }).result);
  app.get<{ Params: { id: string }; Querystring: { revision: number; after?: string } }>("/api/memory-events/:id/memories", {
    schema: { params, querystring: { type: "object", required: ["revision"], additionalProperties: false,
      properties: { revision: { type: "integer", minimum: 0 }, after: uuid } } },
  }, async (request) => {
    if (request.query.revision !== store.work.memory.revision) throw new UserFacingError(409, "MEMORY_CURSOR_EXPIRED", "事件记录已更新，请重新打开");
    const event = graph.event(request.params.id);
    const filter = memoryEligibility({ eventId: event.id, space: event.space, includeHistorical: true }, store.work.memory.settings().timeZone);
    filter.where.push("m.superseded=0");
    const rows = store.db.prepare(`SELECT r.data FROM memory_read m JOIN workspace_records r ON r.id=m.id
      WHERE ${filter.where.join(" AND ")} AND m.id>? ORDER BY m.id LIMIT 51`).all(...filter.args, request.query.after || "") as { data: string }[];
    const memories = rows.slice(0, 50).map((row) => JSON.parse(row.data) as MemoryEntry);
    return { event, memories, revision: store.work.memory.revision, nextCursor: rows.length > 50 ? memories.at(-1)!.id : null };
  });
  app.post<{ Params: { id: string }; Body: { version: number; memoryIds: string[]; title: string; reason: string } }>("/api/memory-events/:id/split", {
    schema: { params, body: { type: "object", required: ["version", "memoryIds", "title", "reason"], properties: { version, memoryIds: list,
      title: { type: "string", minLength: 1, maxLength: 120 }, reason }, additionalProperties: false } },
  }, async (request) => store.memoryCommands.links({ action: "split-event", refs: [{ id: request.params.id, version: request.body.version }],
    memoryIds: request.body.memoryIds, title: request.body.title, reason: request.body.reason }, { actor: "user" }).result);
}
