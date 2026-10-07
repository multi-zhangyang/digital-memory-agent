"use client";

import { useEffect, useState } from "react";
import type { ActivityChange, Asset, MemoryActivity, MemoryActivityDetail, Run } from "@memory/contracts";
import { ArrowUpRight, CalendarDays, Check, GitMerge, History, MapPin, MessageSquare, Plus, RefreshCw, Scissors, Search, Users } from "lucide-react";
import { api, assetUrl } from "@/lib/api";
import type { InspectorTarget } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent, EmptyDescription } from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Artifact, ArtifactHeader, ArtifactTitle, ArtifactContent, ArtifactActions, ArtifactClose } from "@/components/ai-elements/artifact";
import { Sources, SourcesTrigger, SourcesContent, Source } from "@/components/ai-elements/sources";

const label = (activity: MemoryActivity) => activity.stale ? "依据已更新" : ({ candidate: "待核对", confirmed: "已确认", rejected: "已排除", superseded: "已重新整理" }[activity.status]);
type Inspect = (target: InspectorTarget) => void;
type ActivityPage = { activities: MemoryActivity[]; total: number; nextOffset?: number | null };
const changed = () => window.dispatchEvent(new Event("memory-activities-changed"));

function ActivityCard({ activity, assets, onInspect, checked, onChecked }: { activity: MemoryActivity; assets: Asset[]; onInspect: Inspect; checked?: boolean; onChecked?: (checked: boolean) => void }) {
  const assetIds = [...new Set(activity.sources.flatMap((s) => s.type === "asset" ? [s.assetId] : []))];
  const images = assetIds.flatMap((id) => { const asset = assets.find((a) => a.id === id); return asset?.kind === "image" ? [asset] : []; }).slice(0, 3);
  return <Card className="gap-0 overflow-hidden py-0" data-testid="memory-activity-card" data-activity-id={activity.id}>
    {images.length > 0 && <CardContent className="grid auto-cols-fr grid-flow-col gap-1 p-0">
      {images.map((asset) => <Button variant="ghost" type="button" key={asset.id} onClick={() => onInspect({ tab: "assets", id: asset.id })} aria-label={`查看 ${asset.name}`} className="h-40 overflow-hidden rounded-none p-0">
        <img src={assetUrl(asset.id)} alt={asset.name} loading="lazy" className="size-full object-cover" />
      </Button>)}
    </CardContent>}
    <CardHeader className="px-5 pt-5">
      <div className="flex items-start gap-3">
        {onChecked && <Checkbox checked={checked} onCheckedChange={(value) => onChecked(value === true)} aria-label={`选择活动 ${activity.title}`} />}
        <CardTitle className="min-w-0 flex-1 leading-6">{activity.title}</CardTitle>
      </div>
      <CardDescription>{activity.occurredAt || "时间待核对"}{activity.place ? ` · ${activity.place}` : ""}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-1 flex-col gap-3 px-5 py-3">
      {activity.summary && <p className="line-clamp-3 text-sm leading-6">{activity.summary}</p>}
      {activity.issues.length > 0 && <p className="text-sm text-muted-foreground">{activity.issues.length} 项待核对 · {activity.issues[0]}</p>}
    </CardContent>
    <CardFooter className="flex flex-wrap items-center justify-between gap-2 px-5 pb-4">
      <div className="flex items-center gap-2"><Badge variant={activity.status === "confirmed" && !activity.stale ? "secondary" : "outline"}>{label(activity)}</Badge><span className="text-xs text-muted-foreground">{assetIds.length} 份资料</span></div>
      <Button variant="ghost" size="sm" onClick={() => onInspect({ tab: "activities", id: activity.id })}>查看活动<ArrowUpRight data-icon="inline-end" /></Button>
    </CardFooter>
  </Card>;
}

