import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  MemoryCaptureJob,
  MemoryEntry,
  MemoryPerson,
  Run,
} from "@memory/contracts";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import {
  contentHash,
  evidenceOf,
  messageEvidence,
} from "../src/memory-ledger.js";
import type {
  CaptureInput,
  CapturedMemory,
} from "../src/memory-capture-extraction.js";
import {
  dateInZone,
  normalizeMemorySearch,
  budgetMemories,
} from "../src/memory-retrieval.js";
import { resolveMemoryTime } from "../src/memory-time.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => T | Promise<T>,
  condition: (value: T) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (condition(value)) return value;
    await wait(15);
  }
  throw new Error("State did not settle");
}
const entry = (
  quote: string,
  patch: Partial<CapturedMemory> = {},
): CapturedMemory => ({
  title: "个人陈述",
  content: quote,
  quote,
  category: "fact",
  kind: "statement",
  personal: true,
  direct: true,
  identityClaim: false,
  people: [],
  place: "",
  uncertainty: "",
  timeExpression: "",
  attribute: null,
  duplicateOf: null,
  conflictIds: [],
  ...patch,
});
type ProtocolRequest = {
  messages: {
    role: string;
    content: string | { type: string; text?: string }[];
  }[];
  tools?: { function?: { name: string } }[];
};
const content = (value: ProtocolRequest["messages"][number]["content"]) =>
  typeof value === "string"
    ? value
    : value.map((part) => part.text || "").join("");
