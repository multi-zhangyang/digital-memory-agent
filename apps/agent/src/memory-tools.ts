import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolInfo } from "@memory/contracts";
import type { Store } from "./store.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { EvidenceService } from "./memory/evidence-service.js";
import { UserFacingError } from "./errors.js";

export const memoryToolCatalog: ToolInfo[] = [
  { name: "organize_memories", label: "整理生活活动", access: "write", group: "memory" },
  { name: "query_memory_activities", label: "查看生活活动", access: "read", group: "memory" },
  { name: "change_memory_activities", label: "核对生活活动", access: "write", group: "memory" },
  { name: "inspect_memories", label: "检查记忆记录", access: "read", group: "memory" },
  { name: "change_memories", label: "修改记忆记录", access: "write", group: "memory" },
  { name: "manage_memory_links", label: "调整人物与事件关联", access: "write", group: "memory" },
  { name: "search_evidence", label: "检索素材证据", access: "read", group: "memory" },
  { name: "read_evidence", label: "读取原始证据", access: "read", group: "memory" },
  { name: "inspect_source_people", label: "检查素材人物", access: "read", group: "memory" },
  { name: "search_assets", label: "查找资料", access: "read" },
  { name: "read_asset_text", label: "读取文字", access: "read" },
  {
    name: "update_plan",
    label: "更新步骤",
    access: "write",
    group: "workspace",
  },
  {
    name: "write_artifact",
    label: "保存整理结果",
    access: "write",
    group: "workspace",
  },
  {
    name: "read_artifact",
    label: "查看整理结果",
    access: "read",
    group: "workspace",
  },
  {
    name: "propose_memory",
    label: "提出记忆草稿",
    access: "write",
    group: "memory",
  },
  {
    name: "search_memories",
    label: "检索个人记忆",
    access: "read",
    group: "memory",
  },
  { name: "process_assets", label: "处理资料", access: "write", group: "memory" },
  { name: "query_events", label: "查询事件", access: "read", group: "memory" },
  { name: "build_dataset", label: "构建数据集", access: "write", group: "memory" },
  { name: "rebuild_dataset", label: "从当前记忆重建数据集", access: "write", group: "memory" },
  { name: "audit_dataset", label: "批量核验训练样本", access: "write", group: "memory" },
  { name: "inspect_dataset", label: "检查训练样本", access: "read", group: "memory" },
  { name: "review_dataset", label: "核对与修订训练样本", access: "write", group: "memory" },
  { name: "deliver_dataset", label: "核验并交付训练文件", access: "read", group: "memory" },
  { name: "read_job_result", label: "读取作业结果", access: "read", group: "workspace" },
  { name: "manage_job", label: "管理后台作业", access: "write", group: "workspace" },
  { name: "ask_user", label: "等待补充", access: "write", group: "workspace" },
];

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export { toolOutput } from "./integrations/pi/tool-output.js";

export function createMemoryTools(store: Store, conversationId?: string) {
  const evidence = new EvidenceService(store);
  const active = () =>
    conversationId ? store.work.activeRun(conversationId) : undefined;
  return [
    defineTool({
      name: "search_assets",
      label: "查找资料",
      description:
        "Search the user's local asset filenames and metadata. This is filename matching, not semantic search or content understanding. Use a relevant query and page through bounded results only when needed.",
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String({ maxLength: 200 })),
          kind: Type.Optional(
            Type.Union([
              Type.Literal("image"),
              Type.Literal("video"),
              Type.Literal("text"),
              Type.Literal("file"),
            ]),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const run = active();
        if (run?.scope === "selected") {
          const assets = run.assetIds
            .map((id) => store.asset(id))
            .filter(
              (asset) =>
                asset &&
                (!params.kind || asset.kind === params.kind) &&
                asset.name
                  .toLowerCase()
                  .includes((params.query || "").toLowerCase()),
            );
          const offset = params.offset || 0;
          const page = assets.slice(offset, offset + (params.limit || 20));
          return result({
            assets: page,
            total: assets.length,
            nextOffset:
              offset + page.length < assets.length
                ? offset + page.length
                : null,
          });
        }
        return result(
          store.searchAssets(
            params.query || "",
            params.kind,
            params.limit ?? 20,
            params.offset ?? 0,
          ),
        );
      },
    }),
    defineTool({
      name: "read_asset_text",
      label: "读取文字",
      description:
        "Read a bounded, hash-verified UTF-8 page from an original text asset. Use nextOffset to continue. Original text is preserved for traceability; memoryContext.memories carries associated CURRENT confirmed interpretations and user corrections. For personal facts prefer those confirmed revisions over old wording in text; use search_memories if coverage is incomplete. Does not interpret images/video or bypass stopped sources.",
      parameters: Type.Object(
        {
          assetId: Type.String({
            pattern:
              "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          }),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 24000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const run = active();
        if (run?.scope === "selected" && !run.assetIds.includes(params.assetId))
          throw new Error("这份资料不在本次选定的范围内。");
        const asset = store.asset(params.assetId);
        if (!asset) throw new Error("资料不存在。");
        if (asset.memorySpace === "demo")
          throw new Error("虚构示例只在示例空间中使用，不属于个人资料。");
        if (asset.kind !== "text")
          throw new Error("这份资料不是可读取的文字文件。");
        const read = await evidence.read("asset:" + asset.id,
          { allowedAssetIds: run?.scope === "selected" ? run.assetIds : undefined, allowObservations: run?.useMemory !== false },
          { offset: params.offset, limit: params.maxBytes ?? 12000, signal });
        signal?.throwIfAborted();
        if (run) {
          const latest = active();
          if (!latest || latest.id !== run.id || !["running", "waiting"].includes(latest.status) || latest.memoryEpoch !== run.memoryEpoch)
            throw new UserFacingError(409, "RUN_CHANGED", "任务或依据已改变，请重新读取");
          store.work.source(run.id, { assetId: asset.id, name: asset.name, sha256: asset.sha256,
            start: read.source!.start, end: read.source!.end, quote: read.source!.text });
        }
        return result({ sourceRef: run ? store.work.recordRef(run.id, "source", _id, 1) : undefined,
          assetId: asset.id, name: asset.name, text: read.source!.text, offset: read.source!.start,
          nextOffset: read.nextOffset, size: asset.size, verification: read.verification, sha256: asset.sha256,
          ...(read.memoryContext ? { memoryContext: read.memoryContext } : {}) });
      },
    }),
    ...createWorkspaceTools(store, conversationId),
  ];
}
