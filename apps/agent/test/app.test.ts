import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readdir, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { readConfig, type AppConfig } from "../src/config.js";
import type {
  AppHealth,
  Artifact,
  Asset,
  Conversation,
  ConversationDetail,
  MemoryEntry,
  ModelConfiguration,
  Run,
  WorkspaceDetail,
} from "@memory/contracts";

const secret = "test-secret-do-not-expose";
type ProtocolMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};
const messageText = (message: ProtocolMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text || "").join("");
const json = <T>(response: Response): Promise<T> =>
  response.json() as Promise<T>;
const cleaners: Array<() => Promise<unknown>> = [];
const connectionInput = (baseUrl: string) => ({
  enabled: true,
  baseUrl,
  modelName: "test-model",
  apiKey: secret,
  protocol: "openai-completions",
  contextWindow: 256000,
  maxTokens: 16384,
  reasoning: true,
  thinkingLevel: "max",
});
async function post<T>(
  url: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json() as Promise<T>;
}
async function waitRun(
  origin: string,
  id: string,
  status?: string,
): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { run } = await fetch(origin + "/api/runs/" + id).then(
      json<{ run: Run }>,
    );
    if (
      status
        ? run.status === status
        : ["completed", "failed", "stopped"].includes(run.status)
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Run did not settle");
}
afterEach(async () => {
  const pending = cleaners.splice(0).reverse();
  for (const cleanup of pending) await cleanup();
});

