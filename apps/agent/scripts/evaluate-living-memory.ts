// Real Pi/model calls on synthetic experiences and an existing licensed public photo.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, MemoryActivity, MemoryEntry, Run } from "@memory/contracts";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { buildApp } from "../src/app.js";
import { PiMemoryProcessors } from "../src/integrations/pi/processors.js";
import { ModelAccess } from "../src/integrations/pi/model-access.js";

if (!process.argv.includes("--live")) throw new Error("使用 --live 运行真实模型验证");
const original = readConfig();
const provider = original.providers.find((p) => p.model.id === process.env.MEMORY_EVAL_MODEL) ||
  original.providers.find((p) => p.model.name === "gpt-6-luna" && p.model.supportsImages) || original.providers.find((p) => p.model.supportsImages);
if (!provider) throw new Error("请配置支持照片输入的真实模型");
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, "living-memory-live-"));
const config = { ...original, dataDir: directory, providers: [provider], localProcessor: undefined };
let store = new Store(directory);
store.memories.ledger.setSettings({ intake: "manual", capture: "off", textModelId: provider.model.id, photoModelId: provider.model.id });
const processors = new PiMemoryProcessors(config, new ModelAccess(config));
let app = buildApp(config, { store, processors });
const checks: Record<string, boolean> = {}, runs: { scenario: string; run: Run }[] = [];
const report: Record<string, unknown> = { type: "living-memory-live", at: new Date().toISOString(), model: provider.model.name,
  scope: "独立临时数据库；虚构人物、经历及公开杯子照片。未读取个人资料，未训练模型。", checks, runs, completed: false, semanticReview: "pending" };
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const responseText = (run: Run) => run.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
const used = (run: Run, name: string) => run.parts.some((p) => p.type === "tool" && p.name === name && p.state === "complete");
async function asset(content: Buffer, name: string, kind: "text" | "image") {
  const value: Asset = { id: randomUUID(), name, kind, mimeType: kind === "text" ? "text/plain" : "image/jpeg", size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString(), memorySpace: "personal" };
  await writeFile(join(store.assetsDir, value.id), content, { mode: 0o600 }); store.addAsset(value, { processing: "requested" }); return value;
}
async function wait(runId: string) {
  const deadline = Date.now() + 360000;
  while (Date.now() < deadline) {
    const run = store.work.get<Run>("run", runId)!;
    if (["completed", "failed", "stopped"].includes(run.status) || (run.status === "waiting" && run.waitingFor !== "jobs")) return run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("评估任务超时");
}
async function task(scenario: string, text: string, assets: Asset[] = [], conversationId = store.createConversation().id) {
  console.log(JSON.stringify({ phase: "start", scenario })); await save();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/runs`, payload: { text, assetIds: assets.map((a) => a.id),
    scope: "library", modelId: provider!.model.id, thinkingLevel: "low", permissionMode: "auto", useMemory: true, captureMemory: false } });
  if (response.statusCode !== 201) throw new Error("评估任务未创建");
  const run = await wait(response.json<{ run: Run }>().run.id);
  runs.push({ scenario, run }); console.log(JSON.stringify({ phase: "settled", scenario, status: run.status, waitingFor: run.waitingFor,
    tools: run.parts.filter((p) => p.type === "tool").map((p) => ({ name: p.name, state: p.state })) })); await save(); return run;
}
const activities = async () => (await app.inject("/api/memory-activities?limit=50")).json<{ activities: MemoryActivity[] }>().activities;
async function dailyFlow(bytes: Buffer) {
  const photo = await asset(bytes, "咖啡照片.jpg", "image");
  const note = await asset(Buffer.from("沈青和顾宁一起喝咖啡，顾宁把银色保温杯放入灰色背包主袋。"), "随手记录.txt", "text");
  const organized = await task("daily-01-organize", "这些照片和随手记录来自上周日在青禾咖啡馆的同一次喝咖啡。请整理为活动，日期地点按我的说明，照片内容保持观察性质。", [photo, note]);
  let page = await activities();
  let activity = page.find((a) => [photo, note].every((asset) => a.sources.some((s) => s.type === "asset" && s.assetId === asset.id)));
  const reference = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: store.memories.ledger.settings().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(organized.createdAt)) + "T00:00:00Z");
  reference.setUTCDate(reference.getUTCDate() - (reference.getUTCDay() || 7));
  checks.contextOrganization = organized.status === "completed" && !!activity && activity.occurredAt === reference.toISOString().slice(0, 10) && activity.place === "青禾咖啡馆";
  report.organizedActivities = page;
  if (!activity) throw new Error("未形成对应活动");
  const activityId = activity.id;
  await task("daily-01-confirm", `我确认活动「${activity.title}」（${activityId}）当前展示的活动内容属实，请确认这个活动。`);
  activity = (await activities()).find((a) => a.id === activityId)!;
  const summary = activity.summary;
  checks.confirmed = activity.status === "confirmed";
  const supplement = await asset(Buffer.from("同一次喝咖啡的补充：顾宁把备用纸巾放在灰色背包侧袋，沈青带走了蓝色笔记本。"), "咖啡补充.txt", "text");
  const appended = await task("daily-02-append", `把这份新记录补进上次的咖啡活动（${activityId}），保留原活动内容。`, [supplement]);
  activity = (await activities()).find((a) => a.id === activityId)!;
  checks.appendSameActivity = appended.status === "completed" && activity.summary === summary && activity.status === "confirmed" && activity.sources.some((s) => s.type === "asset" && s.assetId === supplement.id);
  checks.noDuplicateActivities = (await activities()).filter((a) => a.sources.some((s) => s.type === "asset" && s.assetId === supplement.id)).length === 1;
  const recall = await task("daily-03-recall", "上次沈青和顾宁在哪里喝咖啡？补充记录里备用纸巾放在哪里？也把那次的照片找给我。");
  checks.recallSources = recall.status === "completed" && /青禾咖啡馆/.test(responseText(recall)) && /侧袋/.test(responseText(recall)) && recall.sources.some((s) => s.assetId === photo.id);
  const compacted = await app.inject({ method: "POST", url: `/api/conversations/${recall.conversationId}/compact`, payload: { instructions: "保留咖啡活动引用、用户目标和查询结果。" } });
  const session = (await app.inject(`/api/conversations/${recall.conversationId}/session`)).json();
  checks.piCompaction = compacted.statusCode === 200 && session.nodes.some((node: { kind?: string }) => node.kind === "compaction");
  const corrected = await task("daily-04-correct", "上次喝咖啡的地点写错了，改成杉溪咖啡馆。", [], recall.conversationId);
  activity = (await activities()).find((a) => a.id === activityId)!;
  checks.corrected = corrected.status === "completed" && activity.place === "杉溪咖啡馆" && activity.summary.includes("杉溪咖啡馆") && !activity.summary.includes("青禾咖啡馆") && !activity.title.includes("青禾咖啡馆");
  const updated = await task("daily-04-recall-again", "沈青和顾宁上次在哪里喝咖啡？请按当前记忆回答。");
  checks.correctedRecall = updated.status === "completed" && /杉溪咖啡馆/.test(responseText(updated)) && !/青禾咖啡馆/.test(responseText(updated));
  checks.observationsUnconfirmed = store.memories.list<MemoryEntry>("memory").filter((m) => !m.derivedFrom).every((m) => m.status === "draft");
  report.finalActivities = await activities();
}
try {
  await app.ready();
  const manifest = JSON.parse(await readFile(join(projectRoot, "examples/photos/manifest.json"), "utf8"));
  const photoSource = manifest.photos.find((p: { id: string }) => p.id === "coffee");
  const bytes = await readFile(join(projectRoot, ".data/photo-fixtures", photoSource.file));
  if (createHash("sha256").update(bytes).digest("hex") !== photoSource.sha256) throw new Error("公开照片校验失败");
  report.photo = photoSource;
  if (process.argv.includes("--daily")) await dailyFlow(bytes);
  else {
  const photo = await asset(bytes, "资料照片.jpg", "image");
  const first = await asset(Buffer.from("2026年9月20日，沈青和顾宁在青禾公园野餐。沈青带了蓝色野餐垫，顾宁带了三明治。两人把空餐盒收进灰色背包，备用纸巾放在背包侧袋。"), "野餐记录.txt", "text");
  const meal = await asset(Buffer.from("2026年9月21日中午，沈青和顾宁在禾里小馆吃午饭，点了菌菇面。"), "午饭记录.txt", "text");
  const organized = await task("01-photos-and-text", "请把这批照片和文字整理成具体的生活活动，使用活动整理能力，检查真实处理结果并列出需要核对的疑点。不要确认事实。照片没有日期或人物信息，不能假定它对应文字中的经历。", [first, meal, photo]);
  let page = await activities();
  checks.organized = organized.status === "completed" && used(organized, "organize_memories") && page.length >= 3;
  checks.datesSeparated = page.some((a) => a.occurredAt === "2026-09-20") && page.some((a) => a.occurredAt === "2026-09-21");
  const photoActivities = page.filter((a) => a.sources.some((s) => s.type === "asset" && s.assetId === photo.id));
  checks.photoRemainsUnknown = photoActivities.length > 0 && photoActivities.every((a) => !a.occurredAt && a.status === "candidate" &&
    a.sources.every((s) => s.type === "asset" && s.assetId === photo.id));
  checks.observationsUnconfirmed = store.memories.list<MemoryEntry>("memory").every((m) => m.status === "draft");
  report.firstActivities = page;

  const second = await asset(Buffer.from("补充2026年9月20日在青禾公园的同一次野餐：收拾餐具后，顾宁把银色保温杯放入灰色背包主袋。沈青负责收起蓝色野餐垫。"), "野餐补充.txt", "text");
  const continued = await task("02-incremental", "继续整理这份新记录，查找与前一批活动的关联；同一次野餐可归为一组，保留具体来源和疑点，仍不确认事实。", [second]);
  page = await activities();
  const picnic = page.find((a) => a.sources.some((s) => s.type === "asset" && s.assetId === first.id) && a.sources.some((s) => s.type === "asset" && s.assetId === second.id));
  checks.crossBatch = continued.status === "completed" && !!picnic;
  checks.noDuplicateActivities = !page.some((activity, index) => page.some((other, otherIndex) => index !== otherIndex &&
    activity.members.every((member) => other.members.some((value) => value.id === member.id && value.version === member.version))));
  report.incrementalActivities = page;
  const recall = await task("03-new-conversation", "请依据已整理资料回答：9月20日野餐结束后，谁把什么颜色的保温杯放进了哪里？请给出来源，注明尚未确认的部分。");
  checks.crossConversation = recall.status === "completed" && /顾宁/.test(responseText(recall)) && /银色/.test(responseText(recall)) && /主袋/.test(responseText(recall)) && recall.sources.length > 0;
  if (picnic) {
    const confirmed = await task("04-confirm-activity", `我确认活动「${picnic.title}」（${picnic.id}）当前展示的活动内容属实，请确认这一个活动。仅确认活动内容，不确认每条照片或文字观察。`);
    page = await activities();
    const current = page.find((a) => a.id === picnic.id);
    checks.confirmation = confirmed.status === "completed" && used(confirmed, "change_memory_activities") && current?.status === "confirmed";
    checks.confirmationScope = store.memories.list<MemoryEntry>("memory").filter((m) => !m.derivedFrom).every((m) => m.status === "draft");

    const question = await task("05-wait-before-correction", `活动「${picnic.title}」（${picnic.id}）地点写错了。请先用 ask_user 询问我正确地点，收到我的回答后，更正这个活动并报告实际保存结果。`);
    checks.waiting = question.status === "waiting" && question.waitingFor === "user" && used(question, "ask_user");
    if (checks.waiting) {
      await app.close();
      store = new Store(directory); app = buildApp(config, { store, processors }); await app.ready();
      const afterRestart = store.work.get<Run>("run", question.id)!;
      checks.waitSurvivesRestart = afterRestart.waitingFor === "user" && afterRestart.question?.text === question.question?.text;
      const answer = await app.inject({ method: "POST", url: `/api/runs/${question.id}/answer`, payload: { answer: "杉溪公园" } });
      const resumed = await wait(question.id); runs.push({ scenario: "06-resumed-correction", run: resumed });
      checks.resumedCorrection = answer.statusCode === 200 && resumed.status === "completed" && used(resumed, "change_memory_activities");
      checks.noRepeatedQuestion = resumed.parts.filter((p) => p.type === "tool" && p.name === "ask_user").length === 1;
      page = await activities(); checks.corrected = page.find((a) => a.id === picnic.id)?.place === "杉溪公园";
      report.correctedActivity = page.find((a) => a.id === picnic.id);
      console.log(JSON.stringify({ phase: "resumed", status: resumed.status, corrected: checks.corrected })); await save();
    }
    const updated = await task("07-corrected-recall", "按已经确认、更正后的个人记忆，9月20日沈青和顾宁在哪里野餐？旧资料有冲突时以我的更正为准。");
    checks.correctedRecall = updated.status === "completed" && /杉溪公园/.test(responseText(updated));
  }
  const unknown = await task("08-unknown", "现有资料能确定9月20日野餐时沈青的车停在哪个车位吗？不知道就说明没有依据，不用询问我。");
  checks.unknown = unknown.status === "completed" && /无法|不能|没有|未提|不清楚|未记录|不确定/.test(responseText(unknown));
  if (checks.confirmation && checks.corrected) {
    const delivered = await task("09-training-files", `请把已由我确认并更正的野餐活动（${picnic!.id}）准备成训练数据，核验样本与文件，实际交付可下载的训练文件。仅使用这个已确认活动，不确认其他观察，不启动训练。`);
    const tool = delivered.parts.find((p) => p.type === "tool" && p.name === "deliver_dataset" && p.state === "complete");
    const delivery = tool?.type === "tool" ? tool.output as { verified: boolean; files: { href: string; kind: string; sha256: string; records?: number }[] } : undefined;
    checks.trainingFileDelivery = delivered.status === "completed" && !!delivery?.verified && delivery.files.some((file) => file.kind === "training" && (file.records || 0) > 0);
    if (delivery?.files.length) {
      const files = await Promise.all(delivery.files.map(async (file) => {
        const response = await app.inject(file.href);
        return { kind: file.kind, status: response.statusCode, hashMatches: createHash("sha256").update(response.rawPayload).digest("hex") === file.sha256 };
      }));
      report.deliveredFiles = files;
      checks.downloadHashes = files.every((file) => file.status === 200 && file.hashMatches);
    }
  }
  report.finalActivities = await activities();
  }
  report.completed = true;
} catch { report.failure = "真实验证未完成，请查看已保存的阶段与工具状态"; }
finally { await save(); await app.close(); }
console.log(JSON.stringify({ report: join(directory, "report.json"), model: provider.model.name, checks, completed: report.completed }));
if (!report.completed || Object.values(checks).some((value) => !value)) process.exitCode = 1;
