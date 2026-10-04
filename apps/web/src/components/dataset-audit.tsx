"use client";

import { useEffect, useState } from "react";
import type { DatasetAuditDecision, DatasetAuditJob, MemoryDataset, MemorySettings, ModelInfo } from "@memory/contracts";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";

export const auditActive = (audit?: DatasetAuditJob) => !!audit && ["queued", "running"].includes(audit.status);
const statusLabels = { queued: "核验排队中", running: "核验中", completed: "已核验", failed: "核验未完成", cancelled: "核验已取消" };
const actionLabels = { approve: "认可", revise: "修订", exclude: "排除", defer: "待核对" };
const actorLabels = { user: "用户", agent: "Agent", processor: "模型" };

export function DatasetAuditSummary({ audit }: { audit: DatasetAuditJob }) {
  return <div className="flex min-w-0 flex-col gap-3" data-testid="dataset-audit-summary" data-audit-status={audit.status}>
    <div className="flex flex-wrap gap-2" role="status" aria-live="polite">
      <Badge variant="outline">{statusLabels[audit.status]}</Badge><Badge variant="outline">模型审阅</Badge>
      <span className="text-sm">{audit.counts.processed} / {audit.counts.total}</span>
    </div>
    <Progress aria-label="样本核验进度" value={audit.counts.total ? audit.counts.processed / audit.counts.total * 100 : 0} />
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">认可 {audit.counts.approved}</Badge><Badge variant="outline">修订 {audit.counts.revised}</Badge>
      <Badge variant="outline">排除 {audit.counts.excluded}</Badge><Badge variant="outline">待核对 {audit.counts.deferred}</Badge>
      {!!audit.counts.failed && <Badge variant="outline">失败 {audit.counts.failed}</Badge>}
      {!!audit.counts.retained && <Badge variant="outline">沿用 {audit.counts.retained}</Badge>}
      {!!audit.counts.unsupported && <Badge variant="outline">需单独核对 {audit.counts.unsupported}</Badge>}
    </div>
    {audit.error && <Alert><AlertTitle>{audit.error}</AlertTitle></Alert>}
  </div>;
}

