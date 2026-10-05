import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "../src/config.js";
import { answerDatasetQuestions } from "../src/integrations/pi/dataset-answer-checker.js";
import { checkedSampleAnswer, datasetSourceSpans, validateDatasetAnswers, type DatasetAnswerFinding, type DatasetAnswerInput } from "../src/memory/dataset-answer-checks.js";

const input: DatasetAnswerInput = { modelId: "test/model", memory: { title: "交接", category: "event", occurredAt: "2025-03-02",
  content: "2025-03-02，林舟把备用钥匙交给陈默。" }, questions: ["2025-03-02，谁收到林舟交出的备用钥匙？"] };
const answer: DatasetAnswerFinding = { index: 0, status: "answerable", answerQuote: "陈默", evidenceQuotes: [input.memory.content], factIndex: 0, reason: "正文明确陈默为接收人" };

describe("source-only dataset checks (controlled model protocol, not semantic accuracy)", () => {
  it("sends only the frozen source and questions even when callers provide candidate answers or repair labels", async () => {
    const sent: unknown[] = [];
    const models = { getModel: () => ({}), completeSimple: async (_model: unknown, context: { messages: { content: string }[] }) => {
      sent.push(JSON.parse(context.messages[0].content));
      const { evidenceQuotes: _quotes, ...finding } = answer;
      return { stopReason: "toolUse", content: [{ type: "toolCall", id: "answer-check", name: "submit_dataset_answers", arguments: { answers: [{ ...finding, evidenceIndices: [0] }] } }],
        usage: { input: 15, output: 12, cacheRead: 0, cacheWrite: 0 } };
    } } as unknown as ModelRuntime;
    const provider = { id: "test", model: { name: "model", maxTokens: 8000, reasoning: false } } as ProviderConfig;
    const withDistractors = { ...input, samples: [{ answer: "故意诱导的答案" }], repair: { reason: "必须认可" }, gold: "参考答案不可发送" };
    const result = await answerDatasetQuestions(models, provider, withDistractors, new AbortController().signal);
    expect(sent).toEqual([{ memory: { ...input.memory, content: [{ index: 0, text: input.memory.content }] }, questions: input.questions }]);
    expect(result).toEqual({ answers: [answer], usage: { input: 15, output: 12 } });
  });

  it("preserves source punctuation and Unicode boundaries in numbered evidence", () => {
    const content = "原文的逗号，不能换成句号。\n" + "字".repeat(1999) + "🌲" + "后半段；".repeat(600);
    const spans = datasetSourceSpans(content);
    expect(spans.map((span) => span.text).join("")).toBe(content);
    expect(spans.every((span, index) => span.index === index && span.text.length <= 2000 && Buffer.from(span.text).toString() === span.text)).toBe(true);
  });

  it("rejects missing questions, invented evidence, ambiguous asserted answers and invalid equivalence groups", () => {
    expect(() => validateDatasetAnswers(input, [])).toThrow("覆盖每道问题");
    expect(() => validateDatasetAnswers(input, [{ ...answer, evidenceQuotes: ["林舟收到了钥匙"] }])).toThrow("引用冻结正文");
    expect(() => validateDatasetAnswers(input, [{ ...answer, status: "ambiguous" }])).toThrow("明确可回答性");
    expect(() => validateDatasetAnswers(input, [{ ...answer, factIndex: 1 }])).toThrow("同事实题目");
    expect(() => validateDatasetAnswers(input, [answer])).not.toThrow();
  });

  it("requires agreement with the independent answer and a fresh check of revised questions", () => {
    const assessment = { questions: input.questions, answers: [answer] };
    expect(() => checkedSampleAnswer(input, assessment, 0, "林舟")).toThrow("候选答案与来源作答不一致");
    expect(() => checkedSampleAnswer({ ...input, questions: ["2025-03-02，谁交出了钥匙？"] }, assessment, 0, "林舟")).toThrow("按修订后的问题重新");
    expect(checkedSampleAnswer(input, assessment, 0, "陈默")).toMatchObject({ modelId: "test/model", question: input.questions[0], answerQuote: "陈默", evidenceQuotes: [input.memory.content] });
  });

  it("blocks pairing identical answers to different people or relations", () => {
    const two = { ...input, memory: { ...input.memory, content: "林舟买的花是红色，陈默拍的花也是红色。" },
      questions: ["林舟买的花是什么颜色？", "陈默拍的花是什么颜色？"] };
    const answers = two.questions.map((_, index) => ({ ...answer, index, answerQuote: "红色", factIndex: index, evidenceQuotes: [two.memory.content] }));
    expect(() => checkedSampleAnswer(two, { questions: two.questions, answers }, 1, "红色", 0)).toThrow("未认定为同一事实");
  });
});