async function fixture(withProvider = false, uploadLimit = 1024 * 1024) {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-test-"));
  cleaners.push(() => rm(dataDir, { recursive: true, force: true }));
  let providerUrl = "";
  const requests: Array<{ messages: ProtocolMessage[]; tools?: unknown[] }> =
    [];
  if (withProvider) {
    const provider = Fastify();
    provider.post<{ Body: { messages: ProtocolMessage[]; tools?: unknown[] } }>(
      "/v1/chat/completions",
      async (request, reply) => {
        requests.push(request.body);
        expect(request.headers.authorization).toBe("Bearer " + secret);
        const users = request.body.messages.filter(
          (message) => message.role === "user",
        );
        const latest = messageText(users.at(-1)!);
        // A durable continuation is a Harness message, with the original user
        // task and answered tool result retained in the Pi request.
        const last = latest === "依据当前任务上下文和恢复记录继续执行，并交付实际结果。"
          ? users.map(messageText).find((text) => text === "question") || latest : latest;
        if (last === "error")
          return reply.code(401).send({
            error: {
              message: "Private upstream error: " + secret,
              type: "authentication_error",
            },
          });
        reply.hijack();
        const response = reply.raw;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (
          content: string | null,
          finish: string | null = null,
        ) => {
          response.write(
            "data: " +
              JSON.stringify({
                id: "test-completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [
                  {
                    index: 0,
                    delta: content === null ? {} : { content },
                    finish_reason: finish,
                  },
                ],
              }) +
              "\n\n",
          );
        };
        const results = request.body.messages.filter(
          (message) => message.role === "tool",
        );
        if (last === "workspace" || last === "recall" || last === "question") {
          const found = results.map((message) => {
            try {
              return JSON.parse(messageText(message));
            } catch {
              return {};
            }
          });
          const asset = found.find((value) => value.assets)?.assets[0];
          const calls =
            last === "workspace"
              ? [
                  [
                    "update_plan",
                    {
                      steps: [
                        { title: "读取资料", status: "running" },
                        { title: "整理结果与记忆", status: "pending" },
                      ],
                    },
                  ],
                  ["search_assets", { query: "" }],
                  ["read_asset_text", { assetId: asset?.id }],
                  [
                    "write_artifact",
                    {
                      title: "散步整理",
                      content: "周六在公园散步。",
                      sourceAssetIds: asset ? [asset.id] : [],
                    },
                  ],
                  [
                    "propose_memory",
                    {
                      title: "公园散步",
                      content: "周六在公园散步。",
                      kind: "observation",
                      sourceAssetIds: asset ? [asset.id] : [],
                    },
                  ],
                  [
                    "update_plan",
                    {
                      steps: [
                        { title: "读取资料", status: "completed" },
                        { title: "整理结果与记忆", status: "completed" },
                      ],
                    },
                  ],
                ]
              : last === "recall"
                ? [["search_memories", { query: "公园" }]]
                : [
                    [
                      "ask_user",
                      {
                        question: "这次发生在周几？",
                        options: ["周六", "周日"],
                      },
                    ],
                  ];
          const call = calls[results.length];
          if (call) {
            response.write(
              "data: " +
                JSON.stringify({
                  id: "test-completion",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "test-model",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "workspace-call-" + results.length,
                            type: "function",
                            function: {
                              name: call[0],
                              arguments: JSON.stringify(call[1]),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }) +
                "\n\n",
            );
            chunk(null, "tool_calls");
            response.end("data: [DONE]\n\n");
            return;
          }
          chunk(
            last === "recall"
              ? JSON.stringify(found[0])
              : last === "question"
                ? "收到回答：" + found[0].answer
                : "已保存整理结果与记忆草稿。",
          );
          chunk(null, "stop");
          response.end("data: [DONE]\n\n");
          return;
        }
        if (
          (last === "tools" && results.length < 2) ||
          (last === "missing-tool" && !results.length)
        ) {
          const search = last === "tools" && !results.length;
          const assetId = results.length
            ? JSON.parse(messageText(results.at(-1)!)).assets[0]?.id
            : "00000000-0000-0000-0000-000000000000";
          if (search) chunk("先查找相关资料。");
          response.write(
            "data: " +
              JSON.stringify({
                id: "test-completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: search ? "call-search" : "call-read",
                          type: "function",
                          function: {
                            name: search ? "search_assets" : "read_asset_text",
                            arguments: JSON.stringify(
                              search ? { query: "散步" } : { assetId },
                            ),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }) +
              "\n\n",
          );
          chunk(null, "tool_calls");
          response.end("data: [DONE]\n\n");
          return;
        }
        if (last === "tools" && results.length === 2) {
          chunk("根据资料：" + JSON.parse(messageText(results[1])).text);
          chunk(null, "stop");
          response.end("data: [DONE]\n\n");
          return;
        }
        chunk("收到：" + last + "；轮次=" + users.length);
        if (last === "slow") {
          const timer = setInterval(() => {
            if (!response.destroyed) chunk("…");
          }, 50);
          response.once("close", () => clearInterval(timer));
        } else {
          chunk(null, "stop");
          response.end("data: [DONE]\n\n");
        }
      },
    );
    provider.post<{ Body: { messages: ProtocolMessage[]; tools?: unknown[] } }>(
      "/v1/messages",
      async (request, reply) => {
        requests.push(request.body);
        expect(request.headers["x-api-key"]).toBe(secret);
        const text = messageText(
          request.body.messages
            .filter((message) => message.role === "user")
            .at(-1)!,
        );
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: "test-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Anthropic 收到：" + text },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ];
        for (const event of events)
          reply.raw.write(
            "event: " +
              event.type +
              "\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          );
        reply.raw.end();
      },
    );
    providerUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    cleaners.push(async () => {
      provider.server.closeAllConnections();
      await provider.close();
    });
  }
  const config = readConfig({
    MEMORY_DATA_DIR: dataDir,
    MEMORY_UPLOAD_LIMIT: String(uploadLimit),
    ...(withProvider
      ? {
          MEMORY_OPENAI_API_KEY: secret,
          MEMORY_OPENAI_MODEL: "test-model",
          MEMORY_OPENAI_BASE_URL: providerUrl + "/v1",
          MEMORY_ANTHROPIC_API_KEY: secret,
          MEMORY_ANTHROPIC_MODEL: "test-model",
          MEMORY_ANTHROPIC_BASE_URL: providerUrl,
        }
      : {}),
  });
  let app = buildApp(config);
  let origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cleaners.push(async () => { app.server.closeAllConnections(); await app.close(); });
  return {
    config,
    requests,
    dataDir,
    get app() {
      return app;
    },
    get origin() {
      return origin;
    },
    async restart() {
      await app.close();
      app = buildApp(config);
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
    },
    async create() {
      const response = await fetch(origin + "/api/conversations", {
        method: "POST",
      });
      expect(response.status).toBe(201);
      return (await json<{ conversation: Conversation }>(response)).conversation
        .id;
    },
    async message(
      id: string,
      text: string,
      modelId = "openai-compatible/test-model",
    ) {
      return fetch(origin + "/api/conversations/" + id + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, modelId }),
      });
    },
    async detail(id: string): Promise<ConversationDetail> {
      return fetch(origin + "/api/conversations/" + id).then(
        json<ConversationDetail>,
      );
    },
  };
}