export function MemoryActivitiesPage({ assets, onInspect, onStart }: { assets: Asset[]; onInspect: Inspect; onStart?: () => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ActivityPage>();
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const refresh = () => setRevision((r) => r + 1); window.addEventListener("memory-activities-changed", refresh); return () => window.removeEventListener("memory-activities-changed", refresh); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void api<ActivityPage>("/memory-activities?" + new URLSearchParams({ query, limit: "30" }), { signal: controller.signal })
      .then((result) => { setPage(result); setError(""); setSelected((ids) => ids.filter((id) => result.activities.some((activity) => activity.id === id))); }).catch((e) => { if (!controller.signal.aborted) setError(e.message); }); }, query ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, revision]);
  async function merge() {
    const refs = page?.activities.filter((a) => selected.includes(a.id)).map(({ id, version }) => ({ id, version })) || [];
    if (refs.length < 2) return;
    setBusy(true); setError("");
    try { await api(`/memory-activities/${refs[0].id}/commands`, { method: "POST", body: JSON.stringify({ action: "merge-activities", refs, reason: "用户将所选资料归为同一次活动" }) }); changed(); }
    catch (e) { setError(e instanceof Error ? e.message : "合并失败"); } finally { setBusy(false); }
  }
  return <div className="@container flex flex-col gap-6">
    <div className="flex flex-wrap items-center gap-3">
      <InputGroup className="flex-1 sm:max-w-sm"><InputGroupInput aria-label="查找活动" placeholder="活动、地点或日期" value={query} onChange={(e) => setQuery(e.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>
      <Button variant="ghost" size="icon-sm" aria-label="刷新活动" onClick={() => setRevision((r) => r + 1)}><RefreshCw /></Button>
      {onStart && <Button className="ml-auto" onClick={onStart}><Plus data-icon="inline-start" />整理资料</Button>}
    </div>
    {error && <Alert variant="destructive"><AlertTitle>活动未加载</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {selected.length > 0 && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">已选 {selected.length} 个活动</span><Button variant="outline" size="sm" disabled={selected.length < 2 || busy} onClick={() => void merge()}><GitMerge data-icon="inline-start" />归为同一次活动</Button><Button variant="ghost" size="sm" onClick={() => setSelected([])}>取消选择</Button></div>}
    {!page && !error ? <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-56" /><Skeleton className="h-56" /></div> : !page?.activities.length ? <Empty className="py-20">
      <EmptyHeader><EmptyMedia variant="icon"><CalendarDays /></EmptyMedia><EmptyTitle>{query ? "没有匹配的活动" : "从一段经历开始"}</EmptyTitle><EmptyDescription>{query ? "换个地点、日期或关键词试试。" : "把照片和随手记录交给 Agent，在这里回看整理好的活动。"}</EmptyDescription></EmptyHeader>
      {onStart && <EmptyContent><Button onClick={onStart}><MessageSquare data-icon="inline-start" />开始整理</Button></EmptyContent>}
    </Empty> : <>
      <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">{page.activities.map((activity) => <ActivityCard key={activity.id} activity={activity} assets={assets} onInspect={onInspect} checked={selected.includes(activity.id)} onChecked={(value) => setSelected((ids) => value ? [...ids, activity.id] : ids.filter((id) => id !== activity.id))} />)}</div>
      {page.nextOffset != null && <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const next = await api<ActivityPage>("/memory-activities?" + new URLSearchParams({ query, limit: "30", offset: String(page.nextOffset) })); setPage({ ...next, activities: [...page.activities, ...next.activities] }); } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); } finally { setBusy(false); } }}>加载更多</Button>}
    </>}
  </div>;
}

