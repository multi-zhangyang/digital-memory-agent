import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Artifact, MemoryEntry, Run } from "@memory/contracts";
import type { Store } from "./store.js";
import {
  memoryAttributeSchema,
  memoryCategorySchema,
} from "./memory-extraction.js";
import { messageEvidence } from "./memory/ledger.js";
import { MemoryDrafts } from "./memory/drafts.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const ids = Type.Array(Type.String(), { maxItems: 30 });
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});

export function createWorkspaceTools(store: Store, conversationId?: string) {
  const drafts = new MemoryDrafts(store);
  function run(): Run {
    const value = conversationId && store.work.activeRun(conversationId);
    if (!value) throw new Error("请从工作台开始任务后使用此工具。");
    return value;
  }
  return [
    defineTool({
      name: "update_plan",
      label: "更新步骤",
      description:
        "Set or update a short factual execution plan for multi-step tasks. Update step states as work actually progresses. Do not fabricate completed work.",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            title: text(120),
            status: Type.Union([
              Type.Literal("pending"),
              Type.Literal("running"),
              Type.Literal("completed"),
            ]),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        store.work.patchRun(run().id, { plan: params.steps }, "plan");
        return result({ saved: true });
      },
    }),
    defineTool({
      name: "write_artifact",
      label: "保存整理结果",
      description:
        "Save a useful Markdown note, report, or event timeline in the workspace. To CREATE a new result, set artifactId and version to null (omission is also accepted); the server allocates the ID. Never invent an ID. Cite only sourceAssetIds actually read in this run; use [] for a job-status report with no asset citations. To revise an existing artifact, use read_artifact first and send its returned ID and current version. User edits must never be silently overwritten.",
      parameters: Type.Object({
        title: text(160),
        content: text(100000),
        sourceAssetIds: ids,
        artifactId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "null to create; a real existing ID to revise" })),
        version: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "null to create; the version returned by read_artifact to revise" })),
      }),
      async execute(_id, p, signal) {
        signal?.throwIfAborted();
        const current = run();
        if (!!p.artifactId !== (p.version != null)) throw new Error("新建结果请将 ID 和版本都设为 null；修订时须同时提供已存在的 ID 和当前版本。");
        const artifact = store.work.writeArtifact({
          id: p.artifactId ?? undefined,
          version: p.version ?? undefined,
          conversationId: current.conversationId,
          runId: current.id,
          title: p.title,
          content: p.content,
          sources: store.work.resolveSources(current.id, p.sourceAssetIds),
          author: "agent",
        });
        store.work.patchRun(current.id, {}, "artifact");
        return result({
          artifactId: artifact.id,
          title: artifact.title,
          version: artifact.version,
        });
      },
    }),
    defineTool({
      name: "read_artifact",
      label: "查看整理结果",
      description:
        "Read an existing result in this conversation, or list results with artifactId: null (omission is accepted). Never invent an ID. Historical results may contain old descriptions; memoryContextUpdated means facts/policies changed since creation, so compare current confirmations and original evidence before reuse. Unrelated memory changes do not hide usable history; stopped dependencies stay unavailable. Read before editing to obtain its current version.",
      parameters: Type.Object({ artifactId: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
      async execute(_id, p, signal) {
        signal?.throwIfAborted();
        const current = run();
        const values = store.work.list<Artifact>(
          "artifact",
          current.conversationId,
        ).filter((artifact) => {
          if (artifact.sources.some((source) => store.work.memory.sourceBlocked(source.sha256, source.start, source.end))) return false;
          const previous = store.work.get<Run>("run", artifact.runId);
          return !(previous?.memoryIds || []).some((id) => {
            const memory = store.memories.get<MemoryEntry>("memory", id);
            return !memory || !!memory.forgottenAt || store.work.memory.suppressed(memory);
          });
        });
        const artifact = p.artifactId
          ? values.find((item) => item.id === p.artifactId)
          : undefined;
        if (p.artifactId && !artifact) throw new Error("结果不存在或关联依据已停止取用；请用 artifactId=null 列出当前会话可用结果，再使用返回的真实 ID。");
        const contextUpdated = (value: Artifact) => (value.memoryEpoch ?? store.work.get<Run>("run", value.runId)?.memoryEpoch ?? 0) < store.work.memory.epoch;
        return result(
          artifact ? { ...artifact, memoryContextUpdated: contextUpdated(artifact),
            policy: "这是已保存结果的当前文档版本，文档描述不是已确认个人事实。memoryContextUpdated 为 true 时关联记忆或偏好可能已改变；修订前须读取当前确认版本及原件，对照历史描述，不能用旧文档推翻用户纠正。" } : {
            artifacts: values.map((value) => ({
              id: value.id,
              title: value.title,
              version: value.version,
              memoryContextUpdated: contextUpdated(value),
            })),
          },
        );
      },
    }),
    defineTool({
      name: "propose_memory",
      label: "提出记忆草稿",
      description:
        "Propose a concise personal memory as a DRAFT for user review, never as confirmed fact. For observations/inferences, select the relevant original reads using sourceRefs returned by read_evidence/read_asset_text (e1, e2...), with their sourceAssetIds. Video claims must select their exact frames, never all frames read in the task by default. Only completed original reads with actual image delivery support visual claims; search results and summaries are not reads. A user statement requires an exact statement quote from the current user request. Write only the concrete observation in content; status/type/source metadata already record its basis, so do not add review labels, disclaimers or instructions to the memory text. Use uncertainty for specific unresolved content, not a generic review notice. Keep unknown dates/identities unknown; video seconds are not event dates.",
      parameters: Type.Object({
        title: text(120),
        content: text(4000),
        kind: Type.Union([
          Type.Literal("statement"),
          Type.Literal("observation"),
          Type.Literal("inference"),
        ]),
        occurredAt: Type.Optional(Type.String({ maxLength: 100 })),
        sourceAssetIds: ids,
        sourceRefs: Type.Optional(Type.Union([Type.Array(Type.String({ pattern: "^e[1-9][0-9]*$" }), { maxItems: 30 }), Type.Null()],
          { description: "Exact sourceRef values returned by this task's original reads. Select only frames/pages supporting this memory; null or [] for a source-free user statement." })),
        statement: Type.Optional(text(1000)),
        category: Type.Optional(memoryCategorySchema),
        people: Type.Optional(Type.Array(text(80), { maxItems: 8 })),
        place: Type.Optional(Type.String({ maxLength: 120 })),
        uncertainty: Type.Optional(Type.String({ maxLength: 500 })),
        attribute: Type.Optional(
          Type.Union([memoryAttributeSchema, Type.Null()]),
        ),
      }),
      async execute(_id, p, signal) {
        signal?.throwIfAborted();
        const current = run();
        if (
          p.sourceAssetIds.some((id) => store.asset(id)?.memorySpace === "demo")
        )
          throw new Error("虚构示例不能写入个人记忆，请使用示例空间。");
        if (!current.captureMemory && !/记住|记忆|remember/i.test(current.text)) throw new Error("本轮未启用自动记录，只有用户明确要求时才能提出记忆。");
        if (
          p.kind === "statement"
            ? !p.statement || !current.text.includes(p.statement)
            : !p.sourceAssetIds.length
        )
          throw new Error(
            "缺少可靠依据：请提供实际读取的资料，或当前用户原话。",
          );
        const sources = p.kind === "statement" && !p.sourceRefs?.length
          ? store.work.resolveSources(current.id, p.sourceAssetIds)
          : store.work.resolveObservationSources(current.id, p.sourceAssetIds, p.sourceRefs);
        const memory = await drafts.propose({
          title: p.title,
          content: p.content,
          kind: p.kind,
          occurredAt: p.occurredAt || "",
          sources,
          statement: p.statement,
          evidence: p.kind === "statement" && p.statement ? [messageEvidence(current, p.statement)] : undefined,
          category: p.category,
          people: p.people,
          place: p.place,
          attribute: p.attribute || undefined,
          uncertainty: p.uncertainty,
        }, { actor: "agent", run: current, signal });
        return result({
          memoryId: memory.id,
          title: memory.title,
          status: "draft",
          version: memory.version,
          ref: store.work.recordRef(current.id, "memory", memory.id, memory.version),
          sources: memory.sources,
        });
      },
    }),
    defineTool({
      name: "search_memories",
      label: "检索个人记忆",
      description:
        "Retrieve bounded current confirmed personal evidence using available keyword, semantic/image and structured indexes. The service handles ranking, current versions and source exclusions. Inspect retrieval status and personResolution: candidates are not identities, names can be ambiguous, similarity is not proof of an answer. query may be empty with filters. includeHistorical returns superseded records for past history only. Use query_events for complete event lists or counts. Respect validity, uncertainty and pendingConflicts. If evidence is missing, say you do not know.",
      parameters: Type.Object({
        query: Type.String({ maxLength: 200 }),
        limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 12 }), Type.Null()])),
        person: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()], { description: "Another person's name or confirmed alias. Omit or use null when not filtering by a known person." })),
        personId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Only an existing confirmed person ID from personIds, never a memory ID. Omit or use null if unknown; do not invent an ID." })),
        eventId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Use an actual event ID returned by query_events, or omit/use null." })),
        category: Type.Optional(Type.Union([memoryCategorySchema, Type.Null()])),
        from: Type.Optional(Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()])),
        to: Type.Optional(Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()])),
        includeHistorical: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      }),
      async execute(_id, p, signal) {
        const current = run();
        if (!current.useMemory) throw new Error("本次任务未启用个人记忆。");
        if ((current.memoryTraces?.length || 0) >= 4) throw new Error("本轮记忆检索已达到三次，请依据现有证据回答或说明信息不足。");
        const started = performance.now();
        const query = { query: p.query, limit: p.limit ?? undefined, person: p.person?.trim() || undefined,
          personId: p.personId ?? undefined, eventId: p.eventId ?? undefined, category: p.category ?? undefined,
          from: p.from ?? undefined, to: p.to ?? undefined, includeHistorical: p.includeHistorical ?? undefined };
        const recall = await store.work.queries.recallAsync(query, 12000, signal);
        store.work.recordRecall(current.id, query, recall.entries, performance.now() - started);
        return result(recall.response);
      },
    }),
    defineTool({
      name: "ask_user",
      label: "等待补充",
      description:
        "Ask for missing information essential to the current task. The task waits for the user's answer. Use only when the answer cannot be obtained from available sources, not for routine permission requests.",
      parameters: Type.Object({
        question: text(1000),
        options: Type.Optional(Type.Array(text(160), { maxItems: 4 })),
      }),
      async execute(_id, p, signal) {
        const current = run();
        store.work.patchRun(
          current.id,
          {
            status: "waiting",
            question: { text: p.question, options: p.options || [] },
          },
          "question",
        );
        while (true) {
          signal?.throwIfAborted();
          const latest = store.work.get<Run>("run", current.id)!;
          if (latest.status === "stopped") throw new Error("已停止");
          if (latest.question?.answer)
            return result({ answer: latest.question.answer });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      },
    }),
  ];
}
