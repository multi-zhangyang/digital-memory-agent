import Fastify, { type FastifyError } from "fastify";
import multipart from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AppHealth,
  Asset,
  ConnectionUpdate,
  Conversation,
  ConversationDetail,
  ProviderId,
} from "@memory/contracts";
import { updateConnection, type AppConfig } from "./config.js";
import { Store } from "./store.js";
import { PiRuntime } from "./integrations/pi/runtime.js";
import { createPiHost } from "./application/pi-host.js";
import { createMemoryTools, memoryToolCatalog } from "./memory-tools.js";
import { type AgentRuntime, UserFacingError } from "./harness/runtime.js";
import { WorkspaceService } from "./application/task-service.js";
import { registerWorkspaceRoutes } from "./application/workspace-routes.js";

import { registerHarnessRoutes } from "./harness-routes.js";
import { createGeneralTools, generalToolCatalog } from "./general-tools.js";
import { MemoryImports } from "./memory/imports.js";
import { MemoryCaptures } from "./memory/captures.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { ModelAccess } from "./integrations/pi/model-access.js";
import { PiMemoryProcessors, type MemoryProcessors } from "./integrations/pi/processors.js";
import { TaskJobs } from "./harness/jobs.js";
import { AssetProcessingService } from "./memory/asset-processing-service.js";
import { createMemoryCommandTools } from "./memory-command-tools.js";
import { createProcessingTools } from "./processing-tools.js";
import { LocalMemoryProcessor, type LocalFeatures } from "./integrations/local-features.js";
import { MemoryFeatureService } from "./memory/feature-service.js";
import { MemoryEvents } from "./memory/events.js";
import { createKnowledgeTools } from "./memory-knowledge-tools.js";
import { registerKnowledgeRoutes } from "./memory-knowledge-routes.js";
import { DatasetService } from "./memory/dataset-service.js";
import { createDatasetTools } from "./dataset-tools.js";
import { registerDatasetRoutes } from "./dataset-routes.js";
import { CapabilityRegistry } from "./harness/capability-registry.js";
import { capabilityStatuses } from "./application/capabilities.js";
import { registerProductRoutes } from "./application/product-routes.js";
import { AutomaticIntake } from "./memory/automatic-intake.js";
import { AssetIndexService } from "./memory/asset-index-service.js";
import { EvidenceService } from "./memory/evidence-service.js";
import { createEvidenceTools } from "./application/evidence-tools.js";
import { captureJobs, memoryIndexJobs } from "./application/maintenance-jobs.js";

const uuid = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
} as const;
const idParams = { type: "object", properties: { id: uuid }, required: ["id"] };
const safeImages = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const safeVideos = new Set(["video/mp4", "video/webm", "video/ogg"]);

