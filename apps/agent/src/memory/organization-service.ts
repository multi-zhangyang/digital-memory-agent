import { createHash, randomUUID } from "node:crypto";
import type { MemoryActivity, MemoryEntry, Run, TaskJob } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import type { AppConfig } from "../config.js";
import type { MemoryProcessors } from "./processors.js";
import type { AssetProcessingService } from "./asset-processing-service.js";
import type { TaskJobDriver } from "../harness/job-driver.js";
import { MemoryActivities, activityToolView } from "./activities.js";
import { EvidenceService } from "./evidence-service.js";
import { processingModel } from "./processing-policy.js";
import { evidenceOf } from "./values.js";
import { memoryTokens } from "./retrieval.js";
import { activityDate, unlinkedVisualPairs, validateActivities, type ActivityExtractionInput } from "./activity-extraction.js";
import { MemorySourceVerifier } from "./source-verifier.js";
import { UserFacingError } from "../errors.js";

interface OrganizationJob {
  id: string; requestId: string; title: string; status: TaskJob["status"]; revision: number; updatedAt: string;
  modelId: string; assetIds: string[]; allowedAssetIds: string[]; ownership: "task" | "library";
  processingJobId?: string; memoryIds?: string[]; cursor: number; activityIds: string[]; failures: { memoryIds: string[]; error: string }[];
  recoveries: number; error?: string;
  validationRetries?: number;
  maintenance?: boolean; sourceVersions?: [string, string][];
}
type OrganizationScope = { requestId: string; modelId?: string; allowedAssetIds?: readonly string[]; ownership?: "task" | "library"; processed?: boolean; maintenance?: boolean };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const terminal = (status: string) => ["completed", "failed", "cancelled", "skipped"].includes(status);

