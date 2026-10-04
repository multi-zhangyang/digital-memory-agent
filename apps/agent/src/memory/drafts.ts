import type { MemoryEntry, Run } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { MemorySourceVerifier } from "./source-verifier.js";
import { UserFacingError } from "../errors.js";

export type MemoryDraftInput = Pick<MemoryEntry, "title" | "content" | "kind" | "sources"> &
  Partial<Pick<MemoryEntry, "occurredAt" | "statement" | "evidence" | "category" | "people" | "place" | "attribute" | "uncertainty">>;

/** New observations share a verified draft path; confirmation remains a separate memory command. */
export class MemoryDrafts {
  private readonly verifier: MemorySourceVerifier;
  constructor(private readonly data: MemoryData) { this.verifier = new MemorySourceVerifier(data); }

  async propose(input: MemoryDraftInput, context: { actor: "user" | "agent"; run?: Run; signal?: AbortSignal }) {
    const run = context.run;
    const draft: MemoryEntry = { ...input, id: "", version: 1, createdAt: "", updatedAt: "", status: "draft",
      occurredAt: input.occurredAt || "", conversationId: run?.conversationId || "", runId: run?.id || "",
      editedBy: context.actor, space: "personal" };
    await this.verifier.verify(draft, context.signal);
    context.signal?.throwIfAborted();
    return this.data.memories.transaction(() => {
      const current = run && this.data.memories.get<Run>("run", run.id);
      if (run && (!current || !["running", "waiting"].includes(current.status) || current.memoryEpoch !== run.memoryEpoch))
        throw new UserFacingError(409, "RUN_CHANGED", "任务或依据已改变，请重新读取后保存草稿");
      const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...value } = draft;
      const memory = this.data.memories.createMemory(value);
      if (current) this.data.recordMemoryActivity?.(current.id, { memoryIds: [...new Set([...current.memoryIds, memory.id])] }, "memory");
      return memory;
    });
  }
}
