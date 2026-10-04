// Explicit live evaluation; only a licensed public fixture enters a fresh private store.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, MemoryEntry, Run, Artifact } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { ModelAccess } from "../src/model-access.js";
import { PiMemoryProcessors, type MemoryProcessors } from "../src/memory-processors.js";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { photoHash } from "../src/photo-source.js";

if (!process.argv.includes("--live")) throw new Error("Use --live to evaluate the configured model with one public photograph");
const original = readConfig();
const provider = original.providers.find((value) => value.model.supportsImages && value.model.name === "gpt-6-luna")
  || original.providers.find((value) => value.model.supportsImages);
if (!provider) throw new Error("A configured image-capable model is required");
const root = join(projectRoot, ".data", "evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const dataDir = await mkdtemp(join(root, "harness-live-"));
const config = { ...original, dataDir };
const actual = new PiMemoryProcessors(config, new ModelAccess(config));
const calls = { text: 0, photos: 0 };
const processors: MemoryProcessors = {
  async extractMemories(input, signal) { calls.text++; return actual.extractMemories(input, signal); },
  async extractPhotoMemories(input, signal) { calls.photos++; return actual.extractPhotoMemories(input, signal); },
  captureMemories: (input, signal) => actual.captureMemories(input, signal),
};
const store = new Store(dataDir);
const app = buildApp(config, { store, processors });
await app.ready();
const reportPath = join(dataDir, "report.json");
const report: Record<string, unknown> = { type: "harness-live", model: provider.model.name,
  createdAt: new Date().toISOString(), completed: false, fixture: "coffee", calls };
let runId: string | undefined;
try {
  const manifest = JSON.parse(await readFile(join(projectRoot, "examples/photos/manifest.json"), "utf8")) as { photos: { id: string; file: string; sha256: string }[] };
  const fixture = manifest.photos.find((photo) => photo.id === "coffee")!;
  const data = await readFile(join(projectRoot, ".data/photo-fixtures", fixture.file));
  if (photoHash(data) !== fixture.sha256) throw new Error("Public fixture checksum mismatch");
  const asset: Asset = { id: randomUUID(), name: "公开示例照片.jpg", kind: "image", mimeType: "image/jpeg", size: data.length,
    sha256: fixture.sha256, createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, asset.id), data, { mode: 0o600 }); store.addAsset(asset);
  const conversation = store.createConversation();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: "请整理所选的公开示例照片，在整理结果中保存一份有来源的简短观察报告。只写画面支持的内容；不知道的人物、关系、日期保留未知，观察保持待核对。",
    modelId: provider.model.id, thinkingLevel: "low", scope: "selected", assetIds: [asset.id], permissionMode: "auto", captureMemory: false,
  } });
  if (response.statusCode !== 201) throw new Error("Could not start the isolated task");
  runId = response.json<{ run: Run }>().run.id;
  let run = store.work.get<Run>("run", runId)!;
  let previous = "";
  const started = Date.now();
  while (!["completed", "failed", "stopped"].includes(run.status)) {
    if (Date.now() - started > 300000) throw new Error("Live task exceeded five minutes");
    const state = JSON.stringify([run.status, run.waitingFor, run.jobs?.map((job) => job.status)]);
    if (state !== previous) {
      console.log(JSON.stringify({ stage: run.status, waitingFor: run.waitingFor, jobs: run.jobs?.map((job) => job.status) }));
      previous = state;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    run = store.work.get<Run>("run", runId)!;
  }
  const memories = store.work.list<MemoryEntry>("memory");
  const artifacts = store.work.list<Artifact>("artifact");
  const checks = {
    runCompleted: run.status === "completed",
    agentUsedProcessingTool: run.parts.some((part) => part.type === "tool" && part.name === "process_assets" && part.state === "complete"),
    backgroundCompleted: !!run.jobs?.length && run.jobs.every((job) => job.status === "completed"),
    completionDelivered: store.work.events(runId).filter((event) => event.type === "job-results").length === 1,
    onePhotoProcessingCall: calls.photos === 1 && calls.text === 0,
    candidatesRetainReview: memories.length > 0 && memories.every((memory) => memory.status === "draft"),
    evidenceMatchesFixture: memories.length > 0 && memories.every((memory) => memory.sources.every((source) => source.assetId === asset.id && source.sha256 === fixture.sha256)),
    savedArtifactWithSource: artifacts.some((artifact) => artifact.sources.some((source) => source.assetId === asset.id)),
  };
  Object.assign(report, { completed: Object.values(checks).every(Boolean), checks, elapsedMs: Date.now() - started, run, memories, artifacts });
  console.log(JSON.stringify({ checks, calls, reportPath }));
  if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.error = "真实模型验证未完成，请检查隔离运行状态";
  if (runId) {
    report.run = store.work.get<Run>("run", runId);
    await app.inject({ method: "POST", url: `/api/runs/${runId}/stop` });
  }
  console.error(JSON.stringify({ error: report.error, errorType: error instanceof Error ? error.name : "unknown", reportPath }));
  process.exitCode = 1;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await app.close();
}
