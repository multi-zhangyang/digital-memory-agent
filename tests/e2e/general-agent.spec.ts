import { test, expect, type APIRequestContext } from "@playwright/test";
async function setup(request: APIRequestContext) {
  await request.post("/api/settings/providers/openai-compatible", {
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
  });
}
test("general workspace creates a project, imports data, executes a script and reviews and reverts actual changes", async ({
  page,
  request,
}) => {
  await setup(request);
  await page.goto("/");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("数据工作区");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  await page.getByLabel("导入项目文件").setInputFiles({
    name: "input.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("amount\n2\n5\n"),
  });
  await expect(
    page
      .getByTestId("project-workspace")
      .getByText("input.csv", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("任务指令").fill("通用任务测试：计算 input.csv 的总额");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
    "data-run-status",
    "completed",
    { timeout: 25000 },
  );
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await expect(page.getByTestId("tool-activity")).toHaveCount(4);
  const command = page.getByTestId("tool-activity").filter({
    has: page.getByRole("button", { name: /执行命令 · python3 sum.py/ }),
  });
  await command.getByRole("button", { name: /执行命令/ }).click();
  await expect(command.getByText("PROCESSING", { exact: false })).toBeVisible();
  await expect(
    command.getByRole("button", { name: "复制终端输出" }),
  ).toBeVisible();
  await command.getByRole("tab", { name: "参数", exact: true }).click();
  await expect(
    command.getByRole("heading", { name: "参数", exact: true }),
  ).toBeVisible();
  await expect(
    command.getByText('"python3 sum.py"', { exact: true }),
  ).toBeVisible();
  await command.getByRole("button", { name: /执行命令/ }).click();
  await expect(
    page.getByRole("button", { name: "思考过程" }).first(),
  ).toBeVisible();
  const pane = page.getByTestId("project-workspace");
  await pane.getByRole("tab", { name: /改动/ }).click();
  await expect(
    pane.getByRole("option", { name: "result.json 新增", exact: true }),
  ).toBeVisible();
  await pane
    .getByRole("option", { name: "result.json 新增", exact: true })
    .click();
  await expect(pane.getByText('"total"', { exact: false })).toBeVisible();
  await page.screenshot({
    path: "test-results/general-agent-changes.png",
    fullPage: true,
    animations: "disabled",
  });
  await pane.getByRole("tab", { name: "终端", exact: true }).click();
  await expect(pane.getByText("PROCESSING", { exact: false })).toBeVisible();
  await pane.getByRole("tab", { name: "文件", exact: true }).click();
  await pane.getByText("result.json", { exact: true }).first().click();
  await pane.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文件内容").fill('{"total":8}');
  await pane.getByRole("button", { name: "保存", exact: true }).click();
  await pane.getByRole("tab", { name: /改动/ }).click();
  await pane
    .getByRole("button", { name: "回退 result.json", exact: true })
    .click();
  await expect(pane.getByRole("alert")).toContainText("后续修改");
  await pane.getByRole("option", { name: "sum.py 新增", exact: true }).click();
  await pane.getByRole("button", { name: "回退 sum.py", exact: true }).click();
  await expect(
    pane.getByRole("option", { name: "sum.py 新增", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "completed",
  );
  const previousUrl = page.url();
  await page.getByRole("button", { name: "从这里分支", exact: true }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(
    page
      .getByRole("log")
      .getByText("通用任务测试：计算 input.csv 的总额", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/projects")).json()).projects.some(
      (p: any) => p.name === "数据工作区",
    ),
  ).toBe(true);
});
test("frontend approval blocks execution and native steering reaches an active Pi run", async ({
  page,
  request,
}) => {
  await setup(request);
  await page.goto("/");
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "询问", exact: true }).click();
  await page.getByLabel("任务指令").fill("权限测试");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("agent-approval")).toBeVisible();
  const taskId = new URL(page.url()).searchParams.get("task");
  expect(
    (
      await request.patch("/api/conversations/" + taskId, {
        data: { title: "检查项目文件写入审批与移动端长标题的完整操作流程" },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.getByTestId("agent-approval")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const stop = page.getByRole("button", { name: "停止任务", exact: true });
  await expect(stop).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "打开终端输出", exact: true }),
  ).toBeInViewport();
  const stopBounds = await stop.boundingBox();
  expect(stopBounds!.x + stopBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/general-agent-mobile-approval.png",
    animations: "disabled",
  });
  await page
    .getByTestId("agent-approval")
    .getByRole("button", { name: "允许本次" })
    .click();
  await expect(page.getByTestId("run-thread")).toHaveAttribute(
    "data-run-status",
    "completed",
  );
  await page.reload();
  await expect(page.getByTestId("agent-approval")).toHaveAttribute(
    "data-approval-status",
    "approved",
  );
  await expect(
    page.getByTestId("agent-approval").getByText("已允许", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "自动", exact: true }).click();
  await page.getByLabel("任务指令").fill("纠偏测试");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  const liveTrace = page
    .getByTestId("run-thread")
    .last()
    .getByRole("button", { name: "执行记录", exact: true });
  await expect(liveTrace).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-activity").last()).toHaveAttribute(
    "data-tool-state",
    "running",
  );
  await page.getByLabel("任务指令").fill("改为输出简短确认");
  await page.getByRole("button", { name: "立即补充指令" }).click();
  await expect(page.getByText("已送达", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
    "data-run-status",
    "completed",
  );
  await expect(
    page.getByText("已按新指令调整。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/general-agent-approval-steering.png",
    fullPage: true,
    animations: "disabled",
  });
});
