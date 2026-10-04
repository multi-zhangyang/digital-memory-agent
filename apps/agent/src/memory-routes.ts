import type { FastifyInstance } from "fastify";
import type {
  MemoryEntry,
  MemoryOverview,
  MemorySearch,
  MemorySpace,
  MemoryPageQuery,
} from "@memory/contracts";
import type { Store } from "./store.js";
import { UserFacingError } from "./harness/runtime.js";
import { memorySpace } from "./memory/retrieval.js";
import { MemoryImports, type MemoryImportInput } from "./memory/imports.js";
import type { MemoryCaptures } from "./memory/captures.js";
import type { MemorySettings, Run } from "@memory/contracts";
import { contentHash, evidenceOf } from "./memory/ledger.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { preparePhoto } from "./memory/photo-source.js";
import { prepareVideoFrame } from "./memory/video-source.js";

const uuid = { type: "string", format: "uuid" };
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: uuid },
  additionalProperties: false,
};
const refs = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    required: ["id", "version"],
    additionalProperties: false,
    properties: { id: uuid, version: { type: "integer", minimum: 1 } },
  },
};
const spaceSchema = { enum: ["personal", "demo"] };
const pageProperties = {
  space: spaceSchema,
  view: { enum: ["records", "all", "profile", "timeline", "draft", "confirmed", "rejected", "forgotten"] },
  query: { type: "string", maxLength: 200 }, person: { type: "string", maxLength: 80 }, personId: uuid,
  from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  conversationId: uuid, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string", maxLength: 2000 },
};
type OverviewQuery = Omit<MemoryPageQuery, "view"> & { view?: MemoryPageQuery["view"] | "people" | "imports" };

