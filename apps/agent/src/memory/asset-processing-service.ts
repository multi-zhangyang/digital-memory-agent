import type { MemoryEntry, MemoryImportJob, ProcessingAssetResult } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import type { MemoryData } from "./data.js";
import { MemoryImports } from "./imports.js";
import { memoryContext } from "./retrieval.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import { UserFacingError } from "../errors.js";
import { processingModel } from "./processing-policy.js";

export interface ProcessingScope {
  requestId: string;
  modelId?: string;
  allowedAssetIds?: readonly string[];
  ownership?: "task" | "library";
}
type ProcessingEntry = Pick<MemoryEntry, "id" | "version" | "title" | "status">
  & Partial<ReturnType<typeof memoryContext>> & { resultOffset: number; truncated?: boolean };

/** Owns model choice, batch processing and paged results, independently of Pi sessions. */
export class AssetProcessingService {
  constructor(private readonly store: MemoryData, private readonly config: AppConfig, private readonly imports: MemoryImports) {}

  async submit(input: { assetIds: string[]; title?: string }, scope: ProcessingScope) {
    const ids = [...new Set(input.assetIds)];
    if (!ids.length || ids.length > 200) throw new UserFacingError(400, "PROCESSING_LIMIT", "每次请选择 1 至 200 份资料");
    const assets = ids.map((id) => {
      if (scope.allowedAssetIds && !scope.allowedAssetIds.includes(id))
        throw new UserFacingError(403, "SOURCE_SCOPE", "只能处理本次所选资料");
      const asset = this.store.asset(id);
      if (!asset || (asset.memorySpace || "personal") !== "personal")
        throw new UserFacingError(404, "SOURCE_MISSING", "所选资料不存在或不可用");
      if (!["text", "image", "video"].includes(asset.kind))
        throw new UserFacingError(400, "UNSUPPORTED_ASSET", "当前处理工具支持 UTF-8 文字、静态照片和视频画面");
      return asset;
    });
    const settings = this.store.memories.ledger.settings();
    const models: Partial<Record<"text" | "image" | "video", string>> = {};
    for (const kind of new Set(assets.map((asset) => asset.kind as "text" | "image" | "video"))) {
      try { models[kind] = processingModel(this.config, settings, kind === "image" ? "photo" : kind, scope.modelId).model.id; }
      catch { /* Missing modalities are individual failures when another processor can run. */ }
    }
    const modelId = models.text || models.image || models.video;
    if (!modelId) throw new UserFacingError(400, "PROCESSOR_UNAVAILABLE", "请先配置本批资料所需的处理模型");
    const shared = this.imports.jobs("personal").find((job) => job.ownership === "library" && !["failed", "cancelled"].includes(job.status)
      && new Set((job.assets || job.chunks).map((chunk) => chunk.assetId)).size === ids.length
      && job.chunks.every((chunk) => (chunk.modelId ?? job.modelId) === models[chunk.media || "text"])
      && job.chunks.every((chunk) => !chunk.video || chunk.video.sampleInterval === Math.max(settings.videoSampleInterval || 10, chunk.video.duration / 119))
      && job.chunks.every((chunk) => assets.some((asset) => asset.id === chunk.assetId && asset.sha256 === chunk.sha256)));
    if (shared) return shared;
    return this.imports.create({ requestId: scope.requestId, assetIds: ids, title: input.title,
      modelId, models, mode: "auto", space: "personal", ownership: scope.ownership || "task" });
  }

