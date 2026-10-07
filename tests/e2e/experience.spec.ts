import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";

async function configure(request: APIRequestContext) {
  const configured = await request.post(
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
  expect(configured.ok()).toBeTruthy();
}

// The external provider is scripted; the agent, Pi session and event log are real.
test("streaming stays editable, reconnects without losing chunks and delivers native follow-up", async ({
  page,
  request,
}) => {
  await configure(request);
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) reads.push(r.url());
  });
  let disconnected = false;
  // Simulate an intermediary closing one SSE response early. Native EventSource
  // must reconnect; subsequent responses are the real durable event stream.
  await page.route("**/api/runs/*/events?after=*", async (route) => {
    if (!disconnected) {
      disconnected = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "retry: 100\n\n",
      });
    } else await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("任务指令").fill("流式体验测试：队列撤回与再次补充");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await page.getByRole("button", { name: "思考中", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("片段 001");
  await expect(page.locator("[data-sd-animate]").first()).toBeVisible();
  await page
    .getByLabel("任务指令")
    .pressSequentially("继续处理下一步", { delay: 10 });
  await expect(page.getByLabel("任务指令")).toHaveValue("继续处理下一步");
  await page.getByRole("button", { name: "选择发送方式" }).click();
  await page
    .getByRole("menuitemradio", { name: "本任务完成后补充", exact: true })
    .click();
  await page
    .getByRole("button", { name: "本任务完成后补充", exact: true })
    .click();
  await page.getByRole("button", { name: "撤回到输入框", exact: true }).click();
  await expect(page.getByLabel("任务指令")).toHaveValue("继续处理下一步");
  await expect(page.getByText("已退回", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "本任务完成后补充", exact: true }).click();
  const scroller = page.getByRole("log").locator(":scope > div").first();
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "completed",
    { timeout: 18000 },
  );
  await expect(page.getByTestId("execution-timeline").getByText("继续处理下一步", { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("task");
  const detail = await (
    await request.get(`/api/conversations/${id}/workspace`)
  ).json();
  const text = detail.runs[0].parts
    .filter((p: { type: string }) => p.type === "text")
    .map((p: { text: string }) => p.text)
    .join("");
  const expected = Array.from(
    { length: 100 },
    (_, i) => `片段 ${String(i + 1).padStart(3, "0")}，`,
  ).join("");
  expect(text).toBe(expected + "OK");
  expect(disconnected).toBeTruthy();
  expect(
    reads.filter((url) => url.includes("/events?after=")).length,
  ).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("log")).toContainText(expected);
  await expect(page.locator("[data-sd-animate]")).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.getByRole("button", { name: "回到底部", exact: true }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "思考过程", exact: true }).first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "压缩上下文", exact: true })).toBeEnabled();
  const sessionReads = reads.filter((url) => url.endsWith("/session")).length;
  await expect(page.getByTestId("work-surface")).toHaveCount(0);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  await page.waitForTimeout(250);
  expect(reads.filter((url) => url.endsWith("/session"))).toHaveLength(sessionReads);
  await page.getByRole("button", { name: "会话与能力" }).click();
  await expect
    .poll(() => reads.filter((url) => url.endsWith("/session")).length)
    .toBeGreaterThan(sessionReads);
});

test("tool disclosure remains stable from execution to completion and failed output stays visible", async ({ page, request }) => {
  await configure(request);
  await page.goto("/");
  await page.getByLabel("任务指令").fill("工具连续显示测试");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("model-waiting")).toBeVisible();
  const command = page.getByTestId("tool-activity").filter({ has: page.getByRole("button", { name: /执行命令/ }) });
  const header = command.getByRole("button", { name: /执行命令/ });
  await expect(command).toHaveAttribute("data-tool-state", "running");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await command.getByRole("tab", { name: "参数", exact: true }).click();
  await expect(command).toHaveAttribute("data-tool-state", "complete", { timeout: 12000 });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(command.getByRole("tab", { name: "参数", exact: true })).toHaveAttribute("data-state", "active");
  await command.getByRole("tab", { name: "结果", exact: true }).click();
  await expect(command).toContainText("STARTEND");
  await expect(page.getByTestId("run-thread")).toHaveAttribute("data-run-status", "completed");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("model-waiting")).toHaveCount(0);
  await page.screenshot({ path: ".data/design-research/0039-interaction/tool-complete.png" });

  // A declined script exercises the real permission boundary and error event.
  await page.getByLabel("任务指令").fill("权限测试");
  await page.getByRole("button", { name: "任务设置", exact: true }).click();
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "只读", exact: true }).click();
  await page.getByRole("dialog", { name: "任务设置" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "任务设置" })).toHaveCount(0);
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  const failed = page.getByTestId("tool-activity").filter({ has: page.getByRole("button", { name: /写入文件/ }) });
  await expect(failed).toHaveAttribute("data-tool-state", "error");
  await expect(failed.getByRole("alert")).toContainText("只读模式");
  await expect(failed.getByRole("button", { name: /写入文件/ })).toHaveAttribute("aria-expanded", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await failed.getByRole("button", { name: /写入文件/ }).click();
  await expect(failed).toHaveAttribute("data-state", "open");
  expect(await failed.locator('[data-slot="collapsible-content"]').evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: ".data/design-research/0039-interaction/tool-mobile.png" });
});

