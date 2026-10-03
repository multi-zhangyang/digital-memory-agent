import type { FastifyInstance } from "fastify";
import type {
  MemoryEntry,
  MemoryOverview,
  MemoryPerson,
  MemorySearch,
  MemorySpace,
} from "@memory/contracts";
import type { Store } from "./store.js";
import { UserFacingError } from "./runtime.js";
import { memorySpace } from "./memory-retrieval.js";
import { MemoryImports, type MemoryImportInput } from "./memory-imports.js";

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

export function registerMemoryRoutes(
  app: FastifyInstance,
  store: Store,
  imports: MemoryImports,
  blocked: () => boolean,
) {
  app.get<{ Querystring: { space?: MemorySpace } }>(
    "/api/memory-overview",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { space: spaceSchema },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<MemoryOverview> => {
      const space = request.query.space || "personal";
      const memories = store.work
        .list<MemoryEntry>("memory")
        .filter((entry) => memorySpace(entry) === space)
        .reverse();
      const people = new Map<string, MemoryPerson>();
      const conflicts: Record<string, string[]> = {};
      for (const memory of memories) {
        if (memory.status === "rejected" || memory.supersededBy) continue;
        const other = store.work.memoryConflicts(memory, memories);
        if (other.length) conflicts[memory.id] = other.map((entry) => entry.id);
        for (const name of memory.people || []) {
          const person = people.get(name) || {
            name,
            memoryIds: [],
            confirmedCount: 0,
          };
          person.memoryIds.push(memory.id);
          if (memory.status === "confirmed") person.confirmedCount++;
          people.set(name, person);
        }
      }
      return {
        memories,
        people: [...people.values()].sort(
          (a, b) => b.memoryIds.length - a.memoryIds.length,
        ),
        jobs: imports.jobs(space).slice(0, 30),
        conflicts,
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
    Body: { version: number; replace: { id: string; version: number }[] };
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
          },
        },
      },
    },
    async (request) => ({
      memory: store.work.resolveMemory(
        request.params.id,
        request.body.version,
        request.body.replace,
      ),
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
    async (request) =>
      store.work.transaction(() => {
        if (
          new Set(request.body.entries.map((entry) => entry.id)).size !==
          request.body.entries.length
        )
          throw new UserFacingError(400, "DUPLICATE", "请选择不同的记忆");
        return {
          memories: request.body.entries.map((ref) =>
            store.work.updateMemory(
              ref.id,
              { status: request.body.status },
              ref.version,
            ),
          ),
        };
      }),
  );
}
