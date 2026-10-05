import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { EvidenceSearchResult, MemoryImportJob, MemorySettings, TaskJob } from "../../packages/contracts/src/index";

// The local provider supplies controlled observations; these tests verify product flows, not model quality.
test("automatic intake runs without a task, exposes unverified evidence, and preserves product navigation", async ({ page, request }) => {
  page.on("pageerror", (error) => { throw error; });
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  expect((await request.post("/api/settings/providers/openai-compatible", { data: {
    enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "browser-test", apiKey: "test-browser-key",
    protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: true, thinkingLevel: "low",
  } })).ok()).toBeTruthy();
  expect((await request.patch("/api/memory-settings", { data: { intake: "automatic", automaticText: true, indexAssets: true, textModelId: "openai-compatible/browser-test" } })).ok()).toBeTruthy();
  try {
    const before = (await (await request.get("/api/conversations")).json()).conversations.length;
    const tag = randomUUID().slice(0, 8);
    const name = `自动入库-${tag}.txt`, text = `星河档案 ${tag} 保存在书房，尚未核对具体时间。`;
    const response = await request.post("/api/assets", { multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(text) } } });
    expect(response.status()).toBe(201);
    const { asset } = await response.json();
    let imported: MemoryImportJob | undefined;
    await expect.poll(async () => {
      const jobs = (await (await request.get("/api/memory-overview?view=imports")).json()).jobs as MemoryImportJob[];
      imported = jobs.find((job) => job.chunks.some((chunk) => chunk.assetId === asset.id));
      return imported?.status;
    }).toBe("completed");
    expect(imported?.ownership).toBe("library");
    expect((await (await request.get("/api/conversations")).json()).conversations.length).toBe(before);
    await expect.poll(async () => {
      const result = (await (await request.get("/api/jobs?kind=asset-index")).json()).jobs as TaskJob[];
      return result.find((job) => job.id === asset.id)?.status;
    }).toBe("completed");
    const evidence = await (await request.get("/api/evidence?query=" + tag)).json() as EvidenceSearchResult;
    expect(evidence.hits.some((hit) => hit.assetId === asset.id && hit.authority === "raw-source")).toBe(true);
    expect(evidence.hits.some((hit) => hit.memoryId === imported!.chunks[0].memoryIds[0] && hit.authority === "unverified")).toBe(true);
    expect((await (await request.get("/api/memory-search?query=" + tag)).json()).memories).toEqual([]);

    await page.goto("/");
    const launcher = page.getByTestId("task-launcher");
    for (const label of ["整理生活", "查找与回忆", "纠正记忆", "准备数据集"]) await expect(launcher.getByRole("button", { name: label, exact: true })).toBeVisible();
    await launcher.getByRole("button", { name: "查找与回忆", exact: true }).click();
    await expect(page.getByLabel("任务指令")).toHaveValue(/查找相关资料和个人记忆/);
    await page.screenshot({ path: "test-results/harness-task-entry.png", fullPage: true, animations: "disabled" });
    await page.goto("/?view=assets");
    await page.getByRole("button", { name: "检索内容", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("内容", { exact: true }).fill(tag);
    await dialog.getByRole("button", { name: "检索", exact: true }).click();
    await expect(dialog.getByText("待核对推断", { exact: true })).toBeVisible();
    await expect(dialog.getByText("具体时间尚未确定", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name, exact: true }).click();
    await expect(dialog.getByRole("button", { name: "用于任务", exact: true })).toBeVisible();
    await expect(dialog.getByText(text, { exact: true }).last()).toBeVisible();
    await page.screenshot({ path: "test-results/harness-evidence.png", fullPage: true, animations: "disabled" });
    await page.goto("/?view=processing");
    const center = page.getByTestId("processing-center");
    await expect(center.getByTestId("processing-job").filter({ hasText: name }).first()).toBeVisible();
    await page.reload();
    await expect(center.getByTestId("processing-job").filter({ hasText: name }).first()).toBeVisible();
    await center.getByRole("tab", { name: "能力状态", exact: true }).click();
    await expect(center.getByRole("row").filter({ hasText: "个人模型训练" })).toContainText("未接入");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/harness-processing-mobile.png", fullPage: true, animations: "disabled" });
    await page.goto("/?view=datasets");
    await expect(page.getByTestId("dataset-page").getByRole("heading", { name: "数据集" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    expect((await request.patch("/api/memory-settings", { data: { ...settings, textModelId: saved.textModelId || "", datasetModelId: saved.datasetModelId || "" } })).ok()).toBeTruthy();
  }
});

test("processing preferences and independent text/dataset model choices survive reload", async ({ page, request }) => {
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  try {
    await page.goto("/?view=settings");
    await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
    await page.getByRole("switch", { name: "新资料自动整理", exact: true }).uncheck();
    for (const label of ["文字处理模型", "数据集问题生成模型"]) {
      await page.getByLabel(label, { exact: true }).click();
      await page.getByRole("option", { name: "browser-test", exact: true }).click();
    }
    await page.getByRole("button", { name: "保存记忆设置" }).click();
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
    await expect(page.getByRole("switch", { name: "新资料自动整理", exact: true })).not.toBeChecked();
    await expect(page.getByLabel("文字处理模型", { exact: true })).toHaveText("browser-test");
    await expect(page.getByLabel("数据集问题生成模型", { exact: true })).toHaveText("browser-test");
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    expect((await request.patch("/api/memory-settings", { data: { ...settings, textModelId: saved.textModelId || "", datasetModelId: saved.datasetModelId || "" } })).ok()).toBeTruthy();
  }
});
