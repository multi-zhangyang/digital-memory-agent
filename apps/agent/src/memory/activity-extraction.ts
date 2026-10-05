import type { AssetKind, ImageRegion, MemoryActivity } from "@memory/contracts";
import { UserFacingError } from "../errors.js";
import { dateMentions } from "./dataset-time-review.js";

export interface ActivityObservation {
  ref: string;
  id: string;
  version: number;
  title: string;
  content: string;
  occurredAt: string;
  place: string;
  status: string;
  uncertainty: string;
  entityIds: string[];
  sourceQuotes?: string[];
  sources: { ref: string; kind: AssetKind; textRange?: { start: number; end: number }; timestamp?: number; region?: ImageRegion }[];
  authority?: "user" | "observation";
}
export function activityDate(memory: { occurredAt: string; editedBy?: string; acceptedBy?: string }, sourceQuotes: string[]) {
  if (memory.editedBy === "user" || memory.acceptedBy === "user") return memory.occurredAt;
  const dates = [...new Set(dateMentions(sourceQuotes.join("\n")).filter((d) => d.precision === 10).map((d) => d.value))];
  return dates.length === 1 ? dates[0] : memory.occurredAt;
}
export interface ActivityExtractionInput {
  modelId: string;
  observations: ActivityObservation[];
  requiredRefs: string[];
  existing: { id: string; title: string; members: string[]; locked: boolean }[];
  separated: [string, string][];
  validationFeedback?: { reason: string; previous: ActivityProposal[] };
}
export interface ActivityProposal extends Pick<MemoryActivity, "title" | "summary" | "occurredAt" | "place" | "issues" | "reason"> {
  members: string[];
}
export interface ActivityExtractionResult {
  activities: ActivityProposal[];
  usage?: { input: number; output: number };
}

// An unlocated visual observation has no cross-source event identity. Shared
// originals can still connect regions/frames; an explicit linked observation
// must carry its supporting originals or confirmed date/place.
export function unlinkedVisualPairs(observations: ActivityObservation[]): [string, string][] {
  const pairs: [string, string][] = [];
  const unlocated = (o: ActivityObservation) => !o.occurredAt && !o.place && o.sources.length > 0 &&
    o.sources.every((source) => source.kind === "image" || source.kind === "video");
  for (let i = 0; i < observations.length; i++) for (let j = i + 1; j < observations.length; j++) {
    const a = observations[i], b = observations[j];
    if ((unlocated(a) || unlocated(b)) && !a.sources.some((source) => b.sources.some((other) => source.ref === other.ref)))
      pairs.push([a.ref, b.ref]);
  }
  return pairs;
}

export function validateActivities(input: ActivityExtractionInput, result: ActivityExtractionResult) {
  const observations = new Map(input.observations.map((o) => [o.ref, o]));
  const used = new Set<string>();
  const invalid = (reason: string): never => { throw new UserFacingError(422, "ACTIVITY_INVALID", `活动归组校验未通过：${reason}`); };
  if (!Array.isArray(result.activities) || result.activities.length > input.requiredRefs.length) invalid("活动数量不能多于 requiredRefs 数量");
  const unlinked = unlinkedVisualPairs(input.observations);
  for (const activity of result.activities) {
    if (!activity.title?.trim() || activity.title.length > 120 || !activity.summary?.trim() || activity.summary.length > 2000 ||
      !activity.reason?.trim() || activity.reason.length > 800 || typeof activity.place !== "string" || activity.place.length > 120 ||
      typeof activity.occurredAt !== "string" || activity.occurredAt.length > 10 ||
      !Array.isArray(activity.issues) || activity.issues.length > 8 || activity.issues.some((issue) => typeof issue !== "string" || issue.length > 240) ||
      !Array.isArray(activity.members) || !activity.members.length || activity.members.length > 48) invalid("活动字段或成员格式不正确");
    if (!activity.members.some((ref) => input.requiredRefs.includes(ref))) invalid("每组必须包含至少一条 requiredRefs；不要重复返回无关的已有活动");
    for (const ref of activity.members) {
      if (!observations.has(ref)) invalid(`成员 ${ref} 不在输入观察中`);
      if (used.has(ref)) invalid(`成员 ${ref} 重复归组；每条观察只能出现一次`);
      used.add(ref);
    }
    const unsupported = unlinked.find(([a, b]) => activity.members.includes(a) && activity.members.includes(b));
    if (unsupported) invalid(`${unsupported.join(" 与 ")} 没有共同原件，且图片或视频观察缺少日期和地点依据；必须分开，不能用其他观察补出其活动身份`);
    const separated = input.separated.find(([a, b]) => activity.members.includes(a) && activity.members.includes(b));
    if (separated) invalid(`${separated.join(" 与 ")} 已要求分开，不能合并`);
    const dates = new Set(activity.members.map((ref) => observations.get(ref)!.occurredAt).filter(Boolean));
    // A concrete activity cannot be joined on people/place alone across conflicting known dates.
    if (dates.size > 1) invalid(`成员 ${activity.members.join(", ")} 含有不同已知日期，必须分开`);
    if (activity.occurredAt && (!/^\d{4}-\d{2}-\d{2}$/.test(activity.occurredAt) || !dates.has(activity.occurredAt))) invalid("活动日期必须来自本组观察的已知日期，未知时留空");
  }
  const missing = input.requiredRefs.filter((ref) => !used.has(ref));
  if (missing.length) invalid(`遗漏 requiredRefs：${missing.join(", ")}；没有可靠关联的观察也须单独归组`);
}
