import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MemoryImportJob, MemorySettings, Run, TrainingSample } from "../../packages/contracts/src/index";

// Generated pixels and a controlled supplier validate UI/service/Pi integration, not perception quality.
const raster = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAAABc2X6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAzUlEQVR4nO3XwQ1EUQhC0dN/004Pk7yw+DexAAUFdHyqzDtoYDGsldYNS7Sk0tnSrU2y4KGkpWipLK3nQd+SvWFkS15AYA55DHsKgTnkMSyGtdK6YYmWVDpbug+UeQcNLIa10rphiZZUOlu6tUkWPJS0FC2VpfU86FuyN4xsyQsIzCGPYU8hMIc8hsWwVlo3LNGSSmdL94Ey76CBxbBWWjcs0ZJKZ0u3NsmCh5KWoqWytJ4HfUv2hpEteQGBOeQx7CkE5pDHsBjWSvsbgh/A5uhpCgIl5wAAAABJRU5ErkJggg==", "base64");

test("attachment-only mixed upload retries individually and the Agent delivers reviewed training files through conversation", async ({ page, request }) => {
  test.setTimeout(90000);
  page.on("pageerror", (error) => { throw error; });
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  expect((await request.post("/api/settings/providers/openai-compatible", { data: {
    enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "agent-first-browser-test", apiKey: "test-browser-key",
    protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: false, thinkingLevel: "off",
  } })).ok()).toBeTruthy();
  expect((await request.patch("/api/memory-settings", { data: { capture: "off", intake: "automatic", automaticText: true, automaticPhotos: true,
    textModelId: "openai-compatible/agent-first-browser-test", photoModelId: "openai-compatible/agent-first-browser-test", datasetModelId: "openai-compatible/agent-first-browser-test" } })).ok()).toBeTruthy();
  const tag = randomUUID().slice(0, 8), textName = `会话文字-${tag}.txt`, photoName = `会话照片-${tag}.png`;
  const uploads: string[] = [];
  let failedOnce = false;
  await page.route("**/api/assets?processing=requested", async (route) => {
    uploads.push(route.request().url());
    if (!failedOnce) { failedOnce = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "测试中的一次上传中断" } }) }); }
    else await route.continue();
  });
  try {
    await page.goto("/");
    const composer = page.getByTestId("workbench-composer").last();
    await composer.getByLabel("附加资料").setInputFiles([
      { name: textName, mimeType: "text/plain", buffer: Buffer.from("2026年9月3日，林舟把备用钥匙交给陈默，陈默说她已收好。") },
      { name: photoName, mimeType: "image/png", buffer: Buffer.concat([raster, Buffer.from(tag)]) },
    ]);
    await expect(composer.getByText(`${textName} · 上传失败`)).toBeVisible();
    await expect(composer.getByText(photoName, { exact: true })).toBeVisible();
    await composer.getByRole("button", { name: `重试上传 ${textName}` }).click();
    await expect(composer.getByText(`${textName} · 上传失败`)).toHaveCount(0);
    await expect(composer.getByText(textName, { exact: true })).toBeVisible();
    expect(uploads).toHaveLength(3);
    await expect(page.getByLabel("任务指令")).toHaveValue("");
    const before = (await (await request.get("/api/memory-overview?view=imports")).json()).jobs as MemoryImportJob[];
    expect(before.some((job) => job.chunks.some((chunk) => [photoName, textName].includes(chunk.name)))).toBe(false);
    const submitted = page.waitForResponse((response) => /\/api\/conversations\/[^/]+\/runs$/.test(response.url()) && response.request().method() === "POST");
    await composer.locator('button[type="submit"]').click();
    const first = (await (await submitted).json()).run as Run;
    expect(first.text).toBe(""); expect(first.assetIds).toHaveLength(2); expect(first.goal).toContain("整理本次");
    const thread = page.getByTestId("run-thread").last();
    await expect(thread).toHaveAttribute("data-run-status", "completed");
    await expect(thread.getByText("两份资料已整理并保存带来源的结果，观察保持待核对。")).toBeVisible();
    await expect(thread.getByTestId("run-job")).toContainText("资料 2 · 已处理 2");
    await page.reload();
    await expect(page.getByTestId("run-job")).toContainText("资料 2 · 已处理 2");

    await page.getByLabel("任务指令").fill("确认这批文字记录，请生成并核对训练样本，修订问题后交付可下载的训练文件。");
    const next = page.waitForResponse((response) => /\/api\/conversations\/[^/]+\/runs$/.test(response.url()) && response.request().method() === "POST");
    await page.getByTestId("workbench-composer").last().locator('button[type="submit"]').click();
    const second = (await (await next).json()).run as Run;
    const deliveredThread = page.locator("#run-" + second.id);
    await expect(deliveredThread).toHaveAttribute("data-run-status", "completed");
    const finished = (await (await request.get("/api/runs/" + second.id)).json()).run as Run;
    for (const name of ["inspect_memories", "change_memories", "build_dataset", "inspect_dataset", "review_dataset", "deliver_dataset"])
      expect(finished.parts.some((part) => part.type === "tool" && part.name === name && part.state === "complete"), name).toBe(true);
    const delivery = finished.parts.find((part) => part.type === "tool" && part.name === "deliver_dataset");
    const datasetId = delivery?.type === "tool" ? (delivery.output as { datasetId: string }).datasetId : "";
    const samples = (await (await request.get(`/api/memory-datasets/${datasetId}/samples`)).json()).samples as TrainingSample[];
    expect(samples).toHaveLength(3);
    expect(samples.every((sample) => sample.status === "ready" && sample.version === 2 && sample.authority === "agent-reviewed")).toBe(true);
    expect(samples.every((sample) => sample.answer !== "她")).toBe(true);
    const downloadEvent = page.waitForEvent("download");
    await deliveredThread.getByRole("link", { name: "training.jsonl", exact: true }).click();
    const download = await downloadEvent;
    const rows = (await readFile((await download.path())!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2); expect(rows.every((sample) => sample.lineage.authority === "agent-reviewed")).toBe(true);
    await page.reload();
    await expect(deliveredThread.getByRole("link", { name: "training.jsonl", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/agent-first-delivery.png", fullPage: true, animations: "disabled" });
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    await request.patch("/api/memory-settings", { data: { ...settings, textModelId: saved.textModelId || "", photoModelId: saved.photoModelId || "", datasetModelId: saved.datasetModelId || "" } });
    await request.post("/api/settings/providers/openai-compatible", { data: { enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "browser-test", apiKey: "test-browser-key", protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: true, thinkingLevel: "low" } });
  }
});
