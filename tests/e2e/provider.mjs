// Local model-protocol fixture. Never used by the application outside Playwright.
import { createServer } from "node:http";
import { createChat } from "@shadcn/helpers/ai-sdk";
const extractionAttempts = new Map();
const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  const buffers = [];
  for await (const chunk of request) buffers.push(chunk);
  const body = JSON.parse(Buffer.concat(buffers).toString() || "{}");
  const messages = body.messages || [];
  const userIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const prompt =
    typeof messages[userIndex]?.content === "string"
      ? messages[userIndex].content
      : (messages[userIndex]?.content || [])
          .map((part) => part.text || "")
          .join("");
  if (body.tools?.some((tool) => tool.function?.name === "extract_memories")) {
    const input = JSON.parse(prompt);
    const text = input.text;
    const attempt = (extractionAttempts.get(text) || 0) + 1;
    extractionAttempts.set(text, attempt);
    const demo = text.includes("以下人物和经历完全虚构");
    const suffix = demo ? "（示例）" : "";
    const base = {
      kind: "observation",
      quote: text,
      occurredAt: "",
      people: [],
      place: "",
      uncertainty: "",
      attribute: null,
    };
    let entries;
    if (text.includes("住在苏州"))
      entries = [
        {
          ...base,
          title: "现居苏州" + suffix,
          content: "我现在住在苏州。",
          category: "profile",
          attribute: { key: "home_city", value: "苏州" },
        },
      ];
    else if (text.includes("住在杭州"))
      entries = [
        {
          ...base,
          title: "现居杭州" + suffix,
          content: "我现在住在杭州。",
          category: "profile",
          attribute: { key: "home_city", value: "杭州" },
        },
      ];
    else if (text.includes("陈默"))
      entries = [
        {
          ...base,
          title: "运河散步" + suffix,
          content: "2026-03-14，我和陈默在杭州运河边散步。",
          category: "event",
          occurredAt: "2026-03-14",
          people: ["陈默"],
          place: "杭州运河",
        },
      ];
    else
      entries = [
        {
          ...base,
          title: "未确定的经历" + suffix,
          content: text,
          category: "fact",
          kind: "inference",
          uncertainty: "具体时间尚未确定",
        },
      ];
    if (text.includes("故障样本") && attempt === 1)
      entries[0].quote = "这句话没有出现在原始资料中";
    await new Promise((resolve) =>
      setTimeout(resolve, text.includes("慢速样本") ? 1600 : 350),
    );
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) =>
      "data: " +
      JSON.stringify({
        id: "memory-extraction-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "browser-test",
        choices: [{ index: 0, delta, finish_reason }],
        usage: {
          prompt_tokens: 240,
          completion_tokens: 120,
          total_tokens: 360,
        },
      }) +
      "\n\n";
    response.end(
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: "extract_" + attempt,
              type: "function",
              function: {
                name: "extract_memories",
                arguments: JSON.stringify({ entries }),
              },
            },
          ],
        },
        null,
      ) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
    return;
  }
  if (prompt.includes("错误测试")) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "Test upstream failure" } }),
    );
    return;
  }
  const results = messages
    .slice(userIndex + 1)
    .filter((message) => message.role === "tool")
    .map((message) => {
      try {
        return JSON.parse(
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text || "").join(""),
        );
      } catch {
        return {};
      }
    });
  const asset = results.find((result) => result.assets)?.assets[0];
  const calls = prompt.includes("通用任务测试")
    ? [
        ["read", { path: "input.csv" }],
        [
          "write",
          {
            path: "sum.py",
            content:
              'import csv,json\nrows=list(csv.DictReader(open("input.csv")))\nprint("PROCESSING")\njson.dump({"total":sum(int(r["amount"]) for r in rows)},open("result.json","w"))\n',
          },
        ],
        ["bash", { command: "python3 sum.py", timeout: 20 }],
        ["read", { path: "result.json" }],
      ]
    : prompt.includes("权限测试")
      ? [["write", { path: "approved.txt", content: "permission granted" }]]
      : prompt.includes("纠偏测试")
        ? [
            [
              "bash",
              { command: "printf START; sleep 3; printf END", timeout: 20 },
            ],
          ]
        : prompt.includes("提问测试")
          ? [
              [
                "ask_user",
                { question: "这次经历发生在周几？", options: ["周六", "周日"] },
              ],
            ]
          : prompt.includes("回忆")
            ? [["search_memories", { query: "公园" }]]
            : prompt.includes("整理") || prompt.includes("等待测试")
              ? [
                  [
                    "update_plan",
                    {
                      steps: [
                        { title: "查找并阅读所选资料", status: "running" },
                        { title: "整理时间线与个人记忆", status: "pending" },
                      ],
                    },
                  ],
                  ["search_assets", { query: "" }],
                  [
                    "read_asset_text",
                    {
                      assetId:
                        asset?.id || "00000000-0000-0000-0000-000000000000",
                    },
                  ],
                  [
                    "write_artifact",
                    {
                      title: "公园散步 · 经历整理",
                      content:
                        "## 经历记录\n\n周六，我在公园散步。\n\n## 待核对\n\n具体日期尚未提供。",
                      sourceAssetIds: asset ? [asset.id] : [],
                    },
                  ],
                  [
                    "propose_memory",
                    {
                      title: "公园散步",
                      content: "周六在公园散步。",
                      kind: "observation",
                      sourceAssetIds: asset ? [asset.id] : [],
                    },
                  ],
                  [
                    "update_plan",
                    {
                      steps: [
                        { title: "查找并阅读所选资料", status: "completed" },
                        { title: "整理时间线与个人记忆", status: "completed" },
                      ],
                    },
                  ],
                ]
              : [];
  const call = calls[results.length];
  const output = prompt.includes("改为输出简短确认")
    ? "已按新指令调整。"
    : prompt.includes("通用任务测试")
      ? "已生成 result.json，合计 7。"
      : prompt.includes("权限测试")
        ? "权限操作完成。"
        : prompt.includes("回忆")
          ? results[0]?.memories?.map((memory) => memory.content).join("\n") ||
            "没有找到已确认的相关记忆。"
          : prompt.includes("提问测试")
            ? "已收到你的回答：" + results[0]?.answer
            : calls.length
              ? "整理已完成。可以在右侧查看笔记，并核对新提出的记忆。"
              : "OK";
  if (body.stream === false) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "test",
        choices: [
          {
            message: { role: "assistant", content: output },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const write = (delta, finish_reason = null, usage) => {
    if (!response.destroyed)
      response.write(
        "data: " +
          JSON.stringify({
            id: "e2e-completion",
            object: "chat.completion.chunk",
            created: 1,
            model: "browser-test",
            choices: [{ index: 0, delta, finish_reason }],
            ...(usage ? { usage } : {}),
          }) +
          "\n\n",
      );
  };
  await new Promise((resolve) =>
    setTimeout(resolve, prompt.includes("等待测试") ? 1600 : call ? 180 : 50),
  );
  if (prompt.includes("流式体验测试")) {
    for (let index = 1; index <= 100 && !response.destroyed; index++) {
      write({ content: `片段 ${String(index).padStart(3, "0")}，` });
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    write({}, "stop", {
      prompt_tokens: 240,
      completion_tokens: 300,
      total_tokens: 540,
    });
  } else if (call) {
    write({ reasoning_content: "检查任务与工具权限。" });
    write({
      tool_calls: [
        {
          index: 0,
          id: "call_" + results.length,
          type: "function",
          function: { name: call[0], arguments: JSON.stringify(call[1]) },
        },
      ],
    });
    write({}, "tool_calls");
  } else {
    const script = createChat()
      .user("test")
      .assistant(({ writer }) => writer.text(output, { mode: "instant" }));
    const stream = await script.transport({ delayMs: 0 }).sendMessages({
      trigger: "submit-message",
      chatId: "test",
      messages: script.get(1),
    });
    for await (const part of stream)
      if (part.type === "text-delta") write({ content: part.delta });
    write({}, "stop", {
      prompt_tokens: 240,
      completion_tokens: 48,
      total_tokens: 288,
    });
  }
  if (!response.destroyed) response.end("data: [DONE]\n\n");
});
server.listen(4312, "127.0.0.1");
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close();
});
