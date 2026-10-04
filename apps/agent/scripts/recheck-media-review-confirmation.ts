// Resume the original explicit batch instruction in an isolated, completed evaluation only.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryEntry, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";

const name = process.argv[2];
if (!process.argv.includes("--live") || !/^media-review-live-[a-zA-Z0-9]+$/.test(name || "")) throw new Error("只允许以 --live 继续已结束的隔离媒体评测");
const dir = join(projectRoot, ".data/evaluations", name), original = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
const prior = original.runs.find((item: { scenario: string }) => item.scenario === "03-confirm-and-correct")?.run as Run | undefined;
if (original.type !== "media-review-live" || !prior) throw new Error("缺少原始确认任务");
const config = readConfig(), provider = config.providers.find((item) => item.model.name === original.model);
if (!provider) throw new Error("原评测模型未配置");
const store = new Store(dir);
if (store.work.list<Run>("run").some((run) => ["queued", "running", "waiting"].includes(run.status))) { store.close(); throw new Error("评测仍在运行"); }
const app = buildApp({ ...config, dataDir: dir, providers: [provider] }, { store });
const entries = () => store.memories.list<MemoryEntry>("memory").filter((memory) => memory.sources.some((source) => prior.assetIds.includes(source.assetId)));
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { type: "media-review-confirmation-recheck", parent: "report.json", at: new Date().toISOString(),
  before: entries().map(({ id, version, status, content }) => ({ id, version, status, content })), checks, manualDataRepairs: 0, completed: false };
const filename = "confirmation-recheck-" + new Date().toISOString().replace(/[-:.]/g, "") + ".json";
let runId: string | undefined;
try {
  const code: Record<string, string> = {};
  for (const file of ["application/task-context.ts", "application/memory-command-context.ts", "integrations/pi/runtime.ts", "memory/captures.ts", "memory/commands.ts", "memory/records.ts"])
    code[file] = createHash("sha256").update(await readFile(join(projectRoot, "apps/agent/src", file))).digest("hex");
  report.code = code; await app.ready();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${prior.conversationId}/runs`, payload: {
    text: prior.text, assetIds: prior.assetIds, scope: "selected", modelId: provider.model.id, permissionMode: "auto", useMemory: true, captureMemory: false, thinkingLevel: "low",
  } });
  if (response.statusCode !== 201) throw new Error("无法开始隔离复验");
  runId = response.json<{ run: Run }>().run.id;
  const end = Date.now() + 360000;
  for (;;) {
    const run = store.work.get<Run>("run", runId)!;
    if (["completed", "failed", "stopped"].includes(run.status)) {
      report.run = run;
      const after = entries(); report.after = after.map(({ id, version, status, content }) => ({ id, version, status, content }));
      report.receipts = store.memoryCommands.receipts(run.id);
      checks.taskCompleted = run.status === "completed";
      checks.selectedCandidatesConfirmed = after.length > 0 && after.every((memory) => memory.status === "confirmed");
      checks.correctedNumberPreserved = after.some((memory) => memory.content.includes("QB49")) && !after.some((memory) => memory.content.includes("QB47"));
      checks.actualUserCommand = store.memoryCommands.receipts(run.id).some((receipt) => receipt.action === "confirm" && receipt.actor === "user" && receipt.instruction?.quote && prior.text.includes(receipt.instruction.quote));
      checks.noTraining = Number(store.db.prepare("SELECT count(*) AS n FROM memory_model_versions").get()!.n) === 0;
      report.completed = Object.values(checks).every(Boolean); break;
    }
    if (Date.now() > end || (run.status === "waiting" && run.question && run.waitingFor !== "jobs")) { await app.inject({ method: "POST", url: `/api/runs/${runId}/stop` }); continue; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
} catch {
  report.error = "复验未完成，保留实际记录";
  if (runId) { report.run = store.work.get<Run>("run", runId); await app.inject({ method: "POST", url: `/api/runs/${runId}/stop` }); }
} finally {
  await app.close(); await writeFile(join(dir, filename), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: join(dir, filename), completed: report.completed, checks }));
}
if (!report.completed) process.exitCode = 1;
