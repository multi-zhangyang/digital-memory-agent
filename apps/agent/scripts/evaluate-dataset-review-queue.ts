import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChatPart, DatasetAuditDecision, DatasetSampleSelection, Run } from "@memory/contracts";
import { readConfig, projectRoot } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { DatasetLedger } from "../src/memory/dataset-ledger.js";
import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { contentHash } from "../src/memory/values.js";

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (!process.argv.includes("--live") || !argument("--source-report")) throw new Error("使用 --live --source-report 指定已完成的隔离样本核验报告");
const sourceReport = resolve(argument("--source-report")!), source = JSON.parse(await readFile(sourceReport, "utf8"));
const questions = JSON.parse(await readFile(source.sourceReport, "utf8"));
if (source.type !== "dataset-audit-live" || !source.completed || !Object.values(source.checks || {}).every(Boolean) || questions.cases?.length !== 6 ||
  questions.manifestHash !== contentHash(await readFile(join(projectRoot, "examples/quality/dataset-questions.json"))))
  throw new Error("来源须为完整的六条虚构材料核验报告，不得使用个人资料库");
const original = readConfig(), provider = original.providers.find((item) => item.model.name === (argument("--model") || "gpt-6-luna"));
if (!provider) throw new Error("请先配置所选模型");
const directory = await mkdtemp(join(projectRoot, ".data/evaluations/dataset-review-queue-live-")), dataDir = join(directory, "store");
await backupMemory(dirname(sourceReport) + "-restored", directory + "-source-archive");
await restoreMemory(directory + "-source-archive", dataDir);
const config = { ...original, dataDir, providers: [provider], localProcessor: undefined };
let store = new Store(dataDir), ledger = new DatasetLedger(store), app = buildApp(config, { store });
store.memories.ledger.setSettings({ intake: "manual", capture: "off", indexAssets: false });
const datasetId: string = source.datasetId, before = ledger.samples(datasetId, "", 100), memories = store.memories.list("memory");
const generationCalls = ledger.get(datasetId).usage?.calls;
const history = () => Object.fromEntries(["dataset_audits", "dataset_audit_inputs", "dataset_audit_views"]
  .map((table) => [table, contentHash(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
const originalHistory = history();
const failed = store.db.prepare("SELECT jobId,ordinal,result FROM dataset_audit_inputs WHERE status='failed' ORDER BY ordinal").all() as { jobId: string; ordinal: number; result: string }[];
const selected = failed.flatMap((row) => (JSON.parse(row.result).decisions as DatasetAuditDecision[]).map((decision) => decision.id));
if (failed.length !== 1 || selected.length !== 3) throw new Error("此验证需要真实核验失败的单个来源及三条题目");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "dataset-review-queue-live", at: new Date().toISOString(), sourceReport, model: provider.model.name,
  datasetId, selected, before, checks, completed: false, trainingStarted: false };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let activeId: string | undefined;
try {
  await app.ready(); await save(); console.log(JSON.stringify({ phase: "agent-review-queue", directory }));
  const started = await app.inject({ method: "POST", url: `/api/conversations/${source.run.conversationId}/runs`, payload: {
    text: `此处仅为六条虚构材料的隔离验证，不是我的真实经历。针对已完成数据集 ${datasetId}，读取原核验作业 ${failed[0].jobId} 的真实结果，定位原失败来源的三条题（不要重跑核验、不要重新生成）。我明确要求这条日期未知的周末买书来源的训练题与配对评测题暂时保留待核对，现有问题和答案全部保持原样，逐题说明各自的待核对依据，原失败记录保留。先从作业真实题目 ID 用 inspect_dataset 的 sampleIds 实际读取三条目标、关联训练题和冻结正文，不能翻阅其余已核对题。使用 review_dataset 的 defer，将这三条题移出训练与评测文件；其他十五条题的版本和内容全部保留。完成后用 view=review 检查实际待核对数量，再用 deliver_dataset 核验并交付剩余可用的训练、评测、待审和版本清单文件，清楚报告待核对数量与限制，不启动训练、不修改个人事实。`,
    modelId: provider.model.id, thinkingLevel: "low", assetIds: [], scope: "library", permissionMode: "auto", useMemory: true, captureMemory: false,
  } });
  if (started.statusCode !== 201) throw new Error("隔离任务创建失败");
  activeId = started.json<{ run: Run }>().run.id;
  if (process.argv.includes("--linked-failed-audit")) {
    // Reproduce a run that already submitted this failed job, retaining the real copied job and results.
    store.db.prepare("INSERT INTO run_jobs(runId,kind,jobId,toolCallId,ownership) VALUES(?,'dataset-audit',?,'existing-failed-audit','library')").run(activeId, failed[0].jobId);
    report.sameTaskFailedAuditLinked = true;
  }
  const deadline = Date.now() + 240000;
  let run = store.work.get<Run>("run", activeId)!;
  while (!["completed", "failed", "stopped"].includes(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300)); run = store.work.get<Run>("run", activeId)!;
  }
  if (!["completed", "failed", "stopped"].includes(run.status)) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` });
  run = store.work.get<Run>("run", activeId)!; report.run = run; activeId = undefined;
  const tools = run.parts.filter((part): part is Extract<ChatPart, { type: "tool" }> => part.type === "tool" && part.state === "complete");
  const samples = ledger.samples(datasetId, "", 100); report.samples = samples;
  checks.realAgentDefer = run.status === "completed" && tools.some((part) => part.name === "read_job_result") && tools.some((part) => part.name === "review_dataset");
  if (process.argv.includes("--single-delivery")) {
    checks.noDuplicateCompletion = tools.filter((part) => part.name === "deliver_dataset").length === 1;
    checks.currentDeliveryAcknowledged = !store.db.prepare(`SELECT 1 FROM run_jobs j JOIN memory_datasets d ON d.id=j.jobId
      WHERE j.runId=? AND j.kind='memory-dataset' AND j.handledRevision<d.revision`).get(run.id);
  }
  const inspections = tools.filter((part) => part.name === "inspect_dataset").map((part) => ({ input: part.input as DatasetSampleSelection & { datasetId?: string },
    samples: (part.output as { samples: { id: string }[] }).samples })).filter((part) => part.input.datasetId === datasetId);
  checks.onlyTargetsInspected = inspections.length >= 2 && inspections.every((part) =>
    (part.input.view === "review" || JSON.stringify([...(part.input.sampleIds || [])].sort()) === JSON.stringify([...selected].sort())) &&
    part.samples.every((sample) => selected.includes(sample.id)));
  checks.otherSamplesUnchanged = before.filter((sample) => !selected.includes(sample.id)).every((sample) =>
    JSON.stringify(samples.find((current) => current.id === sample.id)) === JSON.stringify(sample));
  checks.pendingWithIndividualReasons = selected.every((id) => {
    const current = samples.find((sample) => sample.id === id)!, previous = before.find((sample) => sample.id === id)!;
    return current.status === "review" && current.version === previous.version + 1 && current.question === previous.question && current.answer === previous.answer &&
      current.review?.actor === "agent" && current.review.runId === run.id && !!current.review.reason.trim();
  }) && new Set(selected.map((id) => samples.find((sample) => sample.id === id)!.review!.reason)).size === 3;
  checks.originalAuditUnchanged = JSON.stringify(history()) === JSON.stringify(originalHistory);
  if (process.argv.includes("--linked-failed-audit")) checks.partialDeliveryWithFailedJob = run.status === "completed" && run.jobs?.some((job) => job.kind === "dataset-audit" && job.status === "failed") === true;
  checks.factsAndGenerationUnchanged = JSON.stringify(store.memories.list("memory")) === JSON.stringify(memories) && ledger.list().length === 1 && ledger.get(datasetId).usage?.calls === generationCalls;
  checks.noWeights = !store.db.prepare("SELECT 1 FROM memory_model_versions").get();
  const part = tools.filter((part) => part.name === "deliver_dataset").at(-1);
  const delivery = part?.output as { datasetId: string; partial: boolean; files: { kind: string; href: string; records?: number; sha256: string }[] } | undefined;
  if (!delivery || delivery.datasetId !== datasetId) throw new Error("真实 Agent 未交付实际文件");
  report.delivery = delivery;
  checks.exactPartialDelivery = delivery.partial && delivery.files.find((file) => file.kind === "training")?.records === 10 &&
    delivery.files.find((file) => file.kind === "evaluation")?.records === 5 && delivery.files.find((file) => file.kind === "review")?.records === 3;
  const files: Record<string, string> = {};
  for (const file of delivery.files) {
    const response = await app.inject(file.href); if (response.statusCode !== 200) throw new Error("交付文件不可下载");
    files[file.kind] = contentHash(response.rawPayload);
    await writeFile(join(directory, file.kind + (file.kind === "manifest" ? ".json" : ".jsonl")), response.rawPayload, { mode: 0o600 });
  }
  checks.actualFileHashesMatch = delivery.files.every((file) => files[file.kind] === file.sha256);
  report.files = files;
  const query = new URLSearchParams({ view: "review" }); for (const id of selected) query.append("sampleIds", id);
  const pending = (await app.inject(`/api/memory-datasets/${datasetId}/samples?${query}`)).json();
  checks.apiScopeMatches = pending.matchingSamples === 3 && pending.samples.length === 3 && pending.samples.every((sample: { id: string }) => selected.includes(sample.id));
  const failedOffset = Number(store.db.prepare("SELECT count(*) AS n FROM dataset_audit_inputs i,json_each(i.result,'$.decisions') j WHERE i.jobId=? AND i.ordinal<?").get(failed[0].jobId, failed[0].ordinal)!.n);
  const decisions = (await app.inject(`/api/dataset-audits/${failed[0].jobId}?after=${failedOffset}`)).json().decisions as DatasetAuditDecision[];
  report.decisions = decisions;
  checks.followUpPreservesFailure = selected.every((id) => decisions.some((decision) => decision.id === id && decision.status === "failed" && decision.followUp?.status === "review" && decision.followUp.actor === "agent"));
  const reviewHistory = contentHash(JSON.stringify(store.db.prepare("SELECT * FROM dataset_review_commands ORDER BY rowid").all()));
  await app.close(); await backupMemory(dataDir, directory + "-archive"); await restoreMemory(directory + "-archive", directory + "-restored");
  store = new Store(directory + "-restored"); ledger = new DatasetLedger(store);
  app = buildApp({ ...config, dataDir: directory + "-restored", providers: [] }, { store }); await app.ready();
  checks.restoredSamplesAndHistory = JSON.stringify(ledger.samples(datasetId, "", 100)) === JSON.stringify(samples) && JSON.stringify(history()) === JSON.stringify(originalHistory) &&
    contentHash(JSON.stringify(store.db.prepare("SELECT * FROM dataset_review_commands ORDER BY rowid").all())) === reviewHistory;
  checks.restoredFilesIdentical = true;
  for (const file of delivery.files) checks.restoredFilesIdentical &&= contentHash((await app.inject(file.href)).rawPayload) === files[file.kind];
  report.completed = Object.values(checks).every(Boolean); await save(); console.log(JSON.stringify({ report: join(directory, "report.json"), checks }));
  if (!report.completed) process.exitCode = 1;
} catch (failure) { report.error = failure instanceof Error ? failure.message : "剩余题处理验证未完成"; await save(); throw failure; }
finally { if (activeId) await app.inject({ method: "POST", url: `/api/runs/${activeId}/stop` }); await app.close(); }
