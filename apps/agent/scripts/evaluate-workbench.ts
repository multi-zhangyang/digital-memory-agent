// Opt-in live acceptance on generated project files and public Pi documentation.
// Provider/Exa secrets remain server-side; reports and task state are Git-ignored.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, Run, SessionState, WorkspaceDetail } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 运行真实模型与 Exa 验证");
const original = readConfig();
const provider = original.providers.find((p) => p.model.id === process.env.MEMORY_EVAL_MODEL) ||
  original.providers.find((p) => p.model.name === "gpt-6-luna") || original.providers[0];
if (!provider) throw new Error("请先配置真实模型");
const searchKey = (JSON.parse(await readFile(join(original.dataDir, "harness.json"), "utf8")) as { searchKey?: string }).searchKey;
if (!searchKey) throw new Error("请先配置 Exa");
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "workbench-live-"));
const config = { ...original, dataDir: directory, providers: [provider], localProcessor: undefined };
let store = new Store(directory);
store.memories.ledger.setSettings({ intake: "manual", capture: "off" });
store.harness.settings = { ...store.harness.settings, searchEnabled: true, searchKey };
let app = buildApp(config, { store });
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { at: new Date().toISOString(), model: provider.model.name, checks,
  scope: "生成的 CSV、独立数据库、真实 Pi/模型/Exa；未读取个人资料，未训练模型。", completed: false };
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
try {
  await app.ready();
  const csv = "item,amount\ncoffee,10.5\nbread,4.5\nbus,5\n";
  await writeFile(join(store.harness.root(), "expenses.csv"), csv, { mode: 0o600 });
  const conversation = store.createConversation();
  const accepted = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/runs`, payload: {
    text: "读取项目 expenses.csv，运行 Python 按 amount 列求总额，把结果保存为 result.json。使用 Exa 网络搜索查找 Pi 官方文档关于会话树、steer 与 followUp 的说明，在 report.md 及工作台整理结果中简要记录计算结果、这些能力和真实来源链接。不要把文档说明当作已验证的运行结果。只使用本项目文件与相关公开文档，不读个人资料，不训练模型。",
    modelId: provider.model.id, scope: "library", assetIds: [], permissionMode: "auto", thinkingLevel: "low", useMemory: false, captureMemory: false,
  } });
  report.acceptance = { status: accepted.statusCode, errorCode: accepted.json().error?.code };
  if (accepted.statusCode !== 201) throw new Error("未接受验证任务");
  const id = accepted.json<{ run: Run }>().run.id;
  report.runId = id;
  let steered = false;
  const deadline = Date.now() + 300000;
  let run = store.work.get<Run>("run", id)!;
  while (Date.now() < deadline) {
    run = store.work.get<Run>("run", id)!;
    if (["completed", "failed", "stopped"].includes(run.status) || (run.status === "waiting" && run.waitingFor !== "jobs")) break;
    if (!steered && run.status === "running" && run.parts.some((part) => part.type === "tool")) {
      steered = true;
      const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/steer`, payload: {
        text: "补充：result.json 同时记录 count 和 total 字段，报告用中文，保留原始 expenses.csv。", mode: "steer",
      } });
      checks.steeringAccepted = response.statusCode === 200;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  report.run = run;
  checks.completed = run.status === "completed";
  for (const name of ["read", "bash", "web_search", "write_artifact"]) checks[name] = run.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete");
  checks.steeringDelivered = !!run.interventions?.some((item) => item.status === "delivered") && run.parts.some((part) => part.type === "message" && part.role === "user" && !part.initial);
  const result = JSON.parse(await readFile(join(store.harness.root(), "result.json"), "utf8"));
  checks.computed = result.total === 20 && result.count === 3;
  checks.originalUnchanged = hash(await readFile(join(store.harness.root(), "expenses.csv"))) === hash(csv);
  const document = await readFile(join(store.harness.root(), "report.md"), "utf8");
  const searches = run.parts.flatMap((part) => part.type === "tool" && part.name === "web_search" && part.state === "complete"
    ? ((part.output as { results?: { url: string }[] }).results || []).map((item) => item.url) : []);
  const artifacts = store.work.list<Artifact>("artifact", conversation.id);
  checks.publicCitations = searches.length > 0 && searches.some((url) => document.includes(url)) && artifacts.some((artifact) => searches.some((url) => artifact.content.includes(url)));
  const state = (await app.inject(`/api/conversations/${conversation.id}/session`)).json<SessionState>();
  const messages = run.parts.filter((part) => part.type === "message");
  checks.nativeEntries = messages.length > 1 && messages.every((part) => !!part.entryId && state.nodes.some((node) => node.id === part.entryId));
  const replay = await app.inject(`/api/runs/${id}/events?after=0`);
  checks.durableReplay = replay.statusCode === 200 && replay.body.includes('"type":"message-end"') && replay.body.includes("event: settled");
  await save();
  await app.close();
  store = new Store(directory); app = buildApp(config, { store }); await app.ready();
  const restored = (await app.inject(`/api/conversations/${conversation.id}/timeline`)).json<WorkspaceDetail>();
  checks.restart = JSON.stringify(restored.runs.find((item) => item.id === id)?.parts) === JSON.stringify(run.parts) &&
    restored.artifacts.some((artifact) => artifacts.some((before) => before.id === artifact.id && before.content === artifact.content));
  report.completed = true;
} catch { report.failure = "真实验证未完成；请检查私有报告中的任务状态与工具结果"; }
finally { await save(); await app.close(); }
console.log(JSON.stringify({ report: join(directory, "report.json"), model: provider.model.name, completed: report.completed, checks }));
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
