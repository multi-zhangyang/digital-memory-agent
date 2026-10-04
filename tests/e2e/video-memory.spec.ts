import { test, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryImportJob, MemorySettings, Run } from "../../packages/contracts/src/index";

test("original video frame indexes and timed person review work without generated observations", async ({ page, request }) => {
  test.setTimeout(120000);
  const featureStatus = await (await request.get("/api/memory-features")).json();
  test.skip(featureStatus.state === "not_configured", "需配置实际本地编码器；不使用检测替身");
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  await request.patch("/api/memory-settings", { data: { intake: "manual", capture: "off", indexAssets: true, videoSampleInterval: 2 } });
  page.on("pageerror", (error) => { throw error; });
  try {
    const report = JSON.parse(await readFile(process.env.MEMORY_VIDEO_INDEX_REPORT!, "utf8"));
    const portrait = report.assets[1], name = `画面索引-${randomUUID().slice(0, 8)}.mp4`;
    const uploaded = await request.post("/api/assets?processing=requested", { multipart: { file: { name, mimeType: "video/mp4",
      buffer: await readFile(join(process.env.MEMORY_VIDEO_INDEX_REPORT!.replace(/\/report\.json$/, ""), "assets", portrait.id)) } } });
    expect(uploaded.ok()).toBeTruthy(); const asset = (await uploaded.json()).asset;
    await page.goto("/?view=processing");
    const job = page.getByTestId("processing-job").filter({ hasText: "索引原件 · " + name });
    await expect(job).toContainText("4 / 4", { timeout: 90000 });
    await job.getByRole("button", { name: "索引原件 · " + name, exact: true }).click();
    const indexed = page.getByRole("dialog", { name: "索引原件 · " + name, exact: true });
    await expect(indexed).toContainText("抽样画面 4 / 4");
    await expect(indexed.getByText("已索引", { exact: true })).toHaveCount(4);
    await indexed.getByRole("button", { name: "核对画面", exact: true }).nth(1).click();
    const frame = page.getByRole("dialog", { name: name + " · 00:02", exact: true });
    await expect(frame.getByTestId("video-source-viewer")).toContainText("00:02 / 00:06");
    await expect.poll(() => frame.locator('img').last().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1024);
    await page.screenshot({ path: "test-results/video-index-desktop.png", fullPage: true, animations: "disabled" });
    await frame.getByRole("button", { name: "Close", exact: true }).click();
    await indexed.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto("/?view=assets"); await page.getByRole("button", { name: "检索内容", exact: true }).click();
    const search = page.getByRole("dialog", { name: "检索素材内容", exact: true });
    await search.getByLabel("内容", { exact: true }).fill(name); await search.getByRole("button", { name: "检索", exact: true }).click();
    await expect(search.getByRole("button", { name: "核对画面", exact: true })).toHaveCount(4);
    await search.getByRole("button", { name: "核对画面", exact: true }).nth(1).click();
    await expect(search.getByTestId("video-source-viewer")).toContainText("00:02 / 00:06");
    await search.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto("/?view=memory&filter=people");
    const library = page.getByTestId("memory-library");
    if (!(await library.getByRole("button", { name: "素材人物", exact: true }).isVisible())) await library.getByRole("tab", { name: "人物", exact: true }).click();
    await library.getByRole("button", { name: "素材人物", exact: true }).click();
    const people = page.getByRole("dialog", { name: "素材人物", exact: true });
    await expect(people.getByTestId("entity-group")).toHaveCount(2);
    await people.getByRole("button", { name: "核对这一组", exact: true }).first().click();
    const review = page.getByRole("dialog", { name: "核对人物", exact: true });
    await expect(review).toContainText("2 处出现");
    await expect(review.getByRole("button", { name: /^播放 00:/ })).toHaveCount(2);
    await review.getByRole("button", { name: "查找人物出现", exact: true }).click();
    const personSearch = page.getByRole("dialog", { name: "查找人物出现", exact: true });
    await expect(personSearch.getByRole("button", { name: "核对画面", exact: true })).toHaveCount(2);
    await personSearch.getByRole("button", { name: "核对画面", exact: true }).first().click();
    await expect(personSearch.getByTestId("video-source-viewer")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(personSearch.getByTestId("video-source-viewer")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/video-index-person-mobile.png", fullPage: true, animations: "disabled" });
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    await request.patch("/api/memory-settings", { data: settings });
  }
});

// Real generated MP4 pixels and services; the local provider supplies controlled captions and tool choices.
let bytes: Buffer;
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "video-browser-")), path = join(dir, "source.mp4");
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=4:d=2",
      "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=4:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
    bytes = await readFile(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
async function configure(request: APIRequestContext, modelName: string) {
  expect((await request.post("/api/settings/providers/openai-compatible", { data: { enabled: true, baseUrl: "http://127.0.0.1:4312/v1", modelName,
    apiKey: "test-browser-key", protocol: "openai-completions", supportsImages: true, contextWindow: 256000, maxTokens: 16384, reasoning: false, thinkingLevel: "off" } })).ok()).toBeTruthy();
}

test("video settings, direct processing and a timed original frame survive reload on desktop and mobile", async ({ page, request }) => {
  test.setTimeout(90000);
  page.on("pageerror", (error) => { throw error; });
  await configure(request, "browser-test");
  const saved = (await (await request.get("/api/memory-settings")).json()).settings as MemorySettings;
  await request.patch("/api/memory-settings", { data: { intake: "manual", capture: "off" } });
  try {
    await page.goto("/?view=settings");
    await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
    await page.getByLabel("视频画面间隔（秒）", { exact: true }).fill("2");
    await page.getByRole("switch", { name: "自动处理视频", exact: true }).check();
    await page.getByLabel("视频画面处理模型", { exact: true }).click();
    await page.getByRole("option", { name: "browser-test", exact: true }).click();
    await page.getByRole("button", { name: "保存记忆设置", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
    await page.reload(); await page.getByRole("tab", { name: "个人记忆", exact: true }).click();
    await expect(page.getByLabel("视频画面间隔（秒）", { exact: true })).toHaveValue("2");
    await expect(page.getByRole("switch", { name: "自动处理视频", exact: true })).toBeChecked();
    const name = `视频-${randomUUID().slice(0, 8)}.mp4`;
    const uploaded = await request.post("/api/assets?processing=requested", { multipart: { file: { name, mimeType: "video/mp4", buffer: bytes } } });
    expect(uploaded.ok()).toBeTruthy(); const asset = (await uploaded.json()).asset;
    await page.goto("/?view=assets");
    await page.getByRole("checkbox", { name: "选择 " + name, exact: true }).check();
    const submitted = page.waitForResponse((response) => response.url().endsWith("/api/asset-processing") && response.request().method() === "POST");
    await page.getByRole("button", { name: "处理所选", exact: true }).click();
    const response = await submitted; expect(response.status()).toBe(202); const job = (await response.json()).job as MemoryImportJob;
    await expect.poll(async () => (await (await request.get(`/api/memory-imports/${job.id}`)).json()).job.status).toBe("completed");
    await page.goto("/?view=processing");
    await page.getByTestId("processing-job").filter({ hasText: name }).getByRole("button", { name: name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await dialog.getByRole("tab", { name: "原件处理", exact: true }).click();
    await expect(dialog).toContainText("抽样画面 3 / 3"); await expect(dialog).toContainText("时长 00:04"); await expect(dialog).toContainText("间隔 2 秒");
    await dialog.getByRole("button", { name: "查看原件", exact: true }).click();
    const viewer = page.getByTestId("video-source-viewer"); await expect(viewer).toBeVisible();
    await viewer.getByLabel("画面时间（秒）", { exact: true }).fill("2.2");
    await viewer.getByRole("button", { name: "读取画面", exact: true }).click();
    await expect(viewer).toContainText("00:02.250 / 00:04");
    const frame = viewer.getByRole("link", { name: "查看画面", exact: true }), href = (await frame.getAttribute("href"))!;
    expect(href).toContain("timestamp=2.2");
    const pixels = await request.get(href), digest = createHash("sha256").update(await pixels.body()).digest("hex");
    expect(new URL(href, "http://local").searchParams.get("view")).toBe(digest);
    await expect.poll(() => viewer.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime)).toBe(2.25);
    await page.goto(`/?view=assets&panel=assets&item=${asset.id}&timestamp=2.25`); await page.reload();
    await expect(viewer.getByLabel("画面时间（秒）", { exact: true })).toHaveValue("2.25");
    await expect(viewer).toContainText("00:02.250 / 00:04");
    await expect.poll(() => viewer.getByRole("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(640);
    await expect.poll(() => viewer.locator("video").evaluate((node) => {
      const video = node as HTMLVideoElement; return video.readyState >= 2 && !video.seeking;
    })).toBe(true);
    await viewer.locator("video").evaluate((node) => (node as HTMLVideoElement).play());
    await expect.poll(() => viewer.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(2.25);
    await viewer.locator("video").evaluate((node) => { const video = node as HTMLVideoElement; video.pause(); video.currentTime = 2.25; });
    await expect.poll(() => viewer.locator("video").evaluate((node) => (node as HTMLVideoElement).seeking)).toBe(false);
    await page.screenshot({ path: "test-results/video-source-desktop.png", fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText("00:02.250 / 00:04");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/video-source-mobile.png", fullPage: true, animations: "disabled" });
    await viewer.getByRole("button", { name: "保存记忆草稿", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "保存记忆草稿", exact: true });
    await draft.getByLabel("标题", { exact: true }).fill("蓝色画面 " + asset.id.slice(0, 8));
    await draft.getByLabel("内容", { exact: true }).fill("视频此时显示蓝色画面。");
    const saving = page.waitForResponse((response) => response.url().endsWith(`/api/evidence/asset%3A${asset.id}/drafts`) && response.request().method() === "POST");
    await draft.getByRole("button", { name: "保存草稿", exact: true }).click();
    const savedDraft = await saving; expect(savedDraft.status()).toBe(201);
    const memory = (await savedDraft.json()).memory;
    expect(memory.status).toBe("draft"); expect(memory.acceptedBy).toBeUndefined(); expect(memory.occurredAt).toBe("");
    expect(memory.sources.map((source: { video: { timestamp: number } }) => source.video.timestamp)).toEqual([2.25]);
    await expect(viewer.getByRole("button", { name: "核对草稿", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "核对草稿", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认记住", exact: true })).toBeVisible();
    await expect(page.getByText("视频此时显示蓝色画面。", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/video-memory-draft-mobile.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "确认记住", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/memories/${memory.id}`)).json()).memory.status).toBe("confirmed");
    await page.reload(); await expect(page.getByText("已确认", { exact: true }).first()).toBeVisible();
    const restored = (await (await request.get(`/api/memories/${memory.id}`)).json()).memory;
    expect(restored.sources[0].video.timestamp).toBe(2.25); expect(restored.sources[0].view.sha256).toBe(memory.sources[0].view.sha256);
  } finally {
    const { processingVersion: _version, ...settings } = saved;
    await request.patch("/api/memory-settings", { data: { ...settings, videoModelId: saved.videoModelId || "" } });
  }
});

test("conversation displays actual timed frame pixels and durable result sources", async ({ page, request }) => {
  page.on("pageerror", (error) => { throw error; });
  await configure(request, "video-browser-test");
  try {
    await page.goto("/");
    const composer = page.getByTestId("workbench-composer").last();
    await composer.getByLabel("附加资料").setInputFiles({ name: "会话视频.mp4", mimeType: "video/mp4", buffer: bytes });
    await page.getByLabel("任务指令").fill("读取视频开始画面和 2.2 秒局部，保存带时间的结果。");
    await expect(composer.locator('button[type="submit"]')).toBeEnabled();
    const submitted = page.waitForResponse((response) => /\/api\/conversations\/[^/]+\/runs$/.test(response.url()) && response.request().method() === "POST");
    await composer.locator('button[type="submit"]').click(); const run = (await (await submitted).json()).run as Run;
    const thread = page.locator("#run-" + run.id); await expect(thread).toHaveAttribute("data-run-status", "completed");
    const inspect = async () => {
      const activity = thread.getByRole("button", { name: "执行记录", exact: true });
      if (await activity.getAttribute("data-state") === "closed") await activity.click();
      const reads = thread.getByRole("button", { name: /读取原始证据/ }); await expect(reads).toHaveCount(2);
      for (const button of await reads.all()) if (await button.getAttribute("data-state") === "closed") await button.click();
    };
    await inspect();
    const frame = thread.locator('a[href*="/preview?"][href*="timestamp=2.2"]');
    const href = (await frame.getAttribute("href"))!; expect(href).toContain("timestamp=2.2"); expect(href).toContain("width=0.5");
    await thread.getByRole("button", { name: "播放 00:02.250", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "会话视频.mp4 · 00:02.250", exact: true });
    await expect.poll(() => dialog.locator("video").evaluate((node) => (node as HTMLVideoElement).currentTime)).toBe(2.25);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload(); await inspect(); await expect(frame).toHaveAttribute("href", href);
    await expect.poll(() => thread.getByTestId("evidence-preview").locator("img").last().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(320);
    const stored = (await (await request.get(`/api/runs/${run.id}`)).json()).run as Run;
    expect(stored.sources.map((source) => source.video?.timestamp)).toEqual([0, 2.25]);
    await expect(thread.getByRole("button", { name: /^视频时间整理 v1/ })).toBeVisible();
    await page.screenshot({ path: "test-results/video-conversation.png", fullPage: true, animations: "disabled" });
  } finally { await configure(request, "browser-test"); }
});