/** Durable bounded batches. No foreground Agent session or polling loop is required. */
export class MemoryOrganizationService {
  private running?: Promise<void>;
  private closed = false;
  private controller?: AbortController;
  private activeId?: string;
  private readonly listeners = new Set<(id: string) => void>();
  private readonly subscriptions: (() => void)[];
  constructor(private readonly data: MemoryData, private readonly config: AppConfig, private readonly processors: () => MemoryProcessors,
    readonly activities: MemoryActivities, private readonly processing: AssetProcessingService, private readonly evidence: EvidenceService) {
    data.db.exec(`CREATE TABLE IF NOT EXISTS memory_organization_jobs(id TEXT PRIMARY KEY,requestId TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS organization_job_state ON memory_organization_jobs(json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS memory_organization_sources(assetId TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_organization_versions(assetId TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_organization_meta(id INTEGER PRIMARY KEY,activationSeq INTEGER NOT NULL);
      INSERT OR IGNORE INTO memory_organization_meta SELECT 1,coalesce(max(seq),0) FROM domain_events;`);
    for (const job of this.jobs().filter((j) => j.status === "running")) {
      job.recoveries++;
      this.save({ ...job, status: job.recoveries > 3 ? "failed" : "queued", error: job.recoveries > 3 ? "多次重启中断，请检查后重试" : undefined });
    }
    const activation = (data.db.prepare("SELECT activationSeq FROM memory_organization_meta WHERE id=1").get() as { activationSeq: number }).activationSeq;
    this.subscriptions = [processing.driver().subscribe(() => this.wake()),
      data.events.subscribe("memory.organization-intake", ["memory-import.changed"], async (event) => {
        if (event.seq <= activation) return;
        const source = data.db.prepare("SELECT data FROM memory_import_jobs WHERE id=?").get(event.aggregateId) as { data: string } | undefined;
        if (!source) return;
        const job = JSON.parse(source.data);
        if (job.ownership !== "library" || job.space !== "personal" || !terminal(job.status) || job.status === "cancelled" || data.memories.ledger.settings().intake !== "automatic") return;
        const assetIds: string[] = [...new Set<string>(job.chunks.filter((c: { status: string }) => ["completed", "skipped"].includes(c.status)).map((c: { assetId: string }) => c.assetId))];
        if (assetIds.length) await this.queueMaintenance(assetIds, job.modelId, true);
      }),
      data.events.subscribe("memory.organization-revisions", ["memory.changed", "memory.invalidated"], async (event) => {
        if (event.seq <= activation) return;
        const memory = event.topic === "memory.changed" ? data.memories.get<MemoryEntry>("memory", event.aggregateId) : undefined;
        if (memory?.derivedFrom?.length) return;
        const ids = memory ? evidenceOf(memory).flatMap((s) => s.type === "asset" ? [s.assetId] : []) :
          (data.db.prepare("SELECT assetId FROM memory_organization_sources").all() as { assetId: string }[]).map((r) => r.assetId);
        await this.queueMaintenance(ids);
      }),
    ];
  }
  jobs(): OrganizationJob[] {
    return (this.data.db.prepare("SELECT data FROM memory_organization_jobs ORDER BY rowid").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  job(id: string): OrganizationJob {
    const row = this.data.db.prepare("SELECT data FROM memory_organization_jobs WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new UserFacingError(404, "JOB_NOT_FOUND", "活动整理作业不存在");
    return JSON.parse(row.data);
  }
  private save(job: OrganizationJob) {
    job = { ...job, revision: job.revision + 1, updatedAt: now() };
    this.data.memories.transaction(() => {
      this.data.db.prepare("UPDATE memory_organization_jobs SET data=? WHERE id=?").run(JSON.stringify(job), job.id);
      this.data.events.publish("memory-organization.changed", job.id, job.revision);
    });
    for (const listener of this.listeners) listener(job.id);
    return job;
  }
  private observations(assetIds: readonly string[], allowedAssetIds: readonly string[]) {
    const rows = this.data.db.prepare(`SELECT DISTINCT r.data FROM memory_evidence_index s JOIN workspace_records r ON r.id=s.memoryId
      WHERE s.assetId IN (SELECT value FROM json_each(?)) AND r.kind='memory' AND json_extract(r.data,'$.derivedFrom') IS NULL ORDER BY r.rowid`)
      .all(JSON.stringify(assetIds)) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as MemoryEntry).filter((m) => this.activities.available(m, allowedAssetIds));
  }
  private fingerprint(assetId: string, allowed: readonly string[]) {
    const observations = this.observations([assetId], allowed);
    return hash([this.data.asset(assetId)?.sha256, observations.map((m) => [m.id, m.version]), this.activities.entities(observations)]);
  }
  private async queueMaintenance(input: string[], modelId?: string, intake = false) {
    const maintained = (this.data.db.prepare("SELECT assetId,sha256 FROM memory_organization_sources").all() as { assetId: string; sha256: string }[])
      .filter((s) => this.data.asset(s.assetId)?.sha256 === s.sha256).map((s) => s.assetId);
    const allowed = [...new Set([...maintained, ...(intake ? input : [])])];
    const ids = [...new Set(input)].sort().filter((id) => {
      const asset = this.data.asset(id);
      return allowed.includes(id) && asset && (asset.memorySpace || "personal") === "personal" &&
        !this.data.memories.ledger.sourceBlocked(asset.sha256) && this.observations([id], allowed).length > 0 &&
        !(this.data.db.prepare("SELECT 1 FROM memory_organization_versions WHERE assetId=? AND fingerprint=?").get(id, this.fingerprint(id, allowed)));
    });
    for (let offset = 0; offset < ids.length; offset += 200) {
      const assetIds = ids.slice(offset, offset + 200), versions = assetIds.map((id) => [id, this.fingerprint(id, allowed)]);
      await this.submit({ assetIds }, { requestId: `maintenance:${hash(versions)}`, modelId, ownership: "library", processed: true, maintenance: true });
    }
  }
  async submit(input: { assetIds: string[]; title?: string }, scope: OrganizationScope) {
    const existing = this.data.db.prepare("SELECT data FROM memory_organization_jobs WHERE requestId=?").get(scope.requestId) as { data: string } | undefined;
    if (existing) {
      const job = JSON.parse(existing.data) as OrganizationJob;
      if (hash([...new Set(input.assetIds)].sort()) !== hash([...job.assetIds].sort()) || (scope.allowedAssetIds && job.allowedAssetIds.some((id) => !scope.allowedAssetIds!.includes(id))))
        throw new UserFacingError(409, "COMMAND_CONFLICT", "此整理请求已用于不同资料范围");
      return job;
    }
    const ids = [...new Set(input.assetIds)];
    if (!ids.length || ids.length > 200) throw new UserFacingError(400, "PROCESSING_LIMIT", "每次请选择 1 至 200 份资料");
    for (const id of ids) {
      const asset = this.data.asset(id);
      if (scope.allowedAssetIds && !scope.allowedAssetIds.includes(id)) throw new UserFacingError(403, "SOURCE_SCOPE", "只能整理本次所选资料");
      if (!asset || (asset.memorySpace || "personal") !== "personal" || !["text", "image", "video"].includes(asset.kind) || this.data.memories.ledger.sourceBlocked(asset.sha256))
        throw new UserFacingError(409, "SOURCE_UNAVAILABLE", "资料不可用或已停止取用");
    }
    const modelId = processingModel(this.config, this.data.memories.ledger.settings(), "text", scope.modelId).model.id;
    if (!this.processors().organizeActivities) throw new UserFacingError(503, "PROCESSOR_UNAVAILABLE", "活动整理模型能力未配置");
    const ownership = scope.ownership || "task";
    // Only library-owned work authorizes future background maintenance.
    if (ownership === "library") for (const id of ids) this.data.db.prepare("INSERT INTO memory_organization_sources VALUES(?,?) ON CONFLICT(assetId) DO UPDATE SET sha256=excluded.sha256").run(id, this.data.asset(id)!.sha256);
    const maintained = (this.data.db.prepare("SELECT s.assetId FROM memory_organization_sources s JOIN assets a ON a.id=s.assetId AND a.sha256=s.sha256").all() as { assetId: string }[]).map((s) => s.assetId);
    const allowedAssetIds = scope.allowedAssetIds ? [...scope.allowedAssetIds] : [...new Set([...ids, ...maintained])];
    const missing = scope.processed ? [] : ids.filter((id) => !this.observations([id], allowedAssetIds).length);
    const upstream = missing.length ? await this.processing.submit({ assetIds: missing }, { requestId: `organize:${scope.requestId}`, modelId: scope.modelId, allowedAssetIds, ownership }) : undefined;
    // Processing preparation can yield; enforce request idempotency again before insertion.
    const duplicate = this.data.db.prepare("SELECT data FROM memory_organization_jobs WHERE requestId=?").get(scope.requestId) as { data: string } | undefined;
    if (duplicate) return JSON.parse(duplicate.data) as OrganizationJob;
    const job: OrganizationJob = { id: randomUUID(), requestId: scope.requestId, title: input.title || "整理生活活动", status: "queued", revision: 0, updatedAt: now(),
      modelId, assetIds: ids, allowedAssetIds, ownership, maintenance: scope.maintenance, processingJobId: upstream?.id, cursor: 0, activityIds: [], failures: [], recoveries: 0 };
    this.data.db.prepare("INSERT INTO memory_organization_jobs VALUES(?,?,?)").run(job.id, job.requestId, JSON.stringify(job));
    this.save(job); this.wake(); return this.job(job.id);
  }
  private async input(job: OrganizationJob, seeds: MemoryEntry[], signal: AbortSignal) {
    const quotes = (memory: MemoryEntry) => memory.sources.filter((s) => this.data.asset(s.assetId)?.kind === "text" && s.quote).map((s) => s.quote!.slice(0, 2000)).slice(0, 2);
    const retrieved = await this.evidence.search({ query: seeds.map((m) => m.title).join(" ").slice(0, 200), limit: 20 }, { allowedAssetIds: job.allowedAssetIds }, signal);
    const relevant = new Set(retrieved.hits.flatMap((hit) => hit.memoryId ? [hit.memoryId] : []));
    const tokens = new Set(memoryTokens(seeds.map((m) => m.content).join(" ")));
    const dates = new Set(seeds.map((m) => activityDate(m, quotes(m))).filter(Boolean));
    const entities = new Set(this.activities.entities(seeds));
    const candidates = this.activities.related([...relevant, ...seeds.map((m) => m.id)], [...dates], job.allowedAssetIds);
    const ranked = candidates.map((activity) => ({ activity, score: activity.members.filter((m) => relevant.has(m.id)).length * 4 +
      Number(dates.has(activity.occurredAt)) * 3 + activity.entityIds.filter((id) => entities.has(id)).length +
      memoryTokens(activity.title + " " + activity.summary).filter((t) => tokens.has(t)).length }))
      .filter((r) => r.score > 1 || r.activity.members.some((m) => seeds.some((s) => s.id === m.id))).sort((a, b) => b.score - a.score).slice(0, 6).map((r) => r.activity);
    const observations = [...new Map([...seeds, ...ranked.flatMap((a) => this.activities.memories(a, job.allowedAssetIds))].map((m) => [m.id, m])).values()].slice(0, 48);
    const names = new Map(observations.map((m, i) => [m.id, `m${i + 1}`]));
    const sourceNames = new Map([...new Set(observations.flatMap((m) => m.sources.map((s) => s.assetId)))].map((id, i) => [id, `s${i + 1}`]));
    const input: ActivityExtractionInput = { modelId: job.modelId, observations: observations.map((m) => ({ ref: names.get(m.id)!, id: m.id, version: m.version,
      title: m.title, content: m.content.slice(0, 2000), occurredAt: activityDate(m, quotes(m)), place: m.place || "", status: m.status,
      sourceQuotes: quotes(m), sources: m.sources.slice(0, 8).map((s) => {
        const kind = this.data.asset(s.assetId)!.kind;
        return { ref: sourceNames.get(s.assetId)!, kind, textRange: kind === "text" ? { start: s.start, end: s.end } : undefined,
          timestamp: s.video?.timestamp, region: s.visual?.region || s.view?.region };
      }),
      authority: m.editedBy === "user" || m.acceptedBy === "user" ? "user" : "observation",
      uncertainty: m.uncertainty || "", entityIds: this.activities.entities([m]) })), requiredRefs: seeds.map((m) => names.get(m.id)!),
      existing: ranked.map((a) => ({ id: a.id, title: a.title, members: a.members.flatMap((m) => names.has(m.id) ? [names.get(m.id)!] : []), locked: a.locked })),
      separated: this.activities.separations(observations.map((m) => m.id)).map(([a, b]) => [names.get(a)!, names.get(b)!]) };
    input.separated.push(...unlinkedVisualPairs(input.observations));
    return { input, observations, ranked };
  }
  wake() {
    if (this.closed || this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    while (!this.closed) {
      let job = this.jobs().find((j) => j.status === "queued" && (!j.processingJobId || terminal(this.processing.driver().get(j.processingJobId).status)));
      if (!job) return;
      this.controller = new AbortController(); this.activeId = job.id;
      const signal = this.controller.signal;
      try {
        job = this.save({ ...job, status: "running", memoryIds: job.memoryIds || this.observations(job.assetIds, job.allowedAssetIds).map((m) => m.id),
          sourceVersions: job.sourceVersions || job.assetIds.map((id) => [id, this.fingerprint(id, job!.allowedAssetIds)]) });
        if (job.maintenance && job.sourceVersions!.every(([id, fingerprint]) => this.data.db.prepare("SELECT 1 FROM memory_organization_versions WHERE assetId=? AND fingerprint=?").get(id, fingerprint))) {
          job = this.save({ ...job, cursor: job.memoryIds!.length,
            activityIds: this.activities.related(job.memoryIds!, [], job.allowedAssetIds).filter((a) => !a.stale).map((a) => a.id) });
        }
        while (job.cursor < job.memoryIds!.length) {
          signal.throwIfAborted();
          const ids = job.memoryIds!.slice(job.cursor, job.cursor + 12);
          const seeds = ids.flatMap((id) => { const memory = this.data.memories.get<MemoryEntry>("memory", id); return memory && this.activities.available(memory, job!.allowedAssetIds) ? [memory] : []; });
          try {
            if (!seeds.length) throw new UserFacingError(409, "SOURCE_CHANGED", "本批活动依据已停用或更新");
            const { input, observations, ranked } = await this.input(job, seeds, signal);
            const verifier = new MemorySourceVerifier(this.data);
            for (const memory of observations) await verifier.verify(memory, signal);
            let result = await this.processors().organizeActivities!(input, signal);
            try { validateActivities(input, result); }
            catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof UserFacingError) || error.code !== "ACTIVITY_INVALID") throw error;
              // One bounded repair of a structured result, within the same frozen
              // source scope. A second invalid result fails the durable batch.
              job = this.save({ ...job, validationRetries: (job.validationRetries || 0) + 1 });
              result = await this.processors().organizeActivities!({ ...input,
                validationFeedback: { reason: error.message, previous: result.activities } }, signal);
              validateActivities(input, result);
            }
            signal.throwIfAborted();
            this.data.memories.transaction(() => {
              if (this.job(job!.id).status === "cancelled") throw new UserFacingError(409, "JOB_CANCELLED", "活动整理已停止");
              if (observations.some((m) => this.data.memories.get<MemoryEntry>("memory", m.id)?.version !== m.version || !this.activities.available(m, job!.allowedAssetIds)) ||
                ranked.some((a) => this.activities.raw(a.id).version !== a.version)) throw new UserFacingError(409, "SOURCE_CHANGED", "整理期间依据已更新，请重新整理受影响资料");
              const byRef = new Map(input.observations.map((o, i) => [o.ref, observations[i]]));
              for (const proposal of result.activities) {
                const members = proposal.members.map((r) => byRef.get(r)!);
                const memberIds = new Set(members.map((m) => m.id));
                const rejected = this.activities.rejected([...memberIds]);
                if (rejected) { job!.activityIds.push(rejected.id); continue; }
                // Reconcile against current overlaps, including groups outside the model's ranked
                // context. A later maintenance/retry subset must not duplicate a fresh larger group.
                // Explicit splitting remains a user command, with persisted separation constraints.
                const overlaps = this.activities.related([...memberIds], [], job!.allowedAssetIds);
                const existing = overlaps.find((a) => !a.stale && members.every((m) => a.members.some((other) => other.id === m.id && other.version === m.version)));
                if (existing) { job!.activityIds.push(existing.id); continue; }
                const next = this.activities.candidate(proposal, members, job!.modelId);
                const locked = overlaps.find((a) => a.locked && a.members.some((m) => memberIds.has(m.id)));
                if (locked) { next.relatedActivityId = locked.id; next.issues = [...new Set([...next.issues, "与已核对活动有关联，新增资料需确认后合入"])]; }
                this.activities.save(next); job!.activityIds.push(next.id);
                for (const previous of overlaps) if (!previous.locked && previous.members.every((m) => memberIds.has(m.id))) {
                  const current = this.activities.raw(previous.id);
                  if (current.status !== "superseded") this.activities.save({ ...current, version: current.version + 1, status: "superseded", replacedBy: next.id, replacementIds: [next.id] }, current.version);
                }
              }
              job!.cursor += ids.length; job!.activityIds = [...new Set(job!.activityIds)]; job = this.save(job!);
            });
          } catch (error) {
            signal.throwIfAborted();
            job = this.save({ ...job, cursor: job.cursor + ids.length, failures: [...job.failures, { memoryIds: ids,
              error: error instanceof UserFacingError ? error.message : "本批活动整理失败，可重试" }] });
          }
        }
        const upstream = job.processingJobId && this.processing.driver().get(job.processingJobId);
        const empty = !job.memoryIds?.length;
        const failed = job.failures.length || empty || (upstream && upstream.status === "failed");
        this.data.memories.transaction(() => {
          if (!failed && job!.ownership === "library") for (const [id, fingerprint] of job!.sourceVersions || [])
            this.data.db.prepare("INSERT INTO memory_organization_versions VALUES(?,?) ON CONFLICT(assetId) DO UPDATE SET fingerprint=excluded.fingerprint").run(id, fingerprint);
          this.save({ ...job!, status: failed ? "failed" : "completed",
          error: empty ? "资料尚无可用观察，请检查处理结果后重试" : upstream && upstream.status === "failed" ? "部分原始资料处理失败，请查看作业覆盖" : undefined });
        });
      } catch (error) {
        const current = this.job(job.id);
        if (current.status !== "cancelled") this.save({ ...current, status: this.closed ? "queued" : "failed", error: this.closed ? undefined : "活动整理已中断，可重试" });
      } finally { this.activeId = undefined; this.controller = undefined; }
    }
  }
  driver(): TaskJobDriver {
    const get = (id: string) => {
      const job = this.job(id), total = job.memoryIds?.length || 0, failed = job.failures.reduce((n, f) => n + f.memoryIds.length, 0);
      const upstream = job.processingJobId ? this.processing.driver().get(job.processingJobId) : undefined;
      return { id, title: job.title, status: job.status, revision: job.revision, updatedAt: job.updatedAt, ownership: job.ownership,
        progress: { total, completed: Math.max(0, job.cursor - failed), failed }, ...(upstream?.coverage ? { coverage: upstream.coverage } : {}), blockedReason: job.error };
    };
    return { get, list: () => this.jobs().slice(-100).reverse().map((j) => get(j.id)),
      result: (id, offset, limit, maxBytes) => {
        const job = this.job(id);
        const current = this.activities.current(job.activityIds, job.allowedAssetIds);
        const result = { activities: [] as ReturnType<typeof activityToolView>[], total: current.length, nextOffset: null as number | null,
          failures: job.failures.slice(0, 5), processingJobId: job.processingJobId, error: job.error,
          policy: "活动归组是可撤销候选；status=confirmed 才表示用户已确认活动内容，来源中的其他断言仍保留各自核对状态。" };
        let cursor = offset;
        for (const activity of current.slice(offset, offset + limit)) {
          result.activities.push(activityToolView(activity));
          if (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 80) {
            result.activities.pop();
            if (!result.activities.length) {
              result.activities.push({ ...activityToolView(activity), summary: "", sources: [], members: [], issues: [], reason: "", entityIds: [], more: "请用 query_memory_activities 按活动 id 分页查看完整结果。" });
              cursor++;
            }
            break;
          }
          cursor++;
        }
        if (cursor < current.length) result.nextOffset = cursor;
        return result;
      },
      authorize: (id, run: Run) => { if (run.scope === "selected" && this.job(id).allowedAssetIds.some((assetId) => !run.assetIds.includes(assetId)))
        throw new UserFacingError(403, "SOURCE_SCOPE", "此活动作业超出本次所选资料范围"); },
      delivered: (run, result) => { for (const activity of (result as { activities: MemoryActivity[] }).activities) for (const source of activity.sources)
        if (source.type === "asset") this.data.recordSource?.(run.id, source); },
      cancel: (id) => { const job = this.job(id); if (terminal(job.status)) return; this.save({ ...job, status: "cancelled" }); if (job.ownership === "task" && job.processingJobId) this.processing.driver().cancel(job.processingJobId);
        if (this.activeId === id) this.controller?.abort(); },
      retry: (id) => { const job = this.job(id); if (!terminal(job.status)) throw new UserFacingError(409, "JOB_RUNNING", "整理仍在进行");
        if (job.processingJobId && ["failed", "cancelled"].includes(this.processing.driver().get(job.processingJobId).status)) this.processing.driver().retry?.(job.processingJobId);
        const failedIds = job.failures.flatMap((f) => f.memoryIds);
        this.save({ ...job, status: "queued", memoryIds: failedIds.length ? [...new Set(failedIds)] : undefined, sourceVersions: undefined, cursor: 0, failures: [], error: undefined, recoveries: 0 }); this.wake(); },
      problem: (id) => this.job(id).error || (this.job(id).failures.length ? "部分活动整理未完成，请核对或重试失败部分" : undefined),
      subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; } };
  }
  busy() { return !!this.running; }
  async idle() { this.wake(); await this.running; }
  async close() { this.closed = true; this.controller?.abort(); await this.running; for (const unsubscribe of this.subscriptions) unsubscribe(); }
}
