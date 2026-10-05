import { createHash } from "node:crypto";
import type { EvidenceRead, MemoryEntry, Run } from "@memory/contracts";
import type { Store } from "../store.js";
import type { CommandContext, CommandReceipt } from "../memory/commands.js";
import { messageEvidence } from "../memory/ledger.js";
import { memoryContext } from "../memory/retrieval.js";
import { UserFacingError } from "../errors.js";
import type { SourceInspection } from "../memory/observation-review.js";
import { evidenceOf } from "../memory/values.js";

export function commandRun(store: Store, conversationId: string, write = false) {
  const run = store.work.activeRun(conversationId);
  if (!run || !["running", "waiting"].includes(run.status)) throw new UserFacingError(409, "RUN_REQUIRED", "任务已结束，无法执行新操作");
  if (!run.useMemory) throw new UserFacingError(403, "MEMORY_DISABLED", "本次任务未启用个人记忆");
  if (write && (run.permissionMode || store.harness.project(store.harness.association(conversationId).projectId).permissionMode) === "read")
    throw new UserFacingError(403, "READ_ONLY", "本次任务为只读模式");
  if (run.memoryEpoch !== undefined && run.memoryEpoch !== store.memories.ledger.epoch) throw new UserFacingError(409, "MEMORY_CHANGED", "记忆已经改变，请从新上下文继续");
  return run;
}

/** These are evidence-bearing user messages, never a default goal, old assistant text or uploaded instructions. */
export function deliveredInstructions(run: Run) {
  const answers = [...(run.questions || []), ...(run.question?.answer ? [run.question] : [])];
  const questions = [...new Map(answers.map((q) => [q.id || q.toolCallId || "legacy", q])).values()];
  return [{ id: run.id, text: run.text }, ...(run.interventions || []).filter((item) => item.status === "delivered"),
    ...questions.flatMap((q) => q.answer ? [{ id: run.id + ":answer" + (q.id ? ":" + q.id : ""), text: q.answer }] : [])];
}

export function userInstruction(run: Run, quote?: string) {
  if (!quote?.trim()) throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "请引用本次用户明确指令；模型观察只能修订草稿");
  const source = deliveredInstructions(run).reverse().find((item) => item.text.includes(quote));
  if (!source) throw new UserFacingError(403, "INVALID_INSTRUCTION", "操作依据必须来自本次实际送达的用户消息");
  const evidence = messageEvidence(run, quote, source.id, source.text);
  if (evidence.type !== "message") throw new Error("Invalid instruction source");
  return evidence;
}

const explicitActions: Record<string, RegExp> = {
  "confirm-activity": /确认|属实|没错|正确|\bconfirm/i,
  "correct-activity": /改|纠正|更正|修订|修正|应该|应为|\bcorrect|\bchange|\bfix/i,
  "reject-activity": /拒绝|驳回|不对|错误|不属于|不是同|不要.{0,10}合|\breject/i,
  "merge-activities": /合并|同一|一次|\bmerge|\bsame/i,
  "split-activity": /拆|分开|不同|不是同|\bsplit|\bseparate/i,
  confirm: /确认|属实|没错|正确|是对的|无误|\bconfirm|\baccurate\b|\bcorrect\b/i,
  reject: /拒绝|驳回|不对|错误|不属实|删掉|\breject|\bincorrect\b|\bwrong\b/i,
  correct: /改|纠正|更正|修订|修正|应该|应为|不是.+(?:是|为)|\bcorrect|\bchange|\bfix|\bupdate|\brevise/i,
  resolve: /改|纠正|更正|替代|冲突|以.+为准|确认|现在|搬|\bresolve|\breplace|\bcorrect|\bchange/i,
  forget: /忘|停用|停止|不要.{0,20}(?:用|记)|删除|\bforget|\bstop|\bdisable|\bdelete/i,
  restore: /恢复|重新.{0,20}(?:用|记)|\brestore|\breenable|\buse.*again/i,
  "link-person": /关联|标记|属于|是|叫|\blink|\bassociate|\bis\b/i,
  "unlink-person": /取消|解除|不属于|不是|删|\bunlink|\bremove|\bnot\b/i,
  identify: /关联|标记|是|叫|名字|身份|\bidentify|\bname|\bis\b/i,
  "merge-people": /合并|同一|一个人|\bmerge|\bsame\b/i,
  "split-person": /拆|分开|不同|不是同|\bsplit|\bseparate|\bdifferent/i,
  "merge-events": /合并|同一|一件事|\bmerge|\bsame\b/i,
  "split-event": /拆|分开|不同|不是同|\bsplit|\bseparate|\bdifferent/i,
};

