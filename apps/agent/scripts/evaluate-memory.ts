// Opt-in evaluation. All records are fictional and live in a fresh ignored directory.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { projectRoot, readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { MemoryCaptureJob, MemoryEntry, Run } from "@memory/contracts";

const live = process.argv.includes("--live");
const reportRoot = join(projectRoot, ".data", "evaluations");
await mkdir(reportRoot, { recursive: true, mode: 0o700 });
const dataDir = await mkdtemp(
  join(reportRoot, live ? "continuous-live-" : "continuous-local-"),
);
const store = new Store(dataDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll<T>(
  read: () => Promise<T>,
  condition: (value: T) => boolean,
) {
  for (let i = 0; i < 900; i++) {
    const value = await read();
    if (condition(value)) return value;
    await sleep(200);
  }
  throw new Error("Evaluation timed out");
}
const report: Record<string, unknown> = {
  mode: live ? "real-model" : "local-retrieval",
  fictional: true,
  completed: false,
  scoringVersion: 2,
  createdAt: new Date().toISOString(),
};
const reportPath = join(dataDir, "report.json");
const saveReport = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });

if (!live) {
  const cases: { query: string; id: string }[] = [];
  store.work.transaction(() => {
    for (const [person, place, event, query] of [
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
      const memory = store.work.createMemory({
        title: `${place}${event}`,
        content: `2025-03-14，我和${person}在${place}${event}。`,
        category: "event",
        people: [person],
        place,
        occurredAt: "2025-03-14",
        sources: [],
        status: "confirmed",
        kind: "statement",
        conversationId: "",
        runId: "",
      });
      cases.push({ query, id: memory.id });
    }
    for (let i = 10; i < 10000; i++)
      store.work.createMemory({
        title: "日常园艺" + i,
        content: `2026-06-01，我完成园艺记录编号${i}，给盆栽浇水。`,
        category: "event",
        occurredAt: "2026-06-01",
        status: "confirmed",
        kind: "statement",
        sources: [],
        conversationId: "",
        runId: "",
      });
  });
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const timings: number[] = [];
  const baselineTimings: number[] = [];
  let hits = 0,
    baselineHits = 0;
  for (let repeat = 0; repeat < 5; repeat++)
    for (const test of cases) {
      const start = performance.now();
      const memories = store.work.searchMemories(test.query, 10);
      timings.push(performance.now() - start);
      if (memories.some((memory) => memory.id === test.id)) hits++;
      const words = [...segmenter.segment(test.query)]
        .filter((part) => part.isWordLike && part.segment.length > 1)
        .map((part) => part.segment);
      const field =
        "lower(json_extract(data,'$.title') || ' ' || json_extract(data,'$.content') || ' ' || coalesce(json_extract(data,'$.people'),'') || ' ' || coalesce(json_extract(data,'$.place'),''))";
      const score = words.length
        ? words.map(() => `(instr(${field},?)>0)`).join("+")
        : "0";
      const before = performance.now();
      const baseline = store.db
        .prepare(
          `SELECT id,(${score}) score FROM workspace_records WHERE kind='memory' AND json_extract(data,'$.status')='confirmed' AND score>0 ORDER BY score DESC,json_extract(data,'$.updatedAt') DESC,rowid DESC LIMIT 10`,
        )
        .all(...words) as { id: string }[];
      baselineTimings.push(performance.now() - before);
      if (baseline.some((memory) => memory.id === test.id)) baselineHits++;
    }
  const percentile = (values: number[], p: number) =>
    Math.round(
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] * 100,
    ) / 100;
  Object.assign(report, {
    records: 10000,
    questions: cases.length,
    repetitions: 5,
    recallAt10: hits / 50,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    baseline: {
      recallAt10: baselineHits / 50,
      p50Ms: percentile(baselineTimings, 0.5),
      p95Ms: percentile(baselineTimings, 0.95),
    },
  });
  store.close();
} else {
  const original = readConfig();
  const provider =
    original.providers.find((value) => value.model.name === "gpt-6-luna") ||
    original.providers[0];
  if (!provider) {
    store.close();
    throw new Error(
      "Configure an agent model before running the opt-in live evaluation",
    );
  }
  const config = { ...original, dataDir };
  const app = buildApp(config, { store });
  await app.ready();
  const request = async <T>(
    path: string,
    body?: object,
    method: "GET" | "POST" | "PATCH" = body ? "POST" : "GET",
  ) => {
    const response = await app.inject({
      method,
      url: "/api" + path,
      ...(body ? { payload: body } : {}),
    });
    if (response.statusCode >= 300)
      throw new Error(
        `Evaluation request failed: ${response.statusCode} ${path}`,
      );
    return response.json<T>();
  };
  const cases = [
    {
      text: "我叫林舟，是一名工业设计师。",
      positive: true,
      terms: ["林舟", "设计"],
    },
    { text: "我现在住在杭州。", positive: true, terms: ["杭州"] },
    {
      text: "我平时喜欢喝不加糖的美式咖啡。",
      positive: true,
      terms: ["咖啡", "不加糖"],
    },
    {
      text: "2025年3月14日，我和陈默在杭州运河边散步。",
      positive: true,
      terms: ["陈默", "散步"],
    },
    {
      text: "2025年4月9日，我与许宁在南京美术馆看展。",
      positive: true,
      terms: ["许宁", "看展"],
    },
    {
      text: "2026年6月2日起，我搬到苏州生活。",
      positive: true,
      terms: ["苏州"],
    },
    { text: "他说：“我在北京当医生。”", positive: false, terms: [] },
    { text: "写个小说角色：我叫江城，住在月球。", positive: false, terms: [] },
    { text: "如果我明年去巴黎，就会尝试学法语。", positive: false, terms: [] },
    {
      text: "我可能在去年暑假遇到过陈默，但不确定。",
      positive: false,
      terms: [],
    },
    { text: "陈默就是我之前提到的阿默。", positive: false, terms: [] },
    { text: "我住在杭州。", positive: true, terms: ["杭州"] },
  ];
  type ExpectedFact = {
    terms: string[];
    attribute?: MemoryEntry["attribute"];
    occurredAt?: string;
  };
  const expectedFacts: ExpectedFact[][] = [
    [
      { terms: ["林舟"], attribute: { key: "name", value: "林舟" } },
      {
        terms: ["工业设计师"],
        attribute: { key: "occupation", value: "工业设计师" },
      },
    ],
    [{ terms: ["杭州"], attribute: { key: "home_city", value: "杭州" } }],
    [{ terms: ["咖啡", "不加糖"] }],
    [{ terms: ["陈默", "散步"], occurredAt: "2025-03-14" }],
    [{ terms: ["许宁", "南京美术馆", "看展"], occurredAt: "2025-04-09" }],
    [{ terms: ["苏州"], attribute: { key: "home_city", value: "苏州" } }],
    [],
    [],
    [],
    [],
    [],
    [{ terms: ["杭州"], attribute: { key: "home_city", value: "杭州" } }],
  ];
  const matchesFact = (memory: MemoryEntry, fact: ExpectedFact) =>
    fact.terms.every((term) => memory.content.includes(term)) &&
    (!fact.attribute ||
      (memory.attribute?.key === fact.attribute.key &&
        memory.attribute.value === fact.attribute.value)) &&
    (!fact.occurredAt || memory.occurredAt === fact.occurredAt);
  const captures: Record<string, unknown>[] = [];
  const answers: Record<string, unknown>[] = [];
  Object.assign(report, {
    model: provider.model.name,
    thinkingLevel: "low",
    captures,
    answers,
  });
  try {
    for (const [index, test] of cases.entries()) {
      // Persist a fictional user turn; the production capture endpoint/queue/extractor execute unchanged.
      const conversation = store.createConversation();
      const run = store.work.createRun(conversation.id, {
        text: test.text,
        modelId: provider.model.id,
        captureMemory: false,
      });
      store.work.patchRun(run.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });
      const { job } = await request<{ job: MemoryCaptureJob }>(
        `/runs/${run.id}/capture`,
        {},
      );
      const settled = await poll(
        () =>
          request<{ jobs: MemoryCaptureJob[] }>(
            `/memory-captures?runId=${run.id}`,
          ).then((value) => value.jobs.find((item) => item.id === job.id)!),
        (value) =>
          ["completed", "failed", "skipped", "cancelled"].includes(
            value.status,
          ),
      );
      const memories = settled.memoryIds.map((id) =>
        store.work.get<MemoryEntry>("memory", id)!,
      );
      const confirmed = memories.filter(
        (memory) => memory.status === "confirmed",
      );
      const evidenceChecks = await Promise.all(
        memories.map(async (memory) => {
          const evidenceIndex =
            memory.evidence?.findIndex(
              (evidence) =>
                evidence.type === "message" && evidence.runId === run.id,
            ) ?? -1;
          return (
            evidenceIndex >= 0 &&
            (
              await request<{ verified: boolean }>(
                `/memories/${memory.id}/evidence/${evidenceIndex}`,
              )
            ).verified
          );
        }),
      );
      captures.push({
        text: test.text,
        positive: test.positive,
        status: settled.status,
        error: settled.error,
        usage: settled.usage,
        confirmed: confirmed.length,
        supported: confirmed.filter((memory) =>
          expectedFacts[index].some((fact) => matchesFact(memory, fact)),
        ).length,
        expectedAutomaticFacts: index === 5 ? 0 : expectedFacts[index].length,
        automaticFactHits:
          index === 5
            ? 0
            : expectedFacts[index].filter((fact) =>
                confirmed.some((memory) => matchesFact(memory, fact)),
              ).length,
        evidenceCount: evidenceChecks.length,
        evidenceVerified: evidenceChecks.every(Boolean),
        memories: memories.map(
          ({
            id,
            content,
            status,
            kind,
            validity,
            uncertainty,
            acceptedBy,
            attribute,
          }) => ({
            id,
            content,
            status,
            kind,
            validity,
            uncertainty,
            acceptedBy,
            attribute,
          }),
        ),
      });
      await saveReport();
      console.log(
        JSON.stringify({
          stage: "capture",
          case: index + 1,
          status: settled.status,
          confirmed: confirmed.length,
          candidates: memories.length,
        }),
      );
    }
    const newHome = store.work
      .list<MemoryEntry>("memory")
      .find(
        (memory) =>
          memory.attribute?.key === "home_city" &&
          memory.attribute.value === "苏州",
      );
    const oldHome = store.work
      .list<MemoryEntry>("memory")
      .find(
        (memory) =>
          memory.status === "confirmed" &&
          memory.attribute?.key === "home_city" &&
          memory.attribute.value === "杭州",
      );
    if (newHome) {
      const conflicts = store.work.memoryConflicts(newHome);
      if (conflicts.length)
        store.work.resolveMemory(
          newHome.id,
          newHome.version,
          conflicts.map(({ id, version }) => ({ id, version })),
          "change",
        );
    }
    const walk = store.work
      .list<MemoryEntry>("memory")
      .find(
        (memory) =>
          memory.category === "event" && memory.content.includes("散步"),
      );
    if (walk)
      store.work.updateMemory(
        walk.id,
        {
          content: "2025-03-15，我和陈默在杭州运河边散步。",
          occurredAt: "2025-03-15",
          validity: { from: "2025-03-15", precision: "day" },
          people: ["陈默"],
          place: "杭州运河",
          reason: "本人纠正日期",
        },
        walk.version,
      );
    const homeChangeConfirmed = !!(
      newHome &&
      oldHome &&
      store.work.get<MemoryEntry>("memory", oldHome.id)?.supersededBy ===
        newHome.id
    );
    report.setup = { homeChangeConfirmed, correctedEvent: !!walk };
    const questions = [
      { question: "我的姓名是什么？", expected: [/林舟/] },
      { question: "我从事什么职业？", expected: [/工业设计/] },
      { question: "我现在生活在哪座城市？", expected: [/苏州/] },
      { question: "搬家以前我住在哪里？请查历史记录。", expected: [/杭州/] },
      {
        question: "和我在运河边散步的人是谁？确切日期是哪天？",
        expected: [/陈默/, /(?:2025[年\-/]0?3[月\-/]15|3月15)/],
      },
      { question: "我与许宁看展去了哪里？", expected: [/南京美术馆/] },
      {
        question: "我平时喝咖啡会加糖吗？",
        expected: [/不加糖|无糖|不加.*糖/],
      },
      {
        question: "我的小学班主任叫什么名字？",
        expected: [
          /不知道|不清楚|无法确定|没有.*(?:记录|信息|记忆)|未.*(?:记录|提供|提到)/,
        ],
      },
    ];
    const confirmed = store.work
      .list<MemoryEntry>("memory")
      .filter((memory) => memory.status === "confirmed");
    const expectedIds = [
      confirmed.find((memory) => memory.attribute?.key === "name")?.id,
      confirmed.find((memory) => memory.attribute?.key === "occupation")?.id,
      newHome?.id,
      oldHome?.id,
      walk?.id,
      confirmed.find(
        (memory) =>
          memory.content.includes("许宁") && memory.content.includes("看展"),
      )?.id,
      confirmed.find((memory) => memory.content.includes("咖啡"))?.id,
    ];
    const qaConversation = store.createConversation();
    for (const [index, test] of questions.entries()) {
      const start = performance.now();
      const { run } = await request<{ run: Run }>(
        `/conversations/${qaConversation.id}/runs`,
        {
          text: test.question,
          modelId: provider.model.id,
          thinkingLevel: "low",
          captureMemory: false,
        },
      );
      const done = await poll(
        () =>
          request<{ run: Run }>("/runs/" + run.id).then((value) => value.run),
        (value) => ["completed", "failed", "stopped"].includes(value.status),
      );
      const answer = done.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const grounded =
        index === 7 ||
        (!!expectedIds[index] && done.memoryIds.includes(expectedIds[index]!));
      const setupPassed = (index !== 2 && index !== 3) || homeChangeConfirmed;
      const normalized = answer.replace(/\s+/g, "");
      const abstained = /不知道|不清楚|无法确认|无法确定/.test(normalized);
      answers.push({
        question: test.question,
        status: done.status,
        answer,
        grounded,
        setupPassed,
        passed:
          done.status === "completed" &&
          setupPassed &&
          grounded &&
          (index === 7 || !abstained) &&
          test.expected.every((pattern) => pattern.test(normalized)),
        elapsedMs: Math.round(performance.now() - start),
        memoryIds: done.memoryIds,
        traces: done.memoryTraces,
        usage: done.usage,
      });
      await saveReport();
      console.log(
        JSON.stringify({
          stage: "answer",
          case: answers.length,
          status: done.status,
          passed: answers.at(-1)!.passed,
        }),
      );
    }
    const coffee = store.work
      .list<MemoryEntry>("memory")
      .find(
        (memory) =>
          memory.status === "confirmed" && memory.content.includes("咖啡"),
      );
    if (coffee) {
      store.work.forgetMemory(coffee.id, coffee.version);
      const { run } = await request<{ run: Run }>(
        `/conversations/${qaConversation.id}/runs`,
        {
          text: "我喝咖啡喜欢加糖还是不加？",
          modelId: provider.model.id,
          thinkingLevel: "low",
          captureMemory: false,
        },
      );
      const done = await poll(
        () =>
          request<{ run: Run }>("/runs/" + run.id).then((value) => value.run),
        (value) => ["completed", "failed", "stopped"].includes(value.status),
      );
      const answer = done.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      report.forgetting = {
        answer,
        recalledStoppedMemory: done.memoryIds.includes(coffee.id),
        abstained:
          /不知道|不清楚|无法确定|没有.*(?:记录|信息|记忆)|未.*(?:记录|提供|提到)/.test(
            answer,
          ),
      };
    }
    const totalConfirmed = captures.reduce(
      (total, item) => total + Number(item.confirmed),
      0,
    );
    Object.assign(report, {
      model: provider.model.name,
      thinkingLevel: "low",
      capturePrecision: totalConfirmed
        ? captures.reduce((total, item) => total + Number(item.supported), 0) /
          totalConfirmed
        : 0,
      automaticFactCoverage:
        captures.reduce(
          (total, item) => total + Number(item.automaticFactHits),
          0,
        ) /
        captures.reduce(
          (total, item) => total + Number(item.expectedAutomaticFacts),
          0,
        ),
      negativeAutoConfirmed: captures
        .filter((item) => !item.positive)
        .reduce((total, item) => total + Number(item.confirmed), 0),
      evidenceVerified: captures.every((item) => item.evidenceVerified),
      answerAccuracy:
        answers.filter((answer) => answer.passed).length / answers.length,
      captures,
      answers,
    });
  } finally {
    await app.close();
  }
}
report.completed = true;
await saveReport();
const { captures, answers, ...summary } = report;
console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
