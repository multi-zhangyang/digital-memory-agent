import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Run } from "@memory/contracts";
import { Store } from "../src/store.js";
import { WorkspaceService } from "../src/application/task-service.js";
import { TaskJobs } from "../src/harness/jobs.js";
import { executionConfiguration } from "../src/application/run-recovery.js";
import type { AgentRuntime, RuntimePromptOptions } from "../src/harness/runtime.js";
import { deliveredInstructions, memoryCommandContext } from "../src/application/memory-command-context.js";
import { MemorySourceVerifier } from "../src/memory/source-verifier.js";
import { createExtensionUI } from "../src/application/extension-ui.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-recovery-")), store = new Store(dir), jobs = new TaskJobs(store);
  const calls: (RuntimePromptOptions | undefined)[] = [];
  const runtime: AgentRuntime = { history: async () => [], cancel: async () => {}, close: async () => {}, prompt: async (_id, _model, _text, receive, options) => { calls.push(options); receive({ type: "text", delta: "已根据保存结果继续" }); } };
  cleanup.push(async () => { jobs.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const conversation = store.createConversation();
  const run = store.work.createRun(conversation.id, { text: "整理我的生活资料", modelId: "test", permissionMode: "auto" });
  store.work.patchRun(run.id, { status: "running", startedAt: new Date().toISOString(), checkpoint: { version: 1, configuration: executionConfiguration(store, run), savedAt: new Date().toISOString() } });
  const restart = () => { const service = new WorkspaceService(store, () => runtime, jobs); cleanup.push(() => service.close()); return service; };
  return { store, calls, run, restart, runtime };
}
async function settled(service: WorkspaceService, run: Run) { for (let n = 0; n < 100 && service.busy(run.conversationId); n++) await new Promise((resolve) => setTimeout(resolve, 10)); }
describe("durable task recovery", () => {
  it("resumes a settled business receipt without replaying the uncertain tool call", async () => {
    const f = await fixture();
    f.store.work.patchRun(f.run.id, { parts: [{ type: "tool", toolCallId: "commit", name: "change_memories", input: {}, state: "running" }],
      receipts: [{ toolCallId: "commit", name: "change_memories", output: { commandId: "durable-command" } }],
      interventions: [{ id: "follow", text: "继续原来的目标", mode: "steer", status: "queued", createdAt: new Date().toISOString() }] });
    const service = f.restart(); service.wake(); await settled(service, f.run);
    expect(service.requireRun(f.run.id).status).toBe("completed");
    expect(f.calls[0]?.recovery?.run.receipts?.[0].output).toEqual({ commandId: "durable-command" });
    expect(f.calls[0]?.recovery?.run.interventions?.[0].text).toBe("继续原来的目标");
  });
  it("requires a decision for an interrupted external effect and preserves that decision", async () => {
    const f = await fixture();
    f.store.work.patchRun(f.run.id, { parts: [{ type: "tool", toolCallId: "external", name: "bash", input: { command: "some-mutation" }, state: "running" }] });
    const service = f.restart(); service.wake(); await settled(service, f.run);
    expect(service.requireRun(f.run.id)).toMatchObject({ status: "waiting", waitingFor: "recovery", recovery: { state: "review", pendingToolIds: ["external"] } });
    expect(f.calls).toHaveLength(0);
    await expect(service.resume(f.run.id)).rejects.toMatchObject({ code: "RECOVERY_REVIEW_REQUIRED" });
    await service.resume(f.run.id, { decisions: [{ toolCallId: "external", action: "skip" }] }); await settled(service, f.run);
    expect(f.calls[0]?.recovery?.run.recovery?.decisions).toEqual([{ toolCallId: "external", action: "skip" }]);
  });
  it("preserves a pending question across restart and resumes the same run after the answer", async () => {
    const f = await fixture();
    f.store.work.patchRun(f.run.id, { status: "waiting", waitingFor: "user", question: { id: "q1", toolCallId: "ask", text: "这是哪次活动？", options: [] } });
    const service = f.restart(); service.wake(); expect(f.calls).toHaveLength(0);
    await service.answer(f.run.id, "这是周末野餐。"); await settled(service, f.run);
    expect(f.calls[0]?.runId).toBe(f.run.id);
    expect(f.calls[0]?.recovery?.run.question?.answer).toBe("这是周末野餐。");
    expect(f.store.work.list("run")).toHaveLength(1);
  });
  it("does not automatically resume an explicit user stop", async () => {
    const f = await fixture(); f.store.work.patchRun(f.run.id, { status: "stopped" });
    const service = f.restart(); service.wake(); expect(f.calls).toHaveLength(0);
    await service.resume(f.run.id); await settled(service, f.run); expect(f.calls).toHaveLength(1);
  });
  it("waits for cancellation and retains a tool result emitted while stopping", async () => {
    const f = await fixture(), service = f.restart();
    f.store.work.patchRun(f.run.id, { status: "running", parts: [{ type: "tool", toolCallId: "script", name: "bash", input: {}, state: "running" }] });
    let acknowledge!: () => void;
    f.runtime.cancel = () => new Promise<void>((resolve) => { acknowledge = resolve; });
    const stopping = service.stop(f.run.id);
    expect(service.requireRun(f.run.id)).toMatchObject({ status: "running", stopRequestedAt: expect.any(String) });
    f.store.work.patchRun(f.run.id, { parts: [{ type: "tool", toolCallId: "script", name: "bash", input: {}, state: "complete", output: "final process output" }] });
    acknowledge(); await stopping;
    expect(service.requireRun(f.run.id)).toMatchObject({ status: "stopped", parts: [{ output: "final process output", state: "complete" }] });
  });
  it("retains a stop requested immediately before restart, including a queued run", async () => {
    const f = await fixture();
    f.store.work.patchRun(f.run.id, { status: "queued", startedAt: undefined, stopRequestedAt: new Date().toISOString() });
    const service = f.restart(); service.wake();
    expect(service.requireRun(f.run.id).status).toBe("stopped");
    expect(f.calls).toHaveLength(0);
  });
  it("retains earlier answers as verifiable evidence after a second question and accepts a short correction answer", async () => {
    const f = await fixture();
    f.store.work.patchRun(f.run.id, { text: "请更正活动地点，先询问我正确地点。", questions: [{ id: "q1", text: "正确地点是什么？", options: [], answer: "杉溪公园" }],
      question: { id: "q2", text: "请确认活动内容。", options: [], answer: "好的" } });
    const run = f.store.work.get<Run>("run", f.run.id)!;
    const context = memoryCommandContext(f.store, run, "change", { action: "correct-activity" }, "user", "杉溪公园");
    expect(context.instruction?.messageId).toBe(run.id + ":answer:q1");
    expect(deliveredInstructions(run).map((item) => item.text)).toEqual([run.text, "杉溪公园", "好的"]);
    expect(memoryCommandContext(f.store, run, "confirm", { action: "confirm-activity" }, "user", "好的").instruction?.messageId).toBe(run.id + ":answer:q2");
    const fact = f.store.memories.createMemory({ title: "活动地点", content: "杉溪公园", occurredAt: "", status: "confirmed", kind: "statement", category: "event", conversationId: run.conversationId, runId: run.id,
      sources: [], evidence: [context.instruction!] });
    await expect(new MemorySourceVerifier(f.store).verify(fact)).resolves.toBeUndefined();
    f.store.work.patchRun(run.id, { questions: [] });
    await expect(new MemorySourceVerifier(f.store).verify(fact)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
  it("blocks recovery after permissions change until the current configuration is reviewed", async () => {
    const f = await fixture(); f.store.work.patchRun(f.run.id, { permissionMode: "read" });
    const service = f.restart(); service.wake(); expect(f.calls).toHaveLength(0);
    await expect(service.resume(f.run.id)).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
    await service.resume(f.run.id, { acceptConfiguration: true }); await settled(service, f.run);
    expect(f.calls[0]?.recovery?.run.permissionMode).toBe("read");
  });
  it("expires an extension dialog durably and resumes with cancellation, even across restart", async () => {
    const f = await fixture();
    const ui = createExtensionUI(f.store, f.run.conversationId, {});
    await expect(ui.confirm("短暂等待", "允许继续？", { timeout: 10 })).rejects.toThrow("等待用户");
    const approval = f.store.harness.approvals(f.run.id)[0];
    const answers: boolean[] = [];
    f.runtime.prompt = async (_id, _model, _text, receive) => {
      answers.push(await ui.confirm("短暂等待", "允许继续？", { timeout: 10 }));
      receive({ type: "text", delta: "请求超时，未执行受询问的操作。" });
    };
    const service = f.restart(); service.wake();
    await expect.poll(() => service.requireRun(f.run.id).status, { timeout: 3000 }).toBe("completed");
    expect(answers).toEqual([false]);
    expect(f.store.harness.approvals(f.run.id)).toEqual([expect.objectContaining({ id: approval.id, status: "denied", resolution: "expired", consumedBy: approval.id })]);
  });
});
