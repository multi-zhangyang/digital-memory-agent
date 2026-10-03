import { open } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolInfo } from "@memory/contracts";
import type { Store } from "./store.js";
import { createWorkspaceTools } from "./workspace-tools.js";

export const memoryToolCatalog: ToolInfo[] = [
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
  { name: "ask_user", label: "等待补充", access: "write", group: "workspace" },
];

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export function toolOutput(value: unknown): unknown {
  const content = (
    value as { content?: Array<{ type: string; text?: string }> }
  )?.content;
  const text =
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n") || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createMemoryTools(store: Store, conversationId?: string) {
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
        "Read a bounded UTF-8 text excerpt from a local asset identified by search_assets. Returns the original asset ID and byte offsets for evidence. Does not interpret images or video. Use nextOffset to continue reading.",
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
        const offset = params.offset ?? 0;
        if (offset > asset.size) throw new Error("读取位置超出文件范围。");
        const length = Math.min(params.maxBytes ?? 12000, asset.size - offset);
        try {
          const file = await open(join(store.assetsDir, asset.id), "r");
          try {
            const { buffer, bytesRead } = await file.read(
              Buffer.alloc(length),
              0,
              length,
              offset,
            );
            signal?.throwIfAborted();
            const text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(buffer.subarray(0, bytesRead), {
              stream: offset + bytesRead < asset.size,
            });
            const end = offset + Buffer.byteLength(text, "utf8");
            if (run)
              store.work.source(run.id, {
                assetId: asset.id,
                name: asset.name,
                sha256: asset.sha256,
                start: offset,
                end,
              });
            return result({
              assetId: asset.id,
              name: asset.name,
              text,
              offset,
              nextOffset: end < asset.size ? end : null,
              size: asset.size,
            });
          } finally {
            await file.close();
          }
        } catch {
          if (signal?.aborted) throw new Error("已停止读取。");
          throw new Error(
            "无法读取文字，请确认文件为 UTF-8 编码且读取位置有效。",
          );
        }
      },
    }),
    ...createWorkspaceTools(store, conversationId),
  ];
}
