import type { ImageRegion, MemoryEntry, SourceRef, VideoFrame } from "@memory/contracts";
import { evidenceOf } from "./values.js";
import { UserFacingError } from "../errors.js";

/** Supplied by the application from completed, persisted tool results, never model parameters. */
export interface SourceInspection {
  toolCallId: string;
  assetId: string;
  sha256: string;
  start: number;
  end: number;
  kind: "text" | "image" | "video";
  video?: VideoFrame;
  region?: ImageRegion;
  viewSha256?: string;
}

function covers(source: SourceRef, reads: SourceInspection[]) {
  const matching = reads.filter((read) => read.assetId === source.assetId && read.sha256 === source.sha256 &&
    (source.video ? read.kind === "video" && Math.abs((read.video?.timestamp ?? -1) - source.video.timestamp) < 0.00001 : read.kind !== "video"));
  if (source.visual || matching.some((read) => read.kind === "image" || read.kind === "video")) {
    const target = source.view?.region || source.visual?.region || { x: 0, y: 0, width: 1, height: 1 };
    return matching.some((read) => ["image", "video"].includes(read.kind) && (!read.region ||
      (read.region.x <= target.x + 1e-9 && read.region.y <= target.y + 1e-9 &&
       read.region.x + read.region.width >= target.x + target.width - 1e-9 &&
       read.region.y + read.region.height >= target.y + target.height - 1e-9)));
  }
  let end = source.start;
  for (const read of matching.filter((read) => read.kind === "text").sort((a, b) => a.start - b.start)) {
    if (read.start > end) break;
    end = Math.max(end, read.end);
    if (end >= source.end && end > source.start) return true;
  }
  return false;
}

export function requireObservationRead(entry: MemoryEntry, reads: SourceInspection[] = []) {
  if (entry.status !== "draft") throw new UserFacingError(403, "USER_INSTRUCTION_REQUIRED", "已确认记录的纠正需要用户明确指令");
  const sources = evidenceOf(entry).filter((source) => source.type === "asset");
  if (!sources.length || !sources.every((source) => covers(source, reads)))
    throw new UserFacingError(409, "OBSERVATION_NOT_INSPECTED", "请先在本次任务用 read_evidence 读取对应原件，再修订观察；文字应覆盖来源范围，图片须实际读取整图或覆盖观察的局部，视频须读取同一时间画面；检索摘要不算原件复核");
}
