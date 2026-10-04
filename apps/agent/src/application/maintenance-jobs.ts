import type { MemoryEntry, TaskJob } from "@memory/contracts";
import type { Store } from "../store.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import type { MemoryCaptures } from "../memory/captures.js";
import type { MemoryFeatureService } from "../memory/feature-service.js";

/** Adapt existing maintenance services to the shared job API; no second queue or worker. */
export function captureJobs(store: Store, captures: MemoryCaptures): TaskJobDriver {
  const get = (id: string): Omit<TaskJob, "kind" | "toolCallId"> => {
    const job = captures.job(id);
    return { id, title: "记录用户陈述", ownership: "library", status: job.status === "waiting" ? "queued" : job.status,
      blockedReason: job.error || job.reason, revision: job.revision || 0, updatedAt: job.updatedAt,
      progress: { total: 1, completed: Number(["completed", "skipped"].includes(job.status)), failed: Number(job.status === "failed") } };
  };
  return { get, list: () => captures.jobs(undefined, 100).map((job) => get(job.id)), cancel: (id) => captures.cancel(id), retry: (id) => captures.retry(id),
    result: (id, offset, limit) => {
      const job = captures.job(id);
      const entries = job.memoryIds.slice(offset, offset + limit).flatMap((memoryId) => {
        const memory = store.memories.get<MemoryEntry>("memory", memoryId);
        return memory && !memory.forgottenAt && memory.status !== "rejected" && !store.memories.ledger.suppressed(memory)
          ? [{ id: memory.id, version: memory.version, title: memory.title, status: memory.status }] : [];
      });
      return { entries, runId: job.runId, error: job.error || job.reason, nextOffset: offset + limit < job.memoryIds.length ? offset + limit : null };
    }, subscribe: () => () => {} };
}
export function memoryIndexJobs(store: Store, features: MemoryFeatureService): TaskJobDriver {
  const get = (id: string): Omit<TaskJob, "kind" | "toolCallId"> => {
    const job = features.job(id);
    return { id, title: "索引记忆 · " + (store.memories.get<MemoryEntry>("memory", id)?.title || "记录已移除"), ownership: "library",
      status: job.status as TaskJob["status"], revision: job.revision, updatedAt: job.updatedAt,
      blockedReason: job.error || (features.status().state === "not_configured" && job.status === "queued" ? "本地特征模型未配置" : undefined),
      actions: ["queued", "running"].includes(job.status) ? ["cancel"] : ["retry"],
      progress: { total: 1, completed: Number(["completed", "skipped"].includes(job.status)), failed: Number(job.status === "failed") } };
  };
  return { get, list: () => features.jobs().map((job) => get(job.memoryId)), result: (id) => {
    const memory = store.memories.get<MemoryEntry>("memory", id);
    return { error: features.job(id).error, entries: memory ? [{ id, title: memory.title, version: memory.version, status: memory.status }] : [] };
  }, cancel: (id) => features.cancelJob(id), retry: (id) => features.retryJob(id), subscribe: () => () => {} };
}