export function ActivityInspector({ id, onInspect, onClose, onChanged, onReference }: { id: string; onInspect: Inspect; onClose: () => void; onChanged: () => void; onReference?: (text: string, assetIds?: string[]) => void }) {
  const [detail, setDetail] = useState<MemoryActivityDetail>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState({ title: "", summary: "", occurredAt: "", place: "" });
  useEffect(() => {
    const controller = new AbortController(); setDetail(undefined); setError(""); setSelected([]);
    void api<MemoryActivityDetail>(`/memory-activities/${id}`, { signal: controller.signal }).then((result) => {
      setDetail(result); const a = result.activity;
      setValues({ title: a.title, summary: a.summary, occurredAt: a.occurredAt, place: a.place });
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, revision]);
  async function command(action: ActivityChange["action"]) {
    if (!detail) return; setBusy(true); setError("");
    const input: ActivityChange = { action, refs: [{ id, version: detail.activity.version }], reason: ({ "confirm-activity": "用户确认表单中的活动内容", "correct-activity": "用户更正表单中的活动内容", "reject-activity": "用户排除此活动关联", "split-activity": "用户将选中记录拆为另一活动", "merge-activities": "用户合并活动" })[action],
      ...(["confirm-activity", "correct-activity"].includes(action) ? { values } : {}), ...(action === "split-activity" ? { memoryIds: selected } : {}) };
    try {
      if (action === "merge-activities" && detail.activity.relatedActivityId) {
        const related = await api<MemoryActivityDetail>(`/memory-activities/${detail.activity.relatedActivityId}`);
        input.refs.push({ id: related.activity.id, version: related.activity.version });
      }
      const receipt = await api<{ result: { activities: MemoryActivity[] } }>(`/memory-activities/${id}/commands`, { method: "POST", body: JSON.stringify(input) });
      changed(); onChanged();
      const next = receipt.result.activities[0];
      if (next.id !== id) onInspect({ tab: "activities", id: next.id });
      else setRevision((r) => r + 1);
    }
    catch (e) { setError(e instanceof Error ? e.message : "活动未保存"); } finally { setBusy(false); }
  }
  const a = detail?.activity;
  return <Artifact className="h-full rounded-none border-0 shadow-none" data-testid="activity-inspector">
    <ArtifactHeader><ArtifactTitle>活动详情</ArtifactTitle><ArtifactActions><ArtifactClose aria-label="关闭活动详情" onClick={onClose} /></ArtifactActions></ArtifactHeader>
    <ArtifactContent className="flex flex-col gap-6 overflow-auto p-6">
      {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!detail ? <Skeleton className="h-60" /> : <>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{label(a!)}</Badge><span className="text-xs text-muted-foreground">版本 {a!.version}</span>{a!.relatedActivityId && <Button variant="link" size="sm" onClick={() => onInspect({ tab: "activities", id: a!.relatedActivityId })}>关联活动</Button>}</div>
        {!!a!.issues.length && <Alert><AlertTitle>待核对</AlertTitle><AlertDescription><ul className="list-disc pl-4">{a!.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></AlertDescription></Alert>}
        <FieldGroup>
          <Field><FieldLabel htmlFor={`activity-title-${id}`}>活动</FieldLabel><Input id={`activity-title-${id}`} value={values.title} onChange={(e) => setValues({ ...values, title: e.target.value })} maxLength={120} /></Field>
          <FieldGroup className="grid grid-cols-2 gap-4">
            <Field><FieldLabel htmlFor={`activity-date-${id}`}><CalendarDays className="size-4" />日期</FieldLabel><Input id={`activity-date-${id}`} type="date" value={values.occurredAt} onChange={(e) => setValues({ ...values, occurredAt: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor={`activity-place-${id}`}><MapPin className="size-4" />地点</FieldLabel><Input id={`activity-place-${id}`} value={values.place} onChange={(e) => setValues({ ...values, place: e.target.value })} maxLength={120} /></Field>
          </FieldGroup>
          <Field><FieldLabel htmlFor={`activity-summary-${id}`}>活动内容</FieldLabel><Textarea id={`activity-summary-${id}`} value={values.summary} onChange={(e) => setValues({ ...values, summary: e.target.value })} rows={5} maxLength={2000} /></Field>
        </FieldGroup>
        {!["rejected", "superseded"].includes(a!.status) && <div className="flex flex-wrap gap-2"><Button disabled={busy || !values.summary.trim() || !values.title.trim()} onClick={() => void command(a!.status === "confirmed" ? "correct-activity" : "confirm-activity")}><Check data-icon="inline-start" />{a!.status === "confirmed" ? "保存更正" : "确认活动内容"}</Button><Button variant="ghost" disabled={busy} onClick={() => void command("reject-activity")}>排除此关联</Button></div>}
        {a!.relatedActivityId && !["rejected", "superseded"].includes(a!.status) && <Button variant="outline" disabled={busy} onClick={() => void command("merge-activities")}><GitMerge data-icon="inline-start" />合并关联活动</Button>}
        {onReference && <Button variant="outline" onClick={() => onReference(`请核对活动「${a!.title}」（活动 ID：${a!.id}），结合当前来源继续整理。`)}><MessageSquare data-icon="inline-start" />带回对话</Button>}
        {onReference && !["rejected", "superseded"].includes(a!.status) && <Button variant="outline" onClick={() => onReference(`请把本次附加的新资料补进活动「${a!.title}」（活动 ID：${a!.id}），保留原活动内容。`, a!.sources.flatMap((source) => source.type === "asset" ? [source.assetId] : []))}><Plus data-icon="inline-start" />补充资料</Button>}
        <Separator />
        <div className="flex flex-col gap-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">来源记录 · {detail.memories.length}</h3><Button variant="ghost" size="sm" disabled={busy || !selected.length || selected.length >= detail.memories.length || ["rejected", "superseded"].includes(a!.status)} onClick={() => void command("split-activity")}><Scissors data-icon="inline-start" />拆分所选</Button></div>
          {detail.memories.map((memory) => <div key={memory.id} className="flex items-start gap-3"><Checkbox aria-label={`拆分记录 ${memory.title}`} checked={selected.includes(memory.id)} onCheckedChange={(value) => setSelected((ids) => value ? [...ids, memory.id] : ids.filter((id) => id !== memory.id))} /><div className="flex min-w-0 flex-1 flex-col gap-2"><Button variant="link" className="h-auto justify-start whitespace-normal p-0 text-left" onClick={() => onInspect({ tab: "memories", id: memory.id })}>{memory.title}</Button><p className="text-sm leading-6">{memory.content}</p><span className="text-xs text-muted-foreground">{memory.status === "confirmed" ? "已确认记录" : "待核对观察"} · v{memory.version}</span></div></div>)}
        </div>
        <Sources><SourcesTrigger count={a!.sources.length} /><SourcesContent>{a!.sources.map((source, i) => source.type === "asset" ? <Source key={i} href={assetUrl(source.assetId)} title={source.name} onClick={(e) => { e.preventDefault(); onInspect({ tab: "assets", id: source.assetId, start: source.start, end: source.end, timestamp: source.video?.timestamp }); }} /> : null)}</SourcesContent></Sources>
        {!!a!.entityIds.length && <div className="flex flex-col gap-2"><h3 className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" />人物候选 · {a!.entityIds.length}</h3><Button variant="outline" onClick={() => onReference?.(`请检查活动「${a!.title}」（${a!.id}）的素材人物，并集中列出需要我核对的身份。`)} disabled={!onReference}>核对人物</Button></div>}
        <Accordion type="single" collapsible><AccordionItem value="history"><AccordionTrigger><span className="flex items-center gap-2"><History className="size-4" />整理依据与版本</span></AccordionTrigger><AccordionContent className="flex flex-col gap-4"><p>{a!.reason}</p>{detail.history.map((version) => <div key={version.version}><p className="text-xs text-muted-foreground">v{version.version} · {new Date(version.updatedAt).toLocaleString("zh-CN")}</p><p className="mt-1 text-sm">{version.summary || version.reason}</p></div>)}</AccordionContent></AccordionItem></Accordion>
      </>}
    </ArtifactContent>
  </Artifact>;
}

export function RunActivities({ run, assets, onInspect }: { run: Run; assets: Asset[]; onInspect: Inspect }) {
  const [page, setPage] = useState<ActivityPage>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const signature = (run.jobs || []).filter((j) => j.kind === "memory-organization").map((j) => `${j.id}:${j.revision}`).join(",") + (run.receipts || []).filter((r) => r.name === "change_memory_activities").length;
  useEffect(() => { const refresh = () => setRevision((r) => r + 1); window.addEventListener("memory-activities-changed", refresh); return () => window.removeEventListener("memory-activities-changed", refresh); }, []);
  useEffect(() => {
    if (!signature || signature === "0") return;
    const controller = new AbortController();
    void api<ActivityPage>(`/runs/${run.id}/activities`, { signal: controller.signal }).then((result) => { setPage(result); setError(""); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [run.id, signature, revision]);
  if (error) return <Alert><AlertTitle>活动结果未加载</AlertTitle><AlertDescription>{error}<Button variant="link" onClick={() => setRevision((r) => r + 1)}>重试</Button></AlertDescription></Alert>;
  if (!page?.activities.length) return null;
  return <div className="@container w-full" data-testid="run-activities"><div className={cn("grid gap-3", page.activities.length > 1 && "@2xl:grid-cols-2")}>{page.activities.map((activity) => <ActivityCard key={activity.id} activity={activity} assets={assets} onInspect={onInspect} />)}</div></div>;
}
