import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import { commandOutput, commandRun, currentMemory, memoryCommandContext } from "./application/memory-command-context.js";
import { UserFacingError } from "./errors.js";
import { memoryAttributeSchema } from "./memory-extraction.js";
import { inspectedReference, versionedReference } from "./application/tool-record-references.js";
import { MemorySourceVerifier } from "./memory/source-verifier.js";

const uuid = Type.String({ format: "uuid" });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const ref = Type.Object({ id: uuid, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const refs = Type.Array(ref, { minItems: 1, maxItems: 50 });
const strings = Type.Array(text(80), { maxItems: 12, uniqueItems: true });
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const patch = Type.Object({
  title: Type.Optional(text(120)), content: Type.Optional(text(12000)), occurredAt: Type.Optional(Type.String({ maxLength: 10 })),
  category: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("event"), Type.Literal("relationship"), Type.Literal("profile")])),
  people: Type.Optional(strings), place: Type.Optional(Type.String({ maxLength: 120 })), uncertainty: Type.Optional(Type.String({ maxLength: 500 })),
  attribute: Type.Optional(Type.Union([memoryAttributeSchema, Type.Null()])),
  validity: Type.Optional(Type.Object({ from: Type.Optional(Type.String({ maxLength: 10 })), to: Type.Optional(Type.String({ maxLength: 10 })),
    precision: Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year"), Type.Literal("unknown")]),
    expression: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false })),
}, { additionalProperties: false });

