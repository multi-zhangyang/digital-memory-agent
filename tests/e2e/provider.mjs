// Local model-protocol fixture. Never used by the application outside Playwright.
import { createServer } from "node:http";
import { createChat } from "@shadcn/helpers/ai-sdk";
import { randomUUID } from "node:crypto";
const extractionAttempts = new Map();
let backgroundReleased = false;
const backgroundWaiters = new Set();
const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  if (request.url === "/test/release-background") {
    backgroundReleased = true;
    for (const release of backgroundWaiters) release();
    backgroundWaiters.clear();
    response.end("released");
    return;
  }
  const buffers = [];
  for await (const chunk of request) buffers.push(chunk);
  const body = JSON.parse(Buffer.concat(buffers).toString() || "{}");
  if (request.url === "/v1/embeddings") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0] })) }));
    return;
  }
  if (request.url === "/features") {
    response.writeHead(200, { "Content-Type": "application/json" });
    const result = body.action === "info" ? { protocol: 1, capabilities: ["text", "image", "face"], revision: "test-v1", dimensions: 5 }
      : body.action === "embed" ? { revision: "test-v1", vectors: body.texts.map(() => [1, 0, 0, 0, 0]), truncated: body.texts.map(() => false), tokens: body.texts.map(() => 1) }
        : body.capability === "face" ? { revision: "test-v1", coordinateSpace: "exif-oriented", faces: [] }
          : { revision: "test-v1", vector: [1, 0, 0, 0, 0] };
    response.end(JSON.stringify(result));
    return;
  }
  const messages = body.messages || [];
  // Follow the advertised protocol: discover a deferred definition before calling it.
  const advertised = new Set((body.tools || []).map((tool) => tool.function?.name));
  const declaredDelta = (delta) => !delta.tool_calls || !advertised.has("tool_search") ? delta : {
    ...delta, tool_calls: delta.tool_calls.map((call) => advertised.has(call.function.name) ? call : {
      ...call, function: { name: "tool_search", arguments: JSON.stringify({ query: call.function.name, limit: 1 }) },
    }),
  };
  const discoveryIds = new Set(messages.flatMap((message) => (message.tool_calls || [])
    .filter((call) => call.function.name === "tool_search").map((call) => call.id)));

  if (!body.tools?.length && messages.some((message) => ["system", "developer"].includes(message.role) &&
    (typeof message.content === "string" ? message.content : (message.content || []).map((part) => part.text || "").join("")).includes("context summarization assistant"))) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "compaction-fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 1000, completion_tokens: 80, total_tokens: 1080 } }) + "\n\n";
    response.end(frame({ content: "用户正在整理咖啡活动；保留活动引用，继续处理补充资料。" }, null) + frame({}, "stop") + "data: [DONE]\n\n");
    return;
  }
  let userIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  let prompt =
    typeof messages[userIndex]?.content === "string"
      ? messages[userIndex].content
      : (messages[userIndex]?.content || [])
          .map((part) => part.text || "")
          .join("");
  if (prompt === "依据当前任务上下文和恢复记录继续执行，并交付实际结果。") {
    const text = (m) => typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("");
    const goal = messages.map((m) => { try { const value = text(m); return JSON.parse(value.slice(value.indexOf("{"))).goal; } catch { return undefined; } }).filter(Boolean).at(-1);
    if (goal) { prompt = goal; const original = messages.findLastIndex((m) => m.role === "user" && text(m) === goal); if (original >= 0) userIndex = original; }
  }
  if (body.tools?.some((tool) => tool.function?.name === "submit_activities")) {
    // Deterministic protocol fixture, not a model quality evaluation.
    const input = JSON.parse(prompt), groups = new Map();
    for (const item of input.observations) {
      const key = body.model === "living-browser-test" ? `${item.occurredAt}:${item.content.includes("野餐") ? "picnic" : item.ref}` : item.ref;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    const activities = [...groups.values()].filter((items) => items.some((item) => input.requiredRefs.includes(item.ref))).map((items) => ({
      title: items[0].content.includes("野餐") ? "青禾公园野餐" : items[0].title,
      summary: items.map((item) => item.sourceQuotes?.[0] || item.content).join("\n").slice(0, 1800),
      occurredAt: items[0].occurredAt, place: items[0].content.includes("野餐") ? "青禾公园" : "",
      members: items.map((item) => item.ref), issues: ["请核对活动与来源是否对应"], reason: "浏览器测试按给定日期和活动词归组。",
    }));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "activity-fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "submit_activities", arguments: JSON.stringify({ activities }) } }] }, null)
      + frame({}, "tool_calls") + "data: [DONE]\n\n"); return;
  }
  if (body.tools?.some((tool) => tool.function?.name === "submit_dataset_answers")) {
    const input = JSON.parse(prompt);
    if (Object.keys(input).sort().join() !== "memory,questions" || !input.memory.content.some((span) => span.text.includes("林舟把备用钥匙交给陈默"))) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Expected only the isolated source and questions" } })); return;
    }
    const answerFor = (question) => question.includes("是什么") ? "备用钥匙" : "陈默";
    const answers = input.questions.map((question, index) => ({ index, status: "answerable", answerQuote: answerFor(question),
      evidenceIndices: [0], factIndex: input.questions.findIndex((other) => answerFor(other) === answerFor(question)),
      reason: "固定协议样例按正文核对接收人或物品；不是实际模型语义评测。",
    }));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "source-answer-browser-fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 180, completion_tokens: 100, total_tokens: 280 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: "source-answer-browser", type: "function", function: { name: "submit_dataset_answers", arguments: JSON.stringify({ answers }) } }] }, null)
      + frame({}, "tool_calls") + "data: [DONE]\n\n"); return;
  }
  if (body.tools?.some((tool) => tool.function?.name === "submit_dataset_review")) {
    const input = JSON.parse(prompt);
    if (!input.memory.content.includes("林舟把备用钥匙交给陈默")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Expected the isolated audit fixture" } })); return;
    }
    const decisions = input.samples.flatMap((sample, index) => !sample.reviewable ? [] : [{
      index, action: "approve", question: null, answerQuote: null, trainingIndex: null,
      reason: "测试正文明确接收人为陈默，成对问答均询问接收与保管人；物品题询问备用钥匙。",
    }]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "audit-browser-fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 240, completion_tokens: 140, total_tokens: 380 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: "audit-browser", type: "function", function: { name: "submit_dataset_review", arguments: JSON.stringify({ decisions }) } }] }, null)
      + frame({}, "tool_calls") + "data: [DONE]\n\n"); return;
  }
  if (body.tools?.some((tool) => tool.function?.name === "submit_dataset_questions")) {
    const { memory } = JSON.parse(prompt);
    if (!memory.content.includes("林舟把备用钥匙交给陈默")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Expected the isolated dataset fixture" } }));
      return;
    }
    const questions = {
      training: [{ question: "林舟把备用钥匙交给了谁？", answerQuote: "陈默" },
        { question: "林舟交给陈默的是什么？", answerQuote: "备用钥匙" }],
      evaluation: [{ question: "谁收到了林舟交出的备用钥匙？", trainingIndex: 0 }],
    };
    if (body.model === "agent-first-browser-test") {
      questions.training[0] = { question: "谁把备用钥匙交给陈默？", answerQuote: "她" };
      questions.evaluation[0] = { question: "陈默从谁手中收到备用钥匙？", trainingIndex: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "dataset-browser-fixture", object: "chat.completion.chunk", created: 1,
      model: "browser-test", choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 200, completion_tokens: 120, total_tokens: 320 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: "dataset-browser", type: "function", function: { name: "submit_dataset_questions", arguments: JSON.stringify(questions) } }] }, null)
      + frame({}, "tool_calls") + "data: [DONE]\n\n");
    return;
  }
  if (body.tools?.some((tool) => tool.function?.name === "extract_photo_memories")) {
    const parts = messages[userIndex]?.content;
    if (!Array.isArray(parts) || parts.filter((part) => part.type === "image_url").length !== 1) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Expected exactly one selected image" } }));
      return;
    }
    // Deliberate fixture output, not visual recognition. Browser assertions exercise the product flow.
    const background = body.model === "background-browser-test";
    const entries = [{ title: background ? "后台图片的独立测试观察" : "照片中的测试色块", content: background ? "后台工具生成的独立测试观察。" : "测试图片中有一个蓝色方块。", kind: "observation", uncertainty: "",
      region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, visibleText: "TEST FIXTURE" }];
    if (body.model === "background-browser-test" && !backgroundReleased)
      await new Promise((resolve) => backgroundWaiters.add(resolve));
    else await new Promise((resolve) => setTimeout(resolve, 500));
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "photo-browser-fixture", object: "chat.completion.chunk", created: 1, model: "browser-test", choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: "photo-browser", type: "function", function: { name: "extract_photo_memories", arguments: JSON.stringify({ entries }) } }] }, null) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    return;
  }
  if (body.tools?.some((tool) => tool.function?.name === "capture_memories")) {
    const input = JSON.parse(prompt);
    const text = input.text;
    const entries = text.startsWith("我每周六都会去城南图书馆读书") ? [{
      title: "周六读书习惯", content: "我每周六都会去城南图书馆读书。", quote: text,
      category: "fact", kind: "statement", personal: true, direct: true, identityClaim: false,
      people: [], place: "城南图书馆", uncertainty: "", timeExpression: "", attribute: null,
      duplicateOf: input.existing.find((entry) => entry.content === "我每周六都会去城南图书馆读书。")?.id || null, conflictIds: [],
    }] : [];
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "capture-browser-fixture", object: "chat.completion.chunk", created: 1, model: "browser-test", choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 220, completion_tokens: 100, total_tokens: 320 } }) + "\n\n";
    response.end(frame({ tool_calls: [{ index: 0, id: "capture-browser", type: "function", function: { name: "capture_memories", arguments: JSON.stringify({ entries }) } }] }, null) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    return;
  }
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
    if (body.model === "living-browser-test") entries = [{ ...base, title: "青禾公园野餐", content: text, category: "event", occurredAt: "2026-09-20", place: "青禾公园" }];
    else if (body.model === "agent-first-browser-test") entries = [{ ...base, title: "交接钥匙", content: text, category: "event" }];
    else if (text.includes("住在苏州"))
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
        choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }],
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
  if (body.model === "living-browser-test") {
    const decode = (message) => { try { const text = typeof message.content === "string" ? message.content : (message.content || []).map((p) => p.text || "").join(""); return JSON.parse(text.slice(text.indexOf("{"))); } catch { return {}; } };
    const data = messages.map(decode), context = data.findLast((value) => value.goal) || {};
    const submitted = data.some((value) => value.job?.kind === "memory-organization") || context.jobs?.some((job) => job.kind === "memory-organization");
    const delta = !submitted ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "organize_memories",
      arguments: JSON.stringify({ assetIds: (context.assets || []).map((asset) => asset.id), title: "整理生活活动" }) } }] } : { content: context.jobs?.some((job) => job.status === "completed")
        ? "已按来源整理生活活动。请核对活动卡片中的内容与疑点。" : "已提交整理，正在等待后台处理结果。" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) => "data: " + JSON.stringify({ id: "living-chat-fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }], usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420 } }) + "\n\n";
    response.end(frame(delta, null) + frame({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n"); return;
  }
  if (body.model === "media-review-browser-test" || body.model === "video-browser-test") {
    // Deliberate integration policy; the generated pixel fixture is not a perception evaluation.
    const asText = (message) => typeof message.content === "string" ? message.content : (message.content || []).map((part) => part.text || "").join("");
    const decode = (message) => { try { const text = asText(message); return JSON.parse(text.slice(text.indexOf("{"))); } catch { return undefined; } };
    const data = messages.map(decode).filter(Boolean);
    const context = data.findLast((value) => value.goal) || {};
    const reads = data.filter((value) => value.verification === "asset-hash" && value.source?.view);
    const video = body.model === "video-browser-test";
    const selected = context.assets?.find((asset) => asset.kind === (video ? "video" : "image"));
    const artifacts = data.some((value) => value.artifactId);
    const delta = video && reads.length >= 2 && !artifacts ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "write_artifact", arguments: JSON.stringify({
      title: "视频时间整理", content: "已读取视频 0 秒的整幅画面与 2.25 秒的中央局部，画面时间和原件来源随结果保留。", sourceAssetIds: [selected?.id],
    }) } }] }
      : reads.length >= 2 ? { content: video ? "已保存带视频时间的整理结果。" : "已读取整图和中央局部，读取结果保留在本次会话中。" }
      : { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "read_evidence", arguments: JSON.stringify({
        id: "asset:" + selected?.id, ...(video ? { timestamp: reads.length ? 2.2 : 0 } : {}), ...(reads.length ? { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } : {}),
      }) } }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (value, finish_reason) => "data: " + JSON.stringify({ id: "media-review-browser", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(value), finish_reason }], usage: { prompt_tokens: 250, completion_tokens: 100, total_tokens: 350 } }) + "\n\n";
    response.end(frame(delta, null) + frame({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    return;
  }
  if (body.model === "agent-first-browser-test") {
    // A deterministic conversation policy exercises real Pi tools. It is never a quality evaluator.
    const asText = (message) => typeof message.content === "string" ? message.content : (message.content || []).map((part) => part.text || "").join("");
    const decode = (message) => { try { const text = asText(message); return JSON.parse(text.slice(text.indexOf("{"))); } catch { return undefined; } };
    const data = messages.map(decode).filter(Boolean);
    const context = data.findLast((value) => value.goal) || {};
    const goal = context.goal || prompt;
    const names = new Map(messages.flatMap((message) => (message.tool_calls || []).map((call) => [call.id, call.function.name])));
    const results = messages.filter((message) => message.role === "tool").map((message) => ({ name: names.get(message.tool_call_id), result: decode(message) }));
    const latest = (name) => results.findLast((value) => value.name === name)?.result;
    const invoke = (name, args) => ({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const notification = data.findLast((value) => value.jobs?.some((job) => job.result));
    let delta;
    if (goal.includes("确认这批文字记录")) {
      const dataset = notification?.jobs?.find((job) => job.kind === "memory-dataset")?.result?.dataset;
      const delivered = latest("deliver_dataset");
      if (delivered) delta = { content: `已核验交付训练文件。\n\n${delivered.files.map((file) => `[${file.name}](${file.href})`).join(" · ")}\n\n样本由 Agent 核对；未运行模型训练。` };
      else if (dataset?.sampleCounts?.review === 0) delta = invoke("deliver_dataset", { datasetId: dataset.id });
      else if (dataset) {
        const inspected = latest("inspect_dataset");
        if (!inspected) delta = invoke("inspect_dataset", { datasetId: dataset.id, after: null, revision: null, limit: null });
        else if (!latest("review_dataset")) delta = invoke("review_dataset", { datasetId: dataset.id, reason: "对照冻结正文核对人物与动作，修订只有代词的答案", samples: inspected.samples.map((sample) => ({
          ref: sample.ref, action: sample.answer === "她" ? "revise" : "approve", question: null, answer: sample.answer === "她" ? "林舟" : null,
        })) });
        else delta = { content: "等待后台重新导出。" };
      } else if (latest("build_dataset")) delta = { content: "等待数据集构建。" };
      else if (context.commands?.some((command) => command.action === "confirm")) delta = invoke("build_dataset", { generation: "model", scope: {
        memoryIds: context.commands.filter((command) => command.action === "confirm").flatMap((command) => command.after.map((ref) => ref.id)),
      } });
      else if (latest("inspect_memories")) delta = invoke("change_memories", { action: "confirm", entries: latest("inspect_memories").memories.map(({ ref }) => ({ ref })), basis: "user", instructionQuote: goal, reason: "用户明确确认文字记录" });
      else delta = invoke("inspect_memories", { view: "draft", query: "备用钥匙" });
    } else if (latest("write_artifact")) delta = { content: "两份资料已整理并保存带来源的结果，观察保持待核对。" };
    else if (notification) delta = invoke("write_artifact", { title: "媒体整理结果", content: "文字与照片已逐份处理。文字记录保留原文，图片为测试观察，均等待核对。", sourceAssetIds: (context.assets || []).map((item) => item.id) });
    else if (latest("process_assets")) delta = { content: "等待资料处理完成。" };
    else delta = invoke("process_assets", {});
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (value, finish_reason) => "data: " + JSON.stringify({ id: "agent-first-browser", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: declaredDelta(value), finish_reason }], usage: { prompt_tokens: 250, completion_tokens: 100, total_tokens: 350 } }) + "\n\n";
    response.end(frame(delta, null) + frame({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    return;
  }
  if (JSON.stringify(messages).includes("后台工具流程测试")) {
    const submitted = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "process_assets"));
    const notified = JSON.stringify(messages).includes("后台作业返回的数据");
    const delta = submitted ? { content: notified ? "后台处理完成，观察等待核对。" : "处理任务已受理。" }
      : { tool_calls: [{ index: 0, id: "background-process", type: "function", function: { name: "process_assets", arguments: "{}" } }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (value, finish_reason) => "data: " + JSON.stringify({ id: "background-browser", object: "chat.completion.chunk", created: 1,
      model: "background-browser-test", choices: [{ index: 0, delta: declaredDelta(value), finish_reason }], usage: { prompt_tokens: 180, completion_tokens: 80, total_tokens: 260 } }) + "\n\n";
    response.end(frame(delta, null) + frame({}, submitted ? "stop" : "tool_calls") + "data: [DONE]\n\n");
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
    .filter((message) => message.role === "tool" && !discoveryIds.has(message.tool_call_id))
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
  const calls = prompt.includes("工具连续显示测试")
    ? [["bash", { command: "printf START; sleep 4; printf END", timeout: 20 }]]
    : prompt.includes("通用任务测试")
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
            ? [["search_memories", { query: prompt.includes("照片") ? "照片 测试色块" : "公园" }]]
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
            choices: [{ index: 0, delta: declaredDelta(delta), finish_reason }],
            ...(usage ? { usage } : {}),
          }) +
          "\n\n",
      );
  };
  await new Promise((resolve) =>
    setTimeout(resolve, prompt.includes("等待测试") || prompt.includes("工具连续显示测试") ? 1600 : call ? 180 : 50),
  );
  if (prompt.includes("流式体验测试")) {
    write({ reasoning_content: "正在检查测试片段。" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let index = 1; index <= 100 && !response.destroyed; index++) {
      write({ content: `片段 ${String(index).padStart(3, "0")}，` });
      await new Promise((resolve) => setTimeout(resolve, prompt.includes("队列撤回") ? 100 : 35));
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
          id: randomUUID(),
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
