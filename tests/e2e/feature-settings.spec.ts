import { test, expect } from "@playwright/test";

// HTTP fixtures verify the real settings/API path; no model quality claim.
test("users configure feature services, test without saving, and restore masked keys", async ({ page, request }) => {
  await page.goto("/?view=settings");
  const panel = page.getByTestId("feature-model-settings");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "文字嵌入 未启用" }).click();
  await panel.getByLabel("服务地址", { exact: true }).fill("http://127.0.0.1:4312/v1");
  await panel.getByLabel("模型名称", { exact: true }).fill("user-selected-embedding");
  await panel.getByLabel("API 密钥", { exact: true }).fill("feature-browser-secret");
  await panel.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("接口验证通过 · 5 维");
  expect((await (await request.get("/api/settings/features")).json()).connections.text.enabled).toBe(false);
  await panel.getByRole("switch", { name: "启用文字嵌入" }).check();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings/features/text") && response.request().method() === "POST");
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  expect(await (await saved).text()).not.toContain("feature-browser-secret");
  await expect(panel.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  await expect(panel.getByText("服务已连接", { exact: true })).toBeVisible();
  await page.reload();
  await panel.getByRole("button", { name: "文字嵌入 已启用" }).click();
  await expect(panel.getByLabel("模型名称", { exact: true })).toHaveValue("user-selected-embedding");
  await expect(panel.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  await panel.getByRole("switch", { name: "启用文字嵌入" }).uncheck();
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("服务已停用");
  await panel.getByRole("button", { name: "文字嵌入 未启用" }).click();
  await panel.getByRole("button", { name: "人脸特征 未启用" }).click();
  await panel.getByLabel("服务地址", { exact: true }).fill("http://127.0.0.1:4312/features");
  await panel.getByLabel("模型名称", { exact: true }).fill("user-selected-face");
  await panel.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("接口验证通过 · 5 维");
  await page.screenshot({ path: "test-results/feature-settings.png", fullPage: true });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("feature-browser-secret");
});