describe("local workspace and boundaries", () => {
  it("starts without credentials, shows disabled capabilities, and rejects cross-origin and invalid requests", async () => {
    const f = await fixture();
    const health = await fetch(f.origin + "/api/health").then(json<AppHealth>);
    expect(health.capabilities).toEqual({
      chat: false,
      assets: true,
      memory: true,
      people: true,
      training: false,
    });
    const modelResponse = await fetch(f.origin + "/api/models").then(
      json<ModelConfiguration>,
    );
    expect(modelResponse.models).toEqual([]);
    const id = await f.create();
    expect((await f.message(id, "hello")).status).toBe(503);
    expect(
      (
        await fetch(f.origin + "/api/conversations", {
          method: "POST",
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.origin + "/api/assets", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/models",
          headers: { host: "rebind.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await fetch(f.origin + "/api/conversations/not-a-uuid")).status,
    ).toBe(400);
  });

  it("stores uploads, preserves content across restart, supports byte ranges and forces unsafe content to download", async () => {
    const f = await fixture();
    const form = new FormData();
    form.append(
      "file",
      new Blob(["0123456789"], { type: "video/mp4" }),
      "旅行.mp4",
    );
    const upload = await fetch(f.origin + "/api/assets", {
      method: "POST",
      body: form,
    });
    expect(upload.status).toBe(201);
    const { asset } = await json<{ asset: Asset }>(upload);
    expect(asset.size).toBe(10);
    expect(asset.kind).toBe("video");
    const range = await fetch(
      f.origin + "/api/assets/" + asset.id + "/content",
      { headers: { Range: "bytes=2-5" } },
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("2345");
    const suffix = await fetch(
      f.origin + "/api/assets/" + asset.id + "/content",
      { headers: { Range: "bytes=-2" } },
    );
    expect(await suffix.text()).toBe("89");
    expect(
      (
        await fetch(f.origin + "/api/assets/" + asset.id + "/content", {
          headers: { Range: "bytes=90-" },
        })
      ).status,
    ).toBe(416);
    await f.restart();
    const assets = await fetch(f.origin + "/api/assets").then(
      json<{ assets: Asset[] }>,
    );
    expect(assets.assets[0].sha256).toBe(asset.sha256);
    expect(
      await fetch(f.origin + "/api/assets/" + asset.id + "/content").then((r) =>
        r.text(),
      ),
    ).toBe("0123456789");
    const html = new FormData();
    html.append(
      "file",
      new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
      "page.html",
    );
    const { asset: htmlAsset } = await fetch(f.origin + "/api/assets", {
      method: "POST",
      body: html,
    }).then(json<{ asset: Asset }>);
    const content = await fetch(
      f.origin + "/api/assets/" + htmlAsset.id + "/content",
    );
    expect(content.headers.get("content-disposition")).toContain("attachment");
    expect(content.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    expect(await content.text()).toBe("<script>alert(1)</script>");
  });

  it("cleans up rejected oversized uploads", async () => {
    const f = await fixture(false, 8);
    const form = new FormData();
    form.append("file", new Blob(["way-too-large-file"]), "large.txt");
    const response = await fetch(f.origin + "/api/assets", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(413);
    expect(await readdir(join(f.dataDir, "assets"))).toEqual([]);
    expect(
      (await fetch(f.origin + "/api/assets").then(json<{ assets: Asset[] }>))
        .assets,
    ).toEqual([]);
  });
});

describe("real Pi adapter with a local model-protocol test server", () => {
  it("streams through Pi, isolates conversations, and restores authoritative history after restart", async () => {
    const f = await fixture(true);
    const models = await fetch(f.origin + "/api/models").then((r) => r.text());
    expect(models).not.toContain(secret);
    const a = await f.create();
    const first = await f.message(a, "第一段经历");
    expect(first.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(await first.text()).toContain("轮次=1");
    expect(f.requests[0].tools).toHaveLength(35);
    for (const name of ["inspect_memories", "change_memories", "manage_memory_links", "inspect_dataset", "audit_dataset", "review_dataset", "deliver_dataset"])
      expect(JSON.stringify(f.requests[0].tools)).toContain(`"${name}"`);
    expect(JSON.stringify(f.requests[0].tools)).toContain('"search_evidence"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"read_evidence"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"inspect_source_people"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"query_events"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"build_dataset"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"process_assets"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"read_job_result"');
    expect(JSON.stringify(f.requests[0].tools)).toContain('"manage_job"');
    expect(JSON.stringify(f.requests[0].tools)).toContain("search_assets");
    expect(JSON.stringify(f.requests[0].tools)).toContain('"bash"');
    expect(messageText(f.requests[0].messages[0])).toContain("你是 digital memory");
    expect(messageText(f.requests[0].messages[0])).toContain("search_evidence");
    expect(messageText(f.requests[0].messages.at(-1)!)).toBe("第一段经历");
    const b = await f.create();
    expect(await (await f.message(b, "另一个会话")).text()).toContain("轮次=1");
    await f.restart();
    const detail = await f.detail(a);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[0].text).toBe("第一段经历");
    expect(await (await f.message(a, "继续")).text()).toContain("轮次=2");
    expect((await f.detail(b)).messages).toHaveLength(2);
  }, 30000);

  it("rejects concurrent turns, cancels a live model stream, and accepts a later turn", async () => {
    const f = await fixture(true);
    const id = await f.create();
    const response = await f.message(id, "slow");
    const reader = response.body!.getReader();
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("text-delta")) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended unexpectedly");
      received += decoder.decode(part.value);
    }
    expect((await f.message(id, "overlap")).status).toBe(409);
    const cancel = await fetch(
      f.origin + "/api/conversations/" + id + "/cancel",
      { method: "POST" },
    );
    expect((await json<{ cancelled: boolean }>(cancel)).cancelled).toBe(true);
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value);
    }
    expect(received).toContain("[DONE]");
    expect((await f.detail(id)).conversation.running).toBe(false);
    expect(await (await f.message(id, "可以继续")).text()).toContain(
      "可以继续",
    );
  }, 30000);

  it("reports provider failure without exposing credentials and releases the run lock", async () => {
    const f = await fixture(true);
    const id = await f.create();
    const response = await f.message(id, "error");
    const stream = await response.text();
    expect(stream).toContain('"type":"error"');
    expect(stream).not.toContain(secret);
    const detail = await f.detail(id);
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail.conversation.running).toBe(false);
    expect(await (await f.message(id, "恢复")).text()).toContain("恢复");
  }, 30000);

  it("switches the same Pi conversation to the Anthropic protocol without losing history", async () => {
    const f = await fixture(true);
    const id = await f.create();
    await (await f.message(id, "第一轮")).text();
    const stream = await (
      await f.message(id, "第二轮", "anthropic/test-model")
    ).text();
    expect(stream).toContain("Anthropic 收到：第二轮");
    expect(
      f.requests
        .at(-1)!
        .messages.filter((message) => message.role === "user")
        .map(messageText),
    ).toEqual(["第一轮", "第二轮"]);
    expect((await f.detail(id)).messages).toHaveLength(4);
  }, 30000);

  it("executes local search and text tools, preserves text/tool order, and restores the full trace", async () => {
    const f = await fixture(true);
    const form = new FormData();
    form.append(
      "file",
      new Blob(["星期六，我在公园散步。"], { type: "text/plain" }),
      "散步.txt",
    );
    await fetch(f.origin + "/api/assets", { method: "POST", body: form });
    const id = await f.create();
    const stream = await (await f.message(id, "tools")).text();
    expect(stream).toContain('"toolName":"search_assets"');
    expect(stream).toContain('"toolName":"read_asset_text"');
    expect(stream).toContain('"type":"tool-output-available"');
    expect(stream).toContain("星期六，我在公园散步。");
    const parts = (await f.detail(id)).messages[1].parts!;
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "tool",
      "text",
    ]);
    expect(
      parts
        .filter((part) => part.type === "tool")
        .every((part) => part.state === "complete"),
    ).toBe(true);
    expect(stream.indexOf('"type":"text-end"')).toBeLessThan(
      stream.indexOf('"type":"tool-input-available"'),
    );
    await f.restart();
    expect((await f.detail(id)).messages[1].parts).toEqual(parts);
  }, 30000);

  it("exposes failed tool execution in the stream and persisted trace", async () => {
    const f = await fixture(true);
    const id = await f.create();
    expect(await (await f.message(id, "missing-tool")).text()).toContain(
      '"type":"tool-output-error"',
    );
    const tool = (await f.detail(id)).messages[1].parts!.find(
      (part) => part.type === "tool",
    );
    expect(tool).toMatchObject({ state: "error", name: "read_asset_text" });
    expect(JSON.stringify(tool)).not.toContain(f.dataDir);
  }, 30000);

  it("saves model settings privately, applies reasoning and context configuration, and tests the connection", async () => {
    const f = await fixture(true);
    const input = connectionInput(f.config.providers[0].baseUrl);
    const response = await fetch(
      f.origin + "/api/settings/providers/openai-compatible",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body).models[0]).toMatchObject({
      contextWindow: 256000,
      reasoning: true,
      thinkingLevel: "max",
    });
    const path = join(f.dataDir, "settings.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(secret);
    expect(
      readConfig({ MEMORY_DATA_DIR: f.dataDir }).providers[0].model
        .thinkingLevel,
    ).toBe("max");
    const test = await fetch(
      f.origin + "/api/settings/providers/openai-compatible/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    expect(await json<{ ok: boolean }>(test)).toMatchObject({ ok: true });
    expect(f.requests.at(-1)).toMatchObject({
      reasoning_effort: "max",
      max_completion_tokens: 2048,
    });
    const withoutKey = { ...input, apiKey: "" };
    expect(
      (
        await fetch(f.origin + "/api/settings/providers/openai-compatible", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withoutKey),
        })
      ).status,
    ).toBe(200);
    expect(f.config.providers[0].apiKey).toBe(secret);
  }, 30000);
});

