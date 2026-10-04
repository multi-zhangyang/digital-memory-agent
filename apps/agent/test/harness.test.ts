import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { executeSandbox } from "../src/sandbox.js";
import type { Run, SessionState } from "@memory/contracts";
vi.setConfig({ testTimeout: 15000 });
const cleaners: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleaners.splice(0).reverse()) await clean();
});
async function fixture(projectPath?: string) {
  const directory = await mkdtemp(join(tmpdir(), "harness-test-"));
  cleaners.push(() => rm(directory, { recursive: true, force: true }));
  const requests: any[] = [];
  const provider = Fastify();
  provider.post<{ Body: { messages: any[]; stream: boolean } }>(
    "/v1/chat/completions",
    async (req, reply) => {
      requests.push(req.body);
      const messages = req.body.messages;
      const i = messages.map((m: any) => m.role).lastIndexOf("user");
      const last = messages[i];
      const prompt =
        typeof last?.content === "string"
          ? last.content
          : (last?.content || []).map((p: any) => p.text || "").join("");
      const count = messages
        .slice(i + 1)
        .filter((m: any) => m.role === "tool").length;
      const calls: Record<string, Array<[string, unknown]>> = {
        workflow: [
          ["read", { path: "input.csv" }],
          [
            "write",
            {
              path: "sum.py",
              content:
                'import csv, json\nrows = list(csv.DictReader(open("input.csv")))\nprint("PROCESSING", flush=True)\njson.dump({"total": sum(int(r["amount"]) for r in rows)}, open("result.json", "w"))\n',
            },
          ],
          ["bash", { command: "python3 sum.py", timeout: 20 }],
          [
            "edit",
            {
              path: "result.json",
              edits: [{ oldText: '"total"', newText: '"sum"' }],
            },
          ],
          ["read", { path: "result.json" }],
        ],
        write: [["write", { path: "protected.txt", content: "written" }]],
        steer: [
          ["bash", { command: 'printf "START\\n"; sleep 1; printf "END\\n"' }],
        ],
        escape: [
          ["read", { path: "../settings.json" }],
          [
            "bash",
            {
              command:
                'cat ../settings.json || true; cat /etc/shadow || true; test ! -e ../settings.json && printf "ISOLATED"',
            },
          ],
        ],
        mcp: [["mcp__fixture__echo", { text: "hello" }]],
        "nullable-artifact": [
          ["write_artifact", { title: "实际作业说明", content: "此条用于验证新建结果，不包含个人事实。", sourceAssetIds: [], artifactId: null, version: null }],
          ["read_artifact", { artifactId: null }],
          ["write_artifact", { title: "不能伪造目标", content: "错误 ID 必须被拒绝。", sourceAssetIds: [], artifactId: "00000000-0000-0000-0000-000000000000", version: 1 }],
        ],
      };
      const call = calls[prompt]?.[count];
      if (!req.body.stream)
        return {
          id: "completion",
          model: "test",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Session summary: task and files retained.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 15,
            total_tokens: 115,
          },
        };
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta: any, finish_reason: string | null = null) =>
        reply.raw.write(
          "data: " +
            JSON.stringify({
              id: "test",
              object: "chat.completion.chunk",
              created: 1,
              model: "test",
              choices: [{ index: 0, delta, finish_reason }],
              usage: {
                prompt_tokens: 400,
                completion_tokens: 50,
                total_tokens: 450,
              },
            }) +
            "\n\n",
        );
      if (call) {
        emit({ reasoning_content: "Inspecting project inputs." });
        emit({
          tool_calls: [
            {
              index: 0,
              id: "call-" + requests.length,
              type: "function",
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({
          content:
            prompt === "adjust" ? "Adjusted after steering." : "Task complete.",
        });
        emit({}, "stop");
      }
      reply.raw.end("data: [DONE]\n\n");
    },
  );
  await provider.listen({ host: "127.0.0.1", port: 0 });
  cleaners.push(() => provider.close());
  const address = provider.server.address() as { port: number };
  const config = readConfig({
    MEMORY_DATA_DIR: directory,
    MEMORY_OPENAI_BASE_URL: "http://127.0.0.1:" + address.port + "/v1",
    MEMORY_OPENAI_API_KEY: "test-secret",
    MEMORY_OPENAI_MODEL: "test",
  });
  const app = buildApp(config);
  await app.ready();
  cleaners.push(() => app.close());
  const api = async (
    path: string,
    body?: unknown,
    method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" = "POST",
  ) => {
    const response = await app.inject({
      url: "/api" + path,
      method,
      ...(body !== undefined
        ? {
            payload: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }
        : {}),
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  };
  // These assertions count foreground requests; capture has its own integration suite.
  await api("/memory-settings", { capture: "off" }, "PATCH");
  const opened = projectPath
    ? await api("/projects/open", { path: projectPath })
    : undefined;
  const { conversation } = await api(
    "/conversations",
    opened ? { projectId: opened.project.id } : {},
  );
  const start = async (text: string, permissionMode?: string) =>
    (
      await api("/conversations/" + conversation.id + "/runs", {
        text,
        modelId: "openai-compatible/test",
        permissionMode,
      })
    ).run as Run;
  const wait = async (id: string, status?: string) => {
    for (let t = 0; t < 500; t++) {
      const { run } = await api("/runs/" + id, undefined, "GET");
      if (
        status
          ? run.status === status
          : ["completed", "failed", "stopped"].includes(run.status)
      )
        return run as Run;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("run timeout");
  };
  return { directory, app, api, conversation, start, wait, requests, config };
}
it("accepts nullable creation and listing through Pi while rejecting invented artifact IDs", async () => {
  const f = await fixture();
  const completed = await f.wait((await f.start("nullable-artifact", "auto")).id);
  const tools = completed.parts.filter((part) => part.type === "tool");
  expect(tools.map((part) => part.state)).toEqual(["complete", "complete", "error"]);
  const saved = (await f.api("/workspace", undefined, "GET")).artifacts;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ title: "实际作业说明", version: 1 });
  expect(saved[0].id).not.toBe("00000000-0000-0000-0000-000000000000");
  const schema = f.requests[0].tools.find((tool: any) => tool.function.name === "write_artifact").function.parameters;
  expect(JSON.stringify(schema.properties.artifactId)).toContain('"type":"null"');
});
it("delivers selected file excerpts and the exact historical revision through real Pi, without loading unrelated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "referenced-project-"));
  cleaners.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "selected.md"), "SELECTED_FILE_CONTEXT");
  await writeFile(
    join(directory, "unselected.md"),
    "UNSELECTED_FILE_MUST_STAY_LOCAL",
  );
  await writeFile(
    join(directory, "long.md"),
    "L".repeat(24000) + "UNREAD_TAIL",
  );
  const f = await fixture(directory);
  const { run } = await f.api("/conversations/" + f.conversation.id + "/runs", {
    text: "Read the files I referenced",
    modelId: "openai-compatible/test",
    fileReferences: [{ path: "selected.md" }, { path: "long.md" }],
  });
  expect((await f.wait(run.id)).status).toBe("completed");
  expect(run.fileReferences).toEqual([
    { path: "selected.md" },
    { path: "long.md" },
  ]);
  const firstContext = JSON.stringify(f.requests.at(-1).messages);
  expect(firstContext).toContain("SELECTED_FILE_CONTEXT");
  expect(firstContext).not.toContain("UNSELECTED_FILE_MUST_STAY_LOCAL");
  expect(firstContext).not.toContain("UNREAD_TAIL");

  const changed = await f.wait((await f.start("write")).id);
  expect(
    changed.changes?.find((change) => change.path === "protected.txt")?.after
      ?.content,
  ).toBe("written");
  await writeFile(join(directory, "protected.txt"), "NEWER_DISK_VERSION");
  const { run: review } = await f.api(
    "/conversations/" + f.conversation.id + "/runs",
    {
      text: "Review that earlier change",
      modelId: "openai-compatible/test",
      fileReferences: [{ path: "protected.txt", runId: changed.id }],
    },
  );
  expect((await f.wait(review.id)).status).toBe("completed");
  const reviewContext = JSON.stringify(f.requests.at(-1).messages);
  expect(reviewContext).toContain("historical");
  expect(reviewContext).toContain("written");
  expect(reviewContext).not.toContain("NEWER_DISK_VERSION");

  const { project } = await f.api("/projects", { name: "Different project" });
  const { conversation } = await f.api("/conversations", {
    projectId: project.id,
  });
  const count = f.requests.length;
  const rejected = await f.app.inject({
    method: "POST",
    url: "/api/conversations/" + conversation.id + "/runs",
    payload: {
      text: "Cross-project reference",
      modelId: "openai-compatible/test",
      fileReferences: [{ path: "protected.txt", runId: changed.id }],
    },
  });
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().error.code).toBe("INVALID_FILE_REFERENCE");
  expect(f.requests).toHaveLength(count);
});

