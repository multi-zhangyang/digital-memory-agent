import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function configure(
  request: APIRequestContext,
  id = "openai-compatible",
  modelName = "browser-test",
) {
  const response = await request.post("/api/settings/providers/" + id, {
    data: {
      enabled: true,
      baseUrl: "http://127.0.0.1:4312/v1",
      modelName,
      apiKey: "test-browser-key",
      protocol: "openai-completions",
      contextWindow: 256000,
      maxTokens: 16384,
      reasoning: true,
      thinkingLevel: "low",
    },
  });
  expect(response.ok()).toBeTruthy();
}
async function complete(page: Page) {
  await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
    "data-run-status",
    "completed",
    { timeout: 25000 },
  );
}

test("all-task list spans work directories, searches older tasks and restores and pins an archived task", async ({
  page,
  request,
}) => {
  await configure(request);
  const { project } = await (
    await request.post("/api/projects", { data: { name: "任务管理" } })
  ).json();
  let archivedId = "";
  for (let i = 0; i < 26; i++) {
    const { conversation } = await (
      await request.post("/api/conversations", {
        data: { projectId: project.id },
      })
    ).json();
    await request.patch("/api/conversations/" + conversation.id, {
      data: {
        title: `工作记录 ${String(i).padStart(2, "0")}`,
        archived: i === 0,
      },
    });
    if (!i) archivedId = conversation.id;
  }
  const other = (await (await request.post("/api/conversations", { data: { projectId: "default" } })).json()).conversation;
  await request.patch("/api/conversations/" + other.id, { data: { title: "另一个工作目录的任务" } });
  await page.goto("/");
  await page.getByLabel("任务指令", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "打开项目 任务管理", exact: true })
    .click();
  await page.getByRole("button", { name: "所有任务", exact: true }).click();
  const launcher = page.getByTestId("task-library");
  await launcher.getByRole("tab", { name: "已归档", exact: true }).click();
  await launcher
    .getByRole("button", { name: "管理任务 工作记录 00", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "取消归档", exact: true }).click();
  await expect(
    launcher.getByRole("button", { name: "工作记录 00", exact: true }),
  ).toHaveCount(0);
  await launcher.getByRole("tab", { name: "最近", exact: true }).click();
  await expect(launcher.getByRole("button", { name: "另一个工作目录的任务", exact: true })).toBeVisible();
  await page.getByLabel("搜索任务", { exact: true }).fill("记录 00");
  await expect(
    launcher.getByRole("button", { name: "工作记录 00", exact: true }),
  ).toBeVisible();
  await launcher
    .getByRole("button", { name: "管理任务 工作记录 00", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "收藏", exact: true }).click();
  await expect(
    page
      .getByTestId("workbench-navigation")
      .getByRole("button", { name: "工作记录 00", exact: true }),
  ).toHaveAttribute("data-pinned", "true");
  await page.getByLabel("搜索任务", { exact: true }).fill("工作记录");
  await launcher.getByRole("button", { name: "加载更多任务" }).click();
  await expect(launcher.locator("tbody").getByRole("row")).toHaveCount(26);
  await page.screenshot({
    path: "test-results/rebuild-task-management.png",
    animations: "disabled",
  });
  await page.reload();
  const saved = (
    await (await request.get("/api/workspace")).json()
  ).conversations.find((item: any) => item.id === archivedId);
  expect(saved.archived).toBe(false);
  expect(saved.pinned).toBe(true);
  await expect(
    page
      .getByTestId("workbench-navigation")
      .getByRole("button", { name: "工作记录 00", exact: true }),
  ).toBeVisible();
});

test("native model selector, reasoning and clipboard attachment reach the actual run payload", async ({
  page,
  request,
}) => {
  await configure(request);
  await configure(request, "ui-secondary", "ui-fast");
  await page.goto("/");
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByPlaceholder("搜索模型或供应商…").fill("ui-fast");
  await page.getByRole("option", { name: /ui-fast/ }).click();
  await expect(
    page.getByRole("button", { name: "选择对话模型", exact: true }),
  ).toContainText("ui-fast");
  await page.getByRole("combobox", { name: "思考强度", exact: true }).click();
  await page.getByRole("option", { name: "max", exact: true }).click();
  await page.getByRole("combobox", { name: "本次权限", exact: true }).click();
  await page.getByRole("option", { name: "只读", exact: true }).click();
  await page.getByLabel("任务指令", { exact: true }).evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["剪贴板内容"], "clipboard-note.txt", { type: "text/plain" }),
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(
    page.getByRole("button", { name: "移除 clipboard-note.txt" }),
  ).toBeVisible();
  await page.getByLabel("任务指令", { exact: true }).fill("验证模型设置与附件");
  const sent = page.waitForRequest(
    (req) => req.url().endsWith("/runs") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.modelId).toBe("ui-secondary/ui-fast");
  expect(body.thinkingLevel).toBe("max");
  expect(body.permissionMode).toBe("read");
  expect(body.assetIds).toHaveLength(1);
  expect(body.scope).toBe("selected");
  await complete(page);
  const taskUrl = page.url();
  await page.getByLabel("任务指令", { exact: true }).fill("保留在原任务的草稿");
  await page.keyboard.press("Control+Shift+O");
  await expect(page.getByTestId("task-launcher")).toBeVisible();
  await page.goto(taskUrl);
  await expect(page.getByLabel("任务指令", { exact: true })).toHaveValue(
    "保留在原任务的草稿",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await expect(page.getByLabel("任务指令", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/rebuild-mobile-navigation.png",
    animations: "disabled",
  });
});