export function buildApp(
  config: AppConfig,
  options: { runtime?: AgentRuntime; store?: Store; processors?: MemoryProcessors; features?: LocalFeatures } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 0,
  });
  const store = options.store || new Store(config.dataDir);
  const featureWorker = options.features || (config.localProcessor ? new LocalMemoryProcessor(config.localProcessor) : undefined);
  const features = new MemoryFeatureService(store, featureWorker);
  const assetIndex = new AssetIndexService(store, features);
  const evidence = new EvidenceService(store, features);
  store.work.queries.features = features;
  const events = new MemoryEvents(store);
  let models = new ModelAccess(config);
  let processors = options.processors || new PiMemoryProcessors(config, models);
  const imports = new MemoryImports(store, config, () => processors);
  const jobs = new TaskJobs(store);
  const processing = new AssetProcessingService(store, config, imports);
  const datasets = new DatasetService(store, () => processors);
  jobs.register("memory-import", processing.driver());
  jobs.register("memory-dataset", datasets.driver());
  jobs.register("dataset-audit", datasets.audits.driver());
  const businessTools = (id: string) => [...createMemoryTools(store, id), ...createMemoryCommandTools(store, id), ...createProcessingTools(store, processing, jobs, id),
    ...createKnowledgeTools(store, events, id), ...createDatasetTools(store, datasets, jobs, id), ...createEvidenceTools(store, config, evidence, id)];
  const capabilities = new CapabilityRegistry([
    { catalog: generalToolCatalog, create: (id: string) => createGeneralTools(store, id) },
    { catalog: memoryToolCatalog, create: businessTools },
  ], () => capabilityStatuses(config, store, features));
  let runtime = options.runtime || new PiRuntime(config, createPiHost(store, (id) => capabilities.tools(id)), models);
  const resetRuntime = () => {
    models = new ModelAccess(config);
    processors = options.processors || new PiMemoryProcessors(config, models);
    runtime = new PiRuntime(config, createPiHost(store, (id) => capabilities.tools(id)), models);
    store.events.publish("processing.configuration-changed", "models", new Date().toISOString());
  };
  let configuring = false;
  const intake = new AutomaticIntake(store, processing, () => configuring);
  jobs.register("asset-intake", intake.driver());
  jobs.register("asset-index", assetIndex.driver());
  const active = new Map<string, { cancelled: boolean; done: Promise<void>; memoryEpoch: number }>();
  const workspace = new WorkspaceService(store, () => runtime, jobs);
  const captures = new MemoryCaptures(store, config, () => processors, () => configuring || workspace.busy() || active.size > 0 || imports.busy());
  workspace.captures = captures;
  jobs.register("memory-capture", captureJobs(store, captures));
  jobs.register("memory-index", memoryIndexJobs(store, features));
  store.events.subscribe("harness.context-invalidation", ["memory.invalidated"], async (event) => {
    const epoch = Number(event.revision);
    await workspace.invalidateMemory(epoch);
    for (const [id, state] of active) if (state.memoryEpoch < epoch) { state.cancelled = true; await runtime.cancel(id); }
  });

  app.register(multipart, {
    limits: { fileSize: config.uploadLimit, files: 1, fields: 1 },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    const hostname = request.hostname;
    const hosts = new Set([
      "localhost",
      "127.0.0.1",
      "[::1]",
      config.host,
      ...config.allowedOrigins.map((value) => new URL(value).hostname),
    ]);
    if (
      !hosts.has(hostname) ||
      (origin && !config.allowedOrigins.includes(origin)) ||
      (!origin && request.headers["sec-fetch-site"] === "cross-site")
    ) {
      return reply.code(403).send({
        error: { code: "ORIGIN_REJECTED", message: "请求来源不被允许。" },
      });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UserFacingError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    const failure = error as FastifyError;
    if (failure.validation)
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "请求内容格式不正确。" },
      });
    if (failure.code === "FST_REQ_FILE_TOO_LARGE")
      return reply.code(413).send({
        error: { code: "FILE_TOO_LARGE", message: "文件超过上传大小限制。" },
      });
    return reply
      .code(
        failure.statusCode && failure.statusCode < 500
          ? failure.statusCode
          : 500,
      )
      .send({
        error: { code: "REQUEST_FAILED", message: "请求未完成，请稍后重试。" },
      });
  });

  const conversation = (id: string): Conversation => {
    const row = store.conversation(id);
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "对话不存在。");
    return {
      ...workspace.conversation(id),
      running: active.has(id) || workspace.busy(id),
    };
  };

  app.get(
    "/api/health",
    async (): Promise<AppHealth> => ({
      status: "ok",
      capabilities: {
        chat: config.providers.length > 0,
        assets: true,
        memory: true,
        people: true,
        training: false,
      },
    }),
  );
  app.get("/api/models", async () => config.publicModels);
  app.get("/api/tools", async () => ({
    tools: capabilities.catalog(),
  }));
  app.post<{ Params: { id: ProviderId }; Body: ConnectionUpdate }>(
    "/api/settings/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "enabled",
            "baseUrl",
            "modelName",
            "protocol",
            "contextWindow",
            "maxTokens",
            "reasoning",
            "thinkingLevel",
          ],
          properties: {
            enabled: { type: "boolean" },
            baseUrl: { type: "string", minLength: 1, maxLength: 2048 },
            modelName: { type: "string", maxLength: 200 },
            apiKey: { type: "string", maxLength: 4096 },
            protocol: {
              enum: [
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
              ],
            },
            contextWindow: { type: "integer", minimum: 8192, maximum: 2000000 },
            maxTokens: { type: "integer", minimum: 256, maximum: 128000 },
            reasoning: { type: "boolean" },
            supportsImages: { type: "boolean" },
            thinkingLevel: {
              enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
          },
        },
      },
    },
    async (request) => {
      if (
        active.size ||
        workspace.busy() ||
        configuring ||
        harness.busy() ||
        imports.busy() ||
        datasets.busy()
      )
        throw new UserFacingError(
          409,
          "AGENT_BUSY",
          "请等待当前任务完成后再修改配置",
        );
      configuring = true;
      try {
        await captures.yieldToForeground();
        try {
          updateConnection(config, request.params.id, request.body);
        } catch {
          throw new UserFacingError(
            400,
            "INVALID_CONFIG",
            "无法保存，请检查接口地址、协议和上下文参数",
          );
        }
        await runtime.close();
        resetRuntime();
        return config.publicModels;
      } finally {
        configuring = false;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/settings/providers/:id/test",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
          },
          required: ["id"],
        },
      },
    },
    async (request) => {
      if (configuring || !runtime.testConnection)
        throw new UserFacingError(409, "AGENT_BUSY", "请稍后重试");
      return runtime.testConnection(request.params.id);
    },
  );
  app.get("/api/conversations", async () => ({
    conversations: store.conversations().map((row) => conversation(row.id)),
  }));
  app.post<{ Body: { projectId?: string } }>(
    "/api/conversations",
    {
      preValidation: async (request) => {
        request.body ||= {};
      },
      schema: {
        body: {
          type: "object",
          properties: { projectId: { type: "string", maxLength: 80 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const project = store.harness.project(
        request.body?.projectId || "default",
      );
      const row = store.createConversation();
      store.harness.link(row.id, project.id);
      return reply
        .code(201)
        .send({ conversation: workspace.conversation(row.id) });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id",
    { schema: { params: idParams } },
    async (request): Promise<ConversationDetail> => ({
      conversation: conversation(request.params.id),
      messages: await runtime.history(request.params.id),
    }),
  );

  app.post<{ Params: { id: string }; Body: { text: string; modelId: string } }>(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text", "modelId"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 100000 },
            modelId: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const row = conversation(id);
      if (configuring || harness.busy())
        throw new UserFacingError(
          409,
          "CONFIGURING",
          "模型配置正在更新，请稍后重试",
        );
      const text = request.body.text.trim();
      if (!text)
        throw new UserFacingError(400, "EMPTY_MESSAGE", "请输入消息内容。");
      if (
        !config.publicModels.models.some(
          (model) => model.id === request.body.modelId,
        )
      )
        throw new UserFacingError(
          503,
          "MODEL_UNAVAILABLE",
          "请先在服务端配置可用的模型 API。",
        );
      if (active.has(id) || workspace.busy(id))
        throw new UserFacingError(
          409,
          "CONVERSATION_BUSY",
          "此对话正在生成，请等待完成或先停止。",
        );
      let complete!: () => void;
      const state = {
        cancelled: false,
        memoryEpoch: store.memories.ledger.epoch,
        done: new Promise<void>((resolve) => {
          complete = resolve;
        }),
      };
      active.set(id, state);
      store.touchConversation(
        id,
        request.body.modelId,
        row.title === "新的对话" ? text.slice(0, 40) : undefined,
      );
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "x-vercel-ai-ui-message-stream": "v1",
        "X-Content-Type-Options": "nosniff",
      });
      const send = (value: unknown) => {
        if (!response.destroyed && !response.writableEnded)
          response.write("data: " + JSON.stringify(value) + "\n\n");
      };
      const messageId = randomUUID();
      let textOpen = false;
      let textIndex = 0;
      let textId = "";
      const pendingTools = new Set<string>();
      const closeText = () => {
        if (textOpen) {
          send({ type: "text-end", id: textId });
          textOpen = false;
        }
      };
      send({ type: "start", messageId });
      send({ type: "start-step" });
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded)
          response.write(": keep-alive\n\n");
      }, 15000);
      try {
        await runtime.prompt(id, request.body.modelId, text, (event) => {
          if (event.type === "text") {
            if (!textOpen) {
              textId = messageId + "-text-" + textIndex++;
              send({ type: "text-start", id: textId });
              textOpen = true;
            }
            send({ type: "text-delta", id: textId, delta: event.delta });
          } else if (event.type === "tool-start") {
            closeText();
            pendingTools.add(event.id);
            send({
              type: "tool-input-available",
              toolCallId: event.id,
              toolName: event.name,
              input: event.input,
            });
          } else if (event.type === "tool-end") {
            pendingTools.delete(event.id);
            if (event.error)
              send({
                type: "tool-output-error",
                toolCallId: event.id,
                errorText: state.cancelled
                  ? "已停止"
                  : typeof event.output === "string"
                    ? event.output
                    : "工具执行失败。",
              });
            else
              send({
                type: "tool-output-available",
                toolCallId: event.id,
                output: event.output,
              });
          }
        });
        closeText();
        for (const toolCallId of pendingTools)
          send({
            type: "tool-output-error",
            toolCallId,
            errorText: state.cancelled ? "已停止" : "执行已中断",
          });
        pendingTools.clear();
        send({ type: "finish-step" });
        send({
          type: "finish",
          finishReason: state.cancelled ? "other" : "stop",
        });
      } catch (error) {
        closeText();
        for (const toolCallId of pendingTools)
          send({
            type: "tool-output-error",
            toolCallId,
            errorText: state.cancelled ? "已停止" : "执行已中断",
          });
        if (!state.cancelled)
          send({
            type: "error",
            errorText:
              error instanceof UserFacingError
                ? error.message
                : "模型请求失败，请检查接口配置或稍后重试。",
          });
        send({
          type: "finish",
          finishReason: state.cancelled ? "other" : "error",
        });
      } finally {
        clearInterval(heartbeat);
        if (!response.destroyed && !response.writableEnded) {
          response.write("data: [DONE]\n\n");
          response.end();
        }
        active.delete(id);
        complete();
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/cancel",
    { schema: { params: idParams } },
    async (request) => {
      conversation(request.params.id);
      const state = active.get(request.params.id);
      if (state) {
        state.cancelled = true;
        await runtime.cancel(request.params.id);
        await state.done;
      }
      return { cancelled: !!state };
    },
  );

  app.get("/api/assets", async () => ({ assets: store.assets() }));
  app.get<{ Params: { id: string } }>(
    "/api/assets/:id",
    { schema: { params: idParams } },
    async (request) => {
      const asset = store.asset(request.params.id);
      if (!asset) throw new UserFacingError(404, "NOT_FOUND", "资料不存在");
      return { asset };
    },
  );
  app.post<{ Querystring: { processing?: "automatic" | "requested" } }>("/api/assets", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: { processing: { enum: ["automatic", "requested"] } },
  } } }, async (request, reply) => {
    const part = await request.file();
    if (!part) throw new UserFacingError(400, "FILE_REQUIRED", "请选择文件。");
    const id = randomUUID();
    const temporary = join(store.assetsDir, id + ".partial");
    const destination = join(store.assetsDir, id);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(
        part.file,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated)
        throw new UserFacingError(
          413,
          "FILE_TOO_LARGE",
          "文件超过上传大小限制。",
        );
      const mimeType = part.mimetype.toLowerCase();
      const kind = safeImages.has(mimeType)
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("text/") || mimeType === "application/json"
            ? "text"
            : "file";
      const asset: Asset = {
        id,
        name:
          part.filename
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .split(/[\\/]/)
            .pop()
            ?.slice(0, 240) || "未命名文件",
        mimeType,
        kind,
        size,
        sha256: hash.digest("hex"),
        createdAt: new Date().toISOString(),
      };
      await rename(temporary, destination);
      store.addAsset(asset, { processing: request.query.processing || "automatic" });
      return reply.code(201).send({ asset });
    } catch (error) {
      await Promise.allSettled([
        rm(temporary, { force: true }),
        rm(destination, { force: true }),
      ]);
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/assets/:id/content",
    { schema: { params: idParams } },
    async (request, reply) => {
      const asset = store.asset(request.params.id);
      if (!asset) throw new UserFacingError(404, "NOT_FOUND", "素材不存在。");
      const inline =
        request.query.download !== "1" &&
        (safeImages.has(asset.mimeType) || safeVideos.has(asset.mimeType));
      reply.header(
        "Content-Type",
        inline ? asset.mimeType : "application/octet-stream",
      );
      reply.header(
        "Content-Disposition",
        (inline ? "inline" : "attachment") +
          "; filename*=UTF-8''" +
          encodeURIComponent(asset.name).replace(/'/g, "%27"),
      );
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Accept-Ranges", "bytes");
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = 0;
        let end = asset.size - 1;
        if (match && (match[1] || match[2])) {
          if (!match[1]) start = Math.max(0, asset.size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(Number(match[2]), end);
          }
        } else start = asset.size;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= asset.size ||
          start < 0
        )
          return reply
            .code(416)
            .header("Content-Range", "bytes */" + asset.size)
            .send();
        reply
          .code(206)
          .header(
            "Content-Range",
            "bytes " + start + "-" + end + "/" + asset.size,
          )
          .header("Content-Length", end - start + 1);
        return reply.send(
          createReadStream(join(store.assetsDir, asset.id), { start, end }),
        );
      }
      reply.header("Content-Length", asset.size);
      return reply.send(createReadStream(join(store.assetsDir, asset.id)));
    },
  );

  const harness = registerHarnessRoutes(
    app,
    config,
    store,
    workspace,
    () => runtime,
    async () => {
      configuring = true;
      try {
        await captures.yieldToForeground();
        await runtime.close();
        resetRuntime();
      } finally {
        configuring = false;
      }
    },
    () => configuring || active.size > 0 || imports.busy(),
  );
  registerWorkspaceRoutes(
    app,
    config,
    workspace,
    () => runtime,
    () => configuring || harness.busy(),
    (id) => active.has(id),
  );
  registerMemoryRoutes(
    app,
    store,
    imports,
    () => configuring || harness.busy(),
    captures,
  );
  registerKnowledgeRoutes(app, store, features, events);
  registerDatasetRoutes(app, datasets);
  registerProductRoutes(app, store, jobs, capabilities, evidence, processing);
  app.addHook("onReady", async () => {
    store.events.start();
    intake.wake();
    assetIndex.start();
    workspace.wake();
    imports.wake();
    captures.wake();
    features.start();
    datasets.start();
  });
  app.addHook("preClose", async () => {
    await store.events.close();
    await intake.close();
    await workspace.close();
    await captures.close();
    await imports.close();
    await assetIndex.close();
    await features.close();
    await datasets.close();
    for (const [id, state] of active) {
      state.cancelled = true;
      await runtime.cancel(id);
    }
    await Promise.all([...active.values()].map((state) => state.done));
  });
  app.addHook("onClose", async () => {
    await runtime.close();
    jobs.close();
    store.close();
  });
  return app;
}
