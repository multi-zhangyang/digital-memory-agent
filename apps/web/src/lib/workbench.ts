import type {
  Artifact,
  Asset,
  AssetCollection,
  ChatPart,
  Conversation,
  MemoryEntry,
  ProjectFileReference,
  Run,
  RunEvent,
  RunStatus,
  ThinkingLevel,
} from "@memory/contracts";
import { assetUrl } from "./api";

export type InspectorTarget = {
  tab: "assets" | "artifacts" | "memories";
  id?: string;
  start?: number;
  end?: number;
  timestamp?: number;
};
export interface TaskDraft {
  text: string;
  assetIds: string[];
  fileReferences?: ProjectFileReference[];
  modelId: string;
  thinkingLevel: ThinkingLevel;
  useMemory: boolean;
  captureMemory?: boolean;
  scope: "selected" | "library";
  permissionMode?: "read" | "ask" | "auto";
}
export interface WorkbenchSnapshot {
  conversations: Conversation[];
  assets: Asset[];
  collections: AssetCollection[];
  artifacts: Artifact[];
  memories: MemoryEntry[];
}
export const emptyDraft = (): TaskDraft => ({
  text: "",
  assetIds: [],
  fileReferences: [],
  modelId: "",
  thinkingLevel: "medium",
  useMemory: true,
  scope: "library",
});
export const statusLabel: Record<RunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待输入",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};
export const isActive = (run: Run) =>
  ["queued", "running", "waiting"].includes(run.status);
export const fileData = (asset: Asset) => ({
  id: asset.id,
  type: "file" as const,
  filename: asset.name,
  mediaType: asset.mimeType,
  url: assetUrl(asset.id),
});

export function applyRunEvent(run: Run, event: RunEvent): Run {
  if (event.seq <= run.cursor) return run;
  const data = event.data as Record<string, unknown>;
  const parts: ChatPart[] = [...run.parts];
  const clonePart = (index: number) => {
    if (index >= 0) parts[index] = { ...parts[index] };
    return parts[index];
  };
  if (event.type === "text" || event.type === "reasoning") {
    const last = clonePart(parts.length - 1);
    if (last?.type === event.type) last.text += String(data.delta);
    else parts.push({ type: event.type, text: String(data.delta) });
  } else if (event.type === "tool-start")
    parts.push({
      type: "tool",
      toolCallId: String(data.id),
      name: String(data.name),
      input: data.input,
      state: "running",
    });
  else if (event.type === "tool-update") {
    const part = clonePart(
      parts.findIndex((p) => p.type === "tool" && p.toolCallId === data.id),
    );
    if (part?.type === "tool") part.output = data.output;
  } else if (event.type === "notice") {
    const previous = clonePart(
      parts.findLastIndex((p) => p.type === "notice" && p.state === "running"),
    );
    if (data.state !== "running" && previous?.type === "notice") {
      previous.text = String(data.text);
      previous.state = data.state as "complete" | "error";
    } else
      parts.push({
        type: "notice",
        text: String(data.text),
        state: data.state as "running" | "complete" | "error",
      });
  } else if (event.type === "tool-end") {
    const part = clonePart(
      parts.findIndex(
        (part) => part.type === "tool" && part.toolCallId === data.id,
      ),
    );
    if (part?.type === "tool") {
      part.state = data.error ? "error" : "complete";
      part.output = data.output;
      if (data.error)
        part.errorText =
          typeof data.output === "string" ? data.output : "工具执行失败";
    }
  } else return { ...run, ...data, cursor: event.seq } as Run;
  return { ...run, parts, cursor: event.seq };
}

export function downloadText(title: string, content: string, extension = "md") {
  const url = URL.createObjectURL(
    new Blob([content], {
      type:
        extension === "patch"
          ? "text/x-diff;charset=utf-8"
          : "text/markdown;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = title.replace(/[\\/:*?"<>|]/g, "_") + "." + extension;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