export function createMemoryCommandTools(store: Store, conversationId: string) {
  return [
    defineTool({
      name: "inspect_memories", label: "检查记忆记录",
      description: "Inspect current memory records, including drafts for review, exact versions, sources, conflicts and related person/event identifiers. Unlike relevance search this is a complete paged catalog with total and nextCursor; scope is applied before pagination. Forgotten records return only identifiers for a user's restore instruction. Drafts remain unconfirmed. Read current versions before changing records. Use assetIds to inspect this batch, and page until coverage is sufficient.",
      parameters: Type.Object({
        ids: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 50, uniqueItems: true })),
        assetIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 200, uniqueItems: true })),
        view: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("draft"), Type.Literal("confirmed"), Type.Literal("rejected"), Type.Literal("forgotten")])),
        query: Type.Optional(Type.String({ maxLength: 200 })), cursor: Type.Optional(text(2000)),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        const run = commandRun(store, conversationId);
        if (run.scope === "selected" && input.assetIds?.some((id) => !run.assetIds.includes(id))) throw new UserFacingError(403, "SOURCE_SCOPE", "只能检查本次所选资料");
        const page = store.memories.queries.catalog.page({ ...input, space: "personal", view: input.view || "all", limit: input.limit || 8, maxBytes: 12000,
          allowedAssetIds: run.scope === "selected" ? run.assetIds : undefined });
        return output({ ...page, memories: page.memories.map((entry) => ({ ...currentMemory(store, entry, run.id),
          ...(!entry.forgottenAt && !store.memories.ledger.suppressed(entry) ? { conflicts: store.memories.memoryConflicts(entry).map((other) => ({ id: other.id, version: other.version, status: other.status })) } : {}) })),
          policy: "用本次返回的短 ref（如 m1）指定变更，它绑定当前记录版本，无需抄写长 ID。draft 是待核对记录；sources 定位原始素材，不覆盖用户纠正。" });
      },
    }),
    defineTool({
      name: "change_memories", label: "修改记忆记录",
      description: "Execute an explicit user instruction to correct, confirm, reject, forget, restore or resolve a conflicting record. Pass current id/version and the exact relevant quote from the current user message or delivered clarification. Optional patch with confirm applies user-supported corrections and confirmation together in one version; uncertainty is changed only when explicitly patched. The server records the real author and message; never claim the user confirmed an autonomous observation. basis=observation permits only draft corrections. Confirm only the user-designated records; do not convert a general organization/export request into blanket factual confirmation. Explicit instructions execute under current permissions; ask only for ambiguity/conflicts. Returns durable idempotent receipt and new versions; continue the task with refreshed context.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("correct"), Type.Literal("confirm"), Type.Literal("reject"), Type.Literal("forget"), Type.Literal("restore"), Type.Literal("resolve")]),
        entries: Type.Array(Type.Union([
          Type.Object({ ...inspectedReference("memory").properties, patch: Type.Optional(patch) }, { additionalProperties: false }),
          Type.Object({ ...versionedReference.properties, patch: Type.Optional(patch) }, { additionalProperties: false }),
        ]), { minItems: 1, maxItems: 50 }),
        replace: Type.Optional(Type.Array(Type.Union([inspectedReference("memory"), versionedReference]), { minItems: 1, maxItems: 50 })), resolution: Type.Optional(Type.Union([Type.Literal("correction"), Type.Literal("change")])),
        basis: Type.Union([Type.Literal("user"), Type.Literal("observation")]),
        instructionQuote: Type.Optional(text(4000)), reason: text(1000),
      }, { additionalProperties: false }),
      async execute(id, input, signal) {
        signal?.throwIfAborted();
        const run = commandRun(store, conversationId, true);
        const { basis, instructionQuote, ...requested } = input;
        const { entries, replace, ...details } = requested;
        const change = { ...details,
          entries: entries.map((entry) => ({ ...store.work.resolveRecordRef(run.id, "memory", entry), ...(entry.patch ? { patch: entry.patch } : {}) })),
          replace: replace?.map((entry) => store.work.resolveRecordRef(run.id, "memory", entry)),
        };
        const context = memoryCommandContext(store, run, id, change, basis, instructionQuote);
        if (basis === "observation") {
          const verifier = new MemorySourceVerifier(store);
          for (const ref of change.entries) await verifier.verify(store.memoryCommands.memory(ref.id, context), signal);
          signal?.throwIfAborted();
          const current = commandRun(store, conversationId, true);
          if (current.id !== run.id || current.memoryEpoch !== run.memoryEpoch) throw new UserFacingError(409, "RUN_CHANGED", "任务或依据已改变，请重新核对");
        }
        const receipt = store.memoryCommands.change(change, context);
        return output(commandOutput(store, receipt, context));
      },
    }),
    defineTool({
      name: "manage_memory_links", label: "调整人物与事件关联",
      description: "Apply a user's explicit identity or event-link correction using current IDs/versions from inspect_memories/query_events. Candidate clustering is not a real identity. link-person/unlink-person refs are memories; identify/merge-people/split-person refs are entity candidates; merge-events/split-event refs are events. Split requires selected observationIds or memoryIds. New names must come from the user; use a known personId when available. The same versioned service is used by direct UI actions.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("link-person"), Type.Literal("unlink-person"), Type.Literal("identify"), Type.Literal("merge-people"), Type.Literal("split-person"), Type.Literal("merge-events"), Type.Literal("split-event")]),
        refs, personId: Type.Optional(uuid), name: Type.Optional(text(80)), aliases: Type.Optional(strings),
        observationIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 50, uniqueItems: true })),
        memoryIds: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 50, uniqueItems: true })), title: Type.Optional(text(120)),
        instructionQuote: text(4000), reason: text(1000),
      }, { additionalProperties: false }),
      async execute(id, input, signal) {
        signal?.throwIfAborted();
        const run = commandRun(store, conversationId, true);
        const { instructionQuote, ...change } = input;
        const context = memoryCommandContext(store, run, id, change, "user", instructionQuote);
        const receipt = store.memoryCommands.links(change, context);
        return output({ ...commandOutput(store, receipt, context),
          ...(receipt.epoch === store.memories.ledger.epoch ? { links: receipt.result } : { linksChanged: true }) });
      },
    }),
  ];
}
