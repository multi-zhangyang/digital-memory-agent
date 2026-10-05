import { test, expect } from "@playwright/test";
import type { Run, MemoryImportJob, MemoryEntry } from "../../packages/contracts/src/index";

// Generated pixels and controlled captions verify integration, not recognition quality.
const raster = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAAABc2X6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAzUlEQVR4nO3XwQ1EUQhC0dN/004Pk7yw+DexAAUFdHyqzDtoYDGsldYNS7Sk0tnSrU2y4KGkpWipLK3nQd+SvWFkS15AYA55DHsKgTnkMSyGtdK6YYmWVDpbug+UeQcNLIa10rphiZZUOlu6tUkWPJS0FC2VpfU86FuyN4xsyQsIzCGPYU8hMIc8hsWwVlo3LNGSSmdL94Ey76CBxbBWWjcs0ZJKZ0u3NsmCh5KWoqWytJ4HfUv2hpEteQGBOeQx7CkE5pDHsBjWSvsbgh/A5uhpCgIl5wAAAABJRU5ErkJggg==", "base64"), Buffer.from("background-fixture")]);

test("background job progress survives a page reload and resumes the Agent while preserving the evidence review status", async ({ page, request }) => {
  page.on("pageerror", (error) => { throw error; });
  expect((await request.post("/api/settings/providers/openai-compatible", { data: {
    enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName: "background-browser-test", apiKey: "test-browser-key",
    protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: true, thinkingLevel: "low",
  } })).ok()).toBeTruthy();
  const uploaded = await request.post("/api/assets", { multipart: { file: { name: "后台处理测试.png", mimeType: "image/png", buffer: raster } } });
  expect(uploaded.ok()).toBeTruthy();
  const { asset } = await uploaded.json();
  const { conversation } = await (await request.post("/api/conversations")).json();
  const started = await request.post(`/api/conversations/${conversation.id}/runs`, { data: {
    text: "后台工具流程测试：整理所选照片", modelId: "openai-compatible/background-browser-test", assetIds: [asset.id],
    scope: "selected", permissionMode: "auto", captureMemory: false,
  } });
  expect(started.status()).toBe(201);
  const initial = (await started.json()).run as Run;
  await page.goto("/?task=" + conversation.id);
  const thread = page.getByTestId("run-thread");
  const jobCard = thread.getByTestId("run-job");
  try {
    await expect(thread).toHaveAttribute("data-run-status", "waiting");
    await expect(jobCard).toHaveAttribute("data-job-status", "running");
    await expect(thread.getByText("后台正在整理", { exact: true })).toBeVisible();
    await page.reload();
    await expect(jobCard).toHaveAttribute("data-job-status", "running");
    await expect(thread).toHaveAttribute("data-run-status", "waiting");
  } finally {
    expect((await request.post("http://127.0.0.1:4312/test/release-background")).ok()).toBeTruthy();
  }
  await expect(thread).toHaveAttribute("data-run-status", "completed");
  await expect(jobCard).toHaveAttribute("data-job-status", "completed");
  await expect(thread.getByText("后台处理完成，观察等待核对。", { exact: false })).toBeVisible();
  const run = (await (await request.get("/api/runs/" + initial.id)).json()).run as Run;
  expect(run.jobs).toHaveLength(1);
  expect(run.waitingFor).toBeNull();
  const job = (await (await request.get("/api/memory-imports/" + run.jobs![0].id)).json()).job as MemoryImportJob;
  const memory = (await (await request.get("/api/memories/" + job.chunks[0].memoryIds[0])).json()).memory as MemoryEntry;
  expect(memory.status).toBe("draft");
  await page.reload();
  await expect(jobCard).toHaveAttribute("data-job-status", "completed");
  await page.screenshot({ path: "test-results/background-job-completed.png", fullPage: true, animations: "disabled" });
});