// Synthetic long history is a browser rendering fixture, not an agent capability test.
test("long histories load incrementally and cached task switches retain the draft and tool disclosure", async ({
  page,
}) => {
  const date = new Date().toISOString();
  const conversation = {
    id: "experience-history",
    title: "长会话体验",
    modelId: null,
    projectId: "default",
    running: false,
    createdAt: date,
    updatedAt: date,
  };
  const runs = Array.from({ length: 60 }, (_, i) => ({
    id: "experience-" + i,
    conversationId: conversation.id,
    text: "分析记录 " + i,
    modelId: "openai-compatible/browser-test",
    status: "completed",
    assetIds: [],
    scope: "library",
    useMemory: false,
    createdAt: date,
    cursor: i + 1,
    sources: [],
    memoryIds: [],
    plan: [],
    parts: [
      ...(i === 59 ? [{ type: "message", id: "input-59", role: "user", initial: true, state: "complete" },
        { type: "notice", id: "compaction-59", text: "上下文压缩已完成", state: "complete" }] : []),
      { type: "reasoning", text: i === 59 ? "核对资料中的时间、地点和人物。\n\n".repeat(12) : "核对信息。" },
      {
        type: "tool",
        name: "read",
        toolCallId: "read-" + i,
        state: "complete",
        input: { path: "note.txt" },
        output: i === 59 ? "完整记录 59\n" + "逐项核对资料。\n".repeat(20) : "完整记录 " + i,
      },
      { type: "text", text: "已检查第 " + i + " 份记录。" },
    ],
  }));
  let delayRead = false;
  let release: (() => void) | undefined;
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      json: {
        ...snapshot,
        conversations: [conversation, ...snapshot.conversations],
      },
    });
  });
  await page.route(
    "**/api/conversations/experience-history/timeline*",
    async (route) => {
      if (delayRead)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.fulfill({
        json: {
          conversation,
          runs: new URL(route.request().url()).searchParams.has("before") ? runs.slice(0, 10) : runs.slice(-50),
          legacyMessages: [],
          assets: [],
          artifacts: [],
          memories: [],
          page: new URL(route.request().url()).searchParams.has("before") ? { hasMore: false, before: null } : { hasMore: true, before: "earlier-10" },
        },
      });
    },
  );
  let approvalReads = 0;
  await page.route("**/api/runs/experience-*/approvals", (route) => {
    approvalReads++;
    return route.fulfill({ json: { approvals: [] } });
  });
  await page.goto("/?task=experience-history");
  await expect(page.getByTestId("run-thread")).toHaveCount(50);
  await expect(page.getByRole("log")).toContainText("上下文压缩已完成");
  const scroller = page.getByRole("log").locator(":scope > div").first();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  const position = () => scroller.evaluate((element) => ({ top: element.scrollTop, page: window.scrollY }));
  const staysInPlace = async (control: Locator, action: () => Promise<void>) => {
    // Focus and click only controls already in view: Playwright must not scroll them into view.
    await expect(control).toBeInViewport();
    const before = await position();
    const box = (await control.boundingBox())!;
    await action();
    await page.waitForTimeout(700); // Include disclosure and spring-scroll animations.
    const after = await position();
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
    expect(after.page).toBe(before.page);
    expect(Math.abs((await control.boundingBox())!.y - box.y)).toBeLessThanOrEqual(1);
  };
  const thinking = page.getByRole("button", { name: "思考过程", exact: true }).last();
  const lastTool = page.getByTestId("tool-activity").last();
  const toolHeader = lastTool.getByRole("button", { name: /读取文件/ });
  const clickAt = async (control: Locator) => {
    const box = (await control.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    await thinking.focus();
    await staysInPlace(thinking, () => page.keyboard.press("Enter"));
    await expect(thinking).toHaveAttribute("aria-expanded", "true");
    await staysInPlace(thinking, () => page.keyboard.press("Space"));
    await expect(thinking).toHaveAttribute("aria-expanded", "false");
    await staysInPlace(toolHeader, () => clickAt(toolHeader));
    await expect(toolHeader).toHaveAttribute("aria-expanded", "true");
    const inputTab = lastTool.getByRole("tab", { name: "参数", exact: true });
    await staysInPlace(inputTab, () => clickAt(inputTab));
    await expect(inputTab).toHaveAttribute("data-state", "active");
    await staysInPlace(inputTab, () => page.keyboard.press("ArrowLeft"));
    await expect(lastTool.getByRole("tab", { name: "结果", exact: true })).toHaveAttribute("data-state", "active");
    await staysInPlace(toolHeader, () => clickAt(toolHeader));
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("任务指令").fill("这条草稿不能丢");
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(60);
  await lastTool.getByRole("button", { name: /读取文件/ }).click();
  await expect(lastTool.getByText(/^完整记录 59/)).toBeVisible();
  await expect(page.getByTestId("work-surface")).toHaveCount(0);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect(lastTool.getByText(/^完整记录 59/)).toBeVisible();
  await expect.poll(() => approvalReads).toBe(60);
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByTestId("workbench-navigation").getByRole("button", { name: "长会话体验", exact: true }).click();
  await expect(lastTool.getByText(/^完整记录 59/)).toBeVisible();
  await page.waitForTimeout(100);
  expect(approvalReads).toBe(60);
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  delayRead = true;
  await page
    .getByTestId("workbench-navigation")
    .getByRole("button", { name: "长会话体验", exact: true })
    .click();
  await expect(page.getByLabel("任务指令")).toHaveValue("这条草稿不能丢");
  await expect(page.getByTestId("run-thread")).toHaveCount(60);
  await expect.poll(() => !!release).toBe(true);
  release!();
  await page.screenshot({
    path: "test-results/workbench-long-history.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("accepting a run preserves text composed while its response is pending", async ({
  page,
  request,
}) => {
  await configure(request);
  let release: (() => void) | undefined;
  await page.route("**/api/conversations/*/runs", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await page.goto("/");
  await page.getByLabel("任务指令").fill("第一条指令");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByLabel("任务指令").fill("等待期间写好的下一条");
  release!();
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "completed",
  );
  await expect(page.getByLabel("任务指令")).toHaveValue("等待期间写好的下一条");
  await page.reload();
  await expect(page.getByLabel("任务指令")).toHaveValue("等待期间写好的下一条");
});

test("native tree navigation restores the user input and retains both branches", async ({ page, request }) => {
  await configure(request);
  await page.goto("/");
  for (const text of ["会话路径一", "会话路径二"]) {
    await page.getByLabel("任务指令").fill(text);
    await page.getByRole("button", { name: "开始任务", exact: true }).click();
    await expect(page.getByTestId("run-thread").last()).toHaveAttribute("data-run-status", "completed");
  }
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  const original = page.url();
  await page.getByRole("button", { name: "会话与能力", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "会话与能力" });
  await dialog.getByRole("button", { name: /你.*会话路径二/ }).click();
  await dialog.getByRole("button", { name: "从此处继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(original);
  await expect(page.getByLabel("任务指令")).toHaveValue("会话路径二");
  await expect(page.getByTestId("run-thread")).toHaveCount(1);
  await page.getByLabel("任务指令").fill("会话路径三");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute("data-run-status", "completed");
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  await expect(page.getByRole("log")).not.toContainText("会话路径二");
  await page.getByRole("button", { name: "会话与能力", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /你.*会话路径二/ })).not.toContainText("当前路径");
  await expect(dialog.getByRole("button", { name: /你.*会话路径三/ })).toContainText("当前路径");
  await page.screenshot({ path: "test-results/workbench-session-tree.png", animations: "disabled" });
});

test("exposes Pi compaction and retains its summary after reload", async ({ page, request }) => {
  await configure(request);
  await page.goto("/");
  // Pi keeps recent context; use enough history for a real compaction.
  await page.getByLabel("任务指令").fill("咖啡活动记录。\n".repeat(5000));
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute("data-run-status", "completed", { timeout: 15000 });
  const compact = page.getByRole("button", { name: "压缩上下文", exact: true });
  await expect(compact).toBeEnabled();
  const completed = page.waitForResponse((response) => /\/conversations\/[^/]+\/compact$/.test(response.url()));
  await compact.click();
  expect((await completed).ok()).toBeTruthy();
  const dialog = page.getByRole("dialog", { name: "会话与能力" });
  await expect(dialog.getByRole("status")).toHaveText("上下文已压缩");
  await expect(dialog.getByText(/^最近压缩 ·/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "会话与能力", exact: true }).click();
  await dialog.getByRole("tab", { name: "上下文", exact: true }).click();
  await expect(dialog.getByText(/^最近压缩 ·/)).toBeVisible();
  await expect(dialog.getByLabel("压缩时保留的重点（可选）")).toBeVisible();
  await page.screenshot({ path: "test-results/pi-compaction.png", animations: "disabled" });
});

test("workspace navigation retains page filters and the message draft", async ({ page, request }) => {
  await configure(request);
  await page.goto("/");
  await page.getByLabel("任务指令").fill("下次继续整理的草稿");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("textbox", { name: "查找活动", exact: true }).fill("公园");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  const library = page.locator('[data-workbench-page="assets"]');
  await library.getByRole("textbox", { name: "按文件名筛选" }).fill("照片");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "查找活动", exact: true })).toHaveValue("公园");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(library.getByRole("textbox", { name: "按文件名筛选" })).toHaveValue("照片");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByTestId("provider-openai-compatible").getByLabel("模型名称", { exact: true }).fill("尚未保存的名称");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByTestId("provider-openai-compatible").getByLabel("模型名称", { exact: true })).toHaveValue("尚未保存的名称");
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await expect(page.getByLabel("任务指令")).toHaveValue("下次继续整理的草稿");
  await page.getByRole("button", { name: "上传资料", exact: true }).waitFor();
});
