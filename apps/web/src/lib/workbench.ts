import { applyPartEvent, isPartEventType } from "@memory/contracts/execution";
import type { PartEvent } from "@memory/contracts";
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
  tab: "assets" | "artifacts" | "memories" | "activities";
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
  if (isPartEventType(event.type)) {
    const partEvent = { ...data, type: event.type } as PartEvent;
    return { ...run, parts: applyPartEvent(run.parts, partEvent), cursor: event.seq,
      ...(event.type === "message-start" ? { presentationVersion: 2 as const } : {}),
      ...(partEvent.type === "message-entry" && partEvent.initial ? { inputEntryId: partEvent.entryId } : {}),
    };
  }
  return { ...run, ...data, cursor: event.seq } as Run;
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
