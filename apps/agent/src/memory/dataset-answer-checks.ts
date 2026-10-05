import type { MemoryEntry, SampleAnswerCheck } from "@memory/contracts";
import { UserFacingError } from "../errors.js";
import { normalizeFact } from "./values.js";

export const DATASET_ANSWER_CHECK_VERSION = 1;
export interface DatasetAnswerInput {
  modelId: string;
  memory: Pick<MemoryEntry, "title" | "content" | "category" | "occurredAt" | "validity">;
  questions: string[];
}
export interface DatasetAnswerFinding {
  index: number;
  status: "answerable" | "ambiguous" | "unsupported";
  answerQuote: string | null;
  evidenceQuotes: string[];
  /** Earliest question asking for the same subject, relation and event/time. */
  factIndex: number | null;
  reason: string;
}
export interface DatasetAnswerResult {
  answers: DatasetAnswerFinding[];
  usage: { input: number; output: number };
}
export interface DatasetAnswerAssessment {
  questions: string[];
  answers: DatasetAnswerFinding[];
}

/** Number exact source chunks once; the model selects them instead of retyping quotations. */
export function datasetSourceSpans(content: string) {
  const spans: { index: number; text: string }[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + 2000);
    if (end < content.length) {
      const boundaries = [...content.slice(start, end).matchAll(/[。！？；\n]/gu)];
      const boundary = boundaries.at(-1);
      if (boundary) end = start + boundary.index + 1;
      else if (/[\uD800-\uDBFF]/u.test(content[end - 1]) && /[\uDC00-\uDFFF]/u.test(content[end])) end--;
    }
    spans.push({ index: spans.length, text: content.slice(start, end) }); start = end;
  }
  return spans;
}

/** Checks provenance and complete coverage; semantic judgements still belong to the model. */
export function validateDatasetAnswers(input: DatasetAnswerInput, answers: DatasetAnswerFinding[]) {
  const invalid = () => { throw new UserFacingError(422, "DATASET_ANSWER_CHECK_INVALID", "来源作答结果须覆盖每道问题，引用冻结正文，并明确可回答性及同事实题目"); };
  if (!input.questions.length || input.questions.length > 50 || answers.length !== input.questions.length ||
    new Set(answers.map((answer) => answer.index)).size !== input.questions.length) invalid();
  const byIndex = new Map(answers.map((answer) => [answer.index, answer]));
  for (const answer of answers) {
    if (!Number.isInteger(answer.index) || answer.index < 0 || answer.index >= input.questions.length || !answer.reason.trim() ||
      !["answerable", "ambiguous", "unsupported"].includes(answer.status) || answer.evidenceQuotes.length > 4 ||
      answer.evidenceQuotes.some((quote) => !quote.trim() || quote.length > 4000 || !input.memory.content.includes(quote))) invalid();
    if (answer.status !== "answerable") {
      if (answer.answerQuote !== null || answer.factIndex !== null) invalid();
      continue;
    }
    if (!answer.answerQuote?.trim() || answer.answerQuote.length > 2000 || !input.memory.content.includes(answer.answerQuote) ||
      !answer.evidenceQuotes.some((quote) => quote.includes(answer.answerQuote!)) ||
      !Number.isInteger(answer.factIndex) || answer.factIndex! < 0 || answer.factIndex! > answer.index) invalid();
    const root = byIndex.get(answer.factIndex!);
    if (!root || root.status !== "answerable" || root.factIndex !== root.index ||
      normalizeFact(root.answerQuote || "") !== normalizeFact(answer.answerQuote!)) invalid();
  }
}

/** Bind the final proposed answer/pair to an assessment that never saw the candidate answers. */
export function checkedSampleAnswer(input: DatasetAnswerInput, assessment: DatasetAnswerAssessment, index: number, answer: string, trainingIndex?: number): SampleAnswerCheck {
  if (JSON.stringify(input.questions) !== JSON.stringify(assessment.questions))
    throw new UserFacingError(409, "DATASET_ANSWER_CHECK_CHANGED", "问题已改变，须按修订后的问题重新读取来源作答");
  validateDatasetAnswers(input, assessment.answers);
  const finding = assessment.answers.find((item) => item.index === index)!;
  if (!finding || finding.status !== "answerable") throw new UserFacingError(422, "DATASET_ANSWER_UNCERTAIN",
    `samples 中索引 ${index} 的来源作答未得到唯一受支持答案。请对照 answerChecks 修复题干前提或消歧；不能支持则 defer 或 exclude`);
  if (normalizeFact(answer) !== normalizeFact(finding.answerQuote!)) throw new UserFacingError(422, "DATASET_ANSWER_MISMATCH",
    `samples 中索引 ${index} 的候选答案与来源作答不一致。请对照 answerChecks 的最短明确答案 revise；不能确定则 defer`);
  if (trainingIndex !== undefined) {
    const training = assessment.answers.find((item) => item.index === trainingIndex);
    if (training?.status !== "answerable" || training.factIndex !== finding.factIndex)
      throw new UserFacingError(422, "DATASET_FACT_MISMATCH", `samples 中索引 ${index} 与训练题 ${trainingIndex} 的来源作答未认定为同一事实。答案相同也不代表人物、所问关系与时间相同；请修订配对问法或 defer`);
  }
  return { version: DATASET_ANSWER_CHECK_VERSION, modelId: input.modelId, question: input.questions[index], answerQuote: finding.answerQuote!,
    evidenceQuotes: finding.evidenceQuotes, equivalentQuestion: input.questions[finding.factIndex!], reason: finding.reason };
}
