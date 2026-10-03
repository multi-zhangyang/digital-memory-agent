import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Artifact, Run } from "@memory/contracts";
import type { Store } from "./store.js";
import {
  memoryAttributeSchema,
  memoryCategorySchema,
} from "./memory-extraction.js";
import { budgetMemories } from "./memory-retrieval.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const ids = Type.Array(Type.String(), { maxItems: 30 });
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});

export function createWorkspaceTools(store: Store, conversationId?: string) {
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
        "Save a useful Markdown note, report, or event timeline in the workspace. Cite only sourceAssetIds actually read in this run. To revise an existing artifact, read it first and send its current version. User edits must never be silently overwritten.",
      parameters: Type.Object({
        title: text(160),
        content: text(100000),
        sourceAssetIds: ids,
        artifactId: Type.Optional(Type.String()),
        version: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_id, p, signal) {
        signal?.throwIfAborted();
        const current = run();
        const artifact = store.work.writeArtifact({
          id: p.artifactId,
          version: p.version,
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
        "Read an existing result in this conversation, or list results when artifactId is omitted. Read before editing to obtain the current version.",
      parameters: Type.Object({ artifactId: Type.Optional(Type.String()) }),
      async execute(_id, p) {
        const current = run();
        const values = store.work.list<Artifact>(
          "artifact",
          current.conversationId,
        );
        const artifact = p.artifactId
          ? values.find((item) => item.id === p.artifactId)
          : undefined;
        if (p.artifactId && !artifact) throw new Error("结果不存在。");
        return result(
          artifact || {
            artifacts: values.map(({ id, title, version }) => ({
              id,
              title,
              version,
            })),
          },
        );
      },
    }),
    defineTool({
      name: "propose_memory",
      label: "提出记忆草稿",
      description:
        "Propose a concise personal memory as a DRAFT for user review, never as confirmed fact. Observations/inferences require sourceAssetIds read in this run. A user statement requires an exact statement quote from the current user request. Do not store assistant output or compressed summaries as fact.",
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
        if (
          p.kind === "statement"
            ? !p.statement || !current.text.includes(p.statement)
            : !p.sourceAssetIds.length
        )
          throw new Error(
            "缺少可靠依据：请提供实际读取的资料，或当前用户原话。",
          );
        const memory = store.work.createMemory({
          title: p.title,
          content: p.content,
          kind: p.kind,
          status: "draft",
          occurredAt: p.occurredAt || "",
          sources: store.work.resolveSources(current.id, p.sourceAssetIds),
          statement: p.statement,
          category: p.category,
          people: p.people,
          place: p.place,
          attribute: p.attribute || undefined,
          uncertainty: p.uncertainty,
          conversationId: current.conversationId,
          runId: current.id,
        });
        store.work.patchRun(current.id, {}, "memory");
        return result({
          memoryId: memory.id,
          title: memory.title,
          status: "draft",
        });
      },
    }),
    defineTool({
      name: "search_memories",
      label: "检索个人记忆",
      description:
        "Search current confirmed personal memories by keywords, an exact person name, category, or ISO dates. query may be empty with filters. includeHistorical also returns superseded records marked supersededBy; use it for past history, never as current facts. Drafts and rejected memories are excluded. Results have a serialized byte budget. Never invent memories when results are empty. This is local search, not embeddings.",
      parameters: Type.Object({
        query: Type.String({ maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
        person: Type.Optional(text(80)),
        category: Type.Optional(memoryCategorySchema),
        from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        includeHistorical: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, p) {
        const current = run();
        if (!current.useMemory) throw new Error("本次任务未启用个人记忆。");
        const memories = budgetMemories(
          store.work.searchMemories(p.query, p.limit || 8, p),
        );
        store.work.patchRun(
          current.id,
          {
            memoryIds: [
              ...new Set([
                ...current.memoryIds,
                ...memories.map((item) => item.id),
              ]),
            ],
          },
          "recall",
        );
        return result({ memories });
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
