import type { MemoryEntry, TrainingSample } from "@memory/contracts";
import { UserFacingError } from "../errors.js";
import { normalizeFact } from "./values.js";
import { assertSampleTime } from "./dataset-time-review.js";

export interface SampleChange {
  id: string;
  version: number;
  action: "approve" | "revise" | "exclude" | "defer";
  question?: string;
  answer?: string;
  evaluationOf?: TrainingSample["evaluationOf"];
  reason?: string;
}
export interface SampleReviewContext {
  actor: "user" | "agent" | "processor";
  requestKey?: string;
  runId?: string;
  jobId?: string;
  modelId?: string;
  protocolVersion?: number;
}
export interface SampleReviewReceipt {
  id: string;
  datasetId: string;
  actor: SampleReviewContext["actor"];
  runId?: string;
  jobId?: string;
  modelId?: string;
  reason: string;
  before: { id: string; version: number }[];
  after: { id: string; version: number; status: TrainingSample["status"] }[];
  propagated?: { id: string; previousVersion: number; version: number; action: "require-review" | "rebind" }[];
  createdAt: string;
}

/** Mechanical checks complement the reviewer's semantic judgement; they do not prove question quality. */
export function validateReviewedSample(sample: TrainingSample, memories: MemoryEntry[]) {
  if (!sample.question.trim() || sample.question.length > 300 || !sample.answer.trim() || sample.answer.length > 24000)
    throw new UserFacingError(422, "INVALID_SAMPLE", "问题须为 1–300 字符，答案须为非空且不超过 24000 字符");
  const grounded = memories.some((memory) => memory.content.includes(sample.answer)) || (sample.kind === "combination" &&
    sample.answer.split("\n").filter(Boolean).every((line) => memories.some((memory) => memory.content.includes(line)) ||
      memories.some((memory) => line === [memory.occurredAt && `发生日期：${memory.occurredAt}`, memory.validity?.from && `记录有效期起点：${memory.validity.from}`, memory.validity?.to && `记录有效期终点：${memory.validity.to}`].filter(Boolean).join("；"))));
  if (!grounded) throw new UserFacingError(422, "UNGROUNDED_ANSWER", "答案必须来自冻结的当前确认正文；请先纠正记忆再重建数据集");
  const answer = normalizeFact(sample.answer);
  if (/^(我|你|您|他|她|它|我们|你们|他们|她们|它们|这个|那个|这里|那里|i|me|you|he|she|it|we|they|this|that)$/iu.test(answer))
    throw new UserFacingError(422, "AMBIGUOUS_ANSWER", "答案只有代词，不能独立表达记忆事实，请修订或排除");
  if (answer && normalizeFact(sample.question).includes(answer)) throw new UserFacingError(422, "ANSWER_IN_QUESTION", "问题已经透露完整答案，请修订问法");
  assertSampleTime(sample, memories);
}