  private assetResults(job: MemoryImportJob): ProcessingAssetResult[] {
    const assets: NonNullable<MemoryImportJob["assets"]> = job.assets || [...new Map(job.chunks.map((chunk) => [chunk.assetId, { assetId: chunk.assetId, name: chunk.name, sha256: chunk.sha256 }])).values()];
    return assets.map((asset) => {
      const chunks = job.chunks.filter((chunk) => chunk.assetId === (asset.duplicateOf || asset.assetId));
      const failed = chunks.filter((chunk) => chunk.status === "failed");
      const pending = chunks.some((chunk) => !["completed", "skipped", "failed"].includes(chunk.status));
      const blocked = chunks.some((chunk) => (chunk.status === "skipped" && !!chunk.reason) || this.store.memories.ledger.sourceBlocked(chunk.sha256, chunk.start, chunk.end));
      const status = blocked ? "blocked" as const : failed.length ? "failed" as const : pending ? "pending" as const
        : asset.duplicateOf || chunks.every((chunk) => chunk.status === "skipped") ? "reused" as const : "completed" as const;
      return { ...asset, status, models: [...new Set(chunks.map((chunk) => chunk.modelId ?? job.modelId).filter(Boolean))],
        observations: new Set(chunks.flatMap((chunk) => chunk.memoryIds)).size,
        chunks: { total: chunks.length, completed: chunks.filter((chunk) => chunk.status === "completed" || chunk.status === "skipped").length, failed: failed.length },
        ...(failed.length ? { error: failed[0].error } : {}), ...(blocked ? { reason: "来源已停止取用" } : {}) };
    });
  }
  private coverage(assets: ReturnType<AssetProcessingService["assetResults"]>) {
    return { total: assets.length, completed: assets.filter((asset) => asset.status === "completed").length,
      reused: assets.filter((asset) => asset.status === "reused").length, failed: assets.filter((asset) => asset.status === "failed").length,
      pending: assets.filter((asset) => asset.status === "pending").length, blocked: assets.filter((asset) => asset.status === "blocked").length };
  }
  private result(id: string, offset: number, limit: number, maxBytes: number, section: "assets" | "entries" = "entries") {
    const job = this.imports.job(id);
    const assets = this.assetResults(job);
    const ids = [...new Set(job.chunks.flatMap((chunk) => chunk.memoryIds))];
    let cursor = Math.min(section === "entries" ? offset : 0, ids.length);
    const failures = job.chunks.filter((chunk) => chunk.status === "failed");
    const result = { entries: [] as ProcessingEntry[], offset: cursor, total: ids.length, unavailable: 0,
      nextOffset: cursor < ids.length ? cursor : null, failedChunks: failures.length,
      failures: failures.slice(0, 3).map((chunk) => ({ assetId: chunk.assetId, error: chunk.error })),
      coverage: this.coverage(assets), assets: [] as typeof assets, nextAssetOffset: null as number | null,
      policy: "提取结果保留核对状态。draft 仅为候选，completed 仅表示处理结束。" };
    const size = () => Buffer.byteLength(JSON.stringify(result));
    while (result.failures.length && size() > maxBytes) result.failures.pop();
    while (section === "entries" && cursor < ids.length && result.entries.length < limit) {
      const memory = this.store.memories.get<MemoryEntry>("memory", ids[cursor]);
      if (!memory || memory.forgottenAt || memory.status === "rejected" || this.store.memories.ledger.suppressed(memory)) {
        cursor++; result.unavailable++; continue;
      }
      result.entries.push({ ...memoryContext(memory), title: memory.title, status: memory.status, resultOffset: cursor });
      if (size() > maxBytes) {
        result.entries.pop();
        if (!result.entries.length) {
          // Read this resultOffset with the ordinary result tool's larger budget when needed.
          result.entries.push({ id: memory.id, version: memory.version, status: memory.status,
            title: memory.title.slice(0, 80), resultOffset: cursor++, truncated: true });
        }
        break;
      }
      cursor++;
    }
    result.nextOffset = cursor < ids.length ? cursor : null;
    let assetOffset = Math.min(section === "assets" ? offset : 0, assets.length);
    while (assetOffset < assets.length && result.assets.length < limit) {
      result.assets.push(assets[assetOffset]);
      if (size() > maxBytes - 48) { result.assets.pop(); break; }
      assetOffset++;
    }
    result.nextAssetOffset = assetOffset < assets.length ? assetOffset : null;
    return result;
  }

  driver(): TaskJobDriver {
    const get = (id: string) => {
      const job = this.imports.job(id);
      return { id, title: job.title, status: job.status, revision: job.revision || 0, updatedAt: job.updatedAt, ownership: job.ownership || "library" as const,
        coverage: this.coverage(this.assetResults(job)),
        progress: { completed: job.chunks.filter((chunk) => chunk.status === "completed" || chunk.status === "skipped").length,
          total: job.chunks.length, failed: job.chunks.filter((chunk) => chunk.status === "failed").length } };
    };
    return {
      get,
      list: () => this.imports.jobs("personal").map((job) => get(job.id)),
      result: (id, offset, limit, maxBytes, section) => this.result(id, offset, limit, maxBytes, section),
      cancel: (id) => this.imports.cancel(id),
      retry: (id, assetIds) => this.imports.retry(id, assetIds),
      subscribe: (listener) => this.imports.subscribe(listener),
      authorize: (id, run) => {
        const job = this.imports.job(id);
        if (job.space !== "personal" || (run.scope === "selected" && (job.assets || job.chunks).some((chunk) => !run.assetIds.includes(chunk.assetId))))
          throw new UserFacingError(403, "SOURCE_SCOPE", "此作业不在本次允许读取的资料范围内");
      },
      delivered: (run, result) => {
        const entries = (result as ReturnType<AssetProcessingService["result"]>).entries;
        for (const entry of entries) {
          const memory = this.store.memories.get<MemoryEntry>("memory", entry.id);
          if (!memory || memory.version !== entry.version || this.store.memories.ledger.suppressed(memory)) continue;
          // These sources were read by the task's processor and returned with derived observations.
          for (const source of memory.sources) this.store.recordSource?.(run.id, source);
        }
      },
    };
  }
}
