"use client";
import { useEffect, useState } from "react";
import type { DatasetSampleSelection, MemoryDataset, MemorySettings, ModelInfo, TrainingSample } from "@memory/contracts";
import { Database, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { api, downloadFile } from "@/lib/api";
import { auditActive, DatasetAuditControls } from "./dataset-audit";

const statuses = { queued: "排队中", running: "构建中", completed: "已构建", failed: "未完成", cancelled: "已取消", skipped: "已跳过" };
export function MemoryDatasetsButton({ memoryIds, models, onOpen }: { memoryIds: string[]; models: ModelInfo[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" variant="outline" onClick={() => setOpen(true)}><Database />数据集</Button>
    {open && <DatasetList memoryIds={memoryIds} models={models} onClose={() => setOpen(false)} onOpen={(id) => { setOpen(false); onOpen(id); }} />}</>;
}
export function MemoryDatasetsPage({ models, onOpen }: { models: ModelInfo[]; onOpen: (id: string) => void }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10"><div className="mx-auto max-w-5xl"><DatasetList memoryIds={[]} models={models} onOpen={onOpen} page /></div></div>;
}
function DatasetList({ memoryIds, models, onClose, onOpen, page = false }: { memoryIds: string[]; models: ModelInfo[]; onClose?: () => void; onOpen: (id: string) => void; page?: boolean }) {
  const [datasets, setDatasets] = useState<MemoryDataset[]>(), [revision, setRevision] = useState(0);
  const [title, setTitle] = useState(""), [format, setFormat] = useState<MemoryDataset["format"]>("mixed");
  const [generator, setGenerator] = useState("template");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ settings: MemorySettings }>("/processing-policy", { signal: controller.signal }).then(({ settings }) => {
      if (!controller.signal.aborted && settings.datasetModelId && models.some((model) => model.id === settings.datasetModelId)) setGenerator(settings.datasetModelId);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); let running = false;
    const load = async () => {
      if (running) return; running = true;
      try { const result = await api<{ datasets: MemoryDataset[] }>("/memory-datasets", { signal: controller.signal }); if (!controller.signal.aborted) setDatasets(result.datasets); }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { running = false; }
    };
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [revision]);
  async function action(path: string, body?: unknown) {
    setBusy(true); setError("");
    try { await api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }); setRevision((value) => value + 1); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function rebuild(job: MemoryDataset) {
    setBusy(true); setError("");
    try {
      const result = await api<{ dataset: MemoryDataset }>(`/memory-datasets/${job.id}/rebuild`, {
        method: "POST", body: JSON.stringify({ revision: job.revision, requestKey: crypto.randomUUID() }),
      });
      setSelected(result.dataset.id); setRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "重建未完成"); }
    finally { setBusy(false); }
  }
  const content = <>
    {page ? <h1 className="text-2xl font-medium">数据集</h1> : <DialogHeader><DialogTitle>数据集</DialogTitle><DialogDescription className="sr-only">数据集列表</DialogDescription></DialogHeader>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <FieldGroup className="grid sm:grid-cols-2">
      <Field><FieldLabel htmlFor="dataset-title">名称</FieldLabel><Input id="dataset-title" value={title} maxLength={120} placeholder="个人记忆数据集" onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="dataset-generator">样本生成</FieldLabel><Select value={generator} onValueChange={setGenerator} disabled={busy}>
        <SelectTrigger id="dataset-generator"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
          <SelectItem value="template">固定模板</SelectItem>
          {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select></Field>
      {generator === "template" && <Field><FieldLabel>样本形式</FieldLabel><Select value={format} onValueChange={(value) => setFormat(value as MemoryDataset["format"])}>
        <SelectTrigger aria-label="样本形式"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="mixed">问答与叙述</SelectItem><SelectItem value="qa">问答</SelectItem><SelectItem value="narrative">叙述</SelectItem></SelectGroup></SelectContent>
      </Select></Field>}
      <Field><FieldLabel>构建范围</FieldLabel><Button disabled={busy} onClick={() => void action("/memory-datasets", {
        requestKey: crypto.randomUUID(), ...(title.trim() ? { title: title.trim() } : {}),
        format: generator === "template" ? format : "qa", ...(generator === "template" ? {} : { modelId: generator }), scope: memoryIds.length ? { memoryIds } : {},
      })}>{memoryIds.length ? `从所选 ${memoryIds.length} 条构建` : "从全部确认记录构建"}</Button></Field>
    </FieldGroup>
    {!datasets ? <Skeleton className="h-32 w-full" /> : !datasets.length ? <Empty><EmptyHeader><EmptyTitle>暂无数据集</EmptyTitle></EmptyHeader></Empty> : <Table>
      <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>状态</TableHead><TableHead>已处理</TableHead><TableHead>待审 / 排除</TableHead><TableHead>样本</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
      <TableBody>{datasets.map((job) => <TableRow key={job.id} data-testid="dataset-row">
        <TableCell><Button variant="link" className="px-0" onClick={() => setSelected(job.id)}>{job.title}</Button>{job.rebuild && <div className="flex flex-wrap gap-2"><Badge variant="outline">重建版本</Badge><Badge variant="outline">沿用 {job.rebuild.reusedSamples} 条样本</Badge></div>}</TableCell>
        <TableCell><Badge variant="outline">{job.stale ? "依赖已变更" : auditActive(job.audit) ? "核验中" : statuses[job.status]}</Badge>{job.error && <p className="mt-1 max-w-52 text-xs text-muted-foreground">{job.error}</p>}</TableCell>
        <TableCell>{job.counts.processed} / {job.counts.total}{job.usage && <p className="text-xs text-muted-foreground">{job.usage.calls} 次调用</p>}</TableCell><TableCell>{job.counts.review} / {job.counts.excluded}</TableCell><TableCell>{job.counts.samples}</TableCell>
        <TableCell><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setSelected(job.id)}>查看样本</Button>
          {["queued", "running"].includes(job.status) && !auditActive(job.audit) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(`/memory-datasets/${job.id}/cancel`)}>取消</Button>}
          {["failed", "cancelled"].includes(job.status) && !job.stale && !auditActive(job.audit) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(`/memory-datasets/${job.id}/retry`)}>重试</Button>}
          {(job.stale || ["completed", "failed", "cancelled"].includes(job.status)) && <Button size="sm" variant="ghost" disabled={busy || auditActive(job.audit)} onClick={() => void rebuild(job)}>重新构建</Button>}
        </div></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    {datasets?.length === 30 && <p className="text-xs text-muted-foreground">最近 30 个数据集</p>}
    {!page && <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>}
    {selected && <DatasetSamples key={selected} id={selected} models={models} onClose={() => setSelected(undefined)} onOpen={onOpen} onChanged={() => setRevision((value) => value + 1)} onRebuild={rebuild} rebuilding={busy} rebuildError={error} onPrevious={setSelected} />}
  </>;
  return page ? <div className="flex flex-col gap-6" data-testid="dataset-page">{content}</div> : <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose?.(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">{content}</DialogContent></Dialog>;
}
function DatasetSamples({ id, models, onClose, onOpen, onChanged, onRebuild, onPrevious, rebuilding, rebuildError }: { id: string; models: ModelInfo[]; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void; onRebuild: (job: MemoryDataset) => Promise<void>; onPrevious: (id: string) => void; rebuilding: boolean; rebuildError: string }) {
  const [data, setData] = useState<{ dataset: MemoryDataset; samples: TrainingSample[]; trainingSamples: TrainingSample[]; matchingSamples: number; nextCursor: string | null }>();
  const [cursor, setCursor] = useState(""), [revision, setRevision] = useState(0), [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<NonNullable<DatasetSampleSelection["view"]>>("all");
  const [sampleIds, setSampleIds] = useState<string[]>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ id: string; version: number; question: string; answer: string; reason: string; trainingId: string }>();
  const pairedTraining = (sample: TrainingSample) => data?.trainingSamples.find((training) => training.id === sample.evaluationOf?.id);
  const trainingChoices = (sample: TrainingSample) => data?.trainingSamples.filter((training) => !training.stale && training.status !== "excluded" &&
    training.memoryRefs.length === sample.memoryRefs.length && training.memoryRefs.every((ref) => sample.memoryRefs.some((source) => source.id === ref.id && source.version === ref.version))) || [];
  async function download(kind: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await downloadFile(`/memory-datasets/${id}/files/${kind}`, kind + (kind === "manifest" ? ".json" : ".jsonl"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "下载失败"); }
    finally { setBusy(false); }
  }
  async function editSample(action: "revise" | "exclude" | "defer") {
    if (!editing) return;
    setBusy(true); setError("");
    try {
      const training = data?.trainingSamples.find((sample) => sample.id === editing.trainingId);
      await api(`/memory-datasets/${id}/review`, { method: "POST", body: JSON.stringify({ requestKey: crypto.randomUUID(), reason: editing.reason,
        samples: [{ id: editing.id, version: editing.version, action, reason: editing.reason, ...(action === "revise" ? { question: editing.question, answer: editing.answer,
          ...(training ? { evaluationOf: { id: training.id, version: training.version } } : {}),
        } : {}) }] }) });
      setEditing(undefined); setRevision((value) => value + 1); onChanged();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "修订失败"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setSelected([]); setError("");
    const query = new URLSearchParams();
    if (cursor) query.set("after", cursor);
    if (view !== "all") query.set("view", view);
    for (const sampleId of sampleIds || []) query.append("sampleIds", sampleId);
    void api<NonNullable<typeof data>>(`/memory-datasets/${id}/samples${query.size ? "?" + query.toString() : ""}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [id, cursor, revision, view, sampleIds]);
  useEffect(() => {
    if (!data || (!["queued", "running"].includes(data.dataset.status) && !auditActive(data.dataset.audit))) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [data]);
  const ready = data?.dataset.status === "completed" && !data.dataset.stale && !auditActive(data.dataset.audit);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !rebuilding) onClose(); }}><DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
    <DialogHeader><DialogTitle>{data?.dataset.title || "样本"}</DialogTitle><div className="flex flex-wrap gap-2"><Badge variant="outline">{data?.dataset.counts.samples ?? "—"} 条样本</Badge>{data && <Badge variant="outline">{data.dataset.stale ? "依赖已变更" : statuses[data.dataset.status]}</Badge>}</div></DialogHeader>
    {data?.dataset.rebuild && <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy || rebuilding} onClick={() => onPrevious(data.dataset.rebuild!.datasetId)}>上一版本</Button>
      <Badge variant="outline">新增 {data.dataset.rebuild.addedMemories} 条记忆</Badge><Badge variant="outline">更新 {data.dataset.rebuild.updatedMemories} 条记忆</Badge>
      <Badge variant="outline">移除 {data.dataset.rebuild.removedMemories} 条记忆</Badge><Badge variant="outline">沿用 {data.dataset.rebuild.reusedSamples} 条样本</Badge>
    </div>}
    {data?.dataset.stale && <Button variant="outline" disabled={busy || rebuilding} onClick={() => void onRebuild(data.dataset)}>重新构建</Button>}
    {rebuildError && <Alert><AlertTitle>{rebuildError}</AlertTitle></Alert>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    {data && <DatasetAuditControls dataset={data.dataset} models={models} disabled={busy || rebuilding || !!editing} onChanged={() => { setRevision((value) => value + 1); onChanged(); }} onInspect={(sampleId) => {
      setSampleIds([sampleId]); setView("all"); setCursor(""); setSelected([]); setEditing(undefined);
    }} />}
    <div className="flex flex-wrap gap-2">{(["training", ...(data?.dataset.generation ? ["evaluation"] : []), "review", "manifest"] as const).map((kind) => <Button key={kind} size="sm" variant="outline" disabled={!ready || busy} asChild={!!ready}>
      {ready ? <a href={`/api/memory-datasets/${id}/files/${kind}`} aria-disabled={busy} download onClick={(event) => { event.preventDefault(); void download(kind); }}><Download />{kind === "training" ? "训练样本" : kind === "evaluation" ? "评测题" : kind === "review" ? "待审样本" : "版本清单"}</a> : <span>{kind === "training" ? "训练样本" : kind === "evaluation" ? "评测题" : kind === "review" ? "待审样本" : "版本清单"}</span>}
    </Button>)}</div>
    <Field><div className="flex flex-wrap items-center gap-2"><FieldLabel id="dataset-sample-status">样本状态</FieldLabel>
      <Badge variant="outline">匹配 {busy ? "—" : data?.matchingSamples ?? "—"} 条</Badge>
      {sampleIds && <Button size="sm" variant="ghost" disabled={busy || !!editing} onClick={() => { setSampleIds(undefined); setCursor(""); }}>全部样本</Button>}</div>
      <ToggleGroup type="single" variant="outline" value={view} disabled={busy || !!editing} aria-labelledby="dataset-sample-status" onValueChange={(value) => {
        if (value) { setView(value as typeof view); setSampleIds(undefined); setCursor(""); setSelected([]); }
      }}>
        <ToggleGroupItem value="all">全部</ToggleGroupItem><ToggleGroupItem value="review">待核对</ToggleGroupItem>
        <ToggleGroupItem value="ready">可导出</ToggleGroupItem><ToggleGroupItem value="excluded">已排除</ToggleGroupItem>
      </ToggleGroup>
    </Field>
    {!data ? <Skeleton className="h-32 w-full" /> : !data.samples.length ? <Empty><EmptyHeader><EmptyTitle>{view === "review" ? "暂无待核对样本" : view === "ready" ? "暂无可导出样本" : view === "excluded" ? "暂无已排除样本" : "暂无样本"}</EmptyTitle></EmptyHeader></Empty> : <Accordion type="multiple">{data.samples.map((sample) => <AccordionItem key={sample.id} value={sample.id}>
      <div className="flex items-center gap-3"><Checkbox aria-label={`选择样本 ${sample.id.slice(0, 6)}`} disabled={!ready || sample.status !== "review" || busy} checked={selected.includes(sample.id)}
        onCheckedChange={(checked) => setSelected(checked ? [...selected, sample.id] : selected.filter((value) => value !== sample.id))} />
        <AccordionTrigger className="min-w-0 flex-1"><span className="flex min-w-0 flex-1 flex-col gap-2"><span className="break-words">{sample.question}</span><span className="flex flex-wrap gap-2"><Badge variant="outline">{sample.intendedUse === "evaluation" ? "评测" : "训练"}</Badge><Badge variant="outline">{sample.stale ? "已过期" : sample.quality?.issues.some((issue) => issue.severity === "blocking") ? "需修订" : sample.status === "ready" ? "可导出" : sample.status === "excluded" ? "已排除" : "待核对"}</Badge>{sample.reusedFrom && <Badge variant="outline">沿用</Badge>}{sample.review?.actor === "agent" && <Badge variant="outline">{sample.status === "ready" ? "Agent 已核对" : sample.status === "excluded" ? "Agent 已排除" : "Agent 留待核对"}</Badge>}{sample.review?.actor === "processor" && <Badge variant="outline">模型审阅</Badge>}</span></span></AccordionTrigger></div>
      <AccordionContent><div className="flex flex-col gap-3"><p className="whitespace-pre-wrap text-sm">{sample.answer}</p>
        {sample.review?.reason && <Field><FieldLabel>核对依据</FieldLabel><p className="whitespace-pre-wrap">{sample.review.reason}</p></Field>}
        {sample.answerCheck && <FieldGroup data-testid="sample-answer-check">
          <Field><FieldTitle>来源作答</FieldTitle><p className="break-words whitespace-pre-wrap">{sample.answerCheck.answerQuote}</p>
            <FieldDescription>{sample.answerCheck.reason}</FieldDescription></Field>
          <Field><FieldTitle>原文片段</FieldTitle>{sample.answerCheck.evidenceQuotes.map((quote, index) =>
            <p key={index} className="break-words whitespace-pre-wrap">{quote}</p>)}</Field>
        </FieldGroup>}
        {sample.intendedUse === "evaluation" && pairedTraining(sample) && <FieldGroup>
          <Field><FieldLabel>关联训练题 · v{pairedTraining(sample)!.version}</FieldLabel><p className="whitespace-pre-wrap">{pairedTraining(sample)!.question}</p></Field>
          <Field><FieldLabel>训练答案</FieldLabel><p className="whitespace-pre-wrap">{pairedTraining(sample)!.answer}</p></Field>
        </FieldGroup>}
        {sample.quality?.issues.map((issue, index) => <Alert key={index}><AlertTitle>{issue.message}</AlertTitle></Alert>)}
        <div className="flex flex-wrap gap-2">{sample.memoryRefs.map((ref) =>
          <Button key={ref.id} size="sm" variant="outline" onClick={() => onOpen(ref.id)}>来源记录 · v{ref.version}</Button>)}
          <Button size="sm" variant="outline" disabled={!ready || busy} onClick={() => setEditing({ id: sample.id, version: sample.version, question: sample.question, answer: sample.answer, reason: "", trainingId: sample.evaluationOf?.id || "" })}>修订样本</Button>
        </div>
        {editing?.id === sample.id && <FieldGroup>
          {sample.intendedUse === "evaluation" && <Field><FieldLabel htmlFor={`training-${sample.id}`}>关联训练题</FieldLabel>
            <Select value={editing.trainingId} onValueChange={(trainingId) => setEditing({ ...editing, trainingId })}><SelectTrigger id={`training-${sample.id}`} className="w-full [&_[data-slot=select-value]]:truncate"><SelectValue placeholder="选择训练题" /></SelectTrigger>
              <SelectContent><SelectGroup>{trainingChoices(sample).map((training) => <SelectItem key={training.id} value={training.id}>{training.question}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>}
          <Field><FieldLabel htmlFor={`question-${sample.id}`}>问题</FieldLabel><Input id={`question-${sample.id}`} value={editing.question} maxLength={300} onChange={(event) => setEditing({ ...editing, question: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor={`answer-${sample.id}`}>答案</FieldLabel><Textarea id={`answer-${sample.id}`} value={editing.answer} maxLength={24000} onChange={(event) => setEditing({ ...editing, answer: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor={`reason-${sample.id}`}>修订依据</FieldLabel><Textarea id={`reason-${sample.id}`} value={editing.reason} maxLength={500} onChange={(event) => setEditing({ ...editing, reason: event.target.value })} /></Field>
          <div className="flex flex-wrap gap-2"><Button disabled={!ready || busy || !editing.reason.trim() || !editing.question.trim() || !editing.answer.trim() || (sample.intendedUse === "evaluation" && !editing.trainingId)} onClick={() => void editSample("revise")}>保存修订</Button>
            <Button variant="outline" disabled={!ready || busy || !editing.reason.trim()} onClick={() => void editSample("defer")}>保留待核对</Button>
            <Button variant="outline" disabled={!ready || busy || !editing.reason.trim()} onClick={() => void editSample("exclude")}>排除此样本</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(undefined)}>取消修订</Button></div>
        </FieldGroup>}
      </div></AccordionContent>
    </AccordionItem>)}</Accordion>}
    {selected.length > 0 && <><Field><FieldLabel htmlFor="sample-review-reason">核对依据</FieldLabel><Textarea id="sample-review-reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
      <Button disabled={busy || !reason.trim() || !ready} onClick={async () => {
        setBusy(true); setError("");
        try { await api(`/memory-datasets/${id}/review`, { method: "POST", body: JSON.stringify({ reason,
          samples: data!.samples.filter((sample) => selected.includes(sample.id)).map(({ id, version }) => ({ id, version })) }) });
          setSelected([]); setReason(""); setRevision((value) => value + 1); onChanged(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "核对失败"); }
        finally { setBusy(false); }
      }}>确认所选样本</Button></>}
    <DialogFooter>{cursor && <Button variant="ghost" disabled={busy} onClick={() => setCursor("")}>回到首批</Button>}
      {data?.nextCursor && <Button variant="outline" disabled={busy} onClick={() => setCursor(data.nextCursor!)}>下一批样本</Button>}
      <Button variant="ghost" disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新</Button><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>
  </DialogContent></Dialog>;
}