it("rejects file references outside the project and through symlinks before any model request", async () => {
  const f = await fixture();
  const root = join(f.directory, "workspace");
  await writeFile(
    join(f.directory, "private.txt"),
    "REFERENCE_PRIVATE_SENTINEL",
  );
  await symlink(join(f.directory, "private.txt"), join(root, "alias.md"));
  for (const path of ["../private.txt", "alias.md"]) {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/conversations/" + f.conversation.id + "/runs",
      payload: {
        text: "Read selected file",
        modelId: "openai-compatible/test",
        fileReferences: [{ path }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("REFERENCE_PRIVATE_SENTINEL");
  }
  const missing = await f.app.inject({
    method: "POST",
    url: "/api/conversations/" + f.conversation.id + "/runs",
    payload: {
      text: "Read missing file",
      modelId: "openai-compatible/test",
      fileReferences: [{ path: "missing.md" }],
    },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe("FILE_REFERENCE_MISSING");
  expect(f.requests).toHaveLength(0);
});

it("runs Pi directly in an existing directory and keeps its file changes, checkpoint and conversation across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-project-"));
  cleaners.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "input.csv"), "amount\n2\n5\n");
  await writeFile(
    join(directory, "AGENTS.md"),
    "# Local project\nKeep the original CSV unchanged.",
  );
  const f = await fixture(directory);
  const run = await f.wait((await f.start("workflow")).id);
  expect(run.status, run.error).toBe("completed");
  expect(
    run.parts
      .filter((part) => part.type === "tool")
      .every((part) => part.state === "complete"),
  ).toBe(true);
  expect(
    JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
  ).toEqual({ sum: 7 });
  expect(await readFile(join(directory, "input.csv"), "utf8")).toBe(
    "amount\n2\n5\n",
  );
  expect(run.changes?.map((change) => change.path).sort()).toEqual([
    "result.json",
    "sum.py",
  ]);
  expect(JSON.stringify(f.requests[0].messages)).toContain(directory);
  expect(JSON.stringify(f.requests[0].messages)).toContain(
    "Keep the original CSV unchanged",
  );
  await expect(
    readFile(join(f.directory, "workspace", "result.json")),
  ).rejects.toThrow();
  await f.app.close();
  const restarted = buildApp(f.config);
  cleaners.push(() => restarted.close());
  await restarted.ready();
  const projects = (await restarted.inject("/api/projects")).json().projects;
  expect(
    projects.find((p: any) => p.id === f.conversation.projectId),
  ).toMatchObject({ directory, directoryKind: "local", available: true });
  const messages = (
    await restarted.inject("/api/conversations/" + f.conversation.id)
  ).json().messages;
  expect(messages.some((message: any) => message.text === "workflow")).toBe(
    true,
  );
  const reverted = await restarted.inject({
    method: "POST",
    url: "/api/runs/" + run.id + "/revert",
    payload: { path: "sum.py" },
  });
  expect(reverted.statusCode, reverted.body).toBe(200);
  await expect(readFile(join(directory, "sum.py"))).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
  ).toEqual({ sum: 7 });
});
it("prevents overlapping project folders from executing or being edited during another run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "overlapping-project-"));
  cleaners.push(() => rm(directory, { recursive: true, force: true }));
  const child = join(directory, "nested");
  await mkdir(child);
  const f = await fixture(directory);
  const project = (await f.api("/projects/open", { path: child })).project;
  const conversation = (
    await f.api("/conversations", { projectId: project.id })
  ).conversation;
  const run = await f.start("write", "ask");
  await f.wait(run.id, "waiting");
  const blockedRun = await f.app.inject({
    method: "POST",
    url: "/api/conversations/" + conversation.id + "/runs",
    payload: { text: "write", modelId: "openai-compatible/test" },
  });
  expect(blockedRun.statusCode).toBe(409);
  const blockedEdit = await f.app.inject({
    method: "PUT",
    url: "/api/projects/" + project.id + "/file",
    payload: { path: "notes.txt", content: "interleaved", hash: null },
  });
  expect(blockedEdit.statusCode).toBe(409);
  const { approvals } = await f.api(
    "/runs/" + run.id + "/approvals",
    undefined,
    "GET",
  );
  await f.api("/approvals/" + approvals[0].id, { approved: false });
  await f.wait(run.id);
  const next = await f.api("/conversations/" + conversation.id + "/runs", {
    text: "write",
    modelId: "openai-compatible/test",
  });
  expect((await f.wait(next.run.id)).status).toBe("completed");
  expect(await readFile(join(child, "protected.txt"), "utf8")).toBe("written");
});
it("runs native Pi file tools and a sandboxed script, streams output, persists reasoning, and protects later edits during revert", async () => {
  const f = await fixture();
  await f.api(
    "/projects/default/file",
    { path: "input.csv", content: "amount\n2\n5\n", hash: null },
    "PUT",
  );
  const run = await f.wait((await f.start("workflow")).id);
  expect(run.status, run.error).toBe("completed");
  expect(run.parts.filter((p) => p.type === "tool").map((p) => p.name)).toEqual(
    ["read", "write", "bash", "edit", "read"],
  );
  expect(run.parts.some((p) => p.type === "reasoning")).toBe(true);
  expect(run.changes?.map((c) => c.path).sort()).toEqual([
    "result.json",
    "sum.py",
  ]);
  const file = await f.api(
    "/projects/default/file?path=result.json",
    undefined,
    "GET",
  );
  expect(JSON.parse(file.content)).toEqual({ sum: 7 });
  const eventResponse = await f.app.inject("/api/runs/" + run.id + "/events");
  expect(eventResponse.body).toContain("tool-update");
  expect(eventResponse.body).toContain("PROCESSING");
  await f.api(
    "/projects/default/file",
    { path: "result.json", content: "user edit", hash: file.hash },
    "PUT",
  );
  expect(
    (
      await f.app.inject({
        url: "/api/runs/" + run.id + "/revert",
        method: "POST",
        payload: { path: "result.json" },
      })
    ).statusCode,
  ).toBe(409);
  await f.api("/runs/" + run.id + "/revert", { path: "sum.py" });
  expect(
    (await f.api("/projects/default/files", undefined, "GET")).files.some(
      (x: any) => x.path === "sum.py",
    ),
  ).toBe(false);
});
it("enforces read and ask modes, accepts a real approval, and rejects symlink and parent traversal", async () => {
  const f = await fixture();
  const read = await f.wait((await f.start("write", "read")).id);
  expect(
    read.parts.find((p) => p.type === "tool")?.state,
    JSON.stringify(read),
  ).toBe("error");
  const ask = await f.start("write", "ask");
  await f.wait(ask.id, "waiting");
  const { approvals } = await f.api(
    "/runs/" + ask.id + "/approvals",
    undefined,
    "GET",
  );
  expect(approvals[0].status).toBe("pending");
  await f.api("/approvals/" + approvals[0].id, { approved: false });
  expect(
    (await f.wait(ask.id)).parts.find((p) => p.type === "tool")?.state,
  ).toBe("error");
  const accepted = await f.start("write", "ask");
  await f.wait(accepted.id, "waiting");
  const next = await f.api(
    "/runs/" + accepted.id + "/approvals",
    undefined,
    "GET",
  );
  await f.api("/approvals/" + next.approvals[0].id, { approved: true });
  await f.wait(accepted.id);
  expect(
    (await f.api("/projects/default/file?path=protected.txt", undefined, "GET"))
      .content,
  ).toBe("written");
  await symlink(
    join(f.directory, "settings.json"),
    join(f.directory, "workspace", "link"),
  );
  expect(
    (await f.app.inject("/api/projects/default/file?path=link")).statusCode,
  ).toBe(403);
  const escape = await f.wait((await f.start("escape")).id);
  expect(escape.parts.filter((p) => p.type === "tool")[0].state).toBe("error");
  expect(JSON.stringify(escape.parts)).toContain("ISOLATED");
  expect(JSON.stringify(escape.parts)).not.toContain("test-secret");
});
it("uses native Pi steering, branches history, compacts and discovers enabled skills and templates", async () => {
  const f = await fixture();
  await f.api("/harness/resources", {
    name: "review",
    kind: "skill",
    description: "Review project files",
    content: "# Review\nRead project files and report findings.",
    enabled: true,
  });
  await f.api("/harness/resources", {
    name: "brief",
    kind: "prompt",
    description: "Brief reply",
    content: "Give a brief answer to $ARGUMENTS",
    enabled: true,
  });
  const run = await f.start("steer");
  for (let i = 0; i < 150; i++) {
    const r = (await f.api("/runs/" + run.id, undefined, "GET")).run;
    if (r.parts.some((p: any) => p.type === "tool")) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  await f.api("/conversations/" + f.conversation.id + "/steer", {
    text: "adjust",
  });
  const end = await f.wait(run.id);
  expect(end.interventions?.[0].status).toBe("delivered");
  expect(JSON.stringify(end.parts)).toContain("Adjusted after steering.");
  const state = (await f.api(
    "/conversations/" + f.conversation.id + "/session",
    undefined,
    "GET",
  )) as SessionState;
  expect(state.skills).toEqual(["organize-materials", "use-memory", "correct-memory", "prepare-dataset", "review"]);
  expect(state.prompts).toEqual(["organize-materials", "use-memory", "correct-memory", "prepare-dataset", "brief"]);
  expect(state.tools.some((t) => t.name === "bash" && t.active)).toBe(true);
  const fork = await f.api("/conversations/" + f.conversation.id + "/fork", {});
  const history = await f.api(
    "/conversations/" + fork.conversation.id,
    undefined,
    "GET",
  );
  expect(history.messages.some((m: any) => m.text === "adjust")).toBe(true);
  expect(fork.conversation.parentId).toBe(f.conversation.id);
  await f.wait((await f.start("context " + "history ".repeat(10000))).id);
  await f.api("/conversations/" + f.conversation.id + "/compact", {});
  await f.wait((await f.start("/skill:review please review")).id);
  expect(JSON.stringify(f.requests.at(-1).messages)).toContain(
    "Read project files and report findings.",
  );
  await f.wait((await f.start("/brief context")).id);
  expect(JSON.stringify(f.requests.at(-1).messages)).toContain(
    "Give a brief answer to context",
  );
  const files = await readFile(
    join(f.directory, "sessions", f.conversation.id + ".jsonl"),
    "utf8",
  );
  expect(files).toContain('"type":"compaction"');
});
it("kills the entire isolated script process when cancelled", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let output = "";
  const promise = executeSandbox(
    join(f.directory, "workspace"),
    "printf READY; sleep 10; touch late.txt",
    (data) => {
      output += data.toString();
      if (output.includes("READY")) abort.abort();
    },
    abort.signal,
  );
  expect((await promise).exitCode).not.toBe(0);
  expect(output).toContain("执行已停止");
});
it("connects a real MCP protocol server and gates its native Pi tool call with an approval", async () => {
  const f = await fixture();
  const mcp = Fastify();
  mcp.post<{
    Body: {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: any;
    };
  }>("/mcp", async (req, reply) => {
    expect(req.headers.authorization).toBe("Bearer private-mcp-token");
    const m = req.body;
    if (m.id === undefined) return reply.code(202).send();
    let result: unknown = {};
    if (m.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      };
    if (m.method === "tools/list")
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    if (m.method === "tools/call")
      result = {
        content: [
          { type: "text", text: "MCP received " + m.params.arguments.text },
        ],
      };
    return { jsonrpc: "2.0", id: m.id, result };
  });
  await mcp.listen({ host: "127.0.0.1", port: 0 });
  cleaners.push(() => mcp.close());
  const address = mcp.server.address() as { port: number };
  const settings = await f.api("/harness/mcp", {
    name: "fixture",
    transport: "http",
    url: "http://127.0.0.1:" + address.port + "/mcp",
    command: "",
    args: [],
    enabled: true,
    headers: { Authorization: "Bearer private-mcp-token" },
  });
  expect(JSON.stringify(settings)).not.toContain("private-mcp-token");
  const run = await f.start("mcp", "ask");
  await f.wait(run.id, "waiting");
  const a = await f.api("/runs/" + run.id + "/approvals", undefined, "GET");
  expect(a.approvals[0].title).toBe("mcp__fixture__echo");
  await f.api("/approvals/" + a.approvals[0].id, { approved: true });
  const end = await f.wait(run.id);
  expect(JSON.stringify(end.parts)).toContain("MCP received hello");
  const state = await f.api(
    "/conversations/" + f.conversation.id + "/session",
    undefined,
    "GET",
  );
  expect(state.tools.some((t: any) => t.name === "mcp__fixture__echo")).toBe(
    true,
  );
});
it("runs a stdio MCP server inside a read-only project sandbox and shuts it down with the Pi extension", async () => {
  const f = await fixture();
  await writeFile(
    join(f.directory, "workspace", "mcp.mjs"),
    `import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0'}};
if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if(m.method==='tools/call')result={content:[{type:'text',text:'STDIO '+m.params.arguments.text}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
  );
  await f.api("/harness/mcp", {
    name: "fixture",
    transport: "stdio",
    url: "",
    command: process.execPath,
    args: ["mcp.mjs"],
    enabled: true,
  });
  const end = await f.wait((await f.start("mcp")).id);
  expect(JSON.stringify(end.parts)).toContain("STDIO hello");
});

it("delivers a native Pi follow-up after a turn and retains queued text when stopped", async () => {
  const f = await fixture();
  const run = await f.start("steer");
  for (let t = 0; t < 200; t++) {
    const r = (await f.api("/runs/" + run.id, undefined, "GET")).run;
    if (r.parts.some((p: any) => p.type === "tool")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await f.api("/conversations/" + f.conversation.id + "/steer", {
    text: "adjust",
    mode: "followUp",
  });
  const end = await f.wait(run.id);
  expect(end.interventions?.[0].status).toBe("delivered");
  expect(JSON.stringify(end.parts)).toContain("Adjusted after steering.");
  const next = await f.start("steer");
  for (let t = 0; t < 200; t++) {
    const r = (await f.api("/runs/" + next.id, undefined, "GET")).run;
    if (r.parts.some((p: any) => p.type === "tool")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await f.api("/conversations/" + f.conversation.id + "/steer", {
    text: "not delivered",
    mode: "followUp",
  });
  await f.api("/runs/" + next.id + "/stop");
  const stopped = await f.wait(next.id);
  expect(stopped.interventions?.[0]).toMatchObject({
    text: "not delivered",
    status: "returned",
  });
});
it("keeps truncated native bash logs readable inside the project boundary", async () => {
  const f = await fixture();
  const { Store } = await import("../src/store.js");
  const { createGeneralTools } = await import("../src/general-tools.js");
  const store = new Store(f.directory);
  try {
    const bash = createGeneralTools(store, f.conversation.id).find(
      (tool) => tool.name === "bash",
    )!;
    const output = await bash.execute(
      "overflow",
      { command: "python3 -c \"print('x' * 60000)\"" },
      undefined,
      undefined,
      {} as never,
    );
    const path = (output.details as { fullOutputPath?: string }).fullOutputPath;
    expect(path).toMatch(/^\.digital-memory\/outputs\//);
    const bytes = await readFile(join(f.directory, "workspace", path!));
    expect(bytes.length).toBe(60001);
    expect(JSON.stringify(output.content)).toContain(path!);
  } finally {
    store.close();
  }
});
