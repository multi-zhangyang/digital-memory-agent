import { test, expect, type APIRequestContext } from "@playwright/test";

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
  await expect(page.getByRole("log")).toContainText("片段 001");
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
  expect(reads.filter((url) => url.endsWith("/session"))).toHaveLength(0);
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  await page.waitForTimeout(250);
  expect(reads.filter((url) => url.endsWith("/session"))).toHaveLength(0);
  await page.getByRole("button", { name: "会话与能力" }).click();
  await expect
    .poll(() => reads.filter((url) => url.endsWith("/session")).length)
    .toBe(1);
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
      { type: "reasoning", text: "核对信息。" },
      {
        type: "tool",
        name: "read",
        toolCallId: "read-" + i,
        state: "complete",
        input: { path: "note.txt" },
        output: "完整记录 " + i,
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
  await page.route("**/api/runs/experience-*/approvals", (route) =>
    route.fulfill({ json: { approvals: [] } }),
  );
  await page.goto("/?task=experience-history");
  await expect(page.getByTestId("run-thread")).toHaveCount(50);
  await expect(page.getByRole("log")).toContainText("上下文压缩已完成");
  await page.getByLabel("任务指令").fill("这条草稿不能丢");
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(60);
  const lastTool = page.getByTestId("tool-activity").last();
  await lastTool.getByRole("button", { name: /读取文件/ }).click();
  await expect(lastTool.getByText("完整记录 59", { exact: true })).toBeVisible();
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect(lastTool.getByText("完整记录 59", { exact: true })).toBeVisible();
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
