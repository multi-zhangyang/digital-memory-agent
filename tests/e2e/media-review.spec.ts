import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MemoryDataset, Run, TrainingSample } from "../../packages/contracts/src/index";

const raster = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAAABc2X6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAzUlEQVR4nO3XwQ1EUQhC0dN/004Pk7yw+DexAAUFdHyqzDtoYDGsldYNS7Sk0tnSrU2y4KGkpWipLK3nQd+SvWFkS15AYA55DHsKgTnkMSyGtdK6YYmWVDpbug+UeQcNLIa10rphiZZUOlu6tUkWPJS0FC2VpfU86FuyN4xsyQsIzCGPYU8hMIc8hsWwVlo3LNGSSmdL94Ey76CBxbBWWjcs0ZJKZ0u3NsmCh5KWoqWytJ4HfUv2hpEteQGBOeQx7CkE5pDHsBjWSvsbgh/A5uhpCgIl5wAAAABJRU5ErkJggg==", "base64");
// Generated raster; the provider is a controlled integration fixture.
async function configure(request: APIRequestContext, name: string) {
  expect((await request.post("/api/settings/providers/openai-compatible", { data: { enabled: true, baseUrl: "http://127.0.0.1:4312/v1",
    modelName: name, apiKey: "test-browser-key", protocol: "openai-completions", supportsImages: true,
    contextWindow: 256000, maxTokens: 16384, reasoning: false, thinkingLevel: "off" } })).ok()).toBeTruthy();
}

test("shows the exact original crop in the conversation and restores evidence and failures after reload", async ({ page, request }) => {
  page.on("pageerror", (error) => { throw error; });
  await configure(request, "media-review-browser-test");
  try {
    await page.goto("/");
    const composer = page.getByTestId("workbench-composer").last();
    await composer.getByLabel("附加资料").setInputFiles({ name: `局部-${randomUUID()}.png`, mimeType: "image/png", buffer: raster });
    await page.getByLabel("任务指令").fill("请查看这张图片的整图和中央局部，保留读取依据。");
    await expect(composer.locator('button[type="submit"]')).toBeEnabled();
    const submitted = page.waitForResponse((response) => /\/api\/conversations\/[^/]+\/runs$/.test(response.url()) && response.request().method() === "POST");
    await composer.locator('button[type="submit"]').click();
    const run = (await (await submitted).json()).run as Run;
    const thread = page.locator("#run-" + run.id);
    await expect(thread).toHaveAttribute("data-run-status", "completed");
    const openEvidence = async () => {
      const buttons = thread.getByRole("button", { name: /读取原始证据/ });
      await expect(buttons).toHaveCount(2);
      for (const button of await buttons.all()) if (await button.getAttribute("data-state") === "closed") await button.click();
    };
    await openEvidence();
    const crop = thread.getByRole("link", { name: "查看局部", exact: true });
    await expect(crop).toBeVisible(); await expect(thread.getByRole("link", { name: "查看整图", exact: true })).toBeVisible();
    const href = await crop.getAttribute("href");
    expect(href).toContain("width=0.5");
    const response = await request.get(href!); expect(response.ok()).toBeTruthy();
    expect(response.headers()["cache-control"]).toContain("no-store");
    const digest = createHash("sha256").update(await response.body()).digest("hex");
    expect(new URL(href!, "http://local").searchParams.get("view")).toBe(digest);
    const preview = page.waitForEvent("popup"); await crop.click();
    const popup = await preview; await popup.waitForLoadState();
    expect(popup.url()).toContain("view=" + digest); await popup.close();
    await page.reload(); await openEvidence();
    await expect(crop).toHaveAttribute("href", href!);
    await expect(thread.getByTestId("evidence-preview").locator("img")).toHaveCount(2);
    await page.screenshot({ path: "test-results/media-review-crop.png", fullPage: true, animations: "disabled" });
    // Explicit network-failure fixture: a vanished version must not keep showing cached evidence.
    await page.route("**/api/evidence/*/preview?*", (route) => route.fulfill({ status: 409, contentType: "application/json", body: '{"error":{"message":"证据版本已变更"}}' }));
    await page.reload(); await openEvidence();
    await expect(thread.getByText("此版本的图片已不可用，请重新读取原件。", { exact: true })).toHaveCount(2);
  } finally { await configure(request, "browser-test"); }
});

