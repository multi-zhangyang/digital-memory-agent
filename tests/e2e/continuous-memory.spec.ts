import { test, expect, type APIRequestContext } from "@playwright/test";
import type { MemoryEntry } from "../../packages/contracts/src/index";

async function configure(request: APIRequestContext) {
  await expect
    .poll(async () =>
      (
        await request.post("/api/settings/providers/openai-compatible", {
          data: {
            enabled: true,
            baseUrl: "http://127.0.0.1:4312/v1",
            modelName: "browser-test",
            apiKey: "test-browser-key",
            protocol: "openai-completions",
            contextWindow: 256000,
            maxTokens: 16384,
            reasoning: true,
            thinkingLevel: "low",
          },
        })
      ).status(),
    )
    .toBe(200);
  await request.patch("/api/memory-settings", {
    data: { capture: "graded", timeZone: "Asia/Shanghai" },
  });
}

test("conversation captures expose original evidence, can be stopped and restored, and retain responsive composition", async ({
  page,
  request,
}) => {
  await configure(request);
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/");
  await page.getByLabel("任务指令").fill("我每周六都会去城南图书馆读书。");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "completed",
  );
  await page.getByLabel("任务指令").fill("草稿不应该被后台记忆处理清空");
  const taskId = new URL(page.url()).searchParams.get("task");
  await expect(page.getByTestId("memory-capture-job").first()).toHaveAttribute(
    "data-job-status",
    "completed",
  );
  await expect(page.getByLabel("任务指令")).toHaveValue(
    "草稿不应该被后台记忆处理清空",
  );
  await page
    .getByRole("button", { name: /周六读书习惯/ })
    .first()
    .click();
  const detail = page.getByTestId("workbench-inspector");
  await expect(detail.getByText("本人陈述 · 自动记录")).toBeVisible();
  await detail.getByRole("button", { name: /原始依据/ }).click();
  await detail.getByRole("button", { name: "核对原文", exact: true }).click();
  await expect(
    detail.getByRole("button", { name: "原文校验通过" }),
  ).toBeVisible();
  const source = detail.getByRole("link", { name: "查看原始消息" }).first();
  expect(await source.getAttribute("href")).toContain("task=" + taskId);
  await detail.getByRole("button", { name: "停止使用", exact: true }).click();
  await expect(detail.getByText("已停止取用，原文保留")).toBeVisible();
  const stopped = await (
    await request.get("/api/memory-search?query=城南图书馆")
  ).json();
  expect(stopped.memories).toHaveLength(0);
  await detail.getByRole("button", { name: "恢复取用", exact: true }).click();
  await expect(detail.getByText("已停止取用，原文保留")).toHaveCount(0);
  await source.click();
  await expect(page.getByTestId("run-thread")).toBeVisible();
  await expect(
    page
      .getByRole("log")
      .getByText("我每周六都会去城南图书馆读书。", { exact: true })
      .first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/continuous-memory-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("memory settings persist and users explicitly associate people and aliases", async ({
  page,
  request,
}) => {
  await configure(request);
  const response = await request.post("/api/memories", {
    data: {
      title: "春日同行",
      content: "2025-04-08，我与顾言在南京看展。",
      occurredAt: "2025-04-08",
    },
  });
  const created: MemoryEntry = (await response.json()).memory;
  await request.patch(`/api/memories/${created.id}`, {
    data: { version: created.version, people: ["顾言"], category: "event" },
  });
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByRole("tab", { name: "人物", exact: true }).click();
  const personRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "顾言", exact: true }) });
  await personRow
    .getByRole("button", { name: "核对人物", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("已确认的别名").fill("阿言");
  await dialog.getByRole("button", { name: "确认关联", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("tab", { name: "全部", exact: true }).click();
  await page.getByLabel("搜索记忆", { exact: true }).fill("阿言");
  await expect(page.getByRole("button", { name: /^春日同行/ })).toBeVisible();
  await page.goto("/?view=settings");
  await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
  await page.getByRole("switch", { name: "自动记录我的明确陈述" }).uncheck();
  await page.getByRole("button", { name: "保存记忆设置" }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "自动记录我的明确陈述" }),
  ).not.toBeChecked();
  await request.patch("/api/memory-settings", { data: { capture: "graded" } });
});

test("timeline date filters include an event whose source only specifies a month", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/memories", {
    data: { title: "春月看展记录", content: "2025年三月，我去南京看展。" },
  });
  const created: MemoryEntry = (await response.json()).memory;
  await request.patch(`/api/memories/${created.id}`, {
    data: {
      version: created.version,
      category: "event",
      validity: { from: "2025-03-01", to: "2025-03-31", precision: "month" },
    },
  });
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2025-03-10");
  await page.getByLabel("结束日期", { exact: true }).fill("2025-03-20");
  await expect(
    page.getByRole("button", { name: /^春月看展记录/ }),
  ).toBeVisible();
  await page.getByLabel("开始日期", { exact: true }).fill("2025-04-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2025-04-30");
  await expect(page.getByRole("button", { name: /^春月看展记录/ })).toHaveCount(
    0,
  );
});
