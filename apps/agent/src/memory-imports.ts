import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  Asset,
  MemoryEntry,
  MemoryImportJob,
  MemoryImportChunk,
  MemorySpace,
  ThinkingLevel,
} from "@memory/contracts";
import type { AppConfig } from "./config.js";
import { projectRoot } from "./config.js";
import type { Store } from "./store.js";
import { UserFacingError, type AgentRuntime } from "./runtime.js";
import {
  EXTRACTOR_VERSION,
  type ExtractedMemory,
} from "./memory-extraction.js";

const now = () => new Date().toISOString();
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const done = (chunk: MemoryImportChunk) =>
  chunk.status === "completed" || chunk.status === "skipped";
const validDate = (value: string) =>
  !value ||
  (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value).toISOString().slice(0, 10) === value);
export interface MemoryImportInput {
  requestId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  space?: MemorySpace;
  title?: string;
  assetIds?: string[];
  records?: { name: string; text: string }[];
  demo?: boolean;
}

export class MemoryImports {
  private worker?: Promise<void>;
  private controller?: AbortController;
  private activeId?: string;
  private closing = false;
  private preparing = 0;
  private creation: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly runtime: () => AgentRuntime,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS memory_import_jobs (id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_extractions (key TEXT PRIMARY KEY, memoryIds TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_import_status ON memory_import_jobs(json_extract(data,'$.status'));`);
    for (const job of this.jobs()) {
      if (job.status !== "running") continue;
      job.recoveries++;
      job.status = job.recoveries > 3 ? "failed" : "queued";
      for (const chunk of job.chunks)
        if (chunk.status === "running") {
          chunk.status = job.recoveries > 3 ? "failed" : "pending";
          chunk.error =
            job.recoveries > 3 ? "多次重启中断，请手动重试" : undefined;
        }
      this.save(job);
    }
  }
  jobs(space?: MemorySpace): MemoryImportJob[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM memory_import_jobs WHERE (? IS NULL OR json_extract(data,'$.space')=?) ORDER BY rowid DESC",
        )
        .all(space ?? null, space ?? null) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  job(id: string): MemoryImportJob {
    const row = this.store.db
      .prepare("SELECT data FROM memory_import_jobs WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "NOT_FOUND", "导入任务不存在");
    return JSON.parse(row.data);
  }
  private save(job: MemoryImportJob) {
    job.updatedAt = now();
    this.store.db
      .prepare("UPDATE memory_import_jobs SET data=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
    return job;
  }
  busy() {
    return (
      this.preparing > 0 ||
      !!this.activeId ||
      this.jobs().some(
        (job) => job.status === "queued" || job.status === "running",
      )
    );
  }
  private async read(asset: Asset) {
    if (asset.kind !== "text" || asset.size > 256 * 1024)
      throw new UserFacingError(
        400,
        "INVALID_TEXT",
        "当前支持每份不超过 256 KB 的 UTF-8 文字资料",
      );
    let buffer: Buffer;
    try {
      buffer = await readFile(join(this.store.assetsDir, asset.id));
    } catch {
      throw new UserFacingError(
        409,
        "SOURCE_MISSING",
        "原始资料已丢失，请重新导入",
      );
    }
    if (hash(buffer) !== asset.sha256 || buffer.length !== asset.size)
      throw new UserFacingError(
        409,
        "SOURCE_CHANGED",
        "原始资料校验不一致，请重新导入",
      );
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer);
      if (text.includes("\0") || !text.trim())
        throw new Error("Empty or binary source");
      return { text, buffer };
    } catch {
      throw new UserFacingError(
        400,
        "INVALID_TEXT",
        "请使用非空的 UTF-8 文本文件",
      );
    }
  }
  create(input: MemoryImportInput): Promise<MemoryImportJob> {
    this.preparing++;
    const promise = this.creation
      .then(() => this.prepare(input))
      .finally(() => {
        this.preparing--;
      });
    this.creation = promise.catch(() => undefined);
    return promise;
  }
  private async prepare(input: MemoryImportInput): Promise<MemoryImportJob> {
    const existing = this.store.db
      .prepare("SELECT data FROM memory_import_jobs WHERE requestId=?")
      .get(input.requestId) as { data: string } | undefined;
    if (existing) return JSON.parse(existing.data);
    if (this.closing)
      throw new UserFacingError(503, "CLOSING", "服务正在关闭，请稍后重试");
    const provider = this.config.providers.find(
      (item) => item.model.id === input.modelId,
    );
    if (!provider || !this.runtime().extractMemories)
      throw new UserFacingError(
        400,
        "MODEL_UNAVAILABLE",
        "请先在设置中配置可用模型",
      );
    const space = input.demo ? "demo" : input.space || "personal";
    let records = input.records || [];
    if (input.demo) {
      if (records.length || input.assetIds?.length)
        throw new UserFacingError(
          400,
          "INVALID_REQUEST",
          "示例导入不能混入其他资料",
        );
      records = await Promise.all(
        ["01-profile.md", "02-walk.md", "03-move.md", "04-uncertain.md"].map(
          async (name) => ({
            name,
            text: await readFile(
              join(projectRoot, "examples/experiences", name),
              "utf8",
            ),
          }),
        ),
      );
    }
    const assets = [...new Set(input.assetIds || [])].map((id) => {
      const asset = this.store.asset(id);
      if (!asset || (asset.memorySpace || "personal") !== space)
        throw new UserFacingError(
          400,
          "INVALID_SOURCE",
          "所选资料不存在或不属于这个记忆空间",
        );
      return asset;
    });
    const created: Asset[] = [];
    try {
      for (const record of records) {
        if (
          !record.name.trim() ||
          !record.text.trim() ||
          Buffer.byteLength(record.text) > 256 * 1024
        )
          throw new UserFacingError(
            400,
            "INVALID_TEXT",
            "请填写标题与非空文字，每份不超过 256 KB",
          );
        const sha256 = hash(record.text);
        const previous = [...this.store.assets(space), ...created].find(
          (asset) => asset.sha256 === sha256 && asset.kind === "text",
        );
        if (previous) {
          assets.push(previous);
          continue;
        }
        const asset: Asset = {
          id: randomUUID(),
          name: record.name.trim().slice(0, 200),
          kind: "text",
          mimeType: "text/plain",
          size: Buffer.byteLength(record.text),
          sha256,
          createdAt: now(),
          memorySpace: space,
        };
        await writeFile(join(this.store.assetsDir, asset.id), record.text, {
          mode: 0o600,
          flag: "wx",
        });
        created.push(asset);
        assets.push(asset);
      }
      const unique = [
        ...new Map(assets.map((asset) => [asset.sha256, asset])).values(),
      ];
      if (!unique.length || unique.length > 20)
        throw new UserFacingError(
          400,
          "IMPORT_LIMIT",
          "每批请选择 1 至 20 份文字资料",
        );
      const chunks: MemoryImportChunk[] = [];
      for (const asset of unique) {
        const { text } = await this.read(asset);
        let offset = 0;
        while (offset < text.length) {
          let end = Math.min(offset + 2200, text.length);
          if (end < text.length) {
            const paragraph = text.lastIndexOf("\n", end);
            if (paragraph > offset + 1100) end = paragraph + 1;
            else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          }
          if (text.slice(offset, end).trim())
            chunks.push({
              id: randomUUID(),
              assetId: asset.id,
              name: asset.name,
              sha256: asset.sha256,
              start: Buffer.byteLength(text.slice(0, offset)),
              end: Buffer.byteLength(text.slice(0, end)),
              status: "pending",
              attempts: 0,
              memoryIds: [],
            });
          offset = end;
        }
      }
      if (chunks.length > 32)
        throw new UserFacingError(
          400,
          "IMPORT_LIMIT",
          "本批超过 32 个处理片段，请分批导入",
        );
      const job: MemoryImportJob = {
        id: randomUUID(),
        title:
          input.title?.trim() ||
          (input.demo
            ? "林舟的经历 · 虚构示例"
            : unique[0].name +
              (unique.length > 1 ? ` 等 ${unique.length} 份` : "")),
        space,
        modelId: input.modelId,
        thinkingLevel: provider.model.reasoning
          ? input.thinkingLevel || provider.model.thinkingLevel
          : "off",
        status: "queued",
        chunks,
        recoveries: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.work.transaction(() => {
        for (const asset of created) this.store.addAsset(asset);
        this.store.db
          .prepare("INSERT INTO memory_import_jobs VALUES (?,?,?)")
          .run(job.id, input.requestId, JSON.stringify(job));
      });
      this.wake();
      return job;
    } catch (error) {
      await Promise.all(
        created.map((asset) =>
          rm(join(this.store.assetsDir, asset.id), { force: true }),
        ),
      );
      throw error;
    }
  }
  wake() {
    if (this.worker || this.closing) return;
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.worker = undefined;
        if (!this.closing && this.jobs().some((job) => job.status === "queued"))
          this.wake();
      });
  }
  private receiptKey(job: MemoryImportJob, chunk: MemoryImportChunk) {
    return hash(
      JSON.stringify([
        job.space,
        chunk.sha256,
        chunk.start,
        chunk.end,
        EXTRACTOR_VERSION,
      ]),
    );
  }
  private candidates(
    job: MemoryImportJob,
    chunk: MemoryImportChunk,
    text: string,
    entries: ExtractedMemory[],
  ) {
    return entries.map((entry) => {
      const index = text.indexOf(entry.quote);
      if (
        index < 0 ||
        !entry.quote.trim() ||
        !validDate(entry.occurredAt) ||
        (entry.kind === "inference" && !entry.uncertainty.trim()) ||
        (entry.attribute &&
          (entry.category !== "profile" ||
            !text.includes(entry.attribute.value) ||
            !/[\p{L}\p{N}]/u.test(entry.attribute.value))) ||
        entry.people.some((name) => !text.includes(name))
      )
        throw new UserFacingError(
          422,
          "INVALID_EVIDENCE",
          "候选的引句、日期或人物无法通过原文校验，请重试或修订原始记录",
        );
      const start = chunk.start + Buffer.byteLength(text.slice(0, index));
      return {
        title: entry.title,
        content: entry.content,
        status: "draft" as const,
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        space: job.space,
        category: entry.category,
        people: [...new Set(entry.people)],
        place: entry.place,
        uncertainty: entry.uncertainty,
        attribute: entry.attribute || undefined,
        sources: [
          {
            assetId: chunk.assetId,
            name: chunk.name,
            sha256: chunk.sha256,
            start,
            end: start + Buffer.byteLength(entry.quote),
            quote: entry.quote,
          },
        ],
        conversationId: "",
        runId: "",
        ingestion: {
          jobId: job.id,
          chunkId: chunk.id,
          modelId: job.modelId,
          extractorVersion: EXTRACTOR_VERSION,
        },
      };
    });
  }
  private async drain() {
    while (!this.closing) {
      let job = this.jobs()
        .reverse()
        .find((value) => value.status === "queued");
      if (!job) return;
      this.activeId = job.id;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      job.status = "running";
      this.save(job);
      try {
        for (let index = 0; index < job.chunks.length; index++) {
          signal.throwIfAborted();
          job = this.job(job.id);
          const chunk = job.chunks[index];
          if (done(chunk) || chunk.status === "failed") continue;
          chunk.status = "running";
          chunk.stage = "read";
          chunk.error = undefined;
          this.save(job);
          try {
            const asset = this.store.asset(chunk.assetId);
            if (!asset)
              throw new UserFacingError(
                409,
                "SOURCE_MISSING",
                "原始资料已丢失，请重新导入",
              );
            const { buffer } = await this.read(asset);
            if (
              asset.sha256 !== chunk.sha256 ||
              (asset.memorySpace || "personal") !== job.space
            )
              throw new UserFacingError(
                409,
                "SOURCE_CHANGED",
                "资料与导入记录不一致，请重新导入",
              );
            signal.throwIfAborted();
            const key = this.receiptKey(job, chunk);
            const receipt = this.store.db
              .prepare("SELECT memoryIds FROM memory_extractions WHERE key=?")
              .get(key) as { memoryIds: string } | undefined;
            if (receipt) {
              chunk.memoryIds = JSON.parse(receipt.memoryIds);
              chunk.status = "skipped";
              chunk.stage = undefined;
              this.save(job);
              continue;
            }
            const text = buffer
              .subarray(chunk.start, chunk.end)
              .toString("utf8");
            chunk.stage = "extract";
            chunk.attempts++;
            this.save(job);
            const runtime = this.runtime();
            if (!runtime.extractMemories)
              throw new UserFacingError(
                400,
                "MODEL_UNAVAILABLE",
                "当前运行时不支持记忆提取",
              );
            const result = await runtime.extractMemories(
              {
                modelId: job.modelId,
                thinkingLevel: job.thinkingLevel,
                name: chunk.name,
                text,
              },
              signal,
            );
            signal.throwIfAborted();
            chunk.stage = "validate";
            chunk.usage = result.usage;
            this.save(job);
            const candidates = this.candidates(
              job,
              chunk,
              text,
              result.entries,
            );
            chunk.stage = "save";
            this.save(job);
            this.store.work.transaction(() => {
              signal.throwIfAborted();
              const fingerprints = new Set<string>();
              chunk.memoryIds = candidates
                .filter((value) => {
                  const fingerprint = hash(
                    JSON.stringify([
                      value.category,
                      value.content.trim(),
                      value.sources[0].quote,
                    ]),
                  );
                  if (fingerprints.has(fingerprint)) return false;
                  fingerprints.add(fingerprint);
                  return true;
                })
                .map((candidate) => this.store.work.createMemory(candidate).id);
              this.store.db
                .prepare("INSERT INTO memory_extractions VALUES (?,?,?)")
                .run(key, JSON.stringify(chunk.memoryIds), now());
              chunk.status = "completed";
              chunk.stage = undefined;
              this.save(job!);
            });
          } catch (error) {
            if (signal.aborted) throw error;
            chunk.status = "failed";
            chunk.stage = undefined;
            chunk.error =
              error instanceof UserFacingError
                ? error.message
                : "处理失败，请检查模型配置后重试此段";
            this.save(job);
          }
        }
        job = this.job(job.id);
        job.status = job.chunks.some((chunk) => chunk.status === "failed")
          ? "failed"
          : "completed";
        this.save(job);
      } catch {
        job = this.job(job.id);
        if (job.status !== "cancelled")
          job.status = this.closing ? "queued" : "failed";
        for (const chunk of job.chunks)
          if (chunk.status === "running") {
            chunk.status =
              this.closing || job.status === "cancelled" ? "pending" : "failed";
            chunk.stage = undefined;
            chunk.error =
              chunk.status === "failed"
                ? "处理意外中断，可重试未完成部分"
                : undefined;
          }
        this.save(job);
      } finally {
        this.activeId = undefined;
        this.controller = undefined;
      }
    }
  }
  cancel(id: string) {
    const job = this.job(id);
    if (job.status !== "queued" && job.status !== "running") return job;
    job.status = "cancelled";
    this.save(job);
    if (this.activeId === id) this.controller?.abort();
    return job;
  }
  retry(id: string) {
    const job = this.job(id);
    if (this.activeId === id)
      throw new UserFacingError(
        409,
        "IMPORT_BUSY",
        "正在停止当前片段，请稍后重试",
      );
    if (job.status !== "failed" && job.status !== "cancelled")
      throw new UserFacingError(409, "IMPORT_BUSY", "当前任务无需重试");
    if (
      !this.config.providers.some(
        (provider) => provider.model.id === job.modelId,
      )
    )
      throw new UserFacingError(
        400,
        "MODEL_UNAVAILABLE",
        "原模型未配置，请恢复配置或新建导入",
      );
    job.status = "queued";
    job.recoveries = 0;
    for (const chunk of job.chunks)
      if (!done(chunk)) {
        chunk.status = "pending";
        chunk.error = undefined;
        chunk.stage = undefined;
      }
    this.save(job);
    this.wake();
    return job;
  }
  async close() {
    this.closing = true;
    this.controller?.abort();
    await this.creation;
    await this.worker;
  }
}
