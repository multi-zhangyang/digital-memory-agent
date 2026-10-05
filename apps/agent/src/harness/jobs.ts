import { createHash } from "node:crypto";
import type { Run, TaskJob } from "@memory/contracts";
import type { Store } from "../store.js";
import { UserFacingError } from "./runtime.js";

import type { TaskJobDriver } from "./job-driver.js";
export type { TaskJobDriver } from "./job-driver.js";
type JobLink = { runId: string; kind: string; jobId: string; toolCallId: string; handledRevision: number; ownership: "task" | "library" };
const finished = (status: TaskJob["status"]) => ["completed", "failed", "cancelled", "skipped"].includes(status);
const stopped = (run: Run) => ["completed", "failed", "stopped"].includes(run.status);


/** Durable links and completion delivery; domain work remains in registered services. */
export class TaskJobs {
  private readonly drivers = new Map<string, TaskJobDriver>();
  private readonly subscriptions: (() => void)[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS run_jobs (
      runId TEXT NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,jobId TEXT NOT NULL,toolCallId TEXT NOT NULL,
      handledRevision INTEGER NOT NULL DEFAULT -1,PRIMARY KEY(runId,kind,jobId));
      CREATE INDEX IF NOT EXISTS run_jobs_job ON run_jobs(kind,jobId);`);
    if (!store.db.prepare("PRAGMA table_info(run_jobs)").all().some((column) => column.name === "ownership"))
      store.db.exec("ALTER TABLE run_jobs ADD COLUMN ownership TEXT NOT NULL DEFAULT 'task'");
    store.db.exec("CREATE TABLE IF NOT EXISTS run_job_retries(runId TEXT NOT NULL,kind TEXT NOT NULL,jobId TEXT NOT NULL,PRIMARY KEY(runId,kind,jobId))");
  }

  register(kind: string, driver: TaskJobDriver) {
    if (this.drivers.has(kind)) throw new Error("Duplicate job driver");
    this.drivers.set(kind, driver);
    this.subscriptions.push(driver.subscribe((id) => this.sync(kind, id)));
    this.subscriptions.push(this.store.events.subscribe(`harness.jobs.${kind}`, [`${kind}.changed`], (event) => this.sync(kind, event.aggregateId)));
  }

  private driver(kind: string) {
    const driver = this.drivers.get(kind);
    if (!driver) throw new UserFacingError(503, "JOB_DRIVER_UNAVAILABLE", "后台作业能力不可用");
    return driver;
  }

  private links(runId: string): JobLink[] {
    return this.store.db.prepare("SELECT * FROM run_jobs WHERE runId=? ORDER BY rowid").all(runId) as unknown as JobLink[];
  }

  list(runId: string): TaskJob[] {
    return this.links(runId).map((link) => ({ ...this.driver(link.kind).get(link.jobId), kind: link.kind, toolCallId: link.toolCallId, ownership: link.ownership }));
  }

  attach(runId: string, kind: string, jobId: string, toolCallId: string, ownership: "task" | "library" = "task") {
    const run = this.store.work.get<Run>("run", runId);
    if (!run || stopped(run)) {
      if (ownership === "task") this.driver(kind).cancel(jobId);
      throw new UserFacingError(409, "RUN_STOPPED", "任务已停止，无法关联后台作业");
    }
    const existing = this.links(runId);
    if (!existing.some((link) => link.kind === kind && link.jobId === jobId) && existing.length >= 8) {
      if (ownership === "task") this.driver(kind).cancel(jobId);
      throw new UserFacingError(409, "JOB_LIMIT", "本次任务已达到后台作业数量上限");
    }
    this.store.work.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO run_jobs(runId,kind,jobId,toolCallId,ownership) VALUES (?,?,?,?,?)")
        .run(runId, kind, jobId, toolCallId, ownership);
      const current = this.store.work.get<Run>("run", runId)!;
      const jobs = this.list(runId), part = current.parts.find((p) => p.type === "tool" && p.toolCallId === toolCallId);
      this.store.work.patchRun(runId, { jobs, receipts: [...(current.receipts || []).filter((r) => r.toolCallId !== toolCallId),
        { toolCallId, name: part?.type === "tool" ? part.name : kind, output: { job: jobs.find((j) => j.kind === kind && j.id === jobId), accepted: true } }] }, "job-submitted");
    });
    return this.list(runId).find((job) => job.kind === kind && job.id === jobId)!;
  }

  private sync(kind: string, jobId: string) {
    const links = this.store.db.prepare("SELECT * FROM run_jobs WHERE kind=? AND jobId=?").all(kind, jobId) as unknown as JobLink[];
    for (const { runId } of links) {
      const run = this.store.work.get<Run>("run", runId);
      if (!run) continue;
      const jobs = this.list(runId);
      if (JSON.stringify(jobs) !== JSON.stringify(run.jobs)) this.store.work.patchRun(runId, { jobs }, "job-progress");
      for (const listener of this.listeners.get(runId) || []) listener();
    }
  }

  hasWork(runId: string) {
    return this.links(runId).some((link) => {
      const job = this.driver(link.kind).get(link.jobId);
      return !finished(job.status) || link.handledRevision < job.revision;
    });
  }

  async wait(runId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const ready = () => this.list(runId).every((job) => finished(job.status));
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const listeners = this.listeners.get(runId) || new Set<() => void>();
      this.listeners.set(runId, listeners);
      const cleanup = () => {
        listeners.delete(check);
        if (!listeners.size) this.listeners.delete(runId);
        signal.removeEventListener("abort", abort);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(signal.reason || new Error("Task stopped")); };
      listeners.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  acknowledge(runId: string, kind: string, jobId: string, revision: number) {
    const job = this.driver(kind).get(jobId);
    if (!finished(job.status) || job.revision !== revision) return;
    this.store.db.prepare("UPDATE run_jobs SET handledRevision=MAX(handledRevision,?) WHERE runId=? AND kind=? AND jobId=?")
      .run(revision, runId, kind, jobId);
  }

  claim(runId: string) {
    return this.store.work.transaction(() => {
      const run = this.store.work.get<Run>("run", runId)!;
      if (stopped(run)) return undefined;
      const links = this.links(runId);
      if (links.some((link) => !finished(this.driver(link.kind).get(link.jobId).status))) return undefined;
      const pending = links.filter((link) => link.handledRevision < this.driver(link.kind).get(link.jobId).revision);
      if (!pending.length) return undefined;
      const jobs = pending.map((link) => {
        const driver = this.driver(link.kind);
        driver.authorize?.(link.jobId, run);
        const job = driver.get(link.jobId);
        const result = driver.result(link.jobId, 0, 8, Math.floor(12000 / pending.length));
        driver.delivered?.(run, result);
        return { ...job, kind: link.kind, result };
      });
      const id = createHash("sha256").update(JSON.stringify(jobs.map((job) => [job.kind, job.id, job.revision]))).digest("hex");
      for (const job of jobs) this.store.db.prepare("UPDATE run_jobs SET handledRevision=? WHERE runId=? AND kind=? AND jobId=?")
        .run(job.revision, runId, job.kind, job.id);
      // Preserve the delivered data before invoking Pi; recovery reuses the notification and never resubmits the jobs.
      const content = { jobs, instruction: "后台作业已结束。请根据真实结果继续原任务并交付；待核对观察不代表已确认事实。失败或覆盖不足须明确说明。" };
      this.store.work.patchRun(runId, { status: "running", waitingFor: null, jobNotification: { id, content } }, "job-results", {
        status: "running", waitingFor: null, notificationId: id, jobIds: jobs.map((job) => job.id),
      });
      return { id, content };
    });
  }

  problem(runId: string) {
    for (const job of this.list(runId)) if (job.status === "failed" || job.status === "cancelled") {
      const driver = this.driver(job.kind);
      const problem = driver.problem ? driver.problem(job.id) : "部分后台作业未完成，请查看作业结果。";
      if (problem) return problem;
    }
  }

  cancel(runId: string) {
    for (const link of this.links(runId)) if (link.ownership === "task") this.driver(link.kind).cancel(link.jobId);
  }

  private authorized(runId: string, jobId: string) {
    const run = this.store.work.get<Run>("run", runId)!;
    const link = this.store.db.prepare(`SELECT j.* FROM run_jobs j JOIN workspace_records r ON r.id=j.runId
      WHERE j.jobId=? AND r.conversationId=? ORDER BY j.rowid DESC LIMIT 1`).get(jobId, run.conversationId) as JobLink | undefined;
    if (!link) throw new UserFacingError(404, "JOB_NOT_FOUND", "此对话中没有该后台作业");
    const driver = this.driver(link.kind);
    driver.authorize?.(jobId, run);
    return { driver, link };
  }

  read(runId: string, jobId: string, offset = 0, limit = 8, section?: "assets" | "entries") {
    const { driver, link } = this.authorized(runId, jobId);
    const result = driver.result(jobId, Math.max(0, offset), Math.max(1, Math.min(20, limit)), 12000, section);
    driver.delivered?.(this.store.work.get<Run>("run", runId)!, result);
    const job = driver.get(jobId);
    this.acknowledge(runId, link.kind, jobId, job.revision);
    return { ...job, kind: link.kind, result };
  }

  manage(runId: string, jobId: string, action: "retry" | "cancel", toolCallId: string, assetIds?: readonly string[]) {
    const { driver, link } = this.authorized(runId, jobId);
    if (action === "retry") {
      if (!driver.retry) throw new UserFacingError(400, "RETRY_UNAVAILABLE", "此后台作业不支持重试");
      if (this.store.db.prepare("SELECT 1 FROM run_job_retries WHERE runId=? AND kind=? AND jobId=?").get(runId, link.kind, jobId))
        throw new UserFacingError(409, "RETRY_LIMIT", "本次任务已重试此作业，继续失败需先解决原因；用户再次交办后可重试");
      this.store.work.transaction(() => {
        this.attach(runId, link.kind, jobId, toolCallId, link.ownership);
        driver.retry!(jobId, assetIds);
        this.store.db.prepare("INSERT INTO run_job_retries VALUES(?,?,?)").run(runId, link.kind, jobId);
      });
    } else driver.cancel(jobId);
    return driver.get(jobId);
  }

  close() {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }

  catalog(): TaskJob[] {
    return [...this.drivers].flatMap(([kind, driver]) => (driver.list?.() || []).map((job) => ({ ...job, kind, toolCallId: "",
      ownership: this.store.db.prepare("SELECT 1 FROM run_jobs WHERE kind=? AND jobId=? AND ownership='task' LIMIT 1").get(kind, job.id) ? "task" as const : job.ownership || "library" as const })));
  }
  inspect(kind: string, id: string, offset = 0, limit = 8, section?: "assets" | "entries") {
    const driver = this.driver(kind);
    return { ...driver.get(id), kind, result: driver.result(id, offset, limit, 12000, section) };
  }
  control(kind: string, id: string, action: "retry" | "cancel") {
    const driver = this.driver(kind);
    if (action === "cancel") driver.cancel(id);
    else {
      if (!driver.retry) throw new UserFacingError(400, "RETRY_UNAVAILABLE", "此作业不支持重试");
      driver.retry(id);
    }
    return { ...driver.get(id), kind };
  }
}
