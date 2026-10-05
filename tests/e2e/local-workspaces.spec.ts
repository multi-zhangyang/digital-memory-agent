import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

test("opens an existing folder, edits originals, runs Pi there and reopens the same persistent project", async ({
  page,
  request,
}) => {
  const parent = await mkdtemp(join(tmpdir(), "digital-memory-folders-"));
  const directory = join(parent, "旅行资料");
  try {
    await mkdir(directory);
    await Promise.all(
      ["笔记", "待整理", ".hidden"].map((name) => mkdir(join(parent, name))),
    );
    await writeFile(join(directory, "input.csv"), "amount\n2\n5\n");
    await writeFile(join(directory, "notes.md"), "原始记录");
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
    let releaseInitialListing!: () => void;
    const listingGate = new Promise<void>((resolve) => {
      releaseInitialListing = resolve;
    });
    await page.route("**/api/directories?**", async (route) => {
      if (!new URL(route.request().url()).searchParams.has("path")) {
        const response = await route.fetch();
        await listingGate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开本地文件夹", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "打开文件夹" });
    const pathInput = picker.getByLabel("文件夹路径", { exact: true });
    await pathInput.focus();
    await pathInput.press("Control+a");
    const initialListing = page.waitForResponse(
      (response) =>
        response.url().includes("/api/directories?") &&
        !new URL(response.url()).searchParams.has("path"),
    );
    releaseInitialListing();
    await initialListing;
    await pathInput.pressSequentially(parent);
    await expect(pathInput).toHaveValue(parent);
    await picker.getByLabel("文件夹路径", { exact: true }).press("Enter");
    await expect(
      picker.getByRole("option", { name: "旅行资料", exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByRole("option", { name: ".hidden", exact: true }),
    ).toHaveCount(0);
    await picker.getByRole("button", { name: "显示隐藏文件夹" }).click();
    await expect(
      picker.getByRole("option", { name: ".hidden", exact: true }),
    ).toBeVisible();
    await picker.getByLabel("筛选文件夹").fill("旅行");
    await expect(picker.getByRole("option")).toHaveCount(1);
    await picker.getByLabel("筛选文件夹").fill("");
    await expect(picker.getByRole("option")).toHaveCount(4);
    await page.screenshot({
      path: "test-results/local-folder-picker.png",
      animations: "disabled",
    });
    await picker.getByRole("option", { name: "旅行资料", exact: true }).click();
    await expect(picker.getByLabel("文件夹路径", { exact: true })).toHaveValue(
      directory,
    );
    await expect(picker.getByText("没有子文件夹")).toBeVisible();
    await picker.getByRole("button", { name: "上级目录" }).click();
    await expect(
      picker.getByRole("option", { name: "旅行资料", exact: true }),
    ).toBeVisible();
    await picker.getByRole("option", { name: "旅行资料", exact: true }).click();
    await picker
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    await expect(picker).not.toBeVisible();
    const pane = page.getByTestId("project-workspace");
    await expect(pane.getByTestId("workspace-directory")).toHaveText(directory);
    await pane.getByText("notes.md", { exact: true }).click();
    await expect(pane.getByText("原始记录", { exact: true })).toBeVisible();
    await pane.getByRole("button", { name: "编辑", exact: true }).click();
    await pane.getByLabel("文件内容").fill("直接保存到原文件夹");
    await pane.getByLabel("文件内容").press("Control+s");
    await expect
      .poll(() => readFile(join(directory, "notes.md"), "utf8"))
      .toBe("直接保存到原文件夹");
    await page
      .getByLabel("任务指令")
      .fill("通用任务测试：计算 input.csv 的总额");
    await page.getByRole("button", { name: "开始任务", exact: true }).click();
    await expect(page.getByTestId("run-thread").last()).toHaveAttribute(
      "data-run-status",
      "completed",
      { timeout: 25000 },
    );
    expect(
      JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
    ).toEqual({ total: 7 });
    const taskUrl = page.url();
    const before = (await (await request.get("/api/projects")).json()).projects;
    const project = before.find(
      (item: { directory: string }) => item.directory === directory,
    );
    expect(project.directoryKind).toBe("local");
    await page.getByTestId("work-surface").getByRole("tab", { name: "文件", exact: true }).click();
    await page.screenshot({
      path: "test-results/local-folder-workspace.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "工作区选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开本地文件夹", exact: true }).click();
    await expect(picker.getByLabel("文件夹路径", { exact: true })).toHaveValue(
      directory,
    );
    await picker
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByTestId("work-surface").getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("data-state", "active");
    const after = (await (await request.get("/api/projects")).json()).projects;
    expect(after).toHaveLength(before.length);
    expect(
      after.find((item: { directory: string }) => item.directory === directory)
        .id,
    ).toBe(project.id);
    await page.reload();
    await page.getByRole("button", { name: "工作区选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "工作目录", exact: true }).hover();
    await expect(page.getByRole("menuitemradio", { name: "打开项目 旅行资料", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.goto(taskUrl);
    await expect(page.getByTestId("run-thread")).toHaveAttribute(
      "data-run-status",
      "completed",
    );
    await expect(page.getByTestId("workspace-directory")).toHaveText(directory);
    await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
    await page.getByRole("button", { name: "切换工作区", exact: true }).click();
    await expect(page.getByTestId("workspace-directory")).toHaveText(directory);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("opens a pasted folder path on mobile and keeps errors and cancellation in the picker", async ({
  page,
  request,
}) => {
  const directory = await mkdtemp(
    join(tmpdir(), "digital-memory-mobile-folder-"),
  );
  try {
    await writeFile(join(directory, "原件.txt"), "本地文件");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开本地文件夹", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "打开文件夹" });
    await picker
      .getByLabel("文件夹路径", { exact: true })
      .fill(join(directory, "missing"));
    await picker
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    await expect(picker.getByRole("alert")).toContainText("文件夹不存在");
    await expect(picker.getByLabel("文件夹路径", { exact: true })).toHaveValue(
      join(directory, "missing"),
    );
    await picker
      .getByLabel("文件夹路径", { exact: true })
      .fill('"' + directory + '"');
    await expect(
      picker.getByRole("button", { name: "打开文件夹", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: "test-results/local-folder-mobile.png",
      animations: "disabled",
    });
    const bounds = await picker.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await picker
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByTestId("workspace-directory")).toHaveText(directory);
    await expect(
      page
        .getByTestId("project-workspace")
        .getByText("原件.txt", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "关闭工作区", exact: true })
      .click();
    await page.keyboard.press("Control+o");
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect(picker).not.toBeVisible();
    expect(
      (await (await request.get("/api/projects")).json()).projects.filter(
        (p: { name: string }) => p.name === basename(directory),
      ),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