test("keeps temporal review failures editable and downloads repaired questions from the real dataset service", async ({ page, request }) => {
  await configure(request, "browser-test");
  const title = "时间复核-" + randomUUID().slice(0, 8);
  const created = await request.post("/api/memories", { data: { title, content: "2024年2月29日，林舟把备用钥匙交给陈默。", category: "event", occurredAt: "2024-02-29" } });
  expect(created.ok()).toBeTruthy(); const entry = (await created.json()).memory;
  const submitted = await request.post("/api/memory-datasets", { data: { requestKey: randomUUID(), title, modelId: "openai-compatible/browser-test", scope: { memoryIds: [entry.id] } } });
  expect(submitted.status()).toBe(202); const dataset = (await submitted.json()).dataset as MemoryDataset;
  await expect.poll(async () => (await (await request.get(`/api/memory-datasets/${dataset.id}`)).json()).dataset.status).toBe("completed");
  const records = (await (await request.get(`/api/memory-datasets/${dataset.id}/samples`)).json()).samples as TrainingSample[];
  expect(records).toHaveLength(3);
  expect(records.every((sample) => sample.quality?.issues.some((issue) => issue.code === "missing-event-time"))).toBe(true);
  await page.goto("/"); await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByTestId("memory-library").getByRole("button", { name: "数据集", exact: true }).click();
  await page.getByRole("dialog", { name: "数据集", exact: true }).getByTestId("dataset-row").filter({ hasText: title }).getByRole("button", { name: "查看样本" }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog.getByText("需修订", { exact: true })).toHaveCount(3);
  await dialog.getByRole("checkbox", { name: /^选择样本 / }).first().check();
  await dialog.getByLabel("核对依据", { exact: true }).fill("先尝试直接核对，用于检验日期检查。");
  await dialog.getByRole("button", { name: "确认所选样本", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("2024-02-29");
  // Evaluation rows depend on reviewed training versions; API order is by stable
  // sample ID and must not determine the order in which their prerequisites are fixed.
  const reviewOrder = [...records].sort((a, b) => Number(a.intendedUse === "evaluation") - Number(b.intendedUse === "evaluation"));
  for (const [index, sample] of reviewOrder.entries()) {
    const item = dialog.locator('[data-slot="accordion-item"]').filter({ hasText: sample.question });
    await item.getByRole("button", { name: new RegExp(sample.question) }).click();
    await item.getByRole("button", { name: "修订样本", exact: true }).click();
    await item.getByLabel("修订依据", { exact: true }).fill("对照冻结原文补足 2024-02-29 的事件日期。");
    if (index === 0) {
      await item.getByLabel("问题", { exact: true }).fill("2025-02-28，" + sample.question);
      await item.getByRole("button", { name: "保存修订", exact: true }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: "没有冻结来源支持" })).toBeVisible();
      await expect(item.getByLabel("问题", { exact: true })).toHaveValue("2025-02-28，" + sample.question);
    }
    await item.getByLabel("问题", { exact: true }).fill("2024-02-29，" + sample.question);
    await item.getByRole("button", { name: "保存修订", exact: true }).click();
    await expect(item.getByRole("button", { name: "保存修订", exact: true })).toHaveCount(0);
    await expect(item.getByText("可导出", { exact: true })).toBeVisible();
  }
  await expect(dialog.getByText("需修订", { exact: true })).toHaveCount(0);
  await page.route(`**/memory-datasets/${dataset.id}/files/training`, (route) => route.fulfill({ status: 422, contentType: "application/json", body: '{"error":{"message":"此下载的版本已改变，请重新检查"}}' }));
  await dialog.getByRole("link", { name: "训练样本", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("此下载的版本已改变");
  await page.unroute(`**/memory-datasets/${dataset.id}/files/training`);
  const downloaded = page.waitForEvent("download"); await dialog.getByRole("link", { name: "训练样本", exact: true }).click();
  const rows = (await readFile((await (await downloaded).path())!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(2); expect(rows.every((row) => row.messages[0].content.startsWith("2024-02-29") && !row.quality.issues.length)).toBe(true);
  await page.screenshot({ path: "test-results/media-review-dates.png", fullPage: true, animations: "disabled" });
});