describe("persistent workbench through real Pi tools", () => {
  it("scopes sources, creates versioned results and draft memories, then recalls only corrected confirmed content", async () => {
    const f = await fixture(true);
    const upload = async (name: string, value: string) => {
      const form = new FormData();
      form.append("file", new Blob([value], { type: "text/plain" }), name);
      return fetch(f.origin + "/api/assets", {
        method: "POST",
        body: form,
      }).then(json<{ asset: Asset }>);
    };
    const { asset } = await upload("散步记录.txt", "周六在公园散步。");
    await upload("另一个人的记录.txt", "这份未选择的记录不应被读取。");
    const id = await f.create();
    const { run } = await post<{ run: Run }>(
      f.origin + "/api/conversations/" + id + "/runs",
      {
        text: "workspace",
        modelId: "openai-compatible/test-model",
        assetIds: [asset.id],
        scope: "selected",
      },
    );
    expect((await waitRun(f.origin, run.id)).status).toBe("completed");
    let detail = await fetch(
      f.origin + "/api/conversations/" + id + "/workspace",
    ).then(json<WorkspaceDetail>);
    expect(detail.runs[0].sources).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        sha256: asset.sha256,
        start: 0,
        end: asset.size,
      }),
    ]);
    const search = detail.runs[0].parts.find(
      (part) => part.type === "tool" && part.name === "search_assets",
    );
    expect(search).toMatchObject({ state: "complete", output: { total: 1 } });
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.memories[0].status).toBe("draft");
    const artifact = detail.artifacts[0];
    const memory = detail.memories[0];
    await post(
      f.origin + "/api/artifacts/" + artifact.id,
      { title: "我的散步记录", content: "用户已修订的内容。", version: 1 },
      "PATCH",
    );
    const stale = await fetch(f.origin + "/api/artifacts/" + artifact.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "覆盖",
        content: "不应覆盖用户修订",
        version: 1,
      }),
    });
    expect(stale.status).toBe(409);
    const recall = async () => {
      const next = await f.create();
      const result = await post<{ run: Run }>(
        f.origin + "/api/conversations/" + next + "/runs",
        { text: "recall", modelId: "openai-compatible/test-model" },
      );
      return waitRun(f.origin, result.run.id);
    };
    expect(JSON.stringify((await recall()).parts)).not.toContain(
      "周六在公园散步",
    );
    await post(
      f.origin + "/api/memories/" + memory.id,
      {
        version: 1,
        status: "confirmed",
        content: "周日在公园散步。",
        reason: "日期更正",
      },
      "PATCH",
    );
    const recalled = await recall();
    expect(JSON.stringify(recalled.parts)).toContain("周日在公园散步");
    expect(recalled.memoryIds).toContain(memory.id);
    await f.restart();
    detail = await fetch(
      f.origin + "/api/conversations/" + id + "/workspace",
    ).then(json<WorkspaceDetail>);
    expect(detail.artifacts[0]).toMatchObject({
      version: 2,
      content: "用户已修订的内容。",
      author: "user",
    });
    expect(detail.memories[0]).toMatchObject({
      version: 2,
      status: "confirmed",
      content: "周日在公园散步。",
    });
    const versions = await fetch(f.origin + "/api/memories/" + memory.id).then(
      json<{ versions: MemoryEntry[] }>,
    );
    expect(versions.versions).toHaveLength(2);
    await post(
      f.origin + "/api/memories/" + memory.id,
      { version: 2, status: "rejected" },
      "PATCH",
    );
    expect(JSON.stringify((await recall()).parts)).not.toContain(
      "周日在公园散步",
    );
  }, 30000);

  it("keeps a run alive after stream disconnect, executes queued work after stopping, and replays events", async () => {
    const f = await fixture(true);
    const id = await f.create();
    const { run } = await post<{ run: Run }>(
      f.origin + "/api/conversations/" + id + "/runs",
      { text: "slow", modelId: "openai-compatible/test-model" },
    );
    await waitRun(f.origin, run.id, "running");
    const response = await fetch(f.origin + "/api/runs/" + run.id + "/events");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("id:");
    await reader.cancel();
    expect(
      (await fetch(f.origin + "/api/runs/" + run.id).then(json<{ run: Run }>))
        .run.status,
    ).toBe("running");
    const next = await post<{ run: Run }>(
      f.origin + "/api/conversations/" + id + "/runs",
      { text: "继续整理", modelId: "openai-compatible/test-model" },
    );
    expect(next.run.status).toBe("queued");
    await fetch(f.origin + "/api/runs/" + run.id + "/stop", { method: "POST" });
    expect((await waitRun(f.origin, next.run.id)).status).toBe("completed");
    const replay = await fetch(
      f.origin + "/api/runs/" + next.run.id + "/events?after=0",
    ).then((response) => response.text());
    expect(replay).toContain("event: settled");
    expect(replay).toContain("继续整理");
    expect(
      (await fetch(f.origin + "/api/runs/" + run.id).then(json<{ run: Run }>))
        .run.status,
    ).toBe("stopped");
  }, 15000);

  it("waits for real user input and continues the same tool call", async () => {
    const f = await fixture(true);
    const id = await f.create();
    const { run } = await post<{ run: Run }>(
      f.origin + "/api/conversations/" + id + "/runs",
      { text: "question", modelId: "openai-compatible/test-model" },
    );
    expect((await waitRun(f.origin, run.id, "waiting")).question?.text).toBe(
      "这次发生在周几？",
    );
    await post(f.origin + "/api/runs/" + run.id + "/answer", {
      answer: "周日",
    });
    const finished = await waitRun(f.origin, run.id);
    expect(finished.status).toBe("completed");
    expect(JSON.stringify(finished.parts)).toContain("收到回答：周日");
  }, 15000);

  it("keeps a Pi question and queued user input through process restart", async () => {
    const f = await fixture(true), id = await f.create();
    const { run } = await post<{ run: Run }>(f.origin + "/api/conversations/" + id + "/runs", { text: "question", modelId: "openai-compatible/test-model" });
    await waitRun(f.origin, run.id, "waiting");
    await post(f.origin + "/api/conversations/" + id + "/steer", { text: "回答后继续原任务", mode: "followUp" });
    await f.restart();
    const waiting = (await fetch(f.origin + "/api/runs/" + run.id).then(json<{ run: Run }>)).run;
    expect(waiting).toMatchObject({ status: "waiting", waitingFor: "user" });
    expect(waiting.interventions?.[0]).toMatchObject({ text: "回答后继续原任务", status: "queued" });
    await post(f.origin + "/api/runs/" + run.id + "/answer", { answer: "周日" });
    const completed = await waitRun(f.origin, run.id);
    expect(completed.status).toBe("completed");
    expect(completed.interventions?.[0].status).toBe("delivered");
    expect(JSON.stringify(completed.parts)).toContain("收到回答：周日");
    expect(completed.parts.filter((part) => part.type === "tool" && part.name === "ask_user")).toHaveLength(1);
  }, 15000);

  it("retains originals and independently saved memories when deleting a conversation", async () => {
    const f = await fixture();
    const id = await f.create();
    await post(
      f.origin + "/api/conversations/" + id,
      { title: "改名任务", pinned: true, archived: true },
      "PATCH",
    );
    expect((await f.detail(id)).conversation).toMatchObject({
      title: "改名任务",
      pinned: true,
      archived: true,
    });
    const { memory } = await post<{ memory: MemoryEntry }>(
      f.origin + "/api/memories",
      { title: "个人偏好", content: "喜欢阅读" },
    );
    expect(
      (await fetch(f.origin + "/api/conversations/" + id, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await fetch(f.origin + "/api/memories/" + memory.id)).status).toBe(
      200,
    );
    expect((await fetch(f.origin + "/api/conversations/" + id)).status).toBe(
      404,
    );
  });
});

