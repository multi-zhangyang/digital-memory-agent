"use client";
import { useEffect, useState } from "react";
import type { CapabilitySnapshot, DatasetAuditDecision, DatasetAuditJob, MemoryDataset, MemoryOverview, ProcessingAssetResult, TaskJob, VideoSourceIndex } from "@memory/contracts";
import { api, videoTime } from "@/lib/api";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProcessingAssets } from "./processing-assets";
import { VideoIndexFrames } from "./video-index-frames";
import { DatasetAuditDecisions, DatasetAuditSummary } from "./dataset-audit";

const labels = { queued: "等待处理", running: "处理中", completed: "已完成", failed: "未完成", cancelled: "已取消", skipped: "已跳过" };
type JobDetail = TaskJob & { result: Partial<VideoSourceIndex> & { activities?: { id: string; title: string; status: string }[]; audit?: DatasetAuditJob; decisions?: DatasetAuditDecision[]; sourceHash?: string; state?: string; assetId?: string; jobId?: string; error?: string; entries?: { id: string; title: string; status: string }[]; assets?: ProcessingAssetResult[]; failures?: { assetId: string; error: string }[]; nextAssetOffset?: number | null } };

export function ProcessingCenter({ onMemory, onAsset, onActivity, onDatasets, onSettings }: { onMemory: (id: string) => void; onAsset: (id: string) => void; onActivity: (id: string) => void; onDatasets: () => void; onSettings: () => void }) {
  const [tab, setTab] = useState("jobs"), [status, setStatus] = useState("all"), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<{ jobs: TaskJob[]; total: number; nextOffset: number | null }>();
  const [capabilities, setCapabilities] = useState<CapabilitySnapshot>();
  const [error, setError] = useState(""), [detailError, setDetailError] = useState(""), [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<TaskJob>(), [detail, setDetail] = useState<JobDetail>(), [resultOffset, setResultOffset] = useState(0);
  const [section, setSection] = useState("entries");
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const result = await api<NonNullable<typeof page>>(`/jobs?offset=${offset}${status === "all" ? "" : `&status=${status}`}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setPage(result); setError(""); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取作业失败"); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [status, offset, revision]);
  useEffect(() => {
    const controller = new AbortController();
    void api<CapabilitySnapshot>("/capabilities", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setCapabilities(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [tab, revision]);
  useEffect(() => {
    setDetail(undefined); setDetailError(""); if (!selected) return;
    const controller = new AbortController(); let pending = false, finished = false;
    const load = async () => {
      if (pending || finished) return; pending = true;
      try {
        const result = await api<JobDetail>(`/jobs/${selected.kind}/${selected.id}?offset=${resultOffset}&section=${section}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setDetail(result); setDetailError(""); finished = !["queued", "running"].includes(result.status); }
      } catch (failure) { if (!controller.signal.aborted) setDetailError(failure instanceof Error ? failure.message : "读取作业失败"); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected, resultOffset, section, revision]);
  async function control(job: TaskJob, action: "retry" | "cancel") {
    setBusy(job.id); setError("");
    try { await api(`/jobs/${job.kind}/${job.id}/${action}`, { method: "POST" }); setRevision((value) => value + 1); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(""); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8" data-testid="processing-center">
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-medium">处理与核对</h1><Button variant="outline" size="sm" onClick={onSettings}>处理设置</Button></div>
      {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="jobs">后台作业</TabsTrigger><TabsTrigger value="review">待核对</TabsTrigger><TabsTrigger value="capabilities">能力状态</TabsTrigger></TabsList>
        <TabsContent value="jobs" className="flex flex-col gap-4">
          <div className="flex justify-between gap-3 pt-2"><Select value={status} onValueChange={(value) => { setStatus(value); setOffset(0); setPage(undefined); }}>
            <SelectTrigger aria-label="作业状态"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部状态</SelectItem>
              {Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectGroup></SelectContent></Select><Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>刷新</Button></div>
          {!page ? <Skeleton className="h-48 w-full" /> : !page.jobs.length ? <p className="py-12 text-sm text-muted-foreground">暂无作业</p> : <Table>
            <TableHeader><TableRow><TableHead>作业</TableHead><TableHead>状态</TableHead><TableHead>进度</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>{page.jobs.map((job) => <TableRow key={job.kind + job.id} data-testid="processing-job">
              <TableCell className="max-w-72"><Button variant="link" className="max-w-full px-0" onClick={() => { setSelected(job); setResultOffset(0); setSection("entries"); }}><span className="truncate">{job.title}</span></Button>
                <p className="text-xs text-muted-foreground">{job.ownership === "task" ? "任务作业" : "资料库作业"}</p></TableCell>
              <TableCell><Badge variant="outline">{job.status === "queued" && job.blockedReason ? "等待配置" : labels[job.status]}</Badge>{job.blockedReason && <p className="mt-1 max-w-56 text-xs text-muted-foreground">{job.blockedReason}</p>}</TableCell>
              <TableCell>{job.progress.completed} / {job.progress.total}{job.progress.failed > 0 && <p className="text-xs text-muted-foreground">失败 {job.progress.failed}</p>}</TableCell>
              <TableCell><div className="flex gap-1">{["queued", "running"].includes(job.status) && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void control(job, "cancel")}>取消</Button>}
                {(job.actions?.includes("retry") || ["failed", "cancelled"].includes(job.status)) && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void control(job, "retry")}>{job.status === "completed" ? "重建" : "重试"}</Button>}</div></TableCell>
            </TableRow>)}</TableBody>
          </Table>}
          <div className="flex items-center gap-2"><span className="mr-auto text-xs text-muted-foreground">最近作业{page ? ` · ${page.total}` : ""}</span>
            {offset > 0 && <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - 40))}>上一页</Button>}
            {page?.nextOffset != null && <Button variant="outline" size="sm" onClick={() => setOffset(page.nextOffset!)}>下一页</Button>}</div>
        </TabsContent>
        <TabsContent value="review"><ReviewQueue onMemory={onMemory} onDatasets={onDatasets} /></TabsContent>
        <TabsContent value="capabilities">{!capabilities ? <Skeleton className="h-48 w-full" /> : <Table>
          <TableHeader><TableRow><TableHead>能力</TableHead><TableHead>状态</TableHead><TableHead>验证</TableHead></TableRow></TableHeader>
          <TableBody>{capabilities.capabilities.map((capability) => <TableRow key={capability.id}>
            <TableCell>{capability.label}</TableCell>
            <TableCell><Badge variant="outline">{!capability.implemented ? "未接入" : !capability.configured ? "未配置" : capability.available ? "可用" : "暂不可用"}</Badge></TableCell>
            <TableCell className="text-xs text-muted-foreground">{capability.verification === "protocol-tested" ? "流程已验证" : capability.verification === "quality-evaluated" ? "质量已评测" : "效果未验证"}</TableCell>
          </TableRow>)}</TableBody></Table>}</TabsContent>
      </Tabs>
    </div>
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(undefined); }}><DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{selected?.title || "作业结果"}</DialogTitle></DialogHeader>
      {selected?.kind === "memory-import" && <Tabs value={section} onValueChange={(value) => { setSection(value); setResultOffset(0); }}>
        <TabsList><TabsTrigger value="entries">观察记录</TabsTrigger><TabsTrigger value="assets">原件处理</TabsTrigger></TabsList>
      </Tabs>}
      {detailError ? <Alert><AlertTitle>{detailError}</AlertTitle></Alert> : !detail ? <Skeleton className="h-32 w-full" /> : <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3"><Badge variant="outline">{labels[detail.status]}</Badge><span className="text-sm">{detail.progress.completed} / {detail.progress.total}</span></div>
        {(detail.blockedReason || detail.result.error) && <Alert><AlertTitle>{detail.blockedReason || detail.result.error}</AlertTitle></Alert>}
        {["memory-dataset", "dataset-audit"].includes(detail.kind) && <Button onClick={() => { setSelected(undefined); onDatasets(); }}>查看数据集与样本</Button>}
        {detail.result.audit && <DatasetAuditSummary audit={detail.result.audit} />}
        {detail.result.decisions && <DatasetAuditDecisions decisions={detail.result.decisions} />}
        {detail.result.assetId && <Button variant="outline" onClick={() => { setSelected(undefined); onAsset(detail.result.assetId!); }}>查看原件</Button>}
        {detail.result.video && <div className="flex flex-wrap gap-2"><Badge variant="outline">时长 {videoTime(detail.result.video.duration)}</Badge>
          <Badge variant="outline">间隔 {Number(detail.result.sampleInterval?.toFixed(3))} 秒</Badge><Badge variant="outline">抽样画面 {detail.result.completed} / {detail.result.total}</Badge></div>}
        {detail.result.frames && detail.result.assetId && detail.result.sourceHash && <VideoIndexFrames frames={detail.result.frames} assetId={detail.result.assetId}
          version={detail.result.sourceHash} name={detail.title.replace(/^索引原件 · /, "")} onMemory={(id) => { setSelected(undefined); onMemory(id); }} />}
        {detail.result.entries?.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3"><span className="text-sm">{entry.title}</span><Button size="sm" variant="outline" onClick={() => { setSelected(undefined); onMemory(entry.id); }}>查看记录</Button></div>)}
        {detail.result.activities?.map((activity) => <div key={activity.id} className="flex items-center justify-between gap-3"><span className="text-sm">{activity.title}</span><Button size="sm" variant="outline" onClick={() => { setSelected(undefined); onActivity(activity.id); }}>核对活动</Button></div>)}
        {!!detail.result.assets?.length && <ProcessingAssets assets={detail.result.assets} onAsset={(id) => { setSelected(undefined); onAsset(id); }} />}
        {detail.result.failures?.map((failure, index) => <p key={index} className="text-sm text-muted-foreground">{failure.error}</p>)}
        <div className="flex gap-2">{resultOffset > 0 && <Button size="sm" variant="ghost" onClick={() => setResultOffset(0)}>回到首批</Button>}
          {(section === "assets" ? detail.result.nextAssetOffset : detail.result.nextOffset) != null && detail.kind !== "memory-dataset" && <Button size="sm" variant="outline" onClick={() => setResultOffset((section === "assets" ? detail.result.nextAssetOffset : detail.result.nextOffset)!)}>继续查看结果</Button>}
          <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>刷新结果</Button></div>
      </div>}
    </DialogContent></Dialog>
  </div>;
}