export function memoryCommandContext(store: Store, run: Run, toolCallId: string, input: unknown,
  basis: "user" | "observation", quote?: string): CommandContext {
  const instruction = basis === "user" ? userInstruction(run, quote) : undefined;
  const sourceReads: SourceInspection[] = [];
  if (basis === "observation") {
    const entries = (input as { entries?: { id: string }[] }).entries || [];
    const sourceIds = new Set(entries.flatMap(({ id }) => {
      const memory = store.memories.get<MemoryEntry>("memory", id);
      return memory ? evidenceOf(memory).flatMap((source) => source.type === "asset" ? [source.assetId] : []) : [];
    }));
    for (const part of (store.work.get<Run>("run", run.id) || run).parts) {
      if (part.type !== "tool" || part.state !== "complete" || part.name !== "read_evidence") continue;
      const result = part.output as (EvidenceRead & { imageDelivered?: boolean }) | undefined;
      const source = result?.source;
      if (!source || result?.verification !== "asset-hash" || !sourceIds.has(source.assetId)) continue;
      if (typeof source.text === "string" || (result.imageDelivered && source.view)) sourceReads.push({
        toolCallId: part.toolCallId, assetId: source.assetId, sha256: source.sha256, start: source.start, end: source.end,
        kind: source.video ? "video" : source.view ? "image" : "text", ...(source.video ? { video: source.video } : {}),
        ...(source.view ? { viewSha256: source.view.sha256, ...(source.view.region ? { region: source.view.region } : {}) } : {}),
      });
    }
  }
  if (instruction) {
    const action = (input as { action?: string }).action || "";
    const pattern = explicitActions[action];
    const question = instruction.messageId === run.id + ":answer" ? run.question :
      [...(run.questions || []), ...(run.question ? [run.question] : [])].find((q) => q.id && instruction.messageId === run.id + ":answer:" + q.id);
    const affirmative = question && /^(好的?|是的?|对的?|确认|可以|没错|yes|ok|correct)[。.!！\s]*$/i.test(instruction.quote.trim());
    // A short field answer belongs to the user's already requested correction. Keep the
    // exact answer as evidence instead of requiring the user to repeat the whole command.
    const correctionAnswer = question && ["correct", "correct-activity"].includes(action) && pattern?.test(run.text);
    if (!pattern || (!pattern.test(instruction.quote) && !(affirmative && pattern.test(question.text)) && !correctionAnswer))
      throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "用户原话未明确指定此类变更，请只处理已授权部分或澄清；整理、提取和导出本身不代表确认事实");
  }
  return { actor: basis === "user" ? "user" : "agent", space: "personal", runId: run.id, instruction,
    ...(basis === "observation" ? { sourceReads } : {}),
    allowedAssetIds: run.scope === "selected" ? run.assetIds : undefined,
    requestKey: createHash("sha256").update(JSON.stringify([run.id, input, basis, instruction])).digest("hex"),
    committed: (receipt) => {
      const current = store.work.get<Run>("run", run.id);
      if (!current || !["running", "waiting"].includes(current.status) || current.memoryEpoch !== run.memoryEpoch)
        throw new UserFacingError(409, "RUN_CHANGED", "任务已停止或上下文改变，操作未提交");
      // This callback is inside the same SQLite transaction as the memory write and outbox event.
      // The current command may have advanced the epoch; check the original run, not the new ledger here.
      const part = current.parts.find((p) => p.type === "tool" && p.toolCallId === toolCallId);
      const receipts = [...(current.receipts || []).filter((r) => r.toolCallId !== toolCallId),
        { toolCallId, name: part?.type === "tool" ? part.name : receipt.action, output: { command: receiptSummary(receipt), result: receipt.result } }];
      store.work.patchRun(current.id, { receipts, memoryEpoch: receipt.epoch, memoryContextReset: { toolCallId, commandId: receipt.id, epoch: receipt.epoch } },
        "memory-command", { command: receiptSummary(receipt) });
    },
  };
}

export function receiptSummary(receipt: CommandReceipt) {
  const { id, action, actor, instruction, sourceReads, before, after, epoch, affectedDatasets, createdAt } = receipt;
  return { id, action, actor, instruction, sourceReads, before, after, epoch, affectedDatasets, createdAt };
}

export function currentMemory(store: Store, entry: MemoryEntry, runId?: string) {
  const reference = runId ? { ref: store.work.recordRef(runId, "memory", entry.id, entry.version) } : {};
  if (entry.forgottenAt || store.memories.ledger.suppressed(entry)) return { ...reference, id: entry.id, version: entry.version, stopped: true };
  return { ...reference, ...memoryContext(entry), title: entry.content.slice(0, 80), status: entry.status, editedBy: entry.editedBy,
    relations: store.memories.ledger.graph.context(entry) };
}

export function commandOutput(store: Store, receipt: CommandReceipt, context: CommandContext) {
  const current: ReturnType<typeof currentMemory>[] = [];
  const remaining: { id: string; version: number }[] = [];
  let bytes = 0;
  for (const ref of receipt.after) {
    const memory = store.memories.get<MemoryEntry>("memory", ref.id);
    if (!memory) continue;
    store.memoryCommands.memory(memory.id, context);
    const value = currentMemory(store, memory, context.runId), size = Buffer.byteLength(JSON.stringify(value));
    if (bytes + size > 12000) remaining.push({ id: memory.id, version: memory.version });
    else { current.push(value); bytes += size; }
  }
  return { receipt: receiptSummary(receipt), current, remaining,
    policy: "回执只记录本次指定目标的实际执行；remaining 仅表示本次回执因长度未列全，不是整批业务目标是否完成。current.status=draft 仍是待核对，correct 只修订正文；用户已明确要求确认时继续对其授权目标执行 confirm 并复查范围。继续使用 current 的新版本，remaining 可用 inspect_memories 分批读取。stopped 记录不再作为回答依据。" };
}
