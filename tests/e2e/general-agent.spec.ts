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
  await page.getByRole("button", { name: "工作区选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建工作目录", exact: true }).click();
  await page.getByLabel("项目名称").fill("数据工作区");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByTestId("project-workspace")).toBeVisible();
  const created = (await (await request.get("/api/projects")).json()).projects.find((item: { name: string }) => item.name === "数据工作区");
  await expect(page.getByTestId("workspace-directory")).toHaveText(created.directory);
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
  await expect(page.getByTestId("tool-activity")).toHaveCount(6);
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
    command.getByRole("tab", { name: "参数", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(
    command.getByText('"python3 sum.py"', { exact: true }),
  ).toBeVisible();
  await command.getByRole("button", { name: /执行命令/ }).click();
  await expect(
    page.getByRole("button", { name: "思考过程" }).first(),
  ).toBeVisible();
  const pane = page.getByTestId("project-workspace").filter({ visible: true });
  await page.getByRole("button", { name: "工作区选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "审阅文件改动", exact: true }).click();
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
  await page.getByRole("button", { name: "工作区选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "打开终端输出", exact: true }).click();
  await expect(pane.getByText("PROCESSING", { exact: false })).toBeVisible();
  await page.getByTestId("work-surface").getByRole("tab", { name: "文件", exact: true }).click();
  await pane.getByText("result.json", { exact: true }).first().click();
  await pane.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文件内容").fill('{"total":8}');
  await page.getByTestId("work-surface").getByRole("tab", { name: "文件", exact: true }).click();
  await pane.getByText("input.csv", { exact: true }).first().click();
  await expect(page.getByTestId("work-surface").getByRole("tab", { name: "input.csv", exact: true })).toHaveAttribute("data-state", "active");
  await page.getByTestId("work-surface").getByRole("tab", { name: "result.json", exact: true }).click();
  await expect(page.getByLabel("文件内容")).toHaveValue('{"total":8}');
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect(page.getByLabel("文件内容")).toHaveValue('{"total":8}');
  await pane.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "工作区选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "审阅文件改动", exact: true }).click();
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
  await page.getByRole("button", { name: "会话与能力", exact: true }).click();
  const controls = page.getByRole("dialog", { name: "会话与能力" });
  await controls.getByRole("tab", { name: "能力", exact: true }).click();
  await expect(controls.getByText("read", { exact: true })).toBeVisible();
  await controls.getByRole("tab", { name: "会话树", exact: true }).click();
  await controls.getByRole("button", { name: /你.*通用任务测试/ }).click();
  await controls.getByRole("button", { name: "新建分支会话", exact: true }).click();
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

test("shows an interrupted tool decision after reload and resumes the same run without repeating the skipped operation", async ({ page, request }) => {
  await setup(request);
  await page.goto("/");
  await page.getByRole("button", { name: "任务设置", exact: true }).click();
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "自动", exact: true }).click();
  await page.getByRole("dialog", { name: "任务设置" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("任务指令").fill("纠偏测试：检查中断后的恢复决定");
  const submitted = page.waitForResponse((response) => /\/api\/conversations\/[^/]+\/runs$/.test(response.url()) && response.request().method() === "POST");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  const run = (await (await submitted).json()).run;
  const thread = page.locator(`#run-${run.id}`);
  await expect(thread.getByTestId("tool-activity")).toHaveAttribute("data-tool-state", "running");
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(thread).toHaveAttribute("data-run-status", "stopped");
  await page.reload();
  const recovery = thread.getByTestId("run-recovery");
  await expect(recovery.getByText("核对中断操作后继续")).toBeVisible();
  await expect(recovery.getByText("本次跳过此工具", { exact: true })).toHaveAttribute("data-state", "on");
  await page.setViewportSize({ width: 390, height: 844 });
  await recovery.getByRole("button", { name: "继续任务", exact: true }).scrollIntoViewIfNeeded();
  await expect(recovery.getByRole("button", { name: "继续任务", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/living-memory-recovery-390.png", animations: "disabled" });
  await recovery.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect(thread).toHaveAttribute("data-run-status", "completed", { timeout: 15000 });
  const finished = (await (await request.get(`/api/runs/${run.id}`)).json()).run;
  expect(finished.recovery.decisions).toHaveLength(1);
  expect(finished.recovery.decisions[0].action).toBe("skip");
  expect(finished.parts.filter((part: { type: string; name?: string }) => part.type === "tool" && part.name === "bash")).toHaveLength(1);
});
test("frontend approval blocks execution and native steering reaches an active Pi run", async ({
  page,
  request,
}) => {
  await setup(request);
  await page.goto("/");
  await page.getByRole("button", { name: "任务设置", exact: true }).click();
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "询问", exact: true }).click();
  await page.getByRole("dialog", { name: "任务设置" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("任务指令").fill("权限测试");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("agent-approval")).toBeVisible({ timeout: 15000 });
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
  await page.getByRole("button", { name: "工作区选项", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "打开终端输出", exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");
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
  await expect(page.getByTestId("tool-activity").filter({ has: page.getByRole("button", { name: /写入文件/ }) })).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("agent-approval")).toHaveAttribute(
    "data-approval-status",
    "approved",
  );
  await expect(
    page.getByTestId("agent-approval").getByText("已允许", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "任务设置", exact: true }).click();
  await page.getByRole("combobox", { name: "本次权限" }).click();
  await page.getByRole("option", { name: "自动", exact: true }).click();
  await page.getByRole("dialog", { name: "任务设置" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("任务指令").fill("纠偏测试");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  await expect(page.getByTestId("tool-activity").last()).toHaveAttribute(
    "data-tool-state",
    "running",
  );
  await page.getByLabel("任务指令").fill("改为输出简短确认");
  await page.getByRole("button", { name: "调整当前任务" }).click();
  await expect(page.getByTestId("execution-timeline").getByText("改为输出简短确认", { exact: true })).toBeVisible({ timeout: 15000 });
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