function ReviewQueue({ onMemory, onDatasets }: { onMemory: (id: string) => void; onDatasets: () => void }) {
  const [overview, setOverview] = useState<MemoryOverview>(), [datasets, setDatasets] = useState<MemoryDataset[]>([]), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      const [memories, samples] = await Promise.allSettled([api<MemoryOverview>("/memory-overview?view=draft&space=personal&limit=50", { signal: controller.signal }),
        api<{ datasets: MemoryDataset[] }>("/memory-datasets", { signal: controller.signal })]);
      pending = false; if (controller.signal.aborted) return;
      setError("");
      if (memories.status === "fulfilled") setOverview(memories.value); else setError("待核对记录读取失败");
      if (samples.status === "fulfilled") setDatasets(samples.value.datasets); else setError("数据集读取失败");
    };
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  return <div className="flex flex-col gap-4 pt-3">
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <div className="flex items-center justify-between gap-3"><span className="text-sm">待核对记录 · {overview?.counts?.draft ?? "—"}</span>
      <Button variant="outline" size="sm" onClick={onDatasets}>数据集待审 · {datasets.reduce((sum, dataset) => sum + dataset.counts.review, 0)}</Button></div>
    {!overview ? <Skeleton className="h-40 w-full" /> : !overview.memories.length ? <p className="py-10 text-sm text-muted-foreground">暂无待核对记录</p> : <Table>
      <TableHeader><TableRow><TableHead>记录</TableHead><TableHead>依据</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
      <TableBody>{overview.memories.map((memory) => <TableRow key={memory.id}><TableCell>{memory.title}<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{memory.content}</p></TableCell>
        <TableCell>{memory.kind === "observation" ? "素材观察" : memory.kind === "inference" ? "模型推断" : "陈述"}</TableCell>
        <TableCell><Button variant="outline" size="sm" onClick={() => onMemory(memory.id)}>核对</Button></TableCell></TableRow>)}</TableBody>
    </Table>}
    {overview?.pagination?.nextCursor && <p className="text-xs text-muted-foreground">显示 {overview.memories.length} / {overview.counts?.draft}</p>}
  </div>;
}
