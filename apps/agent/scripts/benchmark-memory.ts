// Local performance fixtures only. No provider requests, model training or personal data.
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { projectRoot, readConfig } from "../src/config.js";
import { contentHash } from "../src/memory-values.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";
import { toolOutput } from "../src/memory-tools.js";
import type { MemoryEntry } from "@memory/contracts";

const mode = process.argv[2];
const size = Number(process.argv[3]);
const directory = process.argv[4];
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const round = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

if (!mode) {
  const root = join(projectRoot, ".data", "evaluations");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(root, "memory-scale-"));
  const reports = [];
  for (const count of [10000, 100000]) {
    const dataDir = join(output, String(count));
    for (const stage of ["seed", "measure"]) await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), stage, String(count), dataDir], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Benchmark ${stage} exited ${code}`)));
    });
    reports.push(JSON.parse(await readFile(join(dataDir, "report.json"), "utf8")));
  }
  await json(join(output, "report.json"), { synthetic: true, providerCalls: 0, modelTraining: false, reports });
  console.log(JSON.stringify({ reportPath: join(output, "report.json"), completed: true }));
} else {
  if (![10000, 100000].includes(size) || !directory || !["seed", "measure"].includes(mode)) throw new Error("Use benchmark-memory without arguments, or seed/measure 10000|100000 <isolated-directory>");
  const started = performance.now();
  const store = new Store(directory);
  if (mode === "seed") {
    const people = Array.from({ length: 40 }, (_, i) => store.work.memory.savePerson({ name: "虚构人物" + i, aliases: ["性能别名" + i] }));
    const retained: string[] = [];
    for (let offset = 0; offset < size; offset += 500) {
      const rows = Array.from({ length: 500 }, (_, index) => {
        const n = offset + index;
        const occurredAt = `${2020 + n % 7}-${String(1 + n % 12).padStart(2, "0")}-${String(1 + n % 27).padStart(2, "0")}`;
        return { n, occurredAt, text: `${occurredAt}，我与虚构人物${n % 40}在测试地点${n % 80}完成活动${n % 17}，材料编号 memorytoken${n}。` };
      });
      const bytes = Buffer.from(rows.map((row) => row.text).join("\n") + "\n");
      const asset = { id: randomUUID(), name: `性能测试-${offset}.txt`, size: bytes.length, sha256: contentHash(bytes), mimeType: "text/plain", kind: "text" as const, createdAt: new Date().toISOString() };
      await writeFile(join(store.assetsDir, asset.id), bytes, { mode: 0o600 });
      store.work.transaction(() => {
        store.addAsset(asset);
        let start = 0;
        for (const row of rows) {
          const end = start + Buffer.byteLength(row.text);
          const memory = store.work.createMemory({
            title: `性能材料 ${row.n}`, content: row.text, occurredAt: row.occurredAt, category: "event", kind: "statement",
            status: row.n % 5 === 0 ? "draft" : "confirmed", personIds: [people[row.n % 40].id!], people: [people[row.n % 40].name],
            place: `测试地点${row.n % 80}`, conversationId: "", runId: "", acceptedBy: "user",
            sources: [{ assetId: asset.id, name: asset.name, sha256: asset.sha256, start, end, quote: row.text }],
          });
          if (row.n < 101) retained.push(memory.id);
          start = end + 1;
        }
      });
      if ((offset + 500) % 10000 === 0) console.log(JSON.stringify({ stage: "seed", records: offset + 500, target: size, elapsedMs: Math.round(performance.now() - started) }));
    }
    await json(join(directory, "seed.json"), { retained, personId: people[1].id, elapsedMs: round(performance.now() - started), peakRssMiB: round(process.resourceUsage().maxRSS / 1024) });
    store.close();
  } else {
    const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8")) as { retained: string[]; personId: string; elapsedMs: number; peakRssMiB: number };
    const app = buildApp(readConfig({ MEMORY_DATA_DIR: directory }), { store });
    await app.ready();
    const baseline = process.memoryUsage();
    const measurements: Record<string, unknown> = {};
    let peakRss = baseline.rss, peakHeap = baseline.heapUsed;
    async function measure(name: string, operation: (i: number) => unknown | Promise<unknown>, repeats = 12) {
      const times: number[] = [], lengths: number[] = [];
      for (let i = 0; i < repeats; i++) {
        const begin = performance.now();
        const output = await operation(i);
        const serialized = typeof output === "string" ? output : JSON.stringify(output);
        lengths.push(Buffer.byteLength(serialized || ""));
        times.push(performance.now() - begin);
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed);
      }
      measurements[name] = { calls: repeats, firstMs: round(times[0]), p50Ms: round(percentile(times, .5)), p95Ms: round(percentile(times, .95)), maxResponseBytes: Math.max(...lengths) };
      console.log(JSON.stringify({ stage: "measure", records: size, name, ...measurements[name] as object }));
    }
    const api = async (path: string) => {
      const response = await app.inject(path);
      if (response.statusCode !== 200) throw new Error(`Benchmark HTTP ${response.statusCode}: ${path}`);
      return response.body;
    };
    try {
      await measure("libraryOverviewHttp", () => api("/api/memory-overview?view=all&limit=50"));
      await measure("peopleOverviewHttp", () => api("/api/memory-overview?view=people&limit=50"));
      await measure("workspaceHttp", () => api("/api/workspace"));
      await measure("rareTermRecall", (i) => store.work.queries.recall({ query: "memorytoken" + (i * 7 + 1) }).response);
      await measure("commonTermRecall", () => store.work.queries.recall({ query: "测试地点活动" }).response);
      await measure("personAndTimeRecall", () => store.work.queries.recall({ personId: seed.personId, from: "2023-01-01", to: "2026-12-31" }).response);
      await measure("completeEventCountHttp", () => api("/api/memory-events?mode=count"));
      await measure("eventsListHttp", () => api("/api/memory-events?limit=8"));
      await measure("exactDedup", (i) => store.work.duplicateMemory(store.work.get<MemoryEntry>("memory", seed.retained[i])!));
      const conversation = store.createConversation();
      const tool = createWorkspaceTools(store, conversation.id).find((value) => value.name === "search_memories")!;
      await measure("agentToolWithTrace", async (i) => {
        const run = store.work.createRun(conversation.id, { text: "性能查询", modelId: "not-used", captureMemory: false });
        store.work.patchRun(run.id, { status: "running" });
        const output = await tool.execute("benchmark" + i, { query: "memorytoken" + (i * 7 + 1) }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
        store.work.patchRun(run.id, { status: "completed" });
        return toolOutput(output);
      });
      let cursor: string | undefined;
      await measure("successivePagesHttp", async () => {
        const body = await api("/api/memories?limit=50" + (cursor ? "&cursor=" + cursor : ""));
        cursor = JSON.parse(body).nextCursor || undefined;
        return body;
      }, 20);
      await measure("incrementalCorrection", (i) => {
        const old = store.work.get<MemoryEntry>("memory", seed.retained[i])!;
        return store.work.updateMemory(old.id, { content: old.content + "用户补充了一条性能测试说明。", people: old.people, place: old.place }, old.version);
      }, 100);
      const stopped = store.work.get<MemoryEntry>("memory", seed.retained[100])!;
      await measure("forgetAndRestore", (i) => {
        const current = store.work.get<MemoryEntry>("memory", stopped.id)!;
        return store.work.forgetMemory(current.id, current.version, i % 2 === 1);
      }, 10);
      await json(join(directory, "report.json"), { synthetic: true, evidence: "generated UTF-8 files with exact source ranges", providerCalls: 0, modelTraining: false,
        records: size, transport: "Fastify HTTP handlers including serialization; browser rendering tested separately; agentToolWithTrace includes new run creation and finalization", seed,
        memory: { baselineRssMiB: round(baseline.rss / 2 ** 20), sampledPeakRssMiB: round(peakRss / 2 ** 20), processPeakRssMiB: round(process.resourceUsage().maxRSS / 1024), heapGrowthMiB: round((peakHeap - baseline.heapUsed) / 2 ** 20) },
        databaseBytes: (await stat(join(directory, "memory.sqlite"))).size, measurements, completed: true });
    } finally { await app.close(); }
  }
}
