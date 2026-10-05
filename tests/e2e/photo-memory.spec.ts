import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryImportJob } from "../../packages/contracts/src/index";

// Tiny generated PNG; a protocol fixture supplies the caption, not a recognition model.
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAAABc2X6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAzUlEQVR4nO3XwQ1EUQhC0dN/004Pk7yw+DexAAUFdHyqzDtoYDGsldYNS7Sk0tnSrU2y4KGkpWipLK3nQd+SvWFkS15AYA55DHsKgTnkMSyGtdK6YYmWVDpbug+UeQcNLIa10rphiZZUOlu6tUkWPJS0FC2VpfU86FuyN4xsyQsIzCGPYU8hMIc8hsWwVlo3LNGSSmdL94Ey76CBxbBWWjcs0ZJKZ0u3NsmCh5KWoqWytJ4HfUv2hpEteQGBOeQx7CkE5pDHsBjWSvsbgh/A5uhpCgIl5wAAAABJRU5ErkJggg==", "base64");

test("photo import persists vision settings, review, pixel evidence, corrections and stop-use", async ({ page, request }) => {
  page.on("pageerror", (error) => { throw error; });
  expect((await request.post("/api/settings/providers/openai-compatible", { data: {
    enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "browser-test", apiKey: "test-browser-key",
    protocol: "openai-completions", supportsImages: false, contextWindow: 256000, maxTokens: 16384, reasoning: true, thinkingLevel: "low",
  } })).ok()).toBeTruthy();
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByRole("button", { name: "导入照片", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "开始提取照片" })).toBeDisabled();
  await expect(dialog.getByText("请在模型设置中启用图片输入")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto("/?view=settings");
  const form = page.getByTestId("provider-openai-compatible");
  await expect(form).toBeVisible();
  await form.getByRole("switch", { name: "支持图片输入" }).check();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("已保存");
  await page.reload();
  await expect(form.getByRole("switch", { name: "支持图片输入" })).toBeChecked();
  expect((await request.post("/api/settings/providers/photo-processor", { data: {
    enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "photo-browser-test", apiKey: "test-browser-key",
    protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: true, thinkingLevel: "low",
  } })).ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
  const photoModel = page.getByLabel("照片处理模型", { exact: true });
  await photoModel.click();
  await page.getByRole("option", { name: "photo-browser-test", exact: true }).click();
  await page.getByRole("button", { name: "保存记忆设置" }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
  await expect(photoModel).toHaveText("photo-browser-test");

  const name = "公开照片测试-" + randomUUID().slice(0, 8) + ".png";
  await page.goto("/?view=memory");
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByRole("button", { name: "导入照片", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("处理模型", { exact: true })).toHaveText("photo-browser-test");
  await dialog.getByLabel("照片", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: fixture });
  await expect(dialog.getByText("已选 1 张", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
  const importing = page.waitForResponse((response) => response.url().endsWith("/api/memory-imports") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "开始提取照片" }).click();
  const response = await importing;
  expect(response.status()).toBe(202);
  const imported = (await response.json()).job as MemoryImportJob;
  expect(imported.modelId).toBe("photo-processor/photo-browser-test");
  const task = page.getByTestId("memory-import-job").first();
  await expect(task).toHaveAttribute("data-job-status", "completed");
  await expect(task.getByText(/1\/1 张照片/)).toBeVisible();
  await task.getByRole("button", { name: new RegExp(name) }).first().click();
  await task.getByRole("button", { name: new RegExp(name) }).last().click();
  await expect(task.getByText("参数", { exact: true })).toBeVisible();
  await task.getByRole("button", { name: "照片中的测试色块", exact: true }).click();
  const detail = page.getByTestId("workbench-inspector");
  await expect(detail.getByRole("button", { name: "确认记住", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: /原始依据/ }).click();
  // A duplicate observation can legitimately retain several original images.
  const evidence = detail.getByTestId("photo-evidence").filter({ has: page.getByRole("img", { name, exact: true }) });
  await expect(evidence.getByRole("img")).toBeVisible();
  await expect.poll(() => evidence.getByRole("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(evidence.getByLabel("模型标注的观察区域")).toBeVisible();
  await evidence.getByRole("button", { name: "核对原图", exact: true }).click();
  await expect(evidence.getByRole("button", { name: "原图校验通过" })).toBeVisible();
  const job = (await (await request.get("/api/memory-imports/" + imported.id)).json()).job as MemoryImportJob;
  const id = job.chunks[0].memoryIds[0];
  const draft = (await (await request.get("/api/memories/" + id)).json()).memory as MemoryEntry;
  expect(draft).toMatchObject({ status: "draft", occurredAt: "", people: [], kind: "observation" });
  await detail.getByRole("button", { name: "确认记住", exact: true }).click();
  await expect(detail.getByRole("button", { name: "确认记住", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "纠正记忆", exact: true }).click();
  await detail.getByLabel("记忆内容", { exact: true }).fill("经人工核对，照片里的测试色块为红色。");
  await detail.getByLabel("纠正原因", { exact: true }).fill("对照像素修改测试替身的颜色描述");
  await detail.getByRole("button", { name: "保存纠正", exact: true }).click();
  await expect(detail.getByText("经人工核对，照片里的测试色块为红色。", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: /原始依据/ }).click();
  await expect(evidence.getByRole("img")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.getByRole("button", { name: /原始依据/ }).click();
  await expect(evidence.getByRole("img")).toBeVisible();
  await expect.poll(() => evidence.getByRole("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/photo-evidence-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("任务指令").fill("回忆照片里的测试色块是什么颜色。");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveAttribute("data-run-status", "completed");
  await expect(page.getByRole("log").getByText("经人工核对，照片里的测试色块为红色。", { exact: true }).last()).toBeVisible();
  await page.goto("/?view=memory&panel=memories&item=" + id);
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await detail.getByRole("button", { name: "停止使用", exact: true }).click();
  await expect(detail.getByText("已停止取用，原文保留")).toBeVisible();
  const found = (await (await request.get("/api/memory-search?query=" + encodeURIComponent("照片 测试色块"))).json()).memories as MemoryEntry[];
  expect(found.some((memory) => memory.id === id)).toBe(false);
  const stopped = await request.post("/api/memory-imports", { data: { requestId: randomUUID(), modelId: "openai-compatible/browser-test", mode: "photos", assetIds: [job.chunks[0].assetId] } });
  const stoppedId = (await stopped.json()).job.id;
  await expect.poll(async () => (await (await request.get("/api/memory-imports/" + stoppedId)).json()).job.status).toBe("completed");
  const rerun = (await (await request.get("/api/memory-imports/" + stoppedId)).json()).job as MemoryImportJob;
  expect(rerun.chunks[0]).toMatchObject({ attempts: 0, status: "skipped", memoryIds: [] });
  expect((await request.patch("/api/memory-settings", { data: { photoModelId: "" } })).ok()).toBeTruthy();
});