describe("memory review and source enforcement", () => {
  it("rejects unselected reads and invented evidence at the tool boundary", async () => {
    const { Store } = await import("../src/store.js");
    const { createMemoryTools } = await import("../src/memory-tools.js");
    const f = await fixture();
    const store = new Store(f.dataDir);
    cleaners.push(async () => store.close());
    const id = await f.create();
    const run = store.work.createRun(id, {
      text: "我喜欢读书",
      modelId: "test",
      assetIds: [],
      scope: "selected",
    });
    store.work.patchRun(run.id, { status: "running" });
    const tools = createMemoryTools(store, id);
    const execute = (name: string, params: unknown) =>
      (
        tools.find((tool) => tool.name === name)! as unknown as {
          execute: (id: string, params: unknown) => Promise<unknown>;
        }
      ).execute("boundary-test", params);
    const unknown = "00000000-0000-0000-0000-000000000000";
    await expect(
      execute("read_asset_text", { assetId: unknown }),
    ).rejects.toThrow("范围");
    await expect(
      execute("write_artifact", {
        title: "无效来源",
        content: "不能引用",
        sourceAssetIds: [unknown],
      }),
    ).rejects.toThrow("实际读取");
    await expect(
      execute("propose_memory", {
        title: "错误陈述",
        content: "喜欢游泳",
        kind: "statement",
        statement: "我喜欢游泳",
        sourceAssetIds: [],
      }),
    ).rejects.toThrow("可靠依据");
    expect(store.work.list("memory")).toEqual([]);
    expect(store.work.list("artifact")).toEqual([]);
  });

  it("merges reviewed entries without losing their history and rejects stale merges", async () => {
    const f = await fixture();
    const first = await post<{ memory: MemoryEntry }>(
      f.origin + "/api/memories",
      { title: "阅读", content: "喜欢读书" },
    );
    const second = await post<{ memory: MemoryEntry }>(
      f.origin + "/api/memories",
      { title: "书目", content: "喜欢科幻小说" },
    );
    const payload = {
      title: "阅读偏好",
      content: "喜欢阅读科幻小说",
      entries: [first.memory, second.memory].map(({ id, version }) => ({
        id,
        version,
      })),
    };
    await post(
      f.origin + "/api/memories/" + first.memory.id,
      { version: 1, content: "喜欢纸质书" },
      "PATCH",
    );
    const stale = await fetch(f.origin + "/api/memories/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await fetch(f.origin + "/api/memories/" + second.memory.id).then(
          json<{ memory: MemoryEntry }>,
        )
      ).memory.status,
    ).toBe("confirmed");
    payload.entries[0].version = 2;
    const merged = await post<{ memory: MemoryEntry }>(
      f.origin + "/api/memories/merge",
      payload,
    );
    expect(merged.memory.status).toBe("draft");
    const original = await fetch(
      f.origin + "/api/memories/" + first.memory.id,
    ).then(json<{ memory: MemoryEntry; versions: MemoryEntry[] }>);
    expect(original.memory).toMatchObject({ status: "rejected", version: 3 });
    expect(original.memory.reason).toContain(merged.memory.id);
    expect(original.versions).toHaveLength(3);
  });
});
