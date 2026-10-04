// Continue an isolated evaluation after a Harness fix. Never edits the original report or fixes model output by hand.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Artifact, Asset, Run, TrainingSample } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";

const name = process.argv[2];
const sceneOnly = process.argv.includes("--scene-only");
if (!process.argv.includes("--live") || !/^media-review-live-[a-zA-Z0-9]+$/.test(name || ""))
  throw new Error("提供已结束的 media-review-live-目录名及 --live；只允许继续隔离评测库");
const dir = join(projectRoot, ".data/evaluations", name);
const previous = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as { type: string; model: string; assets: Asset[]; seededSample?: { id: string }; runs: { scenario: string; run: Run; artifacts: Artifact[] }[] };
if (previous.type !== "media-review-live") throw new Error("Not an isolated media-review evaluation");
const original = readConfig(), provider = original.providers.find((item) => item.model.name === previous.model && item.model.supportsImages);
if (!provider) throw new Error("Original configured provider is unavailable");
const store = new Store(dir);
if (store.work.list<Run>("run").some((run) => ["running", "waiting", "queued"].includes(run.status))) { store.close(); throw new Error("Original evaluation is still running"); }
const app = buildApp({ ...original, dataDir: dir, providers: [provider] }, { store });
const stamp = new Date().toISOString().replace(/[-:.]/g, ""), filename = "recheck-" + stamp + ".json";
const runs: { scenario: string; run: Run; artifacts: Artifact[] }[] = [], checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "media-review-recheck", at: new Date().toISOString(), model: previous.model, parent: "report.json", runs, checks,
  scope: sceneOnly ? "scene-followup" : "dataset-scene-correction", semanticReview: "pending independent assessment; crop/tool success alone is not visual quality", manualDataRepairs: 0 };
