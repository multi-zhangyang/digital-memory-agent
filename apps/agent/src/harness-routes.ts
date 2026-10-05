import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  AgentApproval,
  AgentResource,
  McpConnection,
  Project,
  Run,
} from "@memory/contracts";
import type { Store } from "./store.js";
import type { AppConfig } from "./config.js";
import { projectRoot } from "./config.js";
import { browseDirectories, isWithin } from "./local-directories.js";
import { UserFacingError, type AgentRuntime } from "./harness/runtime.js";
import type { WorkspaceService } from "./workspace-service.js";
import { extensionPresentation, savePresentation } from "./application/extension-ui.js";
import {
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  changesSince,
  revertChange,
  hash,
} from "./project-files.js";
const text = (maxLength = 1000) => ({ type: "string", maxLength });
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" };
const name = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" };
const mode = { enum: ["read", "ask", "auto"] };
export function registerHarnessRoutes(
  app: FastifyInstance,
  config: AppConfig,
  store: Store,
  service: WorkspaceService,
  runtime: () => AgentRuntime,
  reset: () => Promise<void>,
  unavailable: () => boolean,
) {
  const commands = new Set<string>();
  function idle(projectId?: string) {
    const directory = projectId
      ? store.harness.project(projectId).directory
      : undefined;
    if (
      unavailable() ||
      commands.size ||
      store.conversations().some(
        (c) =>
          service.busy(c.id) &&
          (!projectId ||
            (() => {
              const activeDirectory = store.harness.project(
                store.harness.association(c.id).projectId,
              ).directory;
              return (
                isWithin(directory!, activeDirectory) ||
                isWithin(activeDirectory, directory!)
              );
            })()),
      )
    )
      throw new UserFacingError(409, "AGENT_BUSY", "请等待当前任务完成");
  }
  const model = (conversationId: string) =>
    store.conversation(conversationId)?.modelId ||
    config.publicModels.models[0]?.id ||
    "";
  app.get("/api/projects", async () => ({
    projects: store.harness.projects(),
  }));
  app.get<{
    Querystring: {
      path?: string;
      query?: string;
      hidden?: boolean;
      offset?: number;
    };
  }>(
    "/api/directories",
    {
      schema: {
        querystring: object({
          path: text(4096),
          query: text(200),
          hidden: { type: "boolean" },
          offset: { type: "integer", minimum: 0, maximum: 1000000 },
        }),
      },
    },
    async (req) =>
      browseDirectories(
        req.query,
        store.harness.privatePaths,
        dirname(projectRoot.replace(/\/$/, "")),
      ),
  );
  app.post<{ Body: { path: string } }>(
    "/api/projects/open",
    {
      schema: {
        body: object({ path: { ...text(4096), minLength: 1 } }, ["path"]),
      },
    },
    async (req, reply) => {
      const result = await store.harness.openProject(req.body.path);
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );
  app.post<{ Body: { name: string } }>(
    "/api/projects",
    {
      schema: {
        body: object({ name: { ...text(100), minLength: 1 } }, ["name"]),
      },
    },
    async (req) => ({
      project: store.harness.createProject(req.body.name.trim()),
    }),
  );
  app.patch<{ Params: { id: string }; Body: Partial<Project> }>(
    "/api/projects/:id",
    {
      schema: {
        params: object({ id }, ["id"]),
        body: object({
          name: { ...text(100), minLength: 1 },
          instructions: text(20000),
          permissionMode: mode,
          network: { type: "boolean" },
          disabledTools: { type: "array", items: text(200), maxItems: 200 },
        }),
      },
    },
    async (req) => {
      idle();
      const project = store.harness.project(req.params.id);
      const updated = store.harness.save("project", {
        ...project,
        ...req.body,
        updatedAt: new Date().toISOString(),
      });
      await reset();
      return { project: updated };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/files",
    async (req) => ({
      files: await listProjectFiles(
        store.harness.root(req.params.id),
        store.harness.excludedPaths(req.params.id),
      ),
    }),
  );
  app.get<{
    Params: { id: string };
    Querystring: { path: string; download?: string };
  }>(
    "/api/projects/:id/file",
    {
      schema: {
        querystring: object({ path: text(1024), download: { enum: ["1"] } }, [
          "path",
        ]),
      },
    },
    async (req, reply) => {
      const bytes = await readProjectFile(
        store.harness.root(req.params.id),
        req.query.path,
        undefined,
        store.harness.excludedPaths(req.params.id),
      );
      if (req.query.download === "1")
        return reply
          .header("Content-Type", "application/octet-stream")
          .header(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" +
              encodeURIComponent(
                req.query.path.split("/").at(-1) || "file",
              ).replace(/'/g, "%27"),
          )
          .send(bytes);
      return {
        path: req.query.path,
        content:
          bytes.includes(0) || bytes.length > 512 * 1024
            ? null
            : bytes.toString("utf8"),
        hash: hash(bytes),
        size: bytes.length,
      };
    },
  );
  app.put<{
    Params: { id: string };
    Body: { path: string; content: string; hash?: string | null };
  }>(
    "/api/projects/:id/file",
    {
      schema: {
        body: object(
          {
            path: { ...text(1024), minLength: 1 },
            content: text(512 * 1024),
            hash: { type: ["string", "null"], maxLength: 64 },
          },
          ["path", "content", "hash"],
        ),
      },
    },
    async (req) => {
      idle(req.params.id);
      const root = store.harness.root(req.params.id);
      const excluded = store.harness.excludedPaths(req.params.id);
      let current: Buffer | undefined;
      try {
        current = await readProjectFile(
          root,
          req.body.path,
          undefined,
          excluded,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if ((current ? hash(current) : null) !== req.body.hash)
        throw new UserFacingError(
          409,
          "FILE_CHANGED",
          "文件已有修改，请刷新后检查",
        );
      await writeProjectFile(root, req.body.path, req.body.content, excluded);
      return { saved: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/files",
    async (req) => {
      idle(req.params.id);
      const file = await req.file();
      if (!file) throw new UserFacingError(400, "FILE_REQUIRED", "请选择文件");
      const filename = file.filename.split(/[\\/]/).at(-1) || "file";
      const root = store.harness.root(req.params.id);
      const excluded = store.harness.excludedPaths(req.params.id);
      let exists = false;
      try {
        await readProjectFile(root, filename, undefined, excluded);
        exists = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (exists)
        throw new UserFacingError(
          409,
          "FILE_EXISTS",
          "同名文件已存在，请先重命名",
        );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of file.file) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024)
          throw new UserFacingError(
            413,
            "FILE_LIMIT",
            "项目文件不能超过 10 MB",
          );
        chunks.push(chunk);
      }
      await writeProjectFile(root, filename, Buffer.concat(chunks), excluded);
      return { path: filename };
    },
  );
  app.get("/api/harness", async () => store.harness.publicSettings());
  app.patch<{
    Body: {
      searchEnabled?: boolean;
      searchKey?: string;
      autoCompaction?: boolean;
      retry?: boolean;
    };
  }>(
    "/api/harness",
    {
      schema: {
        body: object({
          searchEnabled: { type: "boolean" },
          searchKey: text(4096),
          autoCompaction: { type: "boolean" },
          retry: { type: "boolean" },
        }),
      },
    },
    async (req) => {
      idle();
      store.harness.saveSettings({
        ...req.body,
        ...(req.body.searchKey === ""
          ? { searchKey: store.harness.settings.searchKey }
          : {}),
      });
      await reset();
      return store.harness.publicSettings();
    },
  );
  app.post<{ Body: Omit<AgentResource, "id"> & { id?: string } }>(
    "/api/harness/resources",
    {
      schema: {
        body: object(
          {
            id,
            name,
            kind: { enum: ["skill", "prompt"] },
            description: text(500),
            content: text(50000),
            enabled: { type: "boolean" },
          },
          ["name", "kind", "description", "content", "enabled"],
        ),
      },
    },
    async (req) => {
      idle();
      const value = { ...req.body, id: req.body.id || randomUUID() };
      const resources = store.harness.settings.resources;
      if (resources.some((r) => r.id !== value.id && r.name === value.name))
        throw new UserFacingError(409, "NAME_EXISTS", "资源名称已存在");
      store.harness.saveSettings({
        resources: [...resources.filter((r) => r.id !== value.id), value],
      });
      await reset();
      return { resource: value };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/harness/resources/:id",
    async (req) => {
      idle();
      store.harness.saveSettings({
        resources: store.harness.settings.resources.filter(
          (r) => r.id !== req.params.id,
        ),
      });
      await reset();
      return { deleted: true };
    },
  );
  const secrets = {
    type: "object",
    maxProperties: 30,
    additionalProperties: text(4096),
  };
  app.post<{
    Body: McpConnection & {
      headers?: Record<string, string>;
      env?: Record<string, string>;
    };
  }>(
    "/api/harness/mcp",
    {
      schema: {
        body: object(
          {
            id,
            name,
            transport: { enum: ["http", "stdio"] },
            exposure: { enum: ["direct", "deferred"] },
            url: text(2048),
            command: text(1000),
            args: { type: "array", items: text(1000), maxItems: 50 },
            enabled: { type: "boolean" },
            headers: secrets,
            env: secrets,
          },
          ["name", "transport", "url", "command", "args", "enabled"],
        ),
      },
    },
    async (req) => {
      idle();
      const s = req.body;
      if (s.transport === "http") {
        const url = new URL(s.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new UserFacingError(
            400,
            "MCP_URL",
            "请输入不含凭据和查询参数的 HTTP(S) MCP 地址",
          );
      }
      if (s.transport === "stdio" && !s.command.trim())
        throw new UserFacingError(400, "MCP_COMMAND", "请输入 MCP 启动命令");
      if (
        [...Object.values(s.headers || {}), ...Object.values(s.env || {})].some(
          (v) => v.startsWith("!") || v.includes("${"),
        )
      )
        throw new UserFacingError(400, "MCP_SECRETS", "认证字段必须使用字面值");
      if (
        Object.keys(s.env || {}).some(
          (k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k),
        )
      )
        throw new UserFacingError(400, "MCP_ENV", "环境变量名称无效");
      const previous = store.harness.settings.mcp.find((m) => m.id === s.id);
      if (
        store.harness.settings.mcp.some(
          (m) => m.id !== s.id && m.name === s.name,
        )
      )
        throw new UserFacingError(409, "MCP_NAME", "连接名称已存在");
      const value = { ...previous, ...s, id: s.id || randomUUID() };
      store.harness.saveSettings({
        mcp: [
          ...store.harness.settings.mcp.filter((m) => m.id !== value.id),
          value,
        ],
      });
      await reset();
      return store.harness.publicSettings();
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/harness/mcp/:id",
    async (req) => {
      idle();
      store.harness.saveSettings({
        mcp: store.harness.settings.mcp.filter((m) => m.id !== req.params.id),
      });
      await reset();
      return { deleted: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/session",
    async (req) => {
      service.conversation(req.params.id);
      if (!runtime().state || !model(req.params.id))
        throw new UserFacingError(503, "MODEL_REQUIRED", "请先配置模型");
      return runtime().state!(req.params.id, model(req.params.id));
    },
  );
  app.post<{
    Params: { id: string };
    Body: { text: string; mode?: "steer" | "followUp" };
  }>(
    "/api/conversations/:id/steer",
    {
      schema: {
        body: object(
          {
            text: { ...text(20000), minLength: 1 },
            mode: { enum: ["steer", "followUp"] },
          },
          ["text"],
        ),
      },
    },
    async (req) => {
      const run = store.work.activeRun(req.params.id);
      if (!run || !runtime().steer)
        throw new UserFacingError(409, "NOT_RUNNING", "没有正在执行的任务");
      const value = {
        id: randomUUID(),
        text: req.body.text,
        mode: req.body.mode || "steer",
        status: "queued" as const,
        createdAt: new Date().toISOString(),
      };
      store.work.patchRun(
        run.id,
        { interventions: [...(run.interventions || []), value] },
        "steering",
      );
      if (["user", "approval", "recovery"].includes(run.waitingFor || "")) return { accepted: true };
      try {
        const disposition = await runtime().steer!(req.params.id, req.body.text, req.body.mode);
        if (disposition === "handled") {
          const latest = service.requireRun(run.id);
          store.work.patchRun(run.id, { interventions: latest.interventions?.map((item) => item.id === value.id ? { ...item, status: "handled" } : item) }, "steering");
        }
      } catch (e) {
        const latest = service.requireRun(run.id);
        store.work.patchRun(
          run.id,
          {
            interventions: latest.interventions?.map((i) =>
              i.id === value.id ? { ...i, status: "returned" } : i,
            ),
          },
          "steering",
        );
        throw e;
      }
      return { accepted: true };
    },
  );
  app.patch<{ Params: { id: string }; Body: { text: string; revision?: string } }>("/api/conversations/:id/editor", {
    schema: { body: object({ text: text(100000), revision: text(80) }, ["text"]) },
  }, async (req) => {
    service.conversation(req.params.id);
    const current = extensionPresentation(store, req.params.id);
    // A delayed browser save must not overwrite a newer extension prefill request.
    if (current.editor?.source === "extension" && current.editor.revision !== req.body.revision)
      return { editor: current.editor };
    savePresentation(store, req.params.id, { ...current, editor: { text: req.body.text, revision: randomUUID(), source: "user" } }, false);
    return { saved: true };
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/queue/clear", async (req) => {
    service.conversation(req.params.id);
    const run = store.work.activeRun(req.params.id);
    if (!run) return { texts: [] };
    if (!runtime().clearQueue) throw new UserFacingError(501, "UNSUPPORTED", "运行时不支持清空队列");
    const pendingIds = new Set(run.interventions?.filter((item) => item.status === "queued").map((item) => item.id));
    await runtime().clearQueue!(req.params.id);
    const latest = service.requireRun(run.id);
    const pending = latest.interventions?.filter((item) => pendingIds.has(item.id) && item.status === "queued") || [];
    store.work.patchRun(run.id, { interventions: latest.interventions?.map((item) => pendingIds.has(item.id) && item.status === "queued" ? { ...item, status: "returned" } : item) }, "queue-cleared");
    return { texts: pending.map((item) => item.text) };
  });
  app.post<{ Params: { id: string }; Body: { entryId: string } }>("/api/conversations/:id/navigate", {
    schema: { body: object({ entryId: text(80) }, ["entryId"]) },
  }, async (req) => {
    service.conversation(req.params.id);
    if (service.busy(req.params.id) || commands.has(req.params.id) || store.work.activeRun(req.params.id))
      throw new UserFacingError(409, "RUN_BUSY", "请先完成或停止当前任务");
    if (!runtime().navigate) throw new UserFacingError(501, "UNSUPPORTED", "运行时不支持会话树导航");
    commands.add(req.params.id);
    try { return await runtime().navigate!(req.params.id, model(req.params.id), req.body.entryId); }
    finally { commands.delete(req.params.id); }
  });
  app.post<{ Params: { id: string }; Body: { instructions?: string } }>(
    "/api/conversations/:id/compact",
    { schema: { body: object({ instructions: text(2000) }) } },
    async (req) => {
      service.conversation(req.params.id);
      idle();
      if (!runtime().compact)
        throw new UserFacingError(501, "UNSUPPORTED", "运行时不支持压缩");
      commands.add(req.params.id);
      try {
        await runtime().compact!(
          req.params.id,
          model(req.params.id),
          req.body.instructions,
        );
        return { compacted: true };
      } finally {
        commands.delete(req.params.id);
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { entryId?: string } }>(
    "/api/conversations/:id/fork",
    { schema: { body: object({ entryId: text(80) }) } },
    async (req) => {
      const parent = service.conversation(req.params.id);
      idle();
      if (!runtime().fork)
        throw new UserFacingError(501, "UNSUPPORTED", "运行时不支持分支");
      const child = store.createConversation();
      store.harness.link(child.id, parent.projectId || "default", parent.id);
      try {
        await runtime().fork!(parent.id, child.id, req.body.entryId);
      } catch (e) {
        store.work.deleteConversation(child.id);
        throw e;
      }
      store.touchConversation(
        child.id,
        parent.modelId || "",
        parent.title + " · 分支",
      );
      return { conversation: service.conversation(child.id) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/export",
    async (req, reply) => {
      const c = service.conversation(req.params.id);
      return reply
        .header(
          "Content-Disposition",
          'attachment; filename="conversation.json"',
        )
        .send({
          conversation: c,
          messages: await runtime().history(c.id),
          runs: store.work.list<Run>("run", c.id),
        });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/runs/:id/approvals",
    async (req) => {
      service.requireRun(req.params.id);
      return { approvals: store.harness.approvals(req.params.id) };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { approved: boolean; answer?: string };
  }>(
    "/api/approvals/:id",
    {
      schema: {
        body: object({ approved: { type: "boolean" }, answer: text(20000) }, [
          "approved",
        ]),
      },
    },
    async (req) => {
      const approval = store.harness.get<AgentApproval>(
        "approval",
        req.params.id,
      );
      if (!approval || approval.status !== "pending")
        throw new UserFacingError(409, "APPROVAL_EXPIRED", "此请求已处理");
      const run = service.requireRun(approval.runId);
      if (!["running", "waiting"].includes(run.status) || run.stopRequestedAt)
        throw new UserFacingError(409, "APPROVAL_EXPIRED", "任务已结束");
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now())
        throw new UserFacingError(409, "APPROVAL_EXPIRED", "此请求已超时");
      if (req.body.approved && approval.kind === "select" && !approval.options.includes(req.body.answer || ""))
        throw new UserFacingError(400, "INVALID_ANSWER", "请选择请求提供的选项");
      store.harness.save("approval", {
        ...approval,
        status: req.body.approved ? "approved" : "denied",
        resolution: "user",
        answer: req.body.answer,
      });
      store.work.patchRun(run.id, {}, "approval");
      await service.approvalResolved(run.id);
      return { saved: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { path: string } }>(
    "/api/runs/:id/revert",
    { schema: { body: object({ path: text(1024) }, ["path"]) } },
    async (req) => {
      const run = service.requireRun(req.params.id);
      const projectId = store.harness.association(run.conversationId).projectId;
      idle(projectId);
      const change = run.changes?.find((c) => c.path === req.body.path);
      if (!change) throw new UserFacingError(404, "NO_CHANGE", "变更不存在");
      const root = store.harness.root(projectId),
        directory = join(config.dataDir, "checkpoints", run.id);
      const excluded = store.harness.excludedPaths(projectId);
      await revertChange(root, directory, change, excluded);
      store.work.patchRun(
        run.id,
        { changes: await changesSince(root, directory, excluded) },
        "reverted",
      );
      return { reverted: true };
    },
  );
  return { busy: () => commands.size > 0 };
}
