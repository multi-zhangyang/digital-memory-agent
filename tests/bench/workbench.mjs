// Read-only browser benchmark. History is synthetic; no model calls or server writes.
// Usage: node tests/bench/workbench.mjs LABEL [http://localhost:3000]
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const label = (process.argv[2] || "local").replace(/[^a-zA-Z0-9_-]/g, "_");
const origin = process.argv[3] || "http://localhost:3000";
const output = `test-results/performance/${label}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const reports = [];
try {
  for (const history of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const requests = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/")) requests.push(new URL(r.url()).pathname);
    });
    await page.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) =>
        window.__longTasks.push(
          ...list
            .getEntries()
            .map((e) => ({ start: e.startTime, duration: e.duration })),
        ),
      ).observe({ type: "longtask", buffered: true });
    });
    if (history) {
      const date = new Date().toISOString();
      const conversation = {
        id: "performance-fixture",
        title: "性能测试 · 长会话",
        modelId: null,
        projectId: "default",
        createdAt: date,
        updatedAt: date,
        running: false,
        status: "completed",
      };
      const runs = Array.from({ length: 60 }, (_, i) => ({
        id: "perf-" + i,
        conversationId: conversation.id,
        text: "请分析第 " + i + " 份数据",
        modelId: "openai-compatible",
        status: "completed",
        assetIds: [],
        scope: "library",
        useMemory: false,
        cursor: i + 1,
        createdAt: date,
        finishedAt: date,
        sources: [],
        memoryIds: [],
        plan: [],
        parts: [
          { type: "reasoning", text: "核对资料中的数字与来源。".repeat(30) },
          {
            type: "tool",
            name: "read",
            toolCallId: "read-" + i,
            input: { path: "data.csv" },
            state: "complete",
            output: "id,amount\n1,35",
          },
          { type: "reasoning", text: "计算并验证结果。".repeat(20) },
          {
            type: "tool",
            name: "bash",
            toolCallId: "bash-" + i,
            input: { command: "python analyze.py" },
            state: "complete",
            output: "TOTAL:35",
          },
          {
            type: "text",
            text:
              "### 分析结果\n\n已经整理了数据并完成计算。\n\n" +
              "结果经过核验，数据来源保存在项目中，可以继续查看。\n\n".repeat(
                8,
              ),
          },
        ],
      }));
      await page.route("**/api/workspace", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          json: {
            ...body,
            conversations: [conversation, ...body.conversations],
          },
        });
      });
      await page.route(
        "**/api/conversations/performance-fixture/workspace",
        (route) =>
          route.fulfill({
            json: {
              conversation,
              runs,
              assets: [],
              artifacts: [],
              memories: [],
              legacyMessages: [],
            },
          }),
      );
      await page.route(
        "**/api/conversations/performance-fixture/session",
        (route) =>
          route.fulfill({
            json: {
              tools: [],
              skills: [],
              prompts: [],
              nodes: [],
              statuses: {},
              context: null,
            },
          }),
      );
      await page.route("**/api/runs/perf-*/approvals", (route) =>
        route.fulfill({ json: { approvals: [] } }),
      );
    }
    await page.goto(origin + (history ? "/?task=performance-fixture" : "/"));
    const input = page.getByLabel("任务指令");
    await input.waitFor();
    await page.waitForTimeout(1600);
    const scenario = history ? "history" : "home";
    await page.screenshot({ path: `${output}/${scenario}.png` });
    const startup = await page.evaluate(() => ({
      scripts: performance
        .getEntriesByType("resource")
        .filter((r) => r.initiatorType === "script")
        .reduce(
          (a, r) => ({
            count: a.count + 1,
            bytes: a.bytes + r.decodedBodySize,
          }),
          { count: 0, bytes: 0 },
        ),
      longTasks: window.__longTasks,
    }));
    const previous = await input.inputValue();
    const latency = [];
    await input.focus();
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        window.__inputStart = performance.now();
      });
      await input.press("a");
      latency.push(
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                resolve(performance.now() - window.__inputStart),
              ),
            ),
        ),
      );
    }
    await input.fill(previous);
    latency.sort((a, b) => a - b);
    reports.push({
      scenario,
      startup,
      inputToFrame: { median: latency[20], p95: latency[38] },
      renderedRuns: await page.getByTestId("run-thread").count(),
      apiRequests: requests,
    });
    await page.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