export function registerMemoryRoutes(
  app: FastifyInstance,
  store: Store,
  imports: MemoryImports,
  blocked: () => boolean,
  captures: MemoryCaptures,
) {
  app.get<{ Params: { id: string } }>("/api/assets/:id/photo-preview", { schema: { params: idParams } }, async (request, reply) => {
    const asset = store.asset(request.params.id);
    if (!asset) throw new UserFacingError(404, "NOT_FOUND", "图片不存在");
    const photo = await preparePhoto(store.assetsDir, asset);
    return reply.type("image/jpeg").header("Cache-Control", "private, no-store").send(photo.data);
  });
  for (const path of ["/api/memory-page", "/api/memories"]) app.get<{ Querystring: MemoryPageQuery }>(path,
    { schema: { querystring: { type: "object", properties: pageProperties, additionalProperties: false } } },
    async (request) => store.work.queries.catalog.page(request.query));
  app.post<{ Body: { ids: string[] } }>("/api/memories/lookup", {
    schema: { body: { type: "object", required: ["ids"], additionalProperties: false,
      properties: { ids: { type: "array", items: uuid, maxItems: 50, uniqueItems: true } } } },
  }, async (request) => ({ memories: store.work.queries.catalog.lookup(request.body.ids) }));
  app.get<{ Querystring: { space?: MemorySpace; query?: string; cursor?: string; limit?: number } }>("/api/memory-people", {
    schema: { querystring: { type: "object", properties: { space: spaceSchema, query: pageProperties.query, cursor: pageProperties.cursor, limit: pageProperties.limit }, additionalProperties: false } },
  }, async (request) => store.work.queries.catalog.people(request.query));
  app.get<{ Querystring: OverviewQuery }>(
    "/api/memory-overview",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { ...pageProperties, view: { enum: [...pageProperties.view.enum, "people", "imports"] } },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<MemoryOverview> => {
      const space = request.query.space || "personal";
      const view = request.query.view;
      const page = store.work.queries.catalog.page(view === "people" || view === "imports" ? { space } : request.query as MemoryPageQuery);
      const memories = page.memories;
      const people = !view || view === "people" ? store.work.queries.catalog.people({ space, query: view === "people" ? request.query.query : undefined,
        cursor: view === "people" ? request.query.cursor : undefined, limit: request.query.limit }) : undefined;
      const conflicts: Record<string, string[]> = {};
      const features = store.work.queries.features?.status(space);
      for (const memory of memories) {
        if (memory.status === "rejected" || memory.supersededBy || memory.forgottenAt || store.work.memory.suppressed(memory)) continue;
        const other = store.work.memoryConflicts(memory);
        if (other.length) conflicts[memory.id] = other.map((entry) => entry.id);
      }
      return {
        memories,
        people: people?.people || [],
        jobs: imports.jobs(space, 30),
        conflicts,
        captures: space === "personal" ? captures.jobs(undefined, 50) : [],
        settings: store.work.memory.settings(),
        revision: store.work.memory.revision,
        pagination: { total: page.total, nextCursor: page.nextCursor, revision: page.revision },
        peoplePagination: people ? { total: people.total, nextCursor: people.nextCursor, revision: people.revision } : undefined,
        counts: store.work.queries.catalog.counts(space),
        features,
        activeJobs: imports.busy() || (space === "personal" && captures.hasPending()) || features?.state === "starting" ||
          (features?.state === "ready" && features.jobs.queued + features.jobs.running > 0),
      };
    },
  );
  app.get<{ Querystring: MemorySearch }>(
    "/api/memory-search",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", maxLength: 200 },
            space: spaceSchema,
            person: { type: "string", maxLength: 80 },
            personId: uuid,
            eventId: uuid,
            category: { enum: ["profile", "event", "relationship", "fact"] },
            from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            includeHistorical: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request) => ({
      memories: store.work.searchMemories(
        request.query.query || "",
        request.query.limit,
        request.query,
      ),
    }),
  );
  app.post<{ Body: MemoryImportInput }>(
    "/api/memory-imports",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "modelId"],
          properties: {
            requestId: uuid,
            modelId: { type: "string", minLength: 1, maxLength: 300 },
            space: spaceSchema,
            demo: { type: "boolean" },
            mode: { const: "photos" },
            title: { type: "string", maxLength: 200 },
            thinkingLevel: {
              enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
            assetIds: {
              type: "array",
              maxItems: 20,
              uniqueItems: true,
              items: uuid,
            },
            records: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "text"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 200 },
                  text: { type: "string", minLength: 1, maxLength: 100000 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (blocked())
        throw new UserFacingError(
          409,
          "CONFIGURING",
          "配置正在更新，请稍后重试",
        );
      return reply.code(202).send({ job: await imports.create(request.body) });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/memory-imports/:id",
    { schema: { params: idParams } },
    async (request) => ({ job: imports.job(request.params.id) }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/memory-imports/:id/cancel",
    { schema: { params: idParams } },
    async (request) => ({ job: imports.cancel(request.params.id) }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/memory-imports/:id/retry",
    { schema: { params: idParams } },
    async (request) => {
      if (blocked())
        throw new UserFacingError(
          409,
          "CONFIGURING",
          "配置正在更新，请稍后重试",
        );
      return { job: imports.retry(request.params.id) };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { version: number; replace: { id: string; version: number }[]; resolution?: "correction" | "change" };
  }>(
    "/api/memories/:id/resolve",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["version", "replace"],
          properties: {
            version: { type: "integer", minimum: 1 },
            replace: refs,
            resolution: { enum: ["correction", "change"] },
          },
        },
      },
    },
    async (request) => ({
      memory: (store.memoryCommands.change({ action: "resolve", entries: [{ id: request.params.id, version: request.body.version }],
        replace: request.body.replace, resolution: request.body.resolution, reason: "用户核对冲突" }, { actor: "user" }).result as { memories: MemoryEntry[] }).memories[0],
    }),
  );
  app.post<{
    Body: {
      entries: { id: string; version: number }[];
      status: "confirmed" | "rejected";
    };
  }>(
    "/api/memories/review",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["entries", "status"],
          properties: {
            entries: refs,
            status: { enum: ["confirmed", "rejected"] },
          },
        },
      },
    },
    async (request) => store.memoryCommands.change({ action: request.body.status === "confirmed" ? "confirm" : "reject",
      entries: request.body.entries, reason: "用户批量核对" }, { actor: "user" }).result,
  );
  app.get("/api/memory-settings", async () => ({ settings: store.work.memory.settings() }));
  app.patch<{ Body: Partial<MemorySettings> }>("/api/memory-settings", { schema: { body: {
    type: "object", additionalProperties: false, properties: { capture: { enum: ["graded", "off"] }, timeZone: { type: "string", minLength: 1, maxLength: 80 },
      photoModelId: { type: "string", maxLength: 200 }, textModelId: { type: "string", maxLength: 200 }, datasetModelId: { type: "string", maxLength: 200 }, datasetReviewModelId: { type: "string", maxLength: 200 },
      videoModelId: { type: "string", maxLength: 200 }, videoSampleInterval: { type: "number", minimum: 1, maximum: 120 },
      intake: { enum: ["automatic", "manual"] }, automaticText: { type: "boolean" }, automaticPhotos: { type: "boolean" }, automaticVideos: { type: "boolean" }, indexAssets: { type: "boolean" } },
  } } }, async (request) => {
    const settings = store.work.memory.setSettings(request.body);
    if (settings.capture === "off") captures.cancelPending();
    return { settings };
  });
  app.get<{ Querystring: { runId?: string } }>("/api/memory-captures", { schema: { querystring: { type: "object", properties: { runId: uuid }, additionalProperties: false } } }, async (request) => ({ jobs: captures.jobs(request.query.runId).slice(0, 50) }));
  for (const action of ["cancel", "retry"] as const) app.post<{ Params: { id: string } }>(`/api/memory-captures/:id/${action}`, { schema: { params: idParams } }, async (request) => {
    if (blocked()) throw new UserFacingError(409, "CONFIGURING", "配置正在更新，请稍后重试");
    return { job: captures[action](request.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/capture", { schema: { params: idParams } }, async (request, reply) => {
    if (blocked()) throw new UserFacingError(409, "CONFIGURING", "配置正在更新，请稍后重试");
    const run = store.work.get<Run>("run", request.params.id);
    if (!run) throw new UserFacingError(404, "NOT_FOUND", "对话不存在");
    if (!["completed", "failed", "stopped"].includes(run.status)) throw new UserFacingError(409, "BUSY", "请等待本轮对话结束");
    const existing = captures.jobs(run.id).find((job) => job.messageId === run.id);
    const job = existing && ["failed", "cancelled"].includes(existing.status) ? captures.retry(existing.id) : captures.enqueue(run, true);
    return reply.code(202).send({ job });
  });
  for (const action of ["forget", "restore"] as const) app.post<{ Params: { id: string }; Body: { version: number } }>(`/api/memories/:id/${action}`, {
    schema: { params: idParams, body: { type: "object", required: ["version"], additionalProperties: false, properties: { version: { type: "integer", minimum: 1 } } } },
  }, async (request) => ({ memory: (store.memoryCommands.change({ action, entries: [{ id: request.params.id, version: request.body.version }],
    reason: action === "restore" ? "用户恢复取用" : "用户停止取用" }, { actor: "user" }).result as { memories: MemoryEntry[] }).memories[0] }));
  app.get<{ Params: { id: string; index: string } }>("/api/memories/:id/evidence/:index", async (request) => {
    const memory = store.work.get<MemoryEntry>("memory", request.params.id);
    const index = Number(request.params.index);
    const evidence = memory && Number.isSafeInteger(index) && index >= 0 ? evidenceOf(memory)[index] : undefined;
    if (!evidence) throw new UserFacingError(404, "NOT_FOUND", "来源不存在");
    if (evidence.type === "asset" && evidence.visual) {
      const asset = store.asset(evidence.assetId);
      if (!asset) throw new UserFacingError(410, "SOURCE_MISSING", "图片原件已不可用");
      if (asset.sha256 !== evidence.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件校验不一致");
      const photo = evidence.video ? await prepareVideoFrame(store.assetsDir, asset, evidence.video.requestedTimestamp, { region: evidence.view?.region })
        : await preparePhoto(store.assetsDir, asset, evidence.view?.region);
      return { evidence, verified: true, verification: "asset-hash", previewMatches: photo.sha256 === evidence.visual.previewSha256 };
    }
    let buffer: Buffer;
    if (evidence.type === "message") {
      const run = store.work.get<Run>("run", evidence.runId);
      const text = run && (evidence.messageId === run.id ? run.text : evidence.messageId === run.id + ":answer" ? run.question?.answer : run.interventions?.find((input) => input.id === evidence.messageId)?.text);
      if (text === undefined) throw new UserFacingError(410, "SOURCE_MISSING", "原始对话已删除，保留引句供核对");
      buffer = Buffer.from(text);
    } else {
      try { buffer = await readFile(join(store.assetsDir, evidence.assetId)); }
      catch { throw new UserFacingError(410, "SOURCE_MISSING", "原始素材已不可用，保留引句供核对"); }
    }
    if (contentHash(buffer) !== evidence.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "原始来源校验不一致");
    return { evidence, quote: buffer.subarray(evidence.start, evidence.end).toString("utf8"), verified: true };
  });
  app.get<{ Params: { id: string; index: string } }>("/api/memories/:id/evidence/:index/image", async (request, reply) => {
    const memory = store.work.get<MemoryEntry>("memory", request.params.id);
    const index = Number(request.params.index);
    const source = memory && Number.isSafeInteger(index) && index >= 0 ? evidenceOf(memory)[index] : undefined;
    if (source?.type !== "asset" || !source.visual) throw new UserFacingError(404, "NOT_FOUND", "照片依据不存在");
    const asset = store.asset(source.assetId);
    if (!asset) throw new UserFacingError(410, "SOURCE_MISSING", "图片原件已不可用");
    if (asset.sha256 !== source.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件校验不一致");
    const photo = source.video ? await prepareVideoFrame(store.assetsDir, asset, source.video.requestedTimestamp, { region: source.view?.region })
      : await preparePhoto(store.assetsDir, asset, source.view?.region);
    if (photo.sha256 !== source.visual.previewSha256)
      throw new UserFacingError(409, "PREVIEW_CHANGED", "图片预处理版本已改变，请下载原图核验");
    return reply.type("image/jpeg").header("Cache-Control", "private, no-store").send(photo.data);
  });
  const personBody = { type: "object", additionalProperties: false, required: ["name", "aliases"], properties: {
    name: { type: "string", minLength: 1, maxLength: 80 }, aliases: { type: "array", maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } },
    entries: { ...refs, minItems: 0 }, unlink: { ...refs, minItems: 0 }, version: { type: "integer", minimum: 1 },
  } };
  for (const method of ["POST", "PATCH"] as const) app.route<{ Params: { id?: string }; Body: { name: string; aliases: string[]; version?: number; entries?: { id: string; version: number }[]; unlink?: { id: string; version: number }[] } }>({
    method, url: method === "POST" ? "/api/memory-people" : "/api/memory-people/:id", schema: { body: personBody },
    handler: async (request) => store.memoryCommands.person({ ...request.body, id: request.params.id }, { actor: "user", space: "personal" }).result,
  });
}
