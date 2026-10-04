// Exercises real retained sources, local indexes and archive I/O. No training or model-generated facts.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryEntry } from "@memory/contracts";
import { Store } from "../src/store.js";
import { DatasetService } from "../src/dataset-service.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { LocalMemoryProcessor } from "../src/local-memory-processor.js";
import { MemoryFeatureService } from "../src/memory-feature-service.js";
import { readConfig, projectRoot } from "../src/config.js";
import { contentHash } from "../src/memory-values.js";
import { buildApp } from "../src/app.js";
import type { Run } from "@memory/contracts";

const sourceDir = process.argv[2] && resolve(process.argv[2]);
if (!sourceDir) throw new Error("Provide a retained hybrid-real evaluation directory, not the user's live data directory");
const sourceReport = JSON.parse(await readFile(join(sourceDir, "report.json"), "utf8"));
if (!Array.isArray(sourceReport.recall) || !sourceReport.faceChecks || !String(sourceReport.scope).includes("虚构")) throw new Error("Expected an isolated hybrid evaluation report");
const root = join(projectRoot, ".data", "evaluations"); await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, "dataset-real-"));
await backupMemory(sourceDir, join(dir, "seed-archive"));
await restoreMemory(join(dir, "seed-archive"), join(dir, "working"));
const store = new Store(join(dir, "working")); const datasets = new DatasetService(store);
const digest = (db: Store) => Object.fromEntries(["workspace_records", "workspace_versions", "memory_observations", "memory_entities", "memory_entity_links", "memory_events", "memory_event_links", "memory_vector_meta"].map((table) => {
  const rows = db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return [table, { rows: rows.length, sha256: contentHash(JSON.stringify(rows)) }];
}));
let restored: Store | undefined, second: DatasetService | undefined, features: MemoryFeatureService | undefined;
try {
  const started = performance.now();
  const job = datasets.submit({ requestKey: "isolated-whole-corpus", title: "公开素材与虚构记录构建演练", format: "mixed" });
  await datasets.idle();
  const completed = datasets.ledger.get(job.id);
  if (completed.status !== "completed" || completed.counts.processed !== completed.counts.total) throw new Error("Dataset did not finish its full manifest");
  const buildMs = performance.now() - started;
  const before = digest(store);
  await datasets.close();
  const backup = await backupMemory(store.dataDir, join(dir, "archive"));
  const recovery = await restoreMemory(join(dir, "archive"), join(dir, "restored"));
  restored = new Store(join(dir, "restored")); second = new DatasetService(restored);
  const after = digest(restored);
  const checks: Record<string, boolean> = {
    fullManifest: completed.counts.processed === completed.counts.total,
    stableIdsVersionsAndGraph: JSON.stringify(before) === JSON.stringify(after),
    stableDataset: JSON.stringify(datasets.ledger.inputPage(job.id)) === JSON.stringify(second.ledger.inputPage(job.id)),
    stableSamples: JSON.stringify(datasets.ledger.samples(job.id, "", 100)) === JSON.stringify(second.ledger.samples(job.id, "", 100)),
  };
  const download = await second.download(job.id, "manifest"); let json = "";
  for await (const chunk of download.stream) json += chunk;
  checks.exportSourcesVerified = JSON.parse(json).inputs.length === completed.counts.total;
  const config = readConfig();
  if (!config.localProcessor) throw new Error("Local processor not configured");
  features = new MemoryFeatureService(restored, new LocalMemoryProcessor(config.localProcessor));
  restored.work.queries.features = features;
  const question = sourceReport.recall[0] as { query: string; expected: string };
  const recalled = await restored.work.queries.recallAsync({ query: question.query, category: "event", limit: 3 });
  checks.realEncoderRecallAfterRestore = recalled.entries[0]?.id === question.expected;
  const entry = restored.work.get<MemoryEntry>("memory", question.expected)!;
  restored.work.updateMemory(entry.id, { content: entry.content + "（恢复演练中的隔离修订）" }, entry.version);
  const affected = second.ledger.get(job.id);
  checks.correctionPropagatesAfterRestore = affected.stale && affected.counts.staleSamples === 2;
  checks.noModelWeights = (restored.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get() as { n: number }).n === 0;
  let agent: unknown;
  if (process.argv.includes("--agent")) {
    const provider = config.providers[0]; if (!provider) throw new Error("No Agent model configured");
    await restoreMemory(join(dir, "seed-archive"), join(dir, "agent-trial"));
    const trial = new Store(join(dir, "agent-trial"));
    const app = buildApp({ ...config, dataDir: trial.dataDir, localProcessor: undefined }, { store: trial });
    try {
      await app.ready();
      const conversation = (await app.inject({ method: "POST", url: "/api/conversations" })).json().conversation;
      const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
        text: "这是隔离的虚构经历评测，不是真实用户资料。请用 build_dataset 从全部已确认的 event 类经历构建问答数据集，不要用检索前几条代替全范围。等待后台完成后，把实际覆盖条数、待审和排除条数、数据集 ID 与下载链接使用 write_artifact 保存为整理结果并交付。无需提问，不训练模型。",
        modelId: provider.model.id, scope: "library", useMemory: true, captureMemory: false, permissionMode: "auto",
      } });
      if (response.statusCode !== 201) throw new Error("Agent task could not start");
      const id = response.json().run.id; const until = Date.now() + 180000;
      let run: Run;
      do {
        await new Promise((resolve) => setTimeout(resolve, 500)); run = trial.work.get<Run>("run", id)!;
        if (["completed", "failed", "stopped"].includes(run.status)) break;
      } while (Date.now() < until);
      const jobs = run.jobs || [];
      const dataset = jobs.find((job) => job.kind === "memory-dataset");
      const details = dataset ? (await app.inject(`/api/memory-datasets/${dataset.id}`)).json() : undefined;
      const tools = run.parts.filter((part) => part.type === "tool");
      agent = { model: provider.model.name, runId: run.id, status: run.status, tools: tools.map((part) => ({ name: part.name, state: part.state })),
        jobs, result: details, answer: run.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        notifications: trial.work.events(id).filter((event) => event.type === "job-results").length };
      checks.actualAgentScopeAndDelivery = run.status === "completed" && jobs.length === 1 && dataset?.status === "completed"
        && details?.dataset?.counts.total === 12 && details.dataset.counts.processed === 12
        && trial.work.events(id).filter((event) => event.type === "job-results").length === 1
        && tools.some((part) => part.name === "write_artifact" && part.state === "complete");
    } finally { await app.close(); }
  }
  const report = { at: new Date().toISOString(), scope: "实际公开图片、虚构文本原件、真实本地编码器和 SQLite；文本确认状态来自原评测种子，不能冒充真实用户确认。图片中的未知身份与日期仍保留。不训练。",
    source: sourceDir, dataset: completed, buildMs, before, after, backup, recovery, checks, agent, trainingStarted: false,
    limitation: "固定 18 条评测记录；不是大规模数据生成、问答多样性或训练效果验证。单元/集成测试另验证用户核对、75 条中断恢复与范围边界。" };
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: join(dir, "report.json"), counts: completed.counts, checks }));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally { await features?.close(); await second?.close(); if (restored?.db.isOpen) restored.close(); await datasets.close(); if (store.db.isOpen) store.close(); }
