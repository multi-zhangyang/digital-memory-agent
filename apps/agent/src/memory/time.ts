import type { MemoryValidity } from "@memory/contracts";
import { dateInZone } from "./retrieval.js";

export function validMemoryDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validateValidity(value: MemoryValidity) {
  return (
    (!value.from || validMemoryDate(value.from)) &&
    (!value.to || validMemoryDate(value.to)) &&
    !(value.from && value.to && value.from > value.to)
  );
}
export function resolveMemoryTime(
  expression: string,
  referenceTime: string,
  timeZone: string,
): MemoryValidity | undefined {
  if (!expression.trim()) return undefined;
  const date = dateInZone(new Date(referenceTime), timeZone);
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const numerals: Record<string, string> = {
    一: "1",
    二: "2",
    三: "3",
    四: "4",
    五: "5",
    六: "6",
    七: "7",
    八: "8",
    九: "9",
    十: "10",
    十一: "11",
    十二: "12",
  };
  const normalized = expression.replace(
    /([一二三四五六七八九十]+)月/g,
    (all, digits: string) => (numerals[digits] ? numerals[digits] + "月" : all),
  );
  const day = normalized.match(/(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})日?/);
  const year = expression.includes("去年")
    ? y - 1
    : expression.includes("前年")
      ? y - 2
      : y;
  let from: string | undefined;
  let to: string | undefined;
  let precision: MemoryValidity["precision"] = "unknown";
  if (day) {
    from = `${day[1] || year}-${day[2].padStart(2, "0")}-${day[3].padStart(2, "0")}`;
    precision = "day";
  } else if (/今天|昨天|前天|today|yesterday/i.test(expression)) {
    const shift = /前天/.test(expression)
      ? -2
      : /昨天|yesterday/i.test(expression)
        ? -1
        : 0;
    from = new Date(Date.parse(date) + shift * 86400000)
      .toISOString()
      .slice(0, 10);
    precision = "day";
  } else {
    const month = normalized.match(/(?:(\d{4})年)?(\d{1,2})月/);
    if (month || /上个月|这个月|本月/.test(expression)) {
      const start = new Date(
        Date.UTC(
          month?.[1] ? Number(month[1]) : year,
          month
            ? Number(month[2]) - 1
            : m - 1 - Number(expression.includes("上个月")),
          1,
        ),
      );
      if (month && (Number(month[2]) < 1 || Number(month[2]) > 12))
        return { precision: "unknown", expression };
      from = start.toISOString().slice(0, 10);
      to = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
      )
        .toISOString()
        .slice(0, 10);
      precision = "month";
    } else if (/\d{4}年|去年|前年|今年/.test(expression)) {
      const target = expression.match(/(\d{4})年/)?.[1] || String(year);
      from = target + "-01-01";
      to = target + "-12-31";
      precision = "year";
    }
  }
  const validity = { from, to, precision, expression };
  return validateValidity(validity)
    ? validity
    : { precision: "unknown", expression };
}