test("historical changes open the correct run, export a real patch and preserve edited code previews", async ({
  page,
  request,
}) => {
  await configure(request);
  const { project } = await (
    await request.post("/api/projects", { data: { name: "差异审阅" } })
  ).json();
  expect(
    (
      await request.put(`/api/projects/${project.id}/file`, {
        data: { path: "input.csv", content: "amount\n2\n5\n", hash: null },
      })
    ).ok(),
  ).toBe(true);
  const { conversation } = await (
    await request.post("/api/conversations", {
      data: { projectId: project.id },
    })
  ).json();
  await page.goto("/?task=" + conversation.id);
  await page
    .getByLabel("任务指令", { exact: true })
    .fill("通用任务测试：第一轮");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await complete(page);
  const input = await (
    await request.get(`/api/projects/${project.id}/file?path=input.csv`)
  ).json();
  expect(
    (
      await request.put(`/api/projects/${project.id}/file`, {
        data: {
          path: "input.csv",
          content: "amount\n9\n1\n",
          hash: input.hash,
        },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByLabel("任务指令", { exact: true })
    .fill("通用任务测试：第二轮");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect(page.getByTestId("run-thread")).toHaveCount(2);
  await complete(page);
  const result = await (
    await request.get(`/api/projects/${project.id}/file?path=result.json`)
  ).json();
  expect(JSON.parse(result.content).total).toBe(10);
  await page
    .getByTestId("run-thread")
    .first()
    .getByRole("button", { name: "审阅 result.json", exact: true })
    .click();
  const pane = page.getByTestId("project-workspace");
  await expect(
    pane.getByRole("combobox", { name: "选择变更轮次" }),
  ).toContainText("第一轮");
  const diff = pane.getByRole("tabpanel", { name: "差异", exact: true });
  await expect(diff.locator("pre")).toContainText('{"total": 7}');
  const download = page.waitForEvent("download");
  await pane
    .getByRole("button", { name: "导出补丁 result.json", exact: true })
    .click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe("result.json.patch");
  const chunks = [];
  for await (const chunk of (await downloaded.createReadStream())!)
    chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain('+{"total": 7}');
  await pane.getByRole("combobox", { name: "选择变更轮次" }).click();
  await page.getByRole("option", { name: "最近一次任务", exact: true }).click();
  await expect(diff.locator("pre")).toContainText('{"total": 7}');
  await expect(diff.locator("pre")).toContainText('{"total": 10}');
  await pane.getByRole("button", { name: "并排对比", exact: true }).click();
  await expect(diff.locator("pre")).toHaveAttribute("data-diff-type", "split");
  await expect(diff.locator("[data-code][data-deletions]")).toContainText(
    '{"total": 7}',
  );
  await expect(diff.locator("[data-code][data-additions]")).toContainText(
    '{"total": 10}',
  );
  await pane.getByRole("button", { name: "逐行对比", exact: true }).click();
  await expect(diff.locator("pre")).toHaveAttribute("data-diff-type", "single");
  await page.screenshot({
    path: "test-results/rebuild-file-review.png",
    animations: "disabled",
  });
  const original = JSON.stringify({
    prefix: "x".repeat(150),
    value: "before",
    suffix: "y".repeat(150),
  });
  expect(
    (
      await request.put(`/api/projects/${project.id}/file`, {
        data: { path: "preview.json", content: original, hash: null },
      })
    ).ok(),
  ).toBe(true);
  await pane.getByRole("tab", { name: "文件", exact: true }).click();
  await pane.getByRole("button", { name: "刷新项目文件", exact: true }).click();
  await pane.getByText("preview.json", { exact: true }).click();
  await expect(
    pane.locator('pre span[style*="--shiki-dark"]').first(),
  ).toBeVisible();
  await pane.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByLabel("文件内容", { exact: true })
    .fill(original.replace("before", "after!"));
  await pane.getByRole("button", { name: "关闭项目面板", exact: true }).click();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect(page.getByLabel("文件内容", { exact: true })).toHaveValue(
    original.replace("before", "after!"),
  );
  await page.getByLabel("文件内容", { exact: true }).press("Control+s");
  await expect(
    pane.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(pane.locator("pre")).toContainText('"after!"');
  await expect(pane.locator("pre")).not.toContainText('"before"');
});
