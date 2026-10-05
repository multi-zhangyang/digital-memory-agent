import { timelinePage } from "./timeline-page.js";
import { extensionPresentation } from "./extension-ui.js";
import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { validateFileReferences } from "../file-references.js";
import { randomUUID } from "node:crypto";
import type { Artifact, AssetCollection, MemoryEntry, MemorySpace, Run, RunInput, WorkspaceDetail } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import { type AgentRuntime, UserFacingError } from "../harness/runtime.js";
import { memoryAttributeSchema, memoryCategorySchema } from "../memory-extraction.js";
import { memorySpace } from "../memory/retrieval.js";
import { validateValidity } from "../memory/time.js";
import { combineEvidence, evidenceOf } from "../memory/ledger.js";

import { WorkspaceService } from "./task-service.js";

const terminal = (run: Run) =>
  ["completed", "failed", "stopped"].includes(run.status);
const uuid = { type: "string", format: "uuid" };
const thinking = {
  enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};
const runSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "modelId"],
  properties: {
    text: { type: "string", maxLength: 100000 },
    modelId: { type: "string", minLength: 1, maxLength: 300 },
    assetIds: { type: "array", items: uuid, maxItems: 30, uniqueItems: true },
    fileReferences: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 2000 },
          runId: uuid,
        },
      },
    },
    scope: { enum: ["selected", "library"] },
    thinkingLevel: thinking,
    useMemory: { type: "boolean" },
    captureMemory: { type: "boolean" },
    retryOf: uuid,
    permissionMode: { enum: ["read", "ask", "auto"] },
  },
};

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: WorkspaceService,
  runtime: () => AgentRuntime,
  unavailable: () => boolean,
  legacyBusy: (id: string) => boolean,
) {
  const store = service.store;
  app.get("/api/workspace", async () => ({
    conversations: store
      .conversations()
      .map((row) => service.conversation(row.id)),
    assets: store.assets(),
    collections: store.work.list<AssetCollection>("collection"),
    artifacts: store.work.list<Artifact>("artifact").reverse(),
    memories: store.work.queries.catalog.page({ space: "personal" }).memories,
  }));
  app.post<{ Body: { title: string; assetIds: string[] } }>(
    "/api/collections",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "assetIds"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            assetIds: {
              type: "array",
              items: uuid,
              maxItems: 1000,
              uniqueItems: true,
            },
          },
        },
      },
    },
    async (request) => {
      if (request.body.assetIds.some((id) => !store.asset(id)))
        throw new UserFacingError(400, "SOURCE_MISSING", "资料不存在");
      const timestamp = new Date().toISOString();
      return {
        collection: store.work.save("collection", {
          ...request.body,
          id: randomUUID(),
          conversationId: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { title: string; assetIds: string[] };
  }>(
    "/api/collections/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "assetIds"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            assetIds: {
              type: "array",
              items: uuid,
              maxItems: 1000,
              uniqueItems: true,
            },
          },
        },
      },
    },
    async (request) => {
      const previous = store.work.get<AssetCollection>(
        "collection",
        request.params.id,
      );
      if (!previous) throw new UserFacingError(404, "NOT_FOUND", "集合不存在");
      if (request.body.assetIds.some((id) => !store.asset(id)))
        throw new UserFacingError(400, "SOURCE_MISSING", "资料不存在");
      return {
        collection: store.work.save("collection", {
          ...previous,
          ...request.body,
          updatedAt: new Date().toISOString(),
        }),
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/conversations/:id/timeline", async (request): Promise<WorkspaceDetail> => {
      const conversation = service.conversation(request.params.id);
      const limit = Number(request.query.limit || 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserFacingError(400, "LIMIT", "历史页大小应为 1 到 100");
      const activeEntryIds = await runtime().activeEntries?.(conversation.id);
      const page = await timelinePage(store, conversation.id, () => runtime().history(conversation.id), request.query.before, limit, activeEntryIds);
      const active = store.work.activeRun(conversation.id);
      if (!request.query.before && active && !page.runs.some((run) => run.id === active.id)) page.runs.unshift(active);
      const ids = new Set(page.runs.flatMap((run) => [...run.assetIds, ...run.sources.map((ref) => ref.assetId)]));
      return { conversation, ...page, presentation: extensionPresentation(store, conversation.id), activeEntryIds, assets: store.assets().filter((asset) => ids.has(asset.id)),
        artifacts: store.work.list<Artifact>("artifact", conversation.id),
        memories: store.work.queries.catalog.page({ conversationId: conversation.id }).memories };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/workspace",
    async (request): Promise<WorkspaceDetail> => {
      const conversation = service.conversation(request.params.id);
      const runs = store.work.list<Run>("run", conversation.id);
      const first = runs[0]?.createdAt;
      const legacyMessages = (await runtime().history(conversation.id)).filter(
        (message) => !first || message.createdAt < first,
      );
      const ids = new Set(
        runs.flatMap((run) => [
          ...run.assetIds,
          ...run.sources.map((ref) => ref.assetId),
        ]),
      );
      return {
        conversation,
        runs,
        assets: store.assets().filter((asset) => ids.has(asset.id)),
        artifacts: store.work.list<Artifact>("artifact", conversation.id),
        memories: store.work.queries.catalog.page({ conversationId: conversation.id }).memories,
        legacyMessages,
      };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { title?: string; pinned?: boolean; archived?: boolean };
  }>(
    "/api/conversations/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            pinned: { type: "boolean" },
            archived: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const row = service.conversation(request.params.id);
      const { title, ...preferences } = request.body;
      if (title?.trim())
        store.touchConversation(row.id, row.modelId || "", title.trim());
      store.work.setPreferences(row.id, preferences);
      return { conversation: service.conversation(row.id) };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (request) => {
      const row = service.conversation(request.params.id);
      if (service.busy(row.id) || legacyBusy(row.id))
        throw new UserFacingError(409, "BUSY", "请先停止当前任务");
      store.work.deleteConversation(row.id);
      await rm(join(store.sessionsDir, row.id + ".jsonl"), { force: true });
      return { deleted: true };
    },
  );
  app.post<{ Params: { id: string }; Body: RunInput }>(
    "/api/conversations/:id/runs",
    { schema: { body: runSchema } },
    async (request, reply) => {
      if (unavailable() || legacyBusy(request.params.id))
        throw new UserFacingError(409, "BUSY", "请等待配置更新或当前请求结束");
      const input = { ...request.body, text: request.body.text.trim() };
      if (!input.text && !input.assetIds?.length)
        throw new UserFacingError(400, "EMPTY", "请输入任务内容或添加资料");
      if (
        !config.providers.some(
          (provider) => provider.model.id === input.modelId,
        )
      )
        throw new UserFacingError(503, "MODEL_UNAVAILABLE", "请先配置模型连接");
      if (
        input.assetIds?.some(
          (id) => !store.asset(id) || store.asset(id)?.memorySpace === "demo",
        )
      )
        throw new UserFacingError(
          400,
          "SOURCE_MISSING",
          "部分资料已不存在，请重新选择",
        );
      if (input.scope === "selected" && !input.assetIds?.length)
        throw new UserFacingError(400, "SOURCE_MISSING", "请至少选择一份资料");
      if (input.fileReferences?.length) {
        const conversation = service.conversation(request.params.id);
        input.fileReferences = await validateFileReferences(
          store,
          conversation.projectId || "default",
          input.fileReferences,
        );
      }
      if (
        input.retryOf &&
        service.requireRun(input.retryOf).conversationId !== request.params.id
      )
        throw new UserFacingError(400, "INVALID_RETRY", "重试任务不匹配");
      if (
        store.work
          .list<Run>("run", request.params.id)
          .filter((run) => run.status === "queued").length >= 10
      )
        throw new UserFacingError(409, "QUEUE_FULL", "待执行队列已满");
      return reply
        .code(201)
        .send({ run: service.enqueue(request.params.id, input) });
    },
  );
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => ({
    run: service.requireRun(request.params.id),
  }));
  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/stop",
    async (request) => {
      await service.stop(request.params.id);
      return { run: service.requireRun(request.params.id) };
    },
  );
  app.post<{ Params: { id: string }; Body: { answer: string } }>(
    "/api/runs/:id/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["answer"],
          properties: {
            answer: { type: "string", minLength: 1, maxLength: 10000 },
          },
        },
      },
    },
    async (request) => {
      const run = service.requireRun(request.params.id);
      if (run.status !== "waiting" || !run.question)
        throw new UserFacingError(
          409,
          "NOT_WAITING",
          "任务当前没有待回答的问题",
        );
      const answer = request.body.answer.trim();
      if (!answer) throw new UserFacingError(400, "EMPTY", "请输入回答");
      return { run: await service.answer(run.id, answer) };
    },
  );
  app.post<{ Params: { id: string }; Body: { decisions?: { toolCallId: string; action: "skip" | "retry" }[]; acceptConfiguration?: boolean } }>(
    "/api/runs/:id/resume", { schema: { body: { type: "object", additionalProperties: false, properties: {
      decisions: { type: "array", maxItems: 50, items: { type: "object", required: ["toolCallId", "action"], additionalProperties: false,
        properties: { toolCallId: { type: "string", minLength: 1, maxLength: 200 }, action: { enum: ["skip", "retry"] } } } },
      acceptConfiguration: { type: "boolean" },
    } } } }, async (request) => ({ run: await service.resume(request.params.id, request.body || {}) }));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/runs/:id/events",
    async (request, reply) => {
      service.requireRun(request.params.id);
      let after = Number(
        request.headers["last-event-id"] || request.query.after || 0,
      );
      if (!Number.isSafeInteger(after) || after < 0)
        throw new UserFacingError(400, "CURSOR", "无效的事件位置");
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      let ticks = 0;
      const tick = () => {
        if (closed || reply.raw.destroyed) return;
        const events = store.work.events(request.params.id, after);
        for (const event of events) {
          reply.raw.write(
            "id: " + event.seq + "\ndata: " + JSON.stringify(event) + "\n\n",
          );
          after = event.seq;
        }
        if (
          terminal(service.requireRun(request.params.id)) &&
          events.length < 1000
        ) {
          reply.raw.write("event: settled\ndata: {}\n\n");
          reply.raw.end();
          clearInterval(timer);
        } else if (++ticks % 100 === 0) reply.raw.write(": heartbeat\n\n");
      };
      const timer = setInterval(tick, 120);
      timer.unref();
      reply.raw.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
      tick();
    },
  );
  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (request) => {
    const artifact = store.work.get<Artifact>("artifact", request.params.id);
    if (!artifact) throw new UserFacingError(404, "NOT_FOUND", "结果不存在");
    return { artifact, versions: store.work.versions<Artifact>(artifact.id) };
  });
  app.patch<{
    Params: { id: string };
    Body: { title: string; content: string; version: number };
  }>(
    "/api/artifacts/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "content", "version"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            content: { type: "string", maxLength: 100000 },
            version: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const artifact = store.work.get<Artifact>("artifact", request.params.id);
      if (!artifact) throw new UserFacingError(404, "NOT_FOUND", "结果不存在");
      return {
        artifact: store.work.writeArtifact({
          ...artifact,
          ...request.body,
          author: "user",
        }),
      };
    },
  );
  app.get<{ Params: { id: string } }>("/api/memories/:id", async (request) => {
    const memory = store.work.get<MemoryEntry>("memory", request.params.id);
    if (!memory) throw new UserFacingError(404, "NOT_FOUND", "记忆不存在");
    return {
      memory,
      versions: store.work.versions<MemoryEntry>(memory.id),
      conflicts: store.work.memoryConflicts(memory),
    };
  });
  app.patch<{
    Params: { id: string };
    Body: {
      version: number;
      title?: string;
      content?: string;
      status?: MemoryEntry["status"];
      occurredAt?: string;
      reason?: string;
      people?: string[];
      place?: string;
      category?: MemoryEntry["category"];
      attribute?: MemoryEntry["attribute"] | null;
      uncertainty?: string;
      validity?: MemoryEntry["validity"];
      personIds?: string[];
    };
  }>(
    "/api/memories/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["version"],
          properties: {
            version: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1, maxLength: 120 },
            content: { type: "string", minLength: 1, maxLength: 4000 },
            status: { enum: ["draft", "confirmed", "rejected"] },
            occurredAt: { type: "string", maxLength: 100 },
            reason: { type: "string", maxLength: 1000 },
            people: {
              type: "array",
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 80 },
              uniqueItems: true,
            },
            place: { type: "string", maxLength: 120 },
            category: memoryCategorySchema,
            attribute: { anyOf: [memoryAttributeSchema, { type: "null" }] },
            uncertainty: { type: "string", maxLength: 500 },
            validity: { type: "object", additionalProperties: false, required: ["precision"], properties: {
              from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              precision: { enum: ["day", "month", "year", "unknown"] }, expression: { type: "string", maxLength: 100 },
            } },
            personIds: { type: "array", maxItems: 8, uniqueItems: true, items: uuid },
          },
        },
      },
    },
    async (request) => {
      const { version, ...patch } = request.body;
      if (patch.validity && !validateValidity(patch.validity)) throw new UserFacingError(400, "INVALID_DATE", "请检查有效时间范围");
      const result = store.memoryCommands.update({ id: request.params.id, version }, patch, { actor: "user" }).result as { memories: MemoryEntry[] };
      const memory = result.memories[0];
      return {
        memory,
        conflicts: store.work.memoryConflicts(memory),
      };
    },
  );
  app.post<{
    Body: {
      title: string;
      content: string;
      occurredAt?: string;
      space?: MemorySpace;
    };
  }>(
    "/api/memories",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            content: { type: "string", minLength: 1, maxLength: 4000 },
            occurredAt: { type: "string", maxLength: 100 },
            space: { enum: ["personal", "demo"] },
          },
        },
      },
    },
    async (request) => ({
      memory: store.work.createMemory({
        ...request.body,
        occurredAt: request.body.occurredAt || "",
        status: "confirmed",
        kind: "statement",
        statement: request.body.content,
        sources: [],
        conversationId: "",
        runId: "",
      }),
    }),
  );
  app.post<{
    Body: {
      entries: Array<{ id: string; version: number }>;
      title: string;
      content: string;
    };
  }>(
    "/api/memories/merge",
    {
      schema: {
        body: {
          type: "object",
          required: ["entries", "title", "content"],
          properties: {
            entries: {
              type: "array",
              minItems: 2,
              maxItems: 10,
              items: {
                type: "object",
                required: ["id", "version"],
                properties: {
                  id: uuid,
                  version: { type: "integer", minimum: 1 },
                },
              },
            },
            title: { type: "string", minLength: 1, maxLength: 120 },
            content: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request) => {
      if (
        new Set(request.body.entries.map((ref) => ref.id)).size !==
        request.body.entries.length
      )
        throw new UserFacingError(400, "DUPLICATE", "请选取不同的记忆");
      const entries = request.body.entries.map((ref) => {
        const entry = store.work.get<MemoryEntry>("memory", ref.id);
        if (!entry || entry.version !== ref.version)
          throw new UserFacingError(
            409,
            "VERSION_CONFLICT",
            "记忆已更新，请刷新后合并",
          );
        return entry;
      });
      if (new Set(entries.map(memorySpace)).size !== 1)
        throw new UserFacingError(
          400,
          "SPACE_MISMATCH",
          "不同记忆空间的记录不能合并",
        );
      if (entries.some((entry) => entry.forgottenAt || store.work.memory.suppressed(entry)))
        throw new UserFacingError(409, "SOURCE_SUPPRESSED", "请先恢复取用后再合并记忆");
      const sources = entries
        .flatMap((entry) => entry.sources)
        .filter(
          (source, index, values) =>
            values.findIndex(
              (other) =>
                other.assetId === source.assetId &&
                other.start === source.start &&
                other.end === source.end,
            ) === index,
        );
      return store.work.transaction(() => {
        const memory = store.work.createMemory({
          title: request.body.title,
          content: request.body.content,
          sources,
          evidence: combineEvidence(entries.flatMap(evidenceOf)),
          status: "draft",
          kind: "inference",
          space: memorySpace(entries[0]),
          occurredAt: "",
          conversationId: entries[0].conversationId,
          runId: entries[0].runId,
          reason: "合并自 " + entries.map((entry) => entry.id).join(", "),
        });
        for (const entry of entries)
          store.work.updateMemory(
            entry.id,
            { status: "rejected", reason: "已合并到 " + memory.id },
            entry.version,
          );
        return { memory };
      });
    },
  );
}
