import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";

const sourceText = (name: string) => name + "\n\n周六，我在公园散步。";
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
        thinkingLevel: "medium",
      },
    },
  );
  expect(response.ok()).toBeTruthy();
}
async function upload(page: Page, name = "公园散步.txt") {
  await page.getByLabel("附加资料", { exact: true }).setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(sourceText(name)),
  });
  await expect(
    page.getByRole("button", { name: "移除 " + name }),
  ).toBeVisible();
}
async function start(page: Page, text: string) {
  await page.getByLabel("任务指令").fill(text);
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
}
async function settle(page: Page) {
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
    "data-run-status",
    "completed",
    { timeout: 25000 },
  );
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

// Runs against the actual harness, database and SSE endpoints. Only the external model is a fixture.
test("dark workbench preserves drafts, uploads, collections and mobile source navigation", async ({
  page,
  request,
}) => {
  await configure(request);
  const originalConversations = (
    await (await request.get("/api/workspace")).json()
  ).conversations.length;
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByLabel("任务指令").fill("明天继续整理这份资料");
  await upload(page, "草稿资料.txt");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择 草稿资料.txt", exact: true })
    .check();
  await page.getByRole("button", { name: "保存为集合" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("生活记录");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "生活记录", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("任务指令")).toHaveValue("明天继续整理这份资料");
  await expect(
    page.getByRole("button", { name: "移除 草稿资料.txt" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workbench-home.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("combobox").fill("草稿资料");
  await page.getByRole("option", { name: /草稿资料/ }).click();
  await expect(
    page.getByText(sourceText("草稿资料.txt"), { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "草稿资料.txt", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText(sourceText("草稿资料.txt"), { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workbench-mobile-source.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    (await (await request.get("/api/workspace")).json()).conversations,
  ).toHaveLength(originalConversations);
});

test("model configuration and tool access are editable and restored without echoing secrets", async ({
  page,
}) => {
  await page.goto("/?view=settings");
  const form = page.getByTestId("provider-openai-compatible");
  await form
    .getByLabel("接口地址", { exact: true })
    .fill("http://127.0.0.1:4312/v1");
  await form.getByLabel("API key", { exact: true }).fill("test-browser-key");
  await form.getByLabel("模型名称", { exact: true }).fill("browser-test");
  if (!(await form.getByLabel("上下文窗口", { exact: true }).isVisible()))
    await form.getByRole("button", { name: "模型参数" }).click();
  await form.getByLabel("上下文窗口", { exact: true }).fill("256000");
  await form.getByRole("switch", { name: "思考模型" }).check();
  await form.getByRole("combobox", { name: "思考强度" }).click();
  await page.getByRole("option", { name: "max", exact: true }).click();
  await form.getByRole("switch", { name: "启用连接" }).check();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/providers/openai-compatible") &&
      response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "保存并测试" }).click();
  expect(await (await savedResponse).text()).not.toContain("test-browser-key");
  await expect(form.getByRole("status")).toContainText("已连接");
  await expect(form.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.reload();
  await form.getByRole("button", { name: "模型参数" }).click();
  await expect(form.getByRole("combobox", { name: "思考强度" })).toContainText(
    "max",
  );
  await expect(form.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.screenshot({
    path: "test-results/workbench-settings.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("Pi tools create versioned results and proposed memories, then recall the corrected memory in a new task", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto("/");
  await upload(page);
  await start(page, "整理我的公园散步经历");
  await settle(page);
  const taskUrl = page.url();
  await expect(page.getByTestId("tool-activity")).toHaveCount(6);
  const readTool = page.getByTestId("tool-activity").nth(2);
  await readTool.getByRole("button").first().click();
  await expect(
    readTool.getByText(sourceText("公园散步.txt"), { exact: true }),
  ).toBeVisible();
  await page.getByTestId("run-thread").getByRole("button", { name: /公园散步 · 经历整理/ }).click();
  await expect(
    page.getByRole("heading", { name: "经历记录", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workbench-task.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "编辑结果", exact: true }).click();
  await page
    .getByLabel("结果内容", { exact: true })
    .fill("## 经历记录\n\n周日，我在公园散步。\n\n已核对时间。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "结果版本" })).toContainText(
    "v2",
  );
  await page.getByRole("combobox", { name: "结果版本" }).click();
  await page.getByRole("option", { name: "v1 · Agent", exact: true }).click();
  await expect(
    page.getByText("周六，我在公园散步。", { exact: true }).last(),
  ).toBeVisible();
  await page
    .getByTestId("run-thread")
    .getByRole("button", { name: "公园散步 待核对" })
    .click();
  await page.getByRole("button", { name: "确认记住", exact: true }).click();
  await page.getByRole("button", { name: "纠正记忆", exact: true }).click();
  await page
    .getByLabel("记忆内容", { exact: true })
    .fill("周日和姐姐在公园散步。");
  await page.getByLabel("发生时间", { exact: true }).fill("2026-10-04");
  await page
    .getByLabel("纠正原因", { exact: true })
    .fill("本人核对了日期与同行人");
  await page.getByRole("button", { name: "保存纠正", exact: true }).click();
  await expect(
    page.getByText("周日和姐姐在公园散步。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "修订记录", exact: true }).click();
  await expect(
    page.getByText("本人核对了日期与同行人", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await start(page, "回忆我的公园经历");
  await settle(page);
  await expect(
    page
      .getByTestId("run-thread")
      .getByText("周日和姐姐在公园散步。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /已取用.*条记忆/ }),
  ).toBeVisible();
  await page.reload();
  await settle(page);
  await page.goto(taskUrl);
  await settle(page);
  await page.getByRole("button", { name: /任务菜单/ }).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("我的公园记忆");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "我的公园记忆", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "2026-10-04", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workbench-memory.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("refresh reconnects a running task, followups queue, and stopping releases the next run", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto("/");
  await upload(page, "队列测试.txt");
  await start(page, "等待测试，整理所选资料");
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "running",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "停止任务", exact: true }),
  ).toBeVisible();
  await page.getByLabel("任务指令").fill("下一条指令");
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "作为新任务排队", exact: true })
    .click();
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(page.getByText("待执行 · 1")).toBeVisible();
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  await settle(page);
  await expect(page.getByTestId("run-thread").first()).toHaveAttribute(
    "data-run-status",
    "stopped",
  );
  await page.reload();
  await expect(page.getByTestId("run-thread").first()).toHaveAttribute(
    "data-run-status",
    "stopped",
  );
  await expect(
    page.getByTestId("run-thread").last().getByText("OK", { exact: true }),
  ).toBeVisible();
});

test("asks for an answer, resumes the tool, and exposes real provider failures", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto("/");
  await start(page, "提问测试");
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "waiting",
  );
  await page.reload();
  await page.getByRole("button", { name: "周日", exact: true }).click();
  await settle(page);
  await expect(
    page.getByText("已收到你的回答：周日", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await start(page, "错误测试");
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "failed",
    { timeout: 25000 },
  );
  await expect(page.getByTestId("run-thread").getByRole("alert").filter({ hasText: "模型请求失败" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新运行", exact: true }),
  ).toBeEnabled();
});

test("free-text answers preserve Chinese composition and drafts after a failed submission", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await start(page, "提问测试：核对日期");
  const run = page.getByTestId("run-thread");
  await expect(run).toHaveAttribute("data-run-status", "waiting");
  const taskId = new URL(page.url()).searchParams.get("task");
  const detail = await (
    await request.get("/api/conversations/" + taskId + "/workspace")
  ).json();
  const runId = detail.runs[0].id;
  try {
    const input = run.getByLabel("补充回答");
    const answer = "周一，按我的更正记录";
    let submissions = 0;
    await page.route("**/api/runs/*/answer", async (route) => {
      submissions += 1;
      if (submissions === 1) {
        await route.fulfill({
          status: 503,
          json: { error: { message: "回答暂未送达，请重试" } },
        });
      } else {
        await route.continue();
      }
    });
    await input.fill(answer);
    await input.dispatchEvent("compositionstart");
    // A synthetic composition does not start the browser's native IME; dispatch
    // its confirmation key without adding an unrelated textarea newline.
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    await input.dispatchEvent("compositionend");
    await expect(input).toHaveValue(answer);
    expect(submissions).toBe(0);
    await run.getByRole("button", { name: "继续", exact: true }).click();
    await expect(
      run.getByText("回答暂未送达，请重试", { exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue(answer);
    await expect(run).toHaveAttribute("data-run-status", "waiting");
    await page.screenshot({
      path: "test-results/ai-elements-mobile-question.png",
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await input.press("Enter");
    await settle(page);
    expect(submissions).toBe(2);
    await expect(
      run.getByText("已收到你的回答：" + answer, { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(run.getByText(answer, { exact: true })).toBeVisible();
  } finally {
    const current = await (await request.get("/api/runs/" + runId)).json();
    if (["running", "waiting", "queued"].includes(current.run.status)) {
      await request.post("/api/runs/" + runId + "/stop");
    }
  }
});

test("same-origin forwarding preserves uploads larger than 10 MB and byte ranges", async ({
  request,
}) => {
  const bytes = Buffer.alloc(12 * 1024 * 1024, 97);
  const upload = await request.post("/api/assets", {
    multipart: {
      file: {
        name: "large-stream-test.bin",
        mimeType: "application/octet-stream",
        buffer: bytes,
      },
    },
  });
  expect(upload.status()).toBe(201);
  const { asset } = await upload.json();
  expect(asset.size).toBe(bytes.length);
  expect(asset.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const range = await request.get("/api/assets/" + asset.id + "/content", {
    headers: { Range: "bytes=10485760-10485769" },
  });
  expect(range.status()).toBe(206);
  expect(await range.body()).toEqual(bytes.subarray(10485760, 10485770));
});

test("mobile completes a task and confirms its memory in the inspector", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await upload(page, "手机公园记录.txt");
  await start(page, "整理手机公园记录");
  await settle(page);
  await page
    .getByTestId("run-thread")
    .getByRole("button", { name: /公园散步 · 经历整理/ })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "经历记录", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page
    .getByTestId("run-thread")
    .getByRole("button", { name: "公园散步 待核对" })
    .click();
  await page.getByRole("button", { name: "确认记住", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("已确认", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workbench-mobile-memory.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "个人记忆", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