export function DatasetAuditDecisions({ decisions, onInspect }: { decisions: DatasetAuditDecision[]; onInspect?: (sampleId: string) => void }) {
  if (!decisions.length) return null;
  return <Table data-testid="dataset-audit-decisions"><TableHeader className="hidden sm:table-header-group"><TableRow><TableHead>问题</TableHead><TableHead>决定</TableHead><TableHead>依据</TableHead></TableRow></TableHeader>
    <TableBody>{decisions.map((decision) => <TableRow key={decision.id} className="flex flex-col sm:table-row">
      <TableCell className="min-w-0 whitespace-normal sm:min-w-48 sm:max-w-72">{onInspect ? <Button variant="link" className="h-auto p-0 text-left whitespace-normal" onClick={() => onInspect(decision.id)}>{decision.question}</Button> : decision.question}</TableCell>
      <TableCell><div className="flex flex-wrap items-start gap-2 sm:flex-col"><Badge variant="outline">{decision.status === "failed" ? "未提交" : actionLabels[decision.action]}</Badge>
        {decision.followUp && <Badge variant="outline">{decision.followUp.status === "excluded" ? "已排除" : decision.followUp.status === "review" ? "待核对" : "已核对"} · v{decision.followUp.version} · {actorLabels[decision.followUp.actor]}</Badge>}
      </div></TableCell>
      <TableCell className="min-w-0 whitespace-normal sm:min-w-48 sm:max-w-96"><div className="flex flex-col gap-3">
        <span>{decision.error || decision.reason}</span>
        {decision.followUp && <Field><FieldLabel>后续依据 · v{decision.followUp.version}</FieldLabel><span>{decision.followUp.reason}</span></Field>}
      </div></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

export function DatasetAuditControls({ dataset, models, disabled, onChanged, onInspect }: {
  dataset: MemoryDataset; models: ModelInfo[]; disabled: boolean; onChanged: () => void; onInspect?: (sampleId: string) => void;
}) {
  const [modelId, setModelId] = useState(models.find((model) => model.id === dataset.generation?.modelId)?.id || models[0]?.id || "");
  const [mode, setMode] = useState<DatasetAuditJob["mode"]>("pending");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [showDecisions, setShowDecisions] = useState(false), [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ decisions: DatasetAuditDecision[]; nextOffset: number | null }>();
  const audit = dataset.audit, running = auditActive(audit);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ settings: MemorySettings }>("/processing-policy", { signal: controller.signal }).then(({ settings }) => {
      if (!controller.signal.aborted && settings.datasetReviewModelId && models.some((model) => model.id === settings.datasetReviewModelId)) setModelId(settings.datasetReviewModelId);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!audit || !showDecisions) return;
    const controller = new AbortController();
    void api<NonNullable<typeof result>>(`/dataset-audits/${audit.id}?after=${offset}`, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setResult(response); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "核验记录读取失败"); });
    return () => controller.abort();
  }, [audit?.id, audit?.revision, dataset.revision, showDecisions, offset]);
  async function submit(action?: "retry" | "cancel") {
    setBusy(true); setError("");
    try {
      await api(action ? `/dataset-audits/${audit!.id}/${action}` : `/memory-datasets/${dataset.id}/audits`, {
        method: "POST", ...(!action ? { body: JSON.stringify({ revision: dataset.revision, requestKey: crypto.randomUUID(), modelId, mode }) } : {}),
      });
      setOffset(0); setResult(undefined); onChanged();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "核验未提交"); }
    finally { setBusy(false); }
  }
  const canSubmit = dataset.status === "completed" && !dataset.stale && !running && !!modelId;
  return <div className="flex min-w-0 flex-col gap-4" data-testid="dataset-audit-controls">
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <FieldGroup className="grid sm:grid-cols-2">
      <Field><FieldLabel htmlFor="dataset-audit-model">核验模型</FieldLabel>
        <Select value={modelId} onValueChange={setModelId} disabled={busy || running || disabled}><SelectTrigger id="dataset-audit-model"><SelectValue placeholder="选择模型" /></SelectTrigger>
          <SelectContent><SelectGroup>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field><FieldLabel id="dataset-audit-scope">核验范围</FieldLabel>
        <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(value) => { if (value) setMode(value as DatasetAuditJob["mode"]); }} disabled={busy || running || disabled} aria-labelledby="dataset-audit-scope">
          <ToggleGroupItem value="pending">待核对问答</ToggleGroupItem><ToggleGroupItem value="all">全部问答</ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </FieldGroup>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={!canSubmit || busy || disabled || (mode === "pending" && !dataset.sampleCounts?.review)} onClick={() => void submit()}>批量核验</Button>
      {running && <Button variant="outline" disabled={busy} onClick={() => void submit("cancel")}>取消核验</Button>}
      {audit && ["failed", "cancelled"].includes(audit.status) && !dataset.stale && <Button variant="outline" disabled={busy || disabled} onClick={() => void submit("retry")}>重试未完成核验</Button>}
      {audit && <Button variant="ghost" onClick={() => setShowDecisions((value) => !value)}>{showDecisions ? "收起核验记录" : "查看核验记录"}</Button>}
    </div>
    {audit && <DatasetAuditSummary audit={audit} />}
    {showDecisions && result && <><DatasetAuditDecisions decisions={result.decisions} onInspect={disabled ? undefined : onInspect} /><div className="flex flex-wrap gap-2">
      {!!offset && <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>回到首批</Button>}
      {result.nextOffset != null && <Button size="sm" variant="outline" onClick={() => setOffset(result.nextOffset!)}>继续查看核验记录</Button>}
    </div></>}
  </div>;
}
