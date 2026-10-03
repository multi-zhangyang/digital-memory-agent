import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryImportJob,
  MemoryOverview,
  Run,
} from "@memory/contracts";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { AgentRuntime } from "../src/runtime.js";
import type {
  ExtractedMemory,
  ExtractionInput,
} from "../src/memory-extraction.js";
import { budgetMemories } from "../src/memory-retrieval.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const waitFor = async <T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> => {
  for (let index = 0; index < 300; index++) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("State did not settle");
};
const candidate = (
  quote: string,
  fields: Partial<ExtractedMemory> = {},
): ExtractedMemory => ({
  title: "河边散步",
  content: quote,
  category: "event",
  kind: "observation",
  quote,
  occurredAt: "2026-03-14",
  people: ["陈默"],
  place: "杭州",
  uncertainty: "",
  attribute: null,
  ...fields,
});
const residence = (city: string, quote: string) =>
  candidate(quote, {
    title: "居住在" + city,
    category: "profile",
    content: "我住在" + city + "。",
    people: [],
    occurredAt: "",
    place: city,
    attribute: { key: "home_city", value: city },
  });

async function fixture(
  extract: (
    input: { document: string; text: string },
    call: number,
  ) => ExtractedMemory[] = (input) => [candidate(input.text)],
) {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-core-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const requests: {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  let calls = 0;
  const provider = Fastify();
  provider.post<{ Body: (typeof requests)[number] }>(
    "/v1/chat/completions",
    async (request, reply) => {
      requests.push(request.body);
      const extraction = request.body.tools?.some(
        (tool) => tool.function?.name === "extract_memories",
      );
      let delta: unknown = { content: "已读取当前确认版本。" };
      if (extraction) {
        const user = request.body.messages
          .filter((message) => message.role === "user")
          .at(-1)!;
        const input = JSON.parse(
          typeof user.content === "string" ? user.content : "{}",
        );
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "extract_" + ++calls,
              type: "function",
              function: {
                name: "extract_memories",
                arguments: JSON.stringify({ entries: extract(input, calls) }),
              },
            },
          ],
        };
      }
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) =>
        "data: " +
        JSON.stringify({
          id: "memory-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-memory",
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: {
            prompt_tokens: 130,
            completion_tokens: 60,
            total_tokens: 190,
          },
        }) +
        "\n\n";
      reply.raw.end(
        chunk(delta, null) +
          chunk({}, extraction ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    },
  );
  const url = await provider.listen({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => provider.close());
  const config = readConfig({
    MEMORY_DATA_DIR: dataDir,
    MEMORY_OPENAI_BASE_URL: url + "/v1",
    MEMORY_OPENAI_API_KEY: "fixture-memory-secret",
    MEMORY_OPENAI_MODEL: "test-memory",
  });
  let store = new Store(dataDir);
  let app = buildApp(config, { store });
  await app.ready();
  cleanup.push(() => app.close());
  const request = async <T>(
    path: string,
    body?: unknown,
    method: "GET" | "POST" | "PATCH" = body === undefined ? "GET" : "POST",
  ) => {
    const response = await app.inject({
      method,
      url: "/api" + path,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json<T>();
  };
  const getJob = async (id: string) =>
    (await request<{ job: MemoryImportJob }>("/memory-imports/" + id)).job;
  return {
    get app() {
      return app;
    },
    get store() {
      return store;
    },
    config,
    dataDir,
    requests,
    get calls() {
      return calls;
    },
    request,
    getJob,
    async start(
      records: { name: string; text: string }[],
      options: object = {},
    ) {
      return (
        await request<{ job: MemoryImportJob }>("/memory-imports", {
          requestId: randomUUID(),
          modelId: config.providers[0].model.id,
          records,
          ...options,
        })
      ).job;
    },
    settle: (id: string) =>
      waitFor(
        () => getJob(id),
        (job) => ["completed", "failed", "cancelled"].includes(job.status),
      ),
    async restart(runtime?: AgentRuntime) {
      await app.close();
      store = new Store(dataDir);
      app = buildApp(config, { store, runtime });
      await app.ready();
    },
  };
}

describe("memory core", () => {
  it("rejects fabricated profile placeholders without saving a false attribute", async () => {
    const f = await fixture((input) => [
      candidate(input.text, {
        category: "profile",
        people: [],
        occurredAt: "",
        attribute: { key: "name", value: ".*" },
      }),
    ]);
    const job = await f.start([
      { name: "占位值检查.md", text: "我喜欢散步。" },
    ]);
    expect((await f.settle(job.id)).status).toBe("failed");
    expect(f.store.work.list("memory")).toHaveLength(0);
  });
  it("extracts through real Pi, anchors UTF-8 evidence, deduplicates and recalls only current confirmed records after restart", async () => {
    const quote = "2026-03-14，我和陈默在杭州散步。";
    const f = await fixture((input) =>
      input.text.includes("散步")
        ? [candidate(quote)]
        : [residence("杭州", "我住在杭州。")],
    );
    const job = await f.start([
      { name: "散步.md", text: "🌳 经历\n" + quote },
      { name: "自述.txt", text: "我住在杭州。" },
    ]);
    const completed = await f.settle(job.id);
    expect(completed.status).toBe("completed");
    expect(f.calls).toBe(2);
    expect(
      completed.chunks.every(
        (chunk) => chunk.status === "completed" && chunk.usage?.input === 130,
      ),
    ).toBe(true);
    const overview = await f.request<MemoryOverview>("/memory-overview");
    expect(overview.memories).toHaveLength(2);
    expect(overview.memories.every((memory) => memory.status === "draft")).toBe(
      true,
    );
    expect(f.store.work.searchMemories("杭州")).toEqual([]);
    for (const memory of overview.memories) {
      const source = memory.sources[0];
      const buffer = await readFile(join(f.store.assetsDir, source.assetId));
      expect(buffer.subarray(source.start, source.end).toString("utf8")).toBe(
        source.quote,
      );
    }
    const duplicate = await f.start([
      { name: "副本.md", text: "🌳 经历\n" + quote },
    ]);
    expect((await f.settle(duplicate.id)).chunks[0].status).toBe("skipped");
    expect(f.calls).toBe(2);
    expect(f.store.work.list("memory")).toHaveLength(2);
    const profile = overview.memories.find(
      (memory) => memory.category === "profile",
    )!;
    await f.request(
      "/memories/" + profile.id,
      { version: profile.version, status: "confirmed" },
      "PATCH",
    );
    await f.request(
      "/memories/" + profile.id,
      {
        version: 2,
        title: "居住在苏州",
        content: "我住在苏州。",
        place: "苏州",
        attribute: { key: "home_city", value: "苏州" },
        reason: "用户更正",
      },
      "PATCH",
    );
    await f.restart();
    expect(f.store.work.searchMemories("杭州")).toHaveLength(0);
    expect(f.store.work.searchMemories("苏州")[0].version).toBe(3);
    const { conversation } = await f.request<{ conversation: { id: string } }>(
      "/conversations",
      {},
    );
    const { run } = await f.request<{ run: Run }>(
      "/conversations/" + conversation.id + "/runs",
      { modelId: f.config.providers[0].model.id, text: "你记得我的居住地吗？" },
    );
    const settled = await waitFor(
      async () => (await f.request<{ run: Run }>("/runs/" + run.id)).run,
      (value) => ["completed", "failed"].includes(value.status),
    );
    expect(settled.status).toBe("completed");
    expect(settled.memoryIds).toEqual([profile.id]);
    const transmitted = JSON.stringify(f.requests.at(-1));
    expect(transmitted).toContain("我住在苏州");
    expect(transmitted).not.toContain(quote);
    expect(f.store.work.versions(profile.id)).toHaveLength(3);
    await f.request(
      "/memories/" + profile.id,
      {
        version: 3,
        title: "居住在南京",
        content: "我住在南京。",
        place: "南京",
        attribute: { key: "home_city", value: "南京" },
      },
      "PATCH",
    );
    const next = await f.request<{ run: Run }>(
      "/conversations/" + conversation.id + "/runs",
      {
        modelId: f.config.providers[0].model.id,
        text: "请再核对一次当前城市。",
      },
    );
    await waitFor(
      async () => (await f.request<{ run: Run }>("/runs/" + next.run.id)).run,
      (value) => ["completed", "failed"].includes(value.status),
    );
    const latestRequest = JSON.stringify(f.requests.at(-1));
    expect(latestRequest).toContain("居住在南京");
    expect(latestRequest).not.toContain("居住在苏州");
    expect(latestRequest.match(/本次任务上下文/g)).toHaveLength(1);
  });

  it("rejects invented evidence, commits valid siblings and retries only failed chunks", async () => {
    const good = "2026-03-14，我和陈默在杭州散步。";
    const f = await fixture((input, call) => [
      candidate(input.text, {
        quote:
          input.document === "坏引句.txt" && call <= 2
            ? "原文从未出现这句话"
            : input.text,
      }),
    ]);
    const job = await f.start([
      { name: "好引句.txt", text: good },
      { name: "坏引句.txt", text: good + "我们看了一棵树。" },
    ]);
    const first = await f.settle(job.id);
    expect(first.status).toBe("failed");
    expect(first.chunks.map((chunk) => chunk.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(first.chunks[1].error).toContain("原文校验");
    expect(f.store.work.list("memory")).toHaveLength(1);
    await f.request("/memory-imports/" + job.id + "/retry", {});
    const retried = await f.settle(job.id);
    expect(retried.status).toBe("completed");
    expect(retried.chunks.map((chunk) => chunk.attempts)).toEqual([1, 2]);
    expect(f.store.work.list("memory")).toHaveLength(2);
    expect(f.calls).toBe(3);
  });

  it("requires explicit versioned conflict resolution and preserves superseded history", async () => {
    const f = await fixture((input) => [
      residence(input.text.includes("苏州") ? "苏州" : "杭州", input.text),
    ]);
    await f.settle(
      (
        await f.start([
          { name: "旧记录.txt", text: "我住在杭州。" },
          { name: "新记录.txt", text: "我搬到了苏州。" },
        ])
      ).id,
    );
    const memories = f.store.work.list<MemoryEntry>("memory");
    const old = memories[0],
      current = memories[1];
    await f.request(
      "/memories/" + old.id,
      { version: 1, status: "confirmed" },
      "PATCH",
    );
    const blocked = await f.app.inject({
      method: "PATCH",
      url: "/api/memories/" + current.id,
      payload: { version: 1, status: "confirmed" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("MEMORY_CONFLICT");
    const stale = await f.app.inject({
      method: "POST",
      url: "/api/memories/" + current.id + "/resolve",
      payload: { version: 1, replace: [{ id: old.id, version: 1 }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      f.store.work.get<MemoryEntry>("memory", old.id)?.supersededBy,
    ).toBeUndefined();
    await f.request("/memories/" + current.id + "/resolve", {
      version: 1,
      replace: [{ id: old.id, version: 2 }],
    });
    expect(
      f.store.work
        .searchMemories("", 8, { category: "profile" })
        .map((memory) => memory.id),
    ).toEqual([current.id]);
    expect(
      f.store.work.searchMemories("", 8, { includeHistorical: true }),
    ).toHaveLength(2);
    expect(f.store.work.get<MemoryEntry>("memory", old.id)?.supersededBy).toBe(
      current.id,
    );
    expect(f.store.work.versions(old.id)).toHaveLength(3);
    expect(
      f.store.work.get<MemoryEntry>("memory", current.id)?.replaces,
    ).toEqual([old.id]);
  });

  it("keeps synthetic examples isolated even after approval, and prevents mixed-space imports and merges", async () => {
    const f = await fixture((input) => [
      candidate(input.text, {
        quote: input.text.slice(0, 40),
        people: [],
        occurredAt: "",
        title: "虚构样本",
        category: "fact",
      }),
    ]);
    const result = await f.request<{ job: MemoryImportJob }>(
      "/memory-imports",
      {
        requestId: randomUUID(),
        modelId: f.config.providers[0].model.id,
        demo: true,
      },
    );
    expect((await f.settle(result.job.id)).status).toBe("completed");
    const demo = await f.request<MemoryOverview>("/memory-overview?space=demo");
    expect(demo.memories).toHaveLength(4);
    await f.request("/memories/review", {
      entries: demo.memories.map((memory) => ({
        id: memory.id,
        version: memory.version,
      })),
      status: "confirmed",
    });
    expect(f.store.work.searchMemories("虚构")).toEqual([]);
    expect(f.store.assets()).toEqual([]);
    expect(f.store.searchAssets("", undefined, 20, 0).total).toBe(0);
    expect(
      (await f.request<MemoryOverview>("/memory-overview")).memories,
    ).toEqual([]);
    expect(
      (await f.request<{ memories: MemoryEntry[] }>("/workspace")).memories,
    ).toEqual([]);
    const { memory } = await f.request<{ memory: MemoryEntry }>("/memories", {
      title: "真实空间手动测试",
      content: "用户亲自填写的内容",
    });
    const merge = await f.app.inject({
      method: "POST",
      url: "/api/memories/merge",
      payload: {
        title: "混入测试",
        content: "拒绝混入",
        entries: [
          { id: memory.id, version: 1 },
          { id: demo.memories[0].id, version: 2 },
        ],
      },
    });
    expect(merge.statusCode).toBe(400);
    const mixed = await f.app.inject({
      method: "POST",
      url: "/api/memory-imports",
      payload: {
        requestId: randomUUID(),
        modelId: f.config.providers[0].model.id,
        assetIds: [demo.memories[0].sources[0].assetId],
      },
    });
    expect(mixed.statusCode).toBe(400);
  });

  it("keeps entity/date retrieval current after correction and bounds serialized recall", async () => {
    const f = await fixture();
    const quote = "2026-03-14，我和陈默在杭州散步。";
    await f.settle((await f.start([{ name: "散步.txt", text: quote }])).id);
    let memory = f.store.work.list<MemoryEntry>("memory")[0];
    await f.request(
      "/memories/" + memory.id,
      { version: 1, status: "confirmed" },
      "PATCH",
    );
    expect(
      (
        await f.request<{ memories: MemoryEntry[] }>(
          "/memory-search?person=陈默&from=2026-03-01&to=2026-03-31",
        )
      ).memories,
    ).toHaveLength(1);
    await f.request(
      "/memories/" + memory.id,
      {
        version: 2,
        content: "2026-04-01，我和许宁在苏州散步。",
        people: ["许宁"],
        place: "苏州",
        occurredAt: "2026-04-01",
      },
      "PATCH",
    );
    expect(
      (await f.request<MemoryOverview>("/memory-overview")).people.map(
        (person) => person.name,
      ),
    ).toEqual(["许宁"]);
    expect(f.store.work.searchMemories("", 8, { person: "陈默" })).toEqual([]);
    expect(
      f.store.work.searchMemories("", 8, { person: "许宁", to: "2026-03-31" }),
    ).toEqual([]);
    expect(
      f.store.work.searchMemories("", 8, {
        person: "许宁",
        from: "2026-04-01",
      }),
    ).toHaveLength(1);
    memory = f.store.work.get<MemoryEntry>("memory", memory.id)!;
    const payload = budgetMemories(
      [
        memory,
        { ...memory, id: randomUUID(), content: "超长".repeat(10000) },
        memory,
      ],
      3000,
    );
    expect(payload).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
      3000,
    );
  });

  it("resumes only unfinished work after shutdown and respects cancellation and immutable evidence", async () => {
    const f = await fixture();
    let calls = 0;
    const blocking: AgentRuntime = {
      history: async () => [],
      prompt: async () => {},
      cancel: async () => {},
      close: async () => {},
      extractMemories: async (input, signal) => {
        calls++;
        if (calls > 1)
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
        return {
          entries: [candidate(input.text, { people: [], occurredAt: "" })],
          usage: { input: 1, output: 1 },
        };
      },
    };
    await f.restart(blocking);
    const job = await f.start([
      { name: "一.txt", text: "第一次经历。" },
      { name: "二.txt", text: "第二次经历。" },
    ]);
    await waitFor(
      () => f.getJob(job.id),
      (value) =>
        value.chunks[0].status === "completed" &&
        value.chunks[1].stage === "extract",
    );
    await f.restart(blocking);
    await waitFor(
      () => f.getJob(job.id),
      (value) => value.chunks[1].stage === "extract",
    );
    expect(f.store.work.list("memory")).toHaveLength(1);
    expect(calls).toBe(3);
    await f.request("/memory-imports/" + job.id + "/cancel", {});
    await waitFor(
      () => f.getJob(job.id),
      (value) =>
        value.status === "cancelled" && value.chunks[1].status === "pending",
    );
    const pending = (await f.getJob(job.id)).chunks[1];
    await writeFile(join(f.store.assetsDir, pending.assetId), "被修改的原文");
    await f.request("/memory-imports/" + job.id + "/retry", {});
    const final = await f.settle(job.id);
    expect(final.status).toBe("failed");
    expect(final.chunks[0].status).toBe("completed");
    expect(final.chunks[1].error).toContain("校验不一致");
    expect(calls).toBe(3);
    expect(f.store.work.list("memory")).toHaveLength(1);
  });
});
