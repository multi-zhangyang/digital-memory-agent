import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatPart, Run } from "@memory/contracts";
import { Store } from "../src/store.js";
import { timelinePage } from "../src/application/timeline-page.js";
import { createExtensionUI, extensionPresentation } from "../src/application/extension-ui.js";
import { createWorkspaceTools } from "../src/workspace-tools.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workbench-state-"));
  const store = new Store(directory), conversation = store.createConversation();
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = store.work.createRun(conversation.id, { text: "协议测试", modelId: "fixture" });
  return { store, conversation, run };
}
const message = (id: string): ChatPart[] => [{ type: "message", id, messageId: id, role: "assistant", entryId: id, state: "complete" },
  { type: "text", id: id + ":0", messageId: id, entryId: id, text: id }];

it("pages actual message boundaries within one run and across legacy history without duplicates", async () => {
  const f = await fixture();
  f.store.work.patchRun(f.run.id, { status: "completed", parts: Array.from({ length: 123 }, (_, index) => message("entry-" + index)).flat() });
  const legacy: ChatMessage[] = [{ id: "legacy", role: "user", text: "legacy", status: "complete", createdAt: "2000-01-01T00:00:00.000Z" }];
  let before: string | undefined, pages = 0;
  const seen: string[] = [];
  do {
    const page = await timelinePage(f.store, f.conversation.id, async () => legacy, before);
    const markers = page.runs.flatMap((run) => run.parts.filter((part) => part.type === "message"));
    expect(markers.length + page.legacyMessages.length).toBeLessThanOrEqual(50);
    seen.unshift(...page.legacyMessages.map((part) => part.id), ...markers.map((part) => part.id!));
    before = page.page.before || undefined;
    expect(++pages).toBeLessThan(6);
  } while (before);
  expect(seen).toEqual(["legacy", ...Array.from({ length: 123 }, (_, index) => "entry-" + index)]);
  expect(new Set(seen).size).toBe(124);
});

it("skips more than a page of abandoned runs when reopening a native branch", async () => {
  const f = await fixture();
  f.store.work.patchRun(f.run.id, { status: "completed", inputEntryId: "selected", parts: message("selected") });
  for (let i = 0; i < 75; i++) {
    const run = f.store.work.createRun(f.conversation.id, { text: "abandoned", modelId: "fixture" });
    f.store.work.patchRun(run.id, { status: "completed", inputEntryId: "other-" + i, parts: message("other-" + i) });
  }
  const page = await timelinePage(f.store, f.conversation.id, async () => [], undefined, 50, ["selected"]);
  expect(page.runs.map((run) => run.id)).toEqual([f.run.id]);
  const cursor = Buffer.from(JSON.stringify({ runId: f.run.id })).toString("base64url");
  const other = f.store.createConversation();
  await expect(timelinePage(f.store, other.id, async () => [], cursor)).rejects.toMatchObject({ code: "CURSOR" });
});

it("persists Web extension prefill, widgets, status and decisions, while making terminal-only requests explicit", async () => {
  const f = await fixture();
  f.store.work.patchRun(f.run.id, { status: "running" });
  const ui = createExtensionUI(f.store, f.conversation.id, {});
  expect(() => ({ ...ui })).not.toThrow(); // Pi spreads the UI port when binding it.
  ui.setStatus("progress", "正在核对");
  ui.setWidget("summary", ["已读取 2 个文件"], { placement: "belowEditor" });
  ui.setEditorText("继续核对这些来源");
  ui.notify("完成了文件读取");
  expect(extensionPresentation(f.store, f.conversation.id)).toMatchObject({ statuses: { progress: "正在核对" },
    widgets: { summary: { lines: ["已读取 2 个文件"], placement: "belowEditor" } }, editor: { text: "继续核对这些来源", source: "extension" } });
  expect(f.store.work.get<Run>("run", f.run.id)?.parts).toContainEqual(expect.objectContaining({ type: "notice", text: "完成了文件读取" }));
  await expect(ui.editor("核对说明", "已有说明")).rejects.toThrow("等待用户");
  const approval = f.store.harness.approvals(f.run.id)[0];
  expect(approval).toMatchObject({ kind: "input", prefill: "已有说明", detail: "" });
  f.store.harness.save("approval", { ...approval, status: "approved", answer: "已核对的说明" });
  expect(await ui.editor("核对说明", "已有说明")).toBe("已核对的说明");
  const restored = createExtensionUI(f.store, f.conversation.id, {});
  expect(restored.getEditorText()).toBe("继续核对这些来源");
  await expect(restored.custom(() => { throw new Error("must not execute a terminal factory"); })).rejects.toThrow("终端组件");
});

it("allows plan evidence links only after a source was actually read", async () => {
  const f = await fixture();
  f.store.work.patchRun(f.run.id, { status: "running", assetIds: ["selected"] });
  const tool = createWorkspaceTools(f.store, f.conversation.id).find((tool) => tool.name === "update_plan")!;
  const input = { steps: [{ title: "读取原件", status: "completed", resultIds: ["asset:selected"] }] };
  await expect(tool.execute("before-read", input as never, undefined, undefined, {} as never)).rejects.toThrow(/仅上传或选中/);
  f.store.work.patchRun(f.run.id, { sources: [{ assetId: "selected", name: "记录.txt", sha256: "test", start: 0, end: 4 }] });
  await expect(tool.execute("after-read", input as never, undefined, undefined, {} as never)).resolves.toBeTruthy();
  expect(f.store.work.get<Run>("run", f.run.id)?.plan[0].resultIds).toEqual(["asset:selected"]);
});
