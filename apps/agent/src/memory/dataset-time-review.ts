import type { MemoryEntry, SampleTimeQuality, TrainingSample } from "@memory/contracts";
import { UserFacingError } from "../errors.js";

type DateMention = { value: string; precision: number };

/** Mechanical date grounding, not an arbitrary-language temporal reasoner. */
function parseDates(text: string) {
  const found = new Map<string, DateMention>();
  const invalid: string[] = [];
  // One match per span: a Chinese date must not also introduce a bare year, while
  // a separately mentioned year must remain available for multi-event questions.
  const pattern = /(?<![\dA-Za-z])([12]\d{3})(?:年(?:\s*(\d{1,2})月(?:\s*(\d{1,2})[日号]?)?)?|[-/.](\d{1,2})(?:[-/.](\d{1,2}))?|(?=$|[^\dA-Za-z]))/gu;
  for (const match of text.normalize("NFKC").matchAll(pattern)) {
    const monthText = match[2] || match[4], dayText = match[3] || match[5];
    const month = monthText ? Number(monthText) : undefined, day = dayText ? Number(dayText) : undefined;
    const value = match[1] + (month === undefined ? "" : "-" + String(month).padStart(2, "0")) + (day === undefined ? "" : "-" + String(day).padStart(2, "0"));
    const parsed = day === undefined ? undefined : new Date(value);
    if ((month !== undefined && (month < 1 || month > 12)) || (day !== undefined &&
      (day < 1 || day > 31 || !parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value))) { invalid.push(match[0]); continue; }
    found.set(value, { value, precision: value.length });
  }
  return { dates: [...found.values()], invalid };
}

export const dateMentions = (text: string) => parseDates(text).dates;

function day(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function matches(mention: DateMention, anchor: string) {
  return mention.precision >= anchor.length && mention.value.slice(0, anchor.length) === anchor;
}

export function sampleTimeQuality(sample: TrainingSample, memories: MemoryEntry[]): SampleTimeQuality {
  const issues: SampleTimeQuality["issues"] = [];
  if (sample.kind !== "qa" || sample.status === "excluded") return { version: 1, issues };
  const question = parseDates(sample.question), questionDates = question.dates, answerDates = dateMentions(sample.answer);
  for (const invalid of question.invalid) issues.push({ code: "invalid-question-date", severity: "blocking", message: `问题中的 ${invalid} 不是有效日期，请核对来源后修订` });
  const asksDate = /何时|什么时候|哪(?:一)?(?:天|年|个月)|几月|几号|日期|什么时间|\bwhen\b|\bwhat date\b/iu.test(sample.question)
    && /^[\d年月日号\s./—–-]+$/u.test(sample.answer.trim()) && answerDates.length > 0;
  const relative = /现在|目前|今天|昨天|明天|今年|去年|上个月|下个月|这次|那次|当时|当年|最近|\b(?:now|today|yesterday|tomorrow|currently)\b/iu.test(sample.question);
  if (relative && !questionDates.length) issues.push({ code: "relative-time", severity: "blocking", message: "问题只有相对时间，离开当前会话后含义会变化；请使用来源支持的明确日期或时段" });
  const knownDates = memories.flatMap((memory) => [...dateMentions(memory.content),
    ...[day(memory.occurredAt), day(memory.validity?.from), day(memory.validity?.to)].filter((value): value is string => !!value).map((value) => ({ value, precision: value.length }))]);
  for (const date of questionDates) {
    const supported = knownDates.some((anchor) => anchor.value.startsWith(date.value));
    const withinValidity = memories.some((memory) => {
      const from = day(memory.validity?.from), to = day(memory.validity?.to);
      return from && to && date.precision === 10 && date.value >= from && date.value <= to;
    });
    if (!supported && !withinValidity) issues.push({ code: "unsupported-question-date", severity: "blocking",
      message: `问题中的 ${date.value} 没有冻结来源支持，请核对发生时间与记录有效期` });
  }
  for (const memory of memories) {
    const occurred = day(memory.occurredAt), from = day(memory.validity?.from), to = day(memory.validity?.to);
    if (occurred) {
      if (!questionDates.some((date) => matches(date, occurred)) && !(asksDate && answerDates.some((date) => matches(date, occurred))))
        issues.push({ code: "missing-event-time", severity: "blocking", memoryId: memory.id,
          message: `这条事件发生于 ${occurred}；问题须明确这个日期，询问该日期本身时可由直接日期答案承载` });
    } else if (from || to) {
      const precision = memory.validity?.precision;
      const length = precision === "year" ? 4 : precision === "month" ? 7 : 10;
      const anchors = [from, to].filter((value): value is string => !!value).map((value) => value.slice(0, length));
      const inPeriod = (date: DateMention) => anchors.some((anchor) => matches(date, anchor)) ||
        (!!from && !!to && date.precision === 10 && date.value >= from && date.value <= to);
      if (!questionDates.some(inPeriod) && !(asksDate && answerDates.some(inPeriod))) issues.push({ code: "missing-validity-time", severity: "blocking", memoryId: memory.id,
        message: `这条记录的已知有效时间为 ${from || "起点未知"} 至 ${to || "终点未知"}；请在问题中明确所问时段或有效期内的日期` });
    } else if (memory.category === "event") {
      issues.push({ code: "unknown-event-time", severity: "review", memoryId: memory.id, message: "来源没有已核对的事件时间；不得补造日期，请用已有事件信息消歧，无法区分则排除" });
    }
  }
  return { version: 1, issues: issues.filter((issue, index, list) => list.findIndex((other) => other.code === issue.code && other.memoryId === issue.memoryId && other.message === issue.message) === index) };
}

export function assertSampleTime(sample: TrainingSample, memories: MemoryEntry[]) {
  const quality = sampleTimeQuality(sample, memories);
  const problem = quality.issues.find((issue) => issue.severity === "blocking");
  if (problem) throw new UserFacingError(422, "SAMPLE_TIME_AMBIGUOUS", problem.message + "。请通过 inspect_dataset 查看并修订或排除此样本");
  return quality;
}
