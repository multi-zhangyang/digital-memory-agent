import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryImportJob,
  MemoryOverview,
} from "../../packages/contracts/src/index";

const modelId = "openai-compatible/browser-test";
async function configure(request: APIRequestContext) {
  const response = await request.post(
    "/api/settings/providers/openai-compatible",
    {
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
    },
  );
  expect(response.ok()).toBeTruthy();
}
async function waitJob(request: APIRequestContext, id: string) {
  let job: MemoryImportJob;
  await expect
    .poll(async () => {
      job = (await (await request.get("/api/memory-imports/" + id)).json()).job;
      return job.status;
    })
    .toMatch(/completed|failed|cancelled/);
  return job!;
}
async function startImport(page: Page) {
  await page
    .getByRole("button", { name: "导入经历", exact: true })
    .first()
    .click();
  return page.getByRole("dialog");
}
async function openMemory(page: Page, title: string) {
  await page
    .getByRole("button", {
      name: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })
    .first()
    .click();
  return page.getByTestId("workbench-inspector");
}
test.beforeEach(async ({ request, page }) => {
  await configure(request);
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("text imports expose real processing, evidence, review and corrected people/timeline", async ({
  page,
  request,
}) => {
  const tag = randomUUID().slice(0, 8);
  const records = [
    {
      name: "自述-" + tag + ".md",
      text: "我现在住在杭州。\n虚构测试编号 " + tag,
    },
    {
      name: "散步-" + tag + ".md",
      text: "2026-03-14，我和朋友陈默在杭州运河边散步。🌳\n虚构测试编号 " + tag,
    },
  ];
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  const dialog = await startImport(page);
  await dialog.getByRole("tab", { name: "文字文件" }).click();
  await dialog
    .getByLabel("选择文字文件")
    .setInputFiles(
      records.map((record) => ({
        name: record.name,
        mimeType: "text/markdown",
        buffer: Buffer.from(record.text),
      })),
    );
  await expect(
    dialog.getByRole("combobox", { name: "记忆提取模型" }),
  ).toContainText("browser-test");
  await dialog.getByRole("button", { name: "开始提取" }).click();
  const firstJob = page.getByTestId("memory-import-job").first();
  await expect(firstJob).toHaveAttribute("data-job-status", "completed");
  await firstJob
    .getByRole("button", { name: new RegExp(records[0].name) })
    .first()
    .click();
  await firstJob
    .getByRole("button", { name: new RegExp(records[0].name) })
    .last()
    .click();
  await expect(firstJob.getByText(/输入 240 · 输出 120 tokens/)).toBeVisible();
  await page.getByRole("tab", { name: /待核对/ }).click();
  const detail = await openMemory(page, "运河散步");
  await detail.getByRole("button", { name: /原始依据/ }).click();
  await expect(detail.locator("blockquote")).toContainText(records[1].text);
  await detail.getByRole("button", { name: "确认记住", exact: true }).click();
  await detail.getByRole("button", { name: "纠正记忆" }).click();
  await detail
    .getByLabel("记忆内容", { exact: true })
    .fill("2026-03-15，我和许宁在杭州运河边散步。");
  await detail.getByLabel("发生时间", { exact: true }).fill("2026-03-15");
  await detail.getByLabel("相关人物", { exact: true }).fill("许宁");
  await detail
    .getByLabel("纠正原因", { exact: true })
    .fill("本人核对了同行人和日期");
  await detail.getByRole("button", { name: "保存纠正" }).click();
  await expect(
    detail.getByText("2026-03-15，我和许宁在杭州运河边散步。", { exact: true }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "关闭工作区" }).click();
  await openMemory(page, "现居杭州");
  await page.getByRole("button", { name: "确认记住", exact: true }).click();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.getByRole("tab", { name: "人物", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "许宁", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  await page.getByLabel("开始日期").fill("2026-03-15");
  await page.getByLabel("结束日期").fill("2026-03-15");
  await expect(
    page.getByRole("cell", { name: "2026-03-15", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/phase9-memory-timeline.png",
    fullPage: true,
  });
  const duplicate = await request.post("/api/memory-imports", {
    data: { requestId: randomUUID(), modelId, records },
  });
  expect(duplicate.ok()).toBeTruthy();
  expect(
    (await waitJob(request, (await duplicate.json()).job.id)).chunks.every(
      (chunk) => chunk.status === "skipped",
    ),
  ).toBeTruthy();
  const found = await (
    await request.get(
      "/api/memory-search?person=许宁&from=2026-03-15&to=2026-03-15",
    )
  ).json();
  expect(
    found.memories.some(
      (memory: MemoryEntry) => memory.reason === "本人核对了同行人和日期",
    ),
  ).toBeTruthy();
});

test("conflicts require visible replacement and synthetic space survives source navigation and reload", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/memory-imports", {
    data: {
      requestId: randomUUID(),
      modelId,
      records: [
        { name: "城市核对一.md", text: "我现在住在杭州。\n虚构城市核对。" },
        {
          name: "城市核对二.md",
          text: "2026-06-02，我现在住在苏州。\n虚构城市核对。",
        },
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const job = await waitJob(request, (await response.json()).job.id);
  expect(job.status).toBe("completed");
  const old = (
    await (
      await request.get("/api/memories/" + job.chunks[0].memoryIds[0])
    ).json()
  ).memory as MemoryEntry;
  expect(
    (
      await request.patch("/api/memories/" + old.id, {
        data: { version: old.version, status: "confirmed" },
      })
    ).ok(),
  ).toBeTruthy();
  const current = job.chunks[1].memoryIds[0];
  await page.goto("/?view=memory&panel=memories&item=" + current);
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await expect(
    page.getByText("与已确认信息不同", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/phase9-memory-conflict.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "确认新记录并替代旧记录", exact: true })
    .click();
  await expect(page.getByText("与已确认信息不同", { exact: true })).toHaveCount(
    0,
  );
  const profile = await (
    await request.get("/api/memory-search?category=profile")
  ).json();
  expect(
    profile.memories.every(
      (memory: MemoryEntry) => memory.attribute?.value === "苏州",
    ),
  ).toBeTruthy();
  const personalBefore = (await (
    await request.get("/api/memory-overview")
  ).json()) as MemoryOverview;
  const dialog = await startImport(page);
  await dialog.getByRole("tab", { name: "虚构示例", exact: true }).click();
  await expect(
    dialog.getByText("虚构 · 独立空间", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "开始提取", exact: true }).click();
  await expect(page.getByTestId("memory-import-job").first()).toHaveAttribute(
    "data-job-status",
    "completed",
  );
  await expect(page.getByRole("combobox", { name: "记忆空间" })).toContainText(
    "虚构示例",
  );
  await page.getByRole("tab", { name: /待核对/ }).click();
  const detail = await openMemory(page, "现居杭州（示例）");
  await detail.getByRole("button", { name: "确认记住", exact: true }).click();
  await detail.getByRole("button", { name: /原始依据/ }).click();
  await detail.getByRole("link", { name: /01-profile.md/ }).click();
  await expect(
    detail.getByRole("heading", { name: "01-profile.md", exact: true }),
  ).toBeVisible();
  await expect(detail.getByText(/我叫林舟/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "记忆空间" })).toContainText(
    "虚构示例",
  );
  await expect(
    page.getByTestId("workbench-inspector").getByText(/我叫林舟/),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/memory-overview")).json()).memories,
  ).toHaveLength(personalBefore.memories.length);
  const assets = (await (await request.get("/api/assets")).json()).assets;
  expect(
    assets.some(
      (asset: { memorySpace?: string }) => asset.memorySpace === "demo",
    ),
  ).toBeFalsy();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "个人记忆", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/phase9-memory-mobile.png",
    fullPage: true,
  });
});

test("import failures and cancellation can be retried from processing records", async ({
  page,
}) => {
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  let dialog = await startImport(page);
  await dialog.getByLabel("记录标题").fill("可重试的记录");
  await dialog
    .getByLabel("经历原文")
    .fill("故障样本，记录了一次日期未明的出行。" + randomUUID());
  await dialog.getByRole("button", { name: "开始提取", exact: true }).click();
  let job = page.getByTestId("memory-import-job").first();
  await expect(job).toHaveAttribute("data-job-status", "failed");
  await job.getByRole("button", { name: /^重试导入/ }).click();
  await expect(job).toHaveAttribute("data-job-status", "completed");
  dialog = await startImport(page);
  await dialog.getByLabel("记录标题").fill("可取消的记录");
  await dialog
    .getByLabel("经历原文")
    .fill("慢速样本，记录了一次日期未明的出行。" + randomUUID());
  await dialog.getByRole("button", { name: "开始提取", exact: true }).click();
  job = page.getByTestId("memory-import-job").first();
  await job.getByRole("button", { name: /^取消导入/ }).click();
  await expect(job).toHaveAttribute("data-job-status", "cancelled");
  await job.getByRole("button", { name: /^重试导入/ }).click();
  await expect(job).toHaveAttribute("data-job-status", "completed");
  await page.reload();
  await page.getByRole("tab", { name: "处理记录", exact: true }).click();
  await expect(page.getByTestId("memory-import-job").first()).toHaveAttribute(
    "data-job-status",
    "completed",
  );
});
