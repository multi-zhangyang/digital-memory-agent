import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function setup(request: APIRequestContext, name: string) {
  const config = await request.post(
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
  expect(config.ok()).toBeTruthy();
  const { project } = await (
    await request.post("/api/projects", { data: { name } })
  ).json();
  for (const [path, content] of [
    ["notes/context.md", "项目约定：保留来源与日期。"],
    ["src/config.ts", 'export const name = "digital memory";'],
    ["input.csv", "amount\n2\n5\n"],
  ]) {
    const response = await request.put(`/api/projects/${project.id}/file`, {
      data: { path, content, hash: null },
    });
    expect(response.ok()).toBeTruthy();
  }
  return project;
}
async function completed(page: Page) {
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
    "data-run-status",
    "completed",
    { timeout: 25000 },
  );
}

test("inline file and command completion preserves focus and sends real project references; quick open keeps the draft", async ({
  page,
  request,
}) => {
  const project = await setup(request, "文件上下文");
  await page.goto("/");
  await page
    .getByRole("button", { name: "打开项目 文件上下文", exact: true })
    .click();
  const input = page.getByLabel("任务指令", { exact: true });
  await input.fill("检查 @cont");
  const suggestions = page.getByRole("listbox", { name: "文件引用建议" });
  await expect(
    suggestions.getByRole("option", { name: "notes/context.md", exact: true }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  await page.screenshot({
    path: "test-results/workflows-file-context.png",
    animations: "disabled",
  });
  await input.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        keyCode: 229,
      }),
    );
  });
  await expect(input).toHaveValue("检查 @cont");
  await expect(suggestions).toBeVisible();
  await input.press("Enter");
  await expect(suggestions).not.toBeVisible();
  await expect(input).toHaveValue("检查 ");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("file-reference-chips")).toContainText(
    "notes/context.md",
  );
  await input.pressSequentially("请按约定分析");
  await page.keyboard.press("Control+p");
  const picker = page.getByRole("dialog", { name: "快速打开文件" });
  await picker.getByLabel("搜索项目文件").fill("config");
  await picker.getByLabel("搜索项目文件").press("Enter");
  await expect(picker).not.toBeVisible();
  await expect(page.getByTestId("project-workspace")).toContainText(
    'export const name = "digital memory";',
  );
  await expect(input).toHaveValue("检查 请按约定分析");
  await input.fill("/rev");
  await expect(page.getByRole("listbox", { name: "命令建议" })).toContainText(
    "/review",
  );
  await input.press("Enter");
  await expect(input).toHaveValue("/review ");
  await input.press("Enter");
  await expect(page.getByRole("tab", { name: /^改动/ })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("file-reference-chips")).toContainText(
    "notes/context.md",
  );
  await input.fill("文件引用验证");
  const sent = page.waitForRequest(
    (req) => req.url().endsWith("/runs") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  expect((await sent).postDataJSON().fileReferences).toEqual([
    { path: "notes/context.md" },
  ]);
  await completed(page);
  await expect(page.getByTestId("file-reference-chips")).toHaveCount(0);
  await expect(page.getByTestId("message-file-references")).toContainText(
    "notes/context.md",
  );
  const conversationId = new URL(page.url()).searchParams.get("task");
  const detail = await (
    await request.get(`/api/conversations/${conversationId}/workspace`)
  ).json();
  expect(detail.conversation.projectId).toBe(project.id);
  expect(detail.runs).toHaveLength(1);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("文件引用验证");
  await expect(page.getByTestId("file-reference-chips")).toContainText(
    "notes/context.md",
  );
  await page.keyboard.press("Control+j");
  await expect(
    page.getByRole("tab", { name: "终端", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("project-workspace")).not.toBeVisible();
});

test("review comments include their historical file version, preserve draft text, and viewed state survives reload", async ({
  page,
  request,
}) => {
  const project = await setup(request, "审阅流程");
  const { conversation } = await (
    await request.post("/api/conversations", {
      data: { projectId: project.id },
    })
  ).json();
  await request.post(`/api/conversations/${conversation.id}/runs`, {
    data: {
      text: "通用任务测试：计算数据",
      modelId: "openai-compatible/browser-test",
      permissionMode: "auto",
    },
  });
  await page.goto("/?task=" + conversation.id);
  await completed(page);
  const run = (
    await (
      await request.get(`/api/conversations/${conversation.id}/workspace`)
    ).json()
  ).runs[0];
  const input = page.getByLabel("任务指令", { exact: true });
  await input.fill("请保留计算逻辑");
  await page
    .getByRole("button", { name: "审阅 result.json", exact: true })
    .click();
  const pane = page.getByTestId("project-workspace");
  await expect(
    pane.getByRole("region", { name: "文件差异 result.json" }),
  ).toBeVisible();
  await expect(
    pane.getByRole("option", { name: "result.json 新增", exact: true }),
  ).toBeInViewport();
  await expect(
    pane.getByRole("button", { name: "评论 result.json", exact: true }),
  ).toBeInViewport();
  await pane.getByRole("option", { name: "sum.py 新增", exact: true }).hover();
  await expect(
    pane.getByRole("region", { name: "文件差异 result.json" }),
  ).toBeVisible();
  const fileList = pane.locator('[data-slot="command"]');
  await fileList.focus();
  await fileList.press("Home");
  await fileList.press("ArrowDown");
  await expect(
    pane.getByRole("region", { name: "文件差异 result.json" }),
  ).toBeVisible();
  await fileList.press("Enter");
  await expect(
    pane.getByRole("region", { name: "文件差异 sum.py" }),
  ).toBeVisible();
  await pane
    .getByRole("option", { name: "result.json 新增", exact: true })
    .click();
  await pane
    .getByRole("checkbox", { name: "已查看 result.json", exact: true })
    .check();
  await pane.getByRole("button", { name: "展开工作区" }).click();
  await expect(pane.getByRole("button", { name: "恢复分栏" })).toBeVisible();
  await page.screenshot({
    path: "test-results/workflows-review-expanded.png",
    animations: "disabled",
  });
  await pane
    .getByRole("button", { name: "评论 result.json", exact: true })
    .click();
  await page.getByLabel("审阅意见", { exact: true }).fill("请补充单位字段");
  await page.getByRole("button", { name: "加入对话", exact: true }).click();
  await expect(input).toHaveValue(
    "请保留计算逻辑\n\nresult.json：\n请补充单位字段",
  );
  await expect(input).toBeVisible();
  await expect(page.getByTestId("file-reference-chips")).toContainText(
    "result.json",
  );
  await page.screenshot({
    path: "test-results/workflows-review-conversation.png",
    animations: "disabled",
  });
  await page.reload();
  await expect(input).toHaveValue(
    "请保留计算逻辑\n\nresult.json：\n请补充单位字段",
  );
  await page
    .getByRole("button", { name: "审阅 result.json", exact: true })
    .click();
  await expect(
    pane.getByRole("checkbox", { name: "已查看 result.json", exact: true }),
  ).toBeChecked();
  const sent = page.waitForRequest(
    (req) => req.url().endsWith("/runs") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  expect((await sent).postDataJSON().fileReferences).toEqual([
    { path: "result.json", runId: run.id },
  ]);
  await completed(page);
  await page.getByTestId("message-file-references").getByRole("button").click();
  await expect(
    pane.getByRole("region", { name: "文件差异 result.json" }),
  ).toBeVisible();
  await expect(
    pane.getByRole("tabpanel", { name: "差异", exact: true }).locator("pre"),
  ).toContainText('"total": 7');
});

test("project navigation and command actions work on desktop and mobile without losing per-project drafts", async ({
  page,
  request,
}) => {
  const project = await setup(request, "项目一");
  await setup(request, "项目二");
  const title =
    "这是一项较长的项目任务名称，用于检查侧栏标题、状态和操作菜单是否保持在工作台范围内";
  const { conversation } = await (
    await request.post("/api/conversations", {
      data: { projectId: project.id },
    })
  ).json();
  await request.patch("/api/conversations/" + conversation.id, {
    data: { title },
  });
  await page.goto("/");
  const input = page.getByLabel("任务指令", { exact: true });
  await page
    .getByRole("button", { name: "打开项目 项目一", exact: true })
    .click();
  const row = await page
    .getByRole("button", { name: title, exact: true })
    .boundingBox();
  const sidebarBounds = await page
    .getByTestId("workbench-navigation")
    .boundingBox();
  expect(row!.x + row!.width).toBeLessThanOrEqual(
    sidebarBounds!.x + sidebarBounds!.width,
  );
  await input.fill("项目一未发送的指令");
  await page
    .getByRole("button", { name: "在 项目二 新建任务", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("项目二未发送的指令");
  await page
    .getByRole("button", { name: "打开项目 项目一", exact: true })
    .click();
  await expect(input).toHaveValue("项目一未发送的指令");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("搜索任务、资料、结果、记忆…").fill("快速打开");
  await page.getByRole("option", { name: /快速打开文件/ }).click();
  await expect(
    page.getByRole("dialog", { name: "快速打开文件" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("项目一未发送的指令");
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("请读取 @cont");
  await page
    .getByRole("option", { name: "notes/context.md", exact: true })
    .click();
  await expect(input).toHaveValue("请读取 ");
  await expect(page.getByTestId("file-reference-chips")).toContainText(
    "notes/context.md",
  );
  await page.screenshot({
    path: "test-results/workflows-mobile-context.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  const sidebar = page.getByRole("dialog");
  await sidebar
    .getByRole("button", { name: "打开项目 项目二", exact: true })
    .click();
  await expect(sidebar).not.toBeVisible();
  await expect(input).toHaveValue("项目二未发送的指令");
});