async function fixture(
  capture: (
    input: CaptureInput,
    attempt: number,
  ) => CapturedMemory[] | Promise<CapturedMemory[]> = (input) => [
    entry(input.text),
  ],
  malformedAttempts = 0,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "continuous-memory-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const requests: ProtocolRequest[] = [];
  let calls = 0;
  const provider = Fastify();
  provider.post<{ Body: ProtocolRequest }>(
    "/v1/chat/completions",
    async (request, reply) => {
      requests.push(request.body);
      const isCapture = request.body.tools?.some(
        (tool) => tool.function?.name === "capture_memories",
      );
      let delta: unknown = { content: "已完成本轮交流。" };
      if (isCapture) {
        const input = JSON.parse(
          content(
            request.body.messages
              .filter((message) => message.role === "user")
              .at(-1)!.content,
          ),
        );
        const attempt = ++calls;
        const entries = attempt <= malformedAttempts ? [] : await capture(input, attempt);
        delta = attempt <= malformedAttempts ? { content: "未提交结构化记录。" } : {
          tool_calls: [
            {
              index: 0,
              id: "capture_" + calls,
              type: "function",
              function: {
                name: "capture_memories",
                arguments: JSON.stringify({ entries }),
              },
            },
          ],
        };
      }
      reply.hijack();
      if (reply.raw.destroyed) return;
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (value: unknown, finish: string | null) =>
        "data: " +
        JSON.stringify({
          id: "memory-protocol-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-memory",
          choices: [{ index: 0, delta: value, finish_reason: finish }],
          usage: {
            prompt_tokens: 140,
            completion_tokens: 60,
            total_tokens: 200,
          },
        }) +
        "\n\n";
      reply.raw.end(
        frame(delta, null) +
          frame({}, isCapture && !(delta && typeof delta === "object" && "content" in delta) ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    },
  );
  const url = await provider.listen({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => provider.close());
  const config = readConfig({
    MEMORY_DATA_DIR: dataDir,
    MEMORY_OPENAI_BASE_URL: url + "/v1",
    MEMORY_OPENAI_API_KEY: "fixture-key",
    MEMORY_OPENAI_MODEL: "test-memory",
  });
  let store = new Store(dataDir);
  // Explicit task/import tests isolate automatic intake, which has its own coverage.
  store.memories.ledger.setSettings({ intake: "manual" });
  let app = buildApp(config, { store });
  let closed = false;
  await app.ready();
  cleanup.push(async () => {
    if (!closed) await app.close();
  });
  async function request<T>(
    path: string,
    body?: object,
    method: "GET" | "POST" | "PATCH" = body ? "POST" : "GET",
  ) {
    const response = await app.inject({
      method,
      url: "/api" + path,
      ...(body ? { payload: body } : {}),
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json<T>();
  }
  const jobs = (id: string) =>
    request<{ jobs: MemoryCaptureJob[] }>("/memory-captures?runId=" + id).then(
      (value) => value.jobs,
    );
  return {
    dataDir,
    config,
    requests,
    request,
    jobs,
    get store() {
      return store;
    },
    get app() {
      return app;
    },
    get calls() {
      return calls;
    },
    async run(
      text: string,
      options: Partial<Run> = {},
      conversationId?: string,
    ) {
      const id =
        conversationId ||
        (await request<{ conversation: { id: string } }>("/conversations", {}))
          .conversation.id;
      const result = await request<{ run: Run }>(`/conversations/${id}/runs`, {
        text,
        modelId: config.providers[0].model.id,
        ...options,
      });
      return until(
        () =>
          request<{ run: Run }>("/runs/" + result.run.id).then(
            (value) => value.run,
          ),
        (run) => ["completed", "failed", "stopped"].includes(run.status),
      );
    },
    settle: (id: string) =>
      until(
        () => jobs(id),
        (jobs) =>
          !!jobs.length &&
          jobs.every((job) =>
            ["completed", "failed", "cancelled", "skipped"].includes(
              job.status,
            ),
          ),
      ),
    async restart(before?: () => Promise<void> | void) {
      await app.close();
      closed = true;
      await before?.();
      store = new Store(dataDir);
      app = buildApp(config, { store });
      await app.ready();
      closed = false;
    },
  };
}
function memory(
  store: Store,
  content: string,
  patch: Partial<MemoryEntry> = {},
) {
  return store.work.createMemory({
    title: content.slice(0, 100),
    content,
    status: "confirmed",
    kind: "statement",
    occurredAt: "",
    sources: [],
    conversationId: "",
    runId: "",
    ...patch,
  });
}

describe("continuous personal memory", () => {
  it("retries a malformed processor response once, then saves a source-checked preference without duplicates", async () => {
    const f = await fixture((input) => [entry(input.text, { category: "profile" })], 1);
    const current = await f.run("我喜欢把整理结果按日期从新到旧排列。");
    const [job] = await f.settle(current.id);
    expect(job).toMatchObject({ status: "completed", attempts: 2, invalidResponseRetries: 1 });
    expect(f.calls).toBe(2);
    const entries = f.store.memories.list<MemoryEntry>("memory");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "confirmed", acceptedBy: "policy", content: current.text });
    expect(evidenceOf(entries[0])).toMatchObject([{ type: "message", runId: current.id, sha256: contentHash(current.text), quote: current.text }]);
  });

  it("keeps repeated malformed capture responses failed with a bounded durable retry count", async () => {
    const f = await fixture(undefined, 2);
    const current = await f.run("我喜欢按日期整理。");
    const [job] = await f.settle(current.id);
    expect(job).toMatchObject({ status: "failed", attempts: 2, invalidResponseRetries: 1 });
    expect(f.calls).toBe(2);
    expect(f.store.memories.list("memory")).toHaveLength(0);
    await wait(300);
    expect(f.calls).toBe(2);
    await f.restart();
    expect((await f.jobs(current.id))[0]).toMatchObject({ status: "failed", attempts: 2, invalidResponseRetries: 1 });
    expect(f.calls).toBe(2);
  });

  it("promotes a matching same-message profile draft only after the independent processor passes source grading", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(async (input) => { await gate; return [entry(input.text, { category: "profile" })]; });
    const current = await f.run("我喜欢按日期从新到旧整理。");
    await until(() => f.calls, (n) => n === 1);
    const draft = memory(f.store, current.text, { status: "draft", kind: "statement", category: "profile", sources: [],
      evidence: [messageEvidence(current, current.text)], conversationId: current.conversationId, runId: current.id });
    release();
    const [job] = await f.settle(current.id);
    expect(job.status).toBe("completed");
    expect(f.store.memories.list("memory")).toHaveLength(1);
    expect(f.store.memories.get<MemoryEntry>("memory", draft.id)).toMatchObject({ status: "confirmed", acceptedBy: "policy", ingestion: { jobId: job.id } });
    expect(job.memoryIds).toEqual([draft.id]);
    const older = memory(f.store, "我喜欢在早晨整理。", { status: "draft", kind: "statement", category: "profile", sources: [],
      evidence: [messageEvidence(current, current.text)], conversationId: current.conversationId, runId: current.id });
    const later = await f.run("我喜欢在早晨整理。");
    await f.settle(later.id);
    expect(f.store.memories.get<MemoryEntry>("memory", older.id)?.status).toBe("draft");
  });
  it("captures exact user-message evidence through Pi, merges repeat evidence and keeps the read/write switches independent", async () => {
    const f = await fixture((input) => [
      entry("我喜欢雨后沿河散步。", {
        title: "散步偏好",
        duplicateOf:
          input.existing.find(
            (value) => value.content === "我喜欢雨后沿河散步。",
          )?.id || null,
      }),
    ]);
    const first = await f.run("🌳 我喜欢雨后沿河散步。", { useMemory: false });
    const [job] = await f.settle(first.id);
    expect(job.status).toBe("completed");
    expect(job.usage?.input).toBe(140);
    const saved = f.store.work.get<MemoryEntry>("memory", job.memoryIds[0])!;
    expect(saved.status).toBe("confirmed");
    expect(saved.acceptedBy).toBe("policy");
    expect(saved.evidence?.[0]).toMatchObject({
      type: "message",
      runId: first.id,
      start: Buffer.byteLength("🌳 "),
      quote: "我喜欢雨后沿河散步。",
    });
    const proof = await f.request<{ quote: string; verified: boolean }>(
      `/memories/${saved.id}/evidence/0`,
    );
    expect(proof).toEqual(
      expect.objectContaining({
        quote: "我喜欢雨后沿河散步。",
        verified: true,
      }),
    );
    const second = await f.run("我喜欢雨后沿河散步。");
    await f.settle(second.id);
    expect(f.store.work.list<MemoryEntry>("memory")).toHaveLength(1);
    expect(
      evidenceOf(f.store.work.get<MemoryEntry>("memory", saved.id)!),
    ).toHaveLength(2);
    const repeated = await f.run("我喜欢雨后沿河散步。");
    await f.settle(repeated.id);
    expect(
      evidenceOf(f.store.work.get<MemoryEntry>("memory", saved.id)!),
    ).toHaveLength(3);
    await f.request("/memory-settings", { capture: "off" }, "PATCH");
    const third = await f.run("我喜欢雨后沿河散步。");
    expect(await f.jobs(third.id)).toEqual([]);
    const count = f.calls;
    await f.request(`/runs/${third.id}/capture`, {});
    await f.settle(third.id);
    expect(f.calls).toBe(count + 1);
    expect(
      (
        await f.request<{ jobs: MemoryCaptureJob[] }>("/memory-captures")
      ).jobs.some((job) => job.runId === third.id),
    ).toBe(true);
  }, 15000);

  it("does not auto-confirm quotations, code, hypothetical events, identity claims or inferences even when a provider labels them direct", async () => {
    const f = await fixture((input) => [
      entry(
        input.text,
        input.text.includes("阿默")
          ? { identityClaim: true }
          : input.text.includes("可能")
            ? { kind: "inference", uncertainty: "尚未确定" }
            : {},
      ),
    ]);
    for (const text of [
      "举例：我住在月球。",
      "小说台词：我现在住在杭州。",
      "```text\n我是一名医生。\n```",
      "如果我搬去北京，我会每天骑车。",
      "陈默就是我之前说的阿默。",
      "我可能在去年去过厦门。",
      "他说：“我在医院工作。”",
    ]) {
      const run = await f.run(text);
      const [job] = await f.settle(run.id);
      expect(job.status).toBe("completed");
    }
    expect(
      f.store.work
        .list<MemoryEntry>("memory")
        .every((value) => value.status === "draft"),
    ).toBe(true);
    expect(f.store.work.searchMemories("")).toEqual([]);
  }, 15000);

  it("checks the surrounding message when an extractor removes quotation or hypothetical markers", async () => {
    const f = await fixture((input) => [
      entry(input.text.includes("巴黎") ? "我明年去巴黎" : "我在北京当医生。"),
    ]);
    for (const text of [
      "他说：“我在北京当医生。”",
      '她说："我在北京当医生。"',
      "> 我在北京当医生。",
      "如果我明年去巴黎，就会学法语。",
    ]) {
      const run = await f.run(text);
      const [job] = await f.settle(run.id);
      expect(job.status).toBe("completed");
      expect(
        job.memoryIds.every(
          (id) =>
            f.store.work.get<MemoryEntry>("memory", id)?.status === "draft",
        ),
      ).toBe(true);
    }
    expect(f.store.work.searchMemories("")).toEqual([]);
  }, 15000);

  it("recognizes a continued first-person clause without taking a subject from another sentence", async () => {
    const f = await fixture(() => [
      entry("是一名工业设计师", {
        category: "profile",
        attribute: { key: "occupation", value: "工业设计师" },
      }),
    ]);
    const run = await f.run("我叫林舟，是一名工业设计师。");
    const [job] = await f.settle(run.id);
    expect(
      f.store.work.get<MemoryEntry>("memory", job.memoryIds[0]),
    ).toMatchObject({
      status: "confirmed",
      attribute: { key: "occupation", value: "工业设计师" },
    });
    const other = await f.run("我叫林舟。陈默是一名工业设计师。");
    const [second] = await f.settle(other.id);
    expect(
      second.memoryIds.every(
        (id) => f.store.work.get<MemoryEntry>("memory", id)?.status === "draft",
      ),
    ).toBe(true);
  }, 10000);

  it("keeps conflicting statements pending, distinguishes a life change, and searches historical effective dates", async () => {
    const f = await fixture((input) => [
      entry(input.text, {
        category: "profile",
        title: "新居住地",
        attribute: { key: "home_city", value: "苏州" },
        timeExpression: "2026-04-02",
      }),
    ]);
    const old = memory(f.store, "我住在杭州。", {
      category: "profile",
      attribute: { key: "home_city", value: "杭州" },
      validity: { from: "2025-01-01", precision: "day" },
    });
    const run = await f.run("2026-04-02起，我住在苏州。");
    const [job] = await f.settle(run.id);
    const candidate = f.store.work.get<MemoryEntry>(
      "memory",
      job.memoryIds[0],
    )!;
    expect(candidate.status).toBe("draft");
    expect(
      f.store.work.memoryConflicts(candidate).map((value) => value.id),
    ).toEqual([old.id]);
    const changed = await f.request<{ memory: MemoryEntry }>(
      `/memories/${candidate.id}/resolve`,
      {
        version: candidate.version,
        replace: [{ id: old.id, version: old.version }],
        resolution: "change",
      },
    );
    expect(changed.memory.status).toBe("confirmed");
    expect(
      f.store.work.searchMemories("我现在住哪里").map((value) => value.id),
    ).toEqual([candidate.id]);
    expect(
      f.store.work
        .searchMemories("我住在哪里", 8, {
          from: "2025-05-01",
          to: "2025-05-31",
        })
        .map((value) => value.id),
    ).toEqual([old.id]);
    expect(f.store.work.get<MemoryEntry>("memory", old.id)?.validity?.to).toBe(
      "2026-04-01",
    );
    const stale = await f.app.inject({
      method: "POST",
      url: `/api/memories/${old.id}/forget`,
      payload: { version: old.version },
    });
    expect(stale.statusCode).toBe(409);
  }, 10000);

  it("rolls back an entire invalid extraction and supports explicit retry", async () => {
    const f = await fixture((input, attempt) =>
      attempt === 1
        ? [
            entry(input.text),
            entry("我没有说过这句话。", { title: "错误候选" }),
          ]
        : [entry(input.text)],
    );
    const run = await f.run("我喜欢植物园。");
    const [job] = await f.settle(run.id);
    expect(job.status).toBe("failed");
    expect(f.store.work.list("memory")).toEqual([]);
    await f.request(`/memory-captures/${job.id}/retry`, {});
    expect((await f.settle(run.id))[0].status).toBe("completed");
    expect(f.store.work.list("memory")).toHaveLength(1);
  }, 10000);

  it("recovers an interrupted background extraction without duplicating memories", async () => {
    const f = await fixture(async (input, call) => {
      if (call === 1) await wait(1100);
      return [entry(input.text)];
    });
    const run = await f.run("我每周会去游泳。");
    await until(
      () => f.jobs(run.id),
      (jobs) => jobs[0]?.status === "running",
    );
    await f.restart();
    expect((await f.settle(run.id))[0].status).toBe("completed");
    expect(f.store.work.list("memory")).toHaveLength(1);
    await f.request(`/runs/${run.id}/capture`, {});
    await wait(300);
    expect(f.store.work.list("memory")).toHaveLength(1);
  }, 10000);

  it("recovers pending captures older than the visible history and can cancel them with the global setting", async () => {
    const f = await fixture();
    const run = await f.run("我每周会去游泳。");
    const [job] = await f.settle(run.id);
    await f.restart(() => {
      const db = new DatabaseSync(join(f.dataDir, "memory.sqlite"));
      db.prepare("UPDATE memory_capture_jobs SET data=? WHERE id=?").run(
        JSON.stringify({ ...job, status: "running" }),
        job.id,
      );
      db.exec("BEGIN");
      for (let i = 0; i < 1001; i++) {
        const id = randomUUID();
        const historical = {
          ...job,
          id,
          messageId: id,
          runId: id,
          status: "completed",
        };
        db.prepare("INSERT INTO memory_capture_jobs VALUES (?,?,?,?)").run(
          id,
          id,
          job.extractorVersion,
          JSON.stringify(historical),
        );
      }
      db.exec("COMMIT");
      db.close();
    });
    expect((await f.settle(run.id))[0]).toMatchObject({
      status: "completed",
      recoveries: 1,
    });
    expect(f.store.work.list("memory")).toHaveLength(1);
    const recovered = (await f.jobs(run.id))[0];
    f.store.db
      .prepare("UPDATE memory_capture_jobs SET data=? WHERE id=?")
      .run(JSON.stringify({ ...recovered, status: "queued" }), job.id);
    await f.request("/memory-settings", { capture: "off" }, "PATCH");
    expect((await f.jobs(run.id))[0].status).toBe("cancelled");
  }, 15000);

  it("cancels queued work and refuses a source that was stopped while extraction was in flight", async () => {
    const f = await fixture(async (input) => {
      await wait(700);
      return [entry(input.text)];
    });
    const run = await f.run("我在南山有一间画室。");
    const [running] = await until(
      () => f.jobs(run.id),
      (jobs) => jobs[0]?.status === "running",
    );
    const saved = memory(f.store, run.text, {
      runId: run.id,
      conversationId: run.conversationId,
      evidence: [messageEvidence(run, run.text)],
    });
    await f.request(`/memories/${saved.id}/forget`, { version: saved.version });
    const [job] = await f.settle(run.id);
    expect(job.status).toBe("completed");
    expect(job.memoryIds).toEqual([]);
    expect(f.store.work.searchMemories("画室")).toEqual([]);
    const next = await f.run("我喜欢在南山画画。");
    const [queued] = await f.jobs(next.id);
    await f.request(`/memory-captures/${queued.id}/cancel`, {});
    expect((await f.settle(next.id))[0].status).toBe("cancelled");
    expect(running.sourceHash).toBe(contentHash(run.text));
  }, 10000);

  it("removes stopped facts and compacted context from actual Pi requests, preserves original evidence and works after restart", async () => {
    const secret = "我的画室门牌是枫桥九号。";
    const f = await fixture((input) =>
      input.text.includes("枫桥") ? [entry(secret)] : [],
    );
    const first = await f.run(secret);
    const [job] = await f.settle(first.id);
    const saved = f.store.work.get<MemoryEntry>("memory", job.memoryIds[0])!;
    const state = await f.request<{ nodes: { id: string }[] }>(
      `/conversations/${first.conversationId}/session`,
    );
    expect(state.nodes.length).toBeGreaterThan(0);
    await f.restart(() => {
      const manager = SessionManager.open(
        join(f.dataDir, "sessions", first.conversationId + ".jsonl"),
      );
      manager.appendCompaction("之前的对话记住了：" + secret, null, 30000);
    });
    await f.request(`/memories/${saved.id}/forget`, { version: saved.version });
    const after = await f.run(
      "你好，请简短回应。",
      { captureMemory: false },
      first.conversationId,
    );
    expect(after.status).toBe("completed");
    const sent = f.requests
      .filter(
        (request) =>
          !request.tools?.some(
            (tool) => tool.function?.name === "capture_memories",
          ),
      )
      .at(-1)!;
    expect(JSON.stringify(sent.messages)).not.toContain("枫桥九号");
    expect(
      await readFile(
        join(f.dataDir, "sessions", first.conversationId + ".jsonl"),
        "utf8",
      ),
    ).toContain(secret);
    const proof = await f.request<{ quote: string; verified: boolean }>(
      `/memories/${saved.id}/evidence/0`,
    );
    expect(proof.verified).toBe(true);
    await f.restart();
    await f.run("请继续。", { captureMemory: false }, first.conversationId);
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain(
      "枫桥九号",
    );
    const duplicate = await f.run(secret);
    const [blocked] = await f.settle(duplicate.id);
    expect(blocked.status).toBe("skipped");
    const stopped = f.store.work.get<MemoryEntry>("memory", saved.id)!;
    await f.request(`/memories/${saved.id}/restore`, {
      version: stopped.version,
    });
    expect(
      f.store.work.searchMemories("枫桥九号").map((value) => value.id),
    ).toEqual([saved.id]);
  }, 15000);

  it("sends the corrected date to Pi while preserving the original title and quotation for review", async () => {
    const original = "2025年3月14日，我和陈默在杭州运河边散步。";
    const f = await fixture((input) => [
      entry(input.text, {
        title: "3月14日与陈默散步",
        category: "event",
        timeExpression: "2025年3月14日",
      }),
    ]);
    const first = await f.run(original);
    const [job] = await f.settle(first.id);
    const saved = f.store.work.get<MemoryEntry>("memory", job.memoryIds[0])!;
    await f.request(
      `/memories/${saved.id}`,
      {
        version: saved.version,
        content: "2025-03-15，我和陈默在杭州运河边散步。",
        occurredAt: "2025-03-15",
        validity: { from: "2025-03-15", precision: "day" },
        people: ["陈默"],
        reason: "纠正日期",
      },
      "PATCH",
    );
    const next = await f.run(
      "我和陈默散步是哪一天？",
      { captureMemory: false },
      first.conversationId,
    );
    expect(next.status).toBe("completed");
    const sent = JSON.stringify(f.requests.at(-1)!.messages);
    expect(sent).toContain("2025-03-15");
    expect(sent).not.toContain("3月14日");
    const proof = await f.request<{ quote: string; verified: boolean }>(
      `/memories/${saved.id}/evidence/0`,
    );
    expect(proof).toMatchObject({ quote: original, verified: true });
    expect(f.store.work.get<MemoryEntry>("memory", saved.id)?.title).toBe(
      "3月14日与陈默散步",
    );
  }, 10000);

  it("invalidates structured corrections only after their transaction commits", async () => {
    const f = await fixture();
    const saved = memory(f.store, "我和陈默去南京看展。", {
      category: "event",
      occurredAt: "2025-03-14",
    });
    const epoch = f.store.work.memory.epoch;
    let invalidations = 0;
    f.store.work.memory.onInvalidate = () => {
      invalidations++;
    };
    expect(() =>
      f.store.work.transaction(() => {
        f.store.work.updateMemory(
          saved.id,
          { occurredAt: "2025-03-15" },
          saved.version,
        );
        throw new Error("Conflicting update");
      }),
    ).toThrow("Conflicting update");
    await Promise.resolve();
    expect(invalidations).toBe(0);
    expect(f.store.work.memory.epoch).toBe(epoch);
    f.store.work.updateMemory(
      saved.id,
      { occurredAt: "2025-03-15" },
      saved.version,
    );
    await Promise.resolve();
    expect(invalidations).toBe(1);
    expect(f.store.work.memory.epoch).toBeGreaterThan(epoch);
  });

  it("isolates same-name people, supports confirmed aliases and unlinks without guessing identity", async () => {
    const f = await fixture();
    const first = memory(f.store, "我和陈默在杭州骑车。", {
      people: ["陈默"],
      occurredAt: "2025-04-12",
    });
    const second = memory(f.store, "我和另一位陈默在成都开会。", {
      people: ["陈默"],
      occurredAt: "2026-06-12",
    });
    const { person } = await f.request<{ person: MemoryPerson }>(
      "/memory-people",
      {
        name: "陈默",
        aliases: ["阿默"],
        entries: [{ id: first.id, version: first.version }],
      },
    );
    expect(
      f.store.work.searchMemories("阿默").map((entry) => entry.id),
    ).toEqual([first.id]);
    expect(
      f.store.work
        .searchMemories("", 8, { personId: person.id })
        .map((entry) => entry.id),
    ).toEqual([first.id]);
    expect(
      f.store.work.get<MemoryEntry>("memory", second.id)?.personIds,
    ).toBeUndefined();
    const linked = f.store.work.get<MemoryEntry>("memory", first.id)!;
    await f.request(
      `/memory-people/${person.id}`,
      {
        name: person.name,
        aliases: person.aliases,
        version: person.version,
        unlink: [{ id: linked.id, version: linked.version }],
      },
      "PATCH",
    );
    expect(f.store.work.searchMemories("阿默")).toEqual([]);
  });

  it("backs up a legacy database, rebuilds its index and retains the exact original data for restore", async () => {
    const f = await fixture();
    const original = memory(f.store, "我和许宁去南京看展。", {
      people: ["许宁"],
    });
    await f.restart(() => {
      const db = new DatabaseSync(join(f.dataDir, "memory.sqlite"));
      db.exec("DELETE FROM migrations WHERE version=3; DROP TABLE memory_fts");
      db.close();
    });
    expect(
      (await stat(join(f.dataDir, "before-continuous-memory.sqlite"))).size,
    ).toBeGreaterThan(0);
    expect(
      f.store.work.searchMemories("许宁").map((entry) => entry.id),
    ).toEqual([original.id]);
    const backup = new DatabaseSync(
      join(f.dataDir, "before-continuous-memory.sqlite"),
      { readOnly: true },
    );
    expect(backup.prepare("PRAGMA quick_check").get()).toEqual({
      quick_check: "ok",
    });
    expect(
      JSON.parse(
        (
          backup
            .prepare("SELECT data FROM workspace_records WHERE id=?")
            .get(original.id) as { data: string }
        ).data,
      ).content,
    ).toBe(original.content);
    expect(
      backup.prepare("SELECT version FROM migrations WHERE version=3").get(),
    ).toBeUndefined();
    backup.close();
    const revision = Number(f.store.db.prepare("SELECT revision FROM memory_feature_jobs WHERE memoryId=?").get(original.id)!.revision);
    f.store.work.memory.rebuild();
    f.store.work.memory.rebuild();
    expect(Number(f.store.db.prepare("SELECT revision FROM memory_feature_jobs WHERE memoryId=?").get(original.id)!.revision)).toBeGreaterThan(revision);
    expect(f.store.work.searchMemories("南京")).toHaveLength(1);
  });
});

describe("memory time and retrieval evaluation", () => {
  it("resolves relative dates against message time and preserves imprecision", () => {
    expect(dateInZone(new Date("2026-01-01T23:30:00Z"))).toBe("2026-01-02");
    expect(
      resolveMemoryTime("昨天", "2026-01-01T23:30:00Z", "Asia/Shanghai"),
    ).toMatchObject({ from: "2026-01-01", precision: "day" });
    expect(
      resolveMemoryTime("去年三月", "2026-01-01T23:30:00Z", "Asia/Shanghai"),
    ).toMatchObject({
      from: "2025-03-01",
      to: "2025-03-31",
      precision: "month",
    });
    expect(
      resolveMemoryTime("2025年3月", "2026-01-02T00:00:00Z", "Asia/Shanghai"),
    ).toMatchObject({
      from: "2025-03-01",
      to: "2025-03-31",
      precision: "month",
    });
    expect(
      resolveMemoryTime("2026-02-30", "2026-01-02T00:00:00Z", "Asia/Shanghai"),
    ).toMatchObject({ precision: "unknown" });
    expect(
      normalizeMemorySearch({ query: "去年发生过什么" }, "2026-10-03"),
    ).toMatchObject({
      from: "2025-01-01",
      to: "2025-12-31",
      includeHistorical: true,
    });
    expect(
      normalizeMemorySearch({ query: "搬家以前我住在哪里？请查历史记录。" }),
    ).toMatchObject({ includeHistorical: true });
  });
  it("keeps past events with month-level dates searchable while filtering expired and future profile values", async () => {
    const f = await fixture();
    const visit = memory(f.store, "2025年三月，我和许宁去南京看展。", {
      category: "event",
      validity: { from: "2025-03-01", to: "2025-03-31", precision: "month" },
    });
    memory(f.store, "我曾住在杭州。", {
      category: "profile",
      attribute: { key: "home_city", value: "杭州" },
      validity: { from: "2020-01-01", to: "2021-12-31", precision: "day" },
    });
    memory(f.store, "我将住在苏州。", {
      category: "profile",
      attribute: { key: "home_city", value: "苏州" },
      validity: { from: "2099-01-01", precision: "day" },
    });
    expect(
      f.store.work.searchMemories("许宁看展").map((value) => value.id),
    ).toEqual([visit.id]);
    expect(f.store.work.searchMemories("我住在哪里")).toEqual([]);
    expect(
      f.store.work
        .searchMemories("我住在哪里", 8, {
          from: "2020-06-01",
          to: "2020-06-30",
        })
        .map((value) => value.attribute?.value),
    ).toEqual(["杭州"]);
  });
  it("retrieves short Chinese names, reordered phrases, dates and profiles in a 10,000-record corpus within a bounded payload", async () => {
    const f = await fixture();
    const truths: { query: string; id: string }[] = [];
    f.store.work.transaction(() => {
      for (const [person, place, action, query] of [
        ["陈默", "杭州运河", "散步", "陈默一起散步"],
        ["许宁", "南京美术馆", "看展", "许宁看展的经历"],
        ["林夏", "青岛海边", "骑车", "在海边和林夏骑车"],
        ["周然", "成都书店", "读书", "和周然去了哪个书店"],
        ["江禾", "苏州花园", "拍照", "苏州拍照江禾"],
        ["宋青", "西安城墙", "跑步", "宋青跑步"],
        ["李沐", "武汉公园", "野餐", "李沐"],
        ["何远", "厦门码头", "看日出", "何远看日出的地点"],
        ["吴笙", "天津剧院", "听音乐会", "天津音乐会吴笙"],
        ["叶岚", "长沙湖边", "钓鱼", "叶岚钓鱼"],
      ]) {
        const value = memory(
          f.store,
          `2025-03-14，我和${person}在${place}${action}。`,
          {
            title: `${place}${action}`,
            category: "event",
            people: [person],
            place,
            occurredAt: "2025-03-14",
          },
        );
        truths.push({ query, id: value.id });
      }
      for (let i = truths.length; i < 10000; i++)
        memory(
          f.store,
          `2026-06-${String((i % 28) + 1).padStart(2, "0")}，我完成日常园艺记录编号${i}，为盆栽浇水。`,
          { category: "event", occurredAt: "2026-06-01" },
        );
    });
    const durations: number[] = [];
    let hits = 0;
    for (const truth of truths) {
      const start = performance.now();
      const results = f.store.work.searchMemories(truth.query, 10);
      durations.push(performance.now() - start);
      if (results.some((value) => value.id === truth.id)) hits++;
      expect(
        Buffer.byteLength(JSON.stringify(budgetMemories(results))),
      ).toBeLessThanOrEqual(12000);
    }
    expect(hits / truths.length).toBeGreaterThanOrEqual(0.9);
    expect(
      durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1],
    ).toBeLessThan(100);
    expect(f.store.work.searchMemories("不存在的火星宇航学校毕业证")).toEqual(
      [],
    );
    expect(() => f.store.work.searchMemories('" OR NEAR ( ) *')).not.toThrow();
    const demo = memory(f.store, "我和陈默去金星探险。", {
      space: "demo",
      people: ["陈默"],
    });
    expect(
      f.store.work.searchMemories("陈默").some((value) => value.id === demo.id),
    ).toBe(false);
  }, 30000);
});
