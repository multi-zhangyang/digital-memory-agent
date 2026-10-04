import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import { MemoryEvents } from "./memory/events.js";
import { UserFacingError } from "./harness/runtime.js";

export function createKnowledgeTools(store: Store, events: MemoryEvents, conversationId: string) {
  return [defineTool({
    name: "inspect_source_people", label: "检查素材人物",
    description: "Inspect locally detected person groups in original images and sampled video frames, even when no caption or memory has been created. Returns entity IDs, current versions, observation IDs and exact source times. Unknown groups are candidates, not names or relationships. Use entityId with search_evidence, then read_evidence to inspect original pixels. Only confirmed appearances carry personId. Source availability and selected scope apply before pagination. Use current versions for an explicit user's identity correction.",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const run = store.work.activeRun(conversationId);
      if (!run?.useMemory) throw new UserFacingError(403, "MEMORY_DISABLED", "本次任务未启用个人记忆");
      const page = store.memories.ledger.graph.entityPage("personal", input.limit || 5, input.offset || 0, run.scope === "selected" ? run.assetIds : undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...page, entities: page.entities.map((entity) => ({ id: entity.id, version: entity.version,
        state: entity.state, ...(entity.personId && entity.observations.some((item) => item.status === "confirmed") ? { personId: entity.personId, personName: entity.personName } : {}),
        observationCount: entity.observationCount, observationsTruncated: entity.observationCount > 3, observations: entity.observations.slice(0, 3).map((item) => ({ observationId: item.observationId, status: item.status,
          source: item.observation.evidence[0], region: item.observation.output.region })) })), revision: store.memories.ledger.revision,
        coverage: "detected-appearances", authority: "candidate-evidence" }) }], details: {} };
    },
  }), defineTool({
    name: "query_events", label: "查询事件",
    description: "List or count all recorded, confirmed, usable events matching structured person/date filters, with revision-bound pagination. A text query is a keyword filter, not semantic completeness. Read coverage: unprocessed assets and unknown dates prevent claims about all real-life experiences. Ambiguous person names must be resolved from returned candidates. Returns stable event IDs and exact memory versions. Use search_memories with eventId for additional event evidence.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })), person: Type.Optional(Type.String({ maxLength: 80 })),
      personId: Type.Optional(Type.String({ format: "uuid" })), eventId: Type.Optional(Type.String({ format: "uuid" })),
      from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
      mode: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("count")])),
      cursor: Type.Optional(Type.String({ maxLength: 2000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const run = store.work.activeRun(conversationId);
      if (!run?.useMemory) throw new UserFacingError(403, "MEMORY_DISABLED", "本次任务未启用个人记忆");
      if ((run.memoryTraces?.length || 0) >= 4) throw new UserFacingError(429, "QUERY_LIMIT", "本轮检索预算已用完，请依据已有结果交付并说明未覆盖部分");
      const started = performance.now();
      const result = events.query(input);
      const ids = [...new Set(result.events.flatMap((event) => event.memories.map((memory) => memory.id)))].slice(0, 50);
      store.work.recordRecall(run.id, { ...input, category: "event" }, store.work.queries.catalog.lookup(ids), performance.now() - started);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  })];
}