const save = () => writeFile(join(dir, filename), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const used = (run: Run, tool: string) => run.parts.some((part) => part.type === "tool" && part.name === tool && part.state === "complete");
let active: string | undefined;
async function task(scenario: string, text: string, assetIds: string[], conversationId = store.createConversation().id) {
  console.log(JSON.stringify({ phase: "start", scenario })); await save();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/runs`, payload: {
    text, assetIds, scope: "selected", modelId: provider!.model.id, permissionMode: "auto", useMemory: true, captureMemory: false, thinkingLevel: "low",
  } });
  if (response.statusCode !== 201) throw new Error("Could not start isolated recheck");
  active = response.json<{ run: Run }>().run.id;
  const until = Date.now() + 360000;
  for (;;) {
    const run = store.work.get<Run>("run", active)!;
    if (["completed", "failed", "stopped"].includes(run.status)) {
      const artifacts = store.work.list<Artifact>("artifact", conversationId).filter((artifact) => artifact.runId === run.id);
      runs.push({ scenario, run, artifacts }); active = undefined; await save();
      console.log(JSON.stringify({ phase: "settled", scenario, status: run.status, tools: run.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.name, state: part.state })) }));
      return { run, artifacts };
    }
    if (Date.now() > until || (run.status === "waiting" && run.question && run.waitingFor !== "jobs")) { await app.inject({ method: "POST", url: `/api/runs/${active}/stop` }); continue; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
try {
  const code: Record<string, string> = {};
  for (const file of ["application/evidence-tools.ts", "application/task-context.ts", "dataset-tools.ts", "memory/dataset-service.ts", "memory/dataset-time-review.ts", "memory/evidence-service.ts", "memory/query-service.ts", "memory/text-source.ts", "memory-tools.ts", "workspace-tools.ts", "harness/product-profile.ts"])
    code[file] = hash(await readFile(join(projectRoot, "apps/agent/src", file)));
  report.code = code;
  await app.ready();
  const originalBuild = previous.runs.find((item) => item.scenario === "04-generate-questions")!.run;
  const datasetId = originalBuild.jobs!.find((job) => job.kind === "memory-dataset")!.id;
  const ledger = new DatasetLedger(store); report.samplesBefore = ledger.samples(datasetId, "", 100);
  if (!sceneOnly) {
    const reviewed = await task("review-after-cursor-fix", `请完成数据集 ${datasetId} 的逐题核对、必要的修订或排除，再交付实际训练文件和独立评测题。核对动作方向、答案和明确的日期，沿用已经确认的纠正。`, originalBuild.assetIds);
    const delivery = reviewed.run.parts.filter((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete").at(-1);
    const delivered = delivery?.type === "tool" ? delivery.output as { datasetId: string; files: { kind: string; href: string; sha256: string }[] } : undefined;
    const samples: TrainingSample[] = ledger.samples(datasetId, "", 100); report.reviewedSamples = samples;
    checks.reviewAndDelivery = !!delivered && used(reviewed.run, "inspect_dataset") && used(reviewed.run, "review_dataset");
    checks.dateFaultRepaired = samples.some((sample) => sample.id === previous.seededSample?.id && sample.version > 1 && !sample.quality?.issues.some((issue) => issue.severity === "blocking"));
    checks.inspectionNoLongerFails = !reviewed.run.parts.some((part) => part.type === "tool" && part.name === "inspect_dataset" && part.state === "error");
    if (delivered) {
      report.delivery = delivered;
      const files: Record<string, { bytes: number; sha256: string; rows?: unknown[] }> = {};
      for (const file of delivered.files) {
        const response = await app.inject(file.href); if (response.statusCode !== 200) throw new Error("Export unavailable");
        files[file.kind] = { bytes: response.rawPayload.length, sha256: hash(response.rawPayload), ...(file.kind === "manifest" ? {} : { rows: response.body.trim() ? response.body.trim().split("\n").map((line) => JSON.parse(line)) : [] }) };
        await writeFile(join(dir, `recheck-${stamp}-${file.kind}.${file.kind === "manifest" ? "json" : "jsonl"}`), response.rawPayload, { mode: 0o600 });
      }
      report.files = files;
      checks.actualDownloads = !!files.training.rows?.length && !!files.evaluation.rows?.length && delivered.files.every((file) => files[file.kind].sha256 === file.sha256);
    }
  }
  const visual = previous.runs.find((item) => item.scenario === "01-new-media-review")!;
  const photo = previous.assets.find((asset) => asset.name === "室内照片.jpg")!;
  const scene = await task("scene-detail-review", "请复核上次整理结果中的室内照片。对拿不准的物体及背景使用原图局部读取，再判断已有描述是否有误；只保留能由像素支持的描述，无法可靠辨认的保留未知。修订并保存整理结果。", [photo.id], visual.run.conversationId);
  checks.sceneCropRead = scene.run.parts.some((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "complete" &&
    (part.output as { imageDelivered?: boolean; source?: { view?: { region?: unknown } } }).imageDelivered && !!(part.output as { source?: { view?: { region?: unknown } } }).source?.view?.region);
  checks.sceneCompleted = scene.run.status === "completed" && scene.artifacts.length > 0;
  checks.historicalArtifactRead = used(scene.run, "read_artifact") && scene.run.parts.some((part) =>
    part.type === "tool" && part.name === "read_artifact" && part.state === "complete" && typeof (part.output as { content?: unknown }).content === "string");
  checks.sourceVersionsAvailable = !scene.run.parts.some((part) => part.type === "tool" && part.name === "read_evidence" && part.state === "error");
  if (!sceneOnly) {
    const recall = await task("corrected-fact-after-restart", "之前已经纠正的蓝色相册编号是什么？只回答当前编号与依据，不复述旧编号。", originalBuild.assetIds);
    const text = recall.run.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    checks.currentCorrectionReused = text.includes("QB49") && !text.includes("QB47");
    checks.currentCorrectionSourced = used(recall.run, "search_memories") || recall.run.parts.some((part) =>
      part.type === "tool" && ["read_asset_text", "read_evidence"].includes(part.name) && part.state === "complete" &&
      JSON.stringify((part.output as { memoryContext?: unknown }).memoryContext || {}).includes("QB49"));
  }
  checks.noTraining = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
  report.completed = Object.values(checks).every(Boolean); if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.error = "复测未完成，保留现场"; report.errorType = error instanceof Error ? error.name : "unknown";
  if (active) { report.interruptedRun = store.work.get<Run>("run", active); await app.inject({ method: "POST", url: `/api/runs/${active}/stop` }); }
  process.exitCode = 1;
} finally { await save(); await app.close(); console.log(JSON.stringify({ reportPath: join(dir, filename), checks, completed: report.completed })); }
