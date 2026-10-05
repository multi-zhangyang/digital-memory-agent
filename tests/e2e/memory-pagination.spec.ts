import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("library fetches successive bounded server pages and can open an older result", async ({ page, request }) => {
  const tag = "pagination" + randomUUID().replaceAll("-", "");
  const ids: string[] = [];
  for (let offset = 0; offset < 111; offset += 4) {
    const batch = await Promise.all(Array.from({ length: Math.min(4, 111 - offset) }, async (_, index) => {
      const response = await request.post("/api/memories", { data: {
        title: tag + " " + (offset + index), content: "分页测试材料 " + tag, space: "demo", occurredAt: "2026-03-12",
      } });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).memory.id as string;
    }));
    ids.push(...batch);
  }
  const sizes: number[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/memory-overview?") && response.url().includes(tag) && response.ok()) {
      const value = await response.json();
      sizes.push(value.memories.length);
    }
  });
  await page.goto("/?space=demo");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByRole("tab", { name: "记忆记录", exact: true }).click();
  const library = page.getByTestId("memory-library");
  await library.getByLabel("搜索记忆").fill(tag);
  const records = library.getByRole("checkbox", { name: /^选择记忆 / });
  await expect(records).toHaveCount(50);
  await library.getByRole("button", { name: "加载更多 · 还有 61 条" }).click();
  await expect(records).toHaveCount(100);
  await library.getByRole("button", { name: "加载更多 · 还有 11 条" }).click();
  await expect(records).toHaveCount(111);
  await expect(library.getByRole("button", { name: /^加载更多/ })).toHaveCount(0);
  expect(sizes).toEqual([50, 50, 11]);
  await library.getByRole("button", { name: new RegExp("^" + tag + " 0 ") }).click();
  await expect(page.getByTestId("workbench-inspector")).toContainText(tag + " 0");
  await page.screenshot({ path: "test-results/memory-server-pagination.png", fullPage: true, animations: "disabled" });
});
