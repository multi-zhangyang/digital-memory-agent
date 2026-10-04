import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import type { AssetProcessingService } from "./memory/asset-processing-service.js";
import type { TaskJobs } from "./harness/jobs.js";
import { UserFacingError } from "./harness/runtime.js";

const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export function createProcessingTools(store: Store, processing: AssetProcessingService, jobs: TaskJobs, conversationId: string) {
  const current = () => {
    const run = store.work.activeRun(conversationId);
    if (!run) throw new UserFacingError(409, "RUN_REQUIRED", "请从任务工作台调用此工具");
    return run;
  };
  return [
    defineTool({
      name: "process_assets", label: "处理资料",
      description: "Submit selected text documents, static photos or videos for background processing into reviewable observations. Videos use configured sampled frames, retain exact frame times and coverage, and do not transcribe audio. The service chooses configured processors and handles batching, validation, deduplication, persistence and progress. Returns a durable job receipt. Submission is not completion or fact confirmation. The harness delivers results automatically; do not poll. End this turn after submitting work and continue when results arrive.",
      parameters: Type.Object({
        assetIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 200, uniqueItems: true })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      }, { additionalProperties: false }),
      async execute(toolCallId, input, signal) {
        signal?.throwIfAborted();
        const run = current();
        if ((run.jobs?.length || 0) >= 8) throw new UserFacingError(409, "JOB_LIMIT", "本次任务已达到后台作业数量上限");
        const assetIds = input.assetIds || run.assetIds;
        const requestId = createHash("sha256").update(JSON.stringify([run.id, "process_assets", [...new Set(assetIds)].sort()])).digest("hex");
        const job = await processing.submit({ ...input, assetIds }, { requestId, modelId: run.modelId,
          allowedAssetIds: run.scope === "selected" ? run.assetIds : undefined });
        const attached = jobs.attach(run.id, "memory-import", job.id, toolCallId, job.ownership || "task");
        if (signal?.aborted) { jobs.cancel(run.id); signal.throwIfAborted(); }
        return output({ job: attached, accepted: true, next: "后台完成后系统会自动返回结果，请等待完成事件；不要把受理状态当作任务完成。" });
      },
    }),
    defineTool({
      name: "read_job_result", label: "读取作业结果",
      description: "Read bounded results of a background job from this conversation, including current candidate status and a nextOffset for additional results. Used for a user's status request or further result inspection, never to poll while waiting for automatic completion.",
      parameters: Type.Object({ jobId: Type.String({ format: "uuid" }), offset: Type.Optional(Type.Integer({ minimum: 0 })),
        section: Type.Optional(Type.Union([Type.Literal("entries"), Type.Literal("assets")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
      async execute(_id, input) { return output(jobs.read(current().id, input.jobId, input.offset, input.limit, input.section)); },
    }),
    defineTool({
      name: "manage_job", label: "管理后台作业",
      description: "Retry unfinished parts of a failed/cancelled job or explicitly cancel a background job in this conversation, including authorized shared library jobs. For media processing, optional assetIds limits retry to individual files. Each task can retry a job once; fix causes before another user-requested retry. Completion is delivered automatically and completed work is retained. Merely stopping a task does not cancel library jobs.",
      parameters: Type.Object({ jobId: Type.String({ format: "uuid" }), action: Type.Union([Type.Literal("retry"), Type.Literal("cancel")]),
        assetIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 200, uniqueItems: true })) }, { additionalProperties: false }),
      async execute(id, input) { return output(jobs.manage(current().id, input.jobId, input.action, id, input.assetIds)); },
    }),
  ];
}
