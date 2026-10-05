import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { MemoryActivity, MemorySettings, Run } from "../../packages/contracts/src/index";

test("organizes activities in conversation, persists corrections and keeps review usable on desktop and mobile", async ({ page, request }) => {
  test.setTimeout(90000);
  page.on("pageerror", (error) => { throw error; });
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  expect((await request.post("/api/settings/providers/openai-compatible", { data: { enabled: true, baseUrl: "http://127.0.0.1:4312/v1",
    modelName: "living-browser-test", apiKey: "test-only", protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: false, thinkingLevel: "off" } })).ok()).toBeTruthy();
  expect((await request.patch("/api/memory-settings", { data: { intake: "manual", capture: "off", textModelId: "openai-compatible/living-browser-test", photoModelId: "openai-compatible/living-browser-test" } })).ok()).toBeTruthy();
  try {
    await page.setViewportSize({ width: 1440, height: 960 }); await page.goto("/");
    await expect(page.getByRole("heading", { name: "新对话", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/living-memory-home-1440.png", animations: "disabled" });
    const tag = randomUUID().slice(0, 8);
    const composer = page.getByTestId("workbench-composer").last();
    await composer.getByLabel("附加资料").setInputFiles([
      { name: `野餐记录-${tag}.txt`, mimeType: "text/plain", buffer: Buffer.from(`2026-09-20 沈青和顾宁在青禾公园野餐。沈青带了蓝色野餐垫。测试批次 ${tag}。`) },
      { name: `野餐收尾-${tag}.txt`, mimeType: "text/plain", buffer: Buffer.from(`2026-09-20 同一次青禾公园野餐后，顾宁收起银色保温杯。测试批次 ${tag}。`) },
    ]);
    await expect(composer.getByText(`野餐收尾-${tag}.txt`, { exact: true })).toBeVisible();
    await page.getByLabel("任务指令").fill("整理这些照片和文字中的生活活动，把待核对的地方列出来。");
    const submitted = page.waitForResponse((r) => /\/api\/conversations\/[^/]+\/runs$/.test(r.url()) && r.request().method() === "POST");
    await composer.locator('button[type="submit"]').click();
    const run = (await (await submitted).json()).run as Run;
    const thread = page.locator(`#run-${run.id}`);
    await expect(thread).toHaveAttribute("data-run-status", "completed");
    await expect(thread.getByTestId("run-activities")).toBeVisible();
    const result = (await (await request.get(`/api/runs/${run.id}/activities`)).json()).activities as MemoryActivity[];
    expect(result).toHaveLength(1); expect(result[0].status).toBe("candidate");
    const id = result[0].id;
    await thread.getByRole("button", { name: "查看活动", exact: true }).click();
    const detail = page.getByTestId("activity-inspector");
    await expect(detail.getByLabel("活动内容", { exact: true })).toContainText("银色保温杯");
    await page.screenshot({ path: "test-results/living-memory-review-1440.png", animations: "disabled" });
    await detail.getByRole("button", { name: "确认活动内容", exact: true }).click();
    await expect(detail.getByText("已确认", { exact: true })).toBeVisible();
    await detail.getByLabel("活动", { exact: true }).fill("杉溪公园野餐");
    await detail.getByLabel("地点", { exact: true }).fill("杉溪公园");
    const content = await detail.getByLabel("活动内容", { exact: true }).inputValue();
    await detail.getByLabel("活动内容", { exact: true }).fill(content.replaceAll("青禾公园", "杉溪公园"));
    await detail.getByRole("button", { name: "保存更正", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/memory-activities/${id}`)).json()).activity.place).toBe("杉溪公园");
    await page.reload();
    await expect(detail.getByLabel("地点", { exact: true })).toHaveValue("杉溪公园");
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.screenshot({ path: "test-results/living-memory-review-1024.png", animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toBeVisible();
    // The official Sheet enters from the right; measure the settled panel, not an animation frame.
    await expect.poll(() => detail.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/living-memory-review-390.png", animations: "disabled" });
    await detail.getByRole("button", { name: "关闭活动详情" }).click();
    await expect(detail).toHaveCount(0);
    await page.screenshot({ path: "test-results/living-memory-chat-390.png", animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await expect(page.getByRole("tab", { name: "活动", exact: true })).toHaveAttribute("data-state", "active");
    const card = page.locator(`[data-activity-id="${id}"]`);
    await expect(card).toContainText("杉溪公园野餐");
    await card.getByRole("button", { name: "查看活动", exact: true }).click();
    await detail.getByRole("checkbox", { name: /^拆分记录 / }).first().check();
    await detail.getByRole("button", { name: "拆分所选", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/memory-activities/${id}`)).json()).activity.status).toBe("superseded");
    await expect(detail.getByText("拆分后请核对活动内容")).toBeVisible();
    await detail.getByRole("button", { name: "关闭活动详情" }).click();
    await page.screenshot({ path: "test-results/living-memory-library-1440.png", animations: "disabled" });
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    await request.patch("/api/memory-settings", { data: { ...settings, textModelId: saved.textModelId || "", photoModelId: saved.photoModelId || "" } });
  }
});
