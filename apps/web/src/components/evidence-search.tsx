"use client";
import { useEffect, useState } from "react";
import type { EvidenceHit, EvidenceRead, EvidenceSearchResult } from "@memory/contracts";
import { api, videoTime } from "@/lib/api";
import { VideoSourceViewer } from "./video-source-viewer";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Attachments, Attachment, AttachmentInfo, AttachmentPreview } from "@/components/ai-elements/attachments";

export function EvidenceSearchDialog({ onClose, onUse, onMemory, entityId }: { onClose: () => void; onUse?: (ids: string[]) => void; onMemory?: (id: string) => void; entityId?: string }) {
  const [query, setQuery] = useState(""), [request, setRequest] = useState<{ query: string } | undefined>(entityId ? { query: "" } : undefined);
  const [result, setResult] = useState<EvidenceSearchResult>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<EvidenceHit>(), [read, setRead] = useState<EvidenceRead>(), [offset, setOffset] = useState(0);
  const [videoTimestamp, setVideoTimestamp] = useState(0);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController(); setBusy(true); setError(""); setSelected(undefined); setRead(undefined);
    void api<EvidenceSearchResult>("/evidence?" + new URLSearchParams({ query: request.query, limit: "12", ...(entityId ? { entityId } : {}) }), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [request, entityId]);
  useEffect(() => {
      setRead(undefined); if (!selected) return;
    const controller = new AbortController(); setError("");
    void api<EvidenceRead>(`/evidence/${encodeURIComponent(selected.id)}?` + new URLSearchParams({ version: String(selected.version), offset: String(offset) }), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setRead(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [selected, offset]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
    <DialogHeader><DialogTitle>{entityId ? "查找人物出现" : "检索素材内容"}</DialogTitle></DialogHeader>
    <form onSubmit={(event) => { event.preventDefault(); setRequest({ query: query.trim() }); }}><FieldGroup className="flex-row items-end gap-2">
      <Field className="min-w-0 flex-1"><FieldLabel htmlFor="evidence-query">内容</FieldLabel><Input id="evidence-query" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="输入人物、事件或素材中的内容" /></Field>
      <Button type="submit" disabled={busy || (!query.trim() && !entityId)}>检索</Button>
    </FieldGroup></form>
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    {busy ? <Skeleton className="h-32 w-full" /> : result && <div className="flex flex-col gap-4">
      {result.truncated && <Badge variant="outline">部分相关结果</Badge>}
      {!result.hits.length && <Empty><EmptyHeader><EmptyTitle>没有找到相关证据</EmptyTitle></EmptyHeader></Empty>}
      {result.hits.map((hit) => <div key={hit.id} className="flex flex-col gap-2 border-b pb-4">
        <div className="flex items-center justify-between gap-2"><Button variant="link" className="max-w-full px-0" onClick={() => { setSelected(hit); setOffset(0); setVideoTimestamp(hit.sources[0]?.type === "asset" ? hit.sources[0].video?.requestedTimestamp ?? 0 : 0); }}><span className="truncate">{hit.title}</span></Button>
          <Badge variant="outline">{hit.authority === "raw-source" ? "原始资料" : hit.authority === "unverified" ? (hit.kind === "inference" ? "待核对推断" : hit.kind === "statement" ? "待核对陈述" : "未核对观察") : "确认记录"}</Badge></div>
        {hit.excerpt && <p className="line-clamp-3 text-sm text-muted-foreground">{hit.excerpt}</p>}
        {hit.type === "frame" && hit.sources[0]?.type === "asset" && <Attachments variant="list"><Attachment data={{ id: hit.id, type: "file", mediaType: "image/jpeg",
          filename: videoTime(hit.sources[0].video!.timestamp), url: `/api/evidence/${encodeURIComponent(hit.id)}/preview?` + new URLSearchParams({ version: String(hit.version), view: hit.sources[0].visual!.previewSha256 }) }}>
          <AttachmentPreview /><AttachmentInfo /><Button variant="ghost" size="sm" onClick={() => { setSelected(hit); setOffset(0); setVideoTimestamp(hit.sources[0].type === "asset" ? hit.sources[0].video!.requestedTimestamp : 0); }}>核对画面</Button>
        </Attachment></Attachments>}
        {hit.sources.some((source) => source.type === "asset" && source.video) && <div className="flex flex-wrap gap-2">{hit.sources.flatMap((source) => source.type === "asset" && source.video ? [
          <Button key={source.assetId + source.video.timestamp} variant="outline" size="sm" onClick={() => {
            setSelected({ ...hit, id: "asset:" + source.assetId, type: "asset", assetId: source.assetId, title: source.name, excerpt: "", version: source.sha256, status: "source", authority: "raw-source" });
            setOffset(0); setVideoTimestamp(source.video!.requestedTimestamp);
          }}>{source.name} · {videoTime(source.video.timestamp)}</Button>
        ] : [])}</div>}
        {hit.uncertainty && <p className="text-xs text-muted-foreground">{hit.uncertainty}</p>}
      </div>)}
    </div>}
    {selected && <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{selected.title}</h3><Button size="sm" variant="ghost" onClick={() => setSelected(undefined)}>收起</Button></div>
      {!read && !error ? <Skeleton className="h-24 w-full" /> : read && <>
        {read.source?.video && read.hit.assetId ? <VideoSourceViewer key={read.hit.assetId + videoTimestamp} assetId={read.hit.assetId} name={read.hit.title} version={String(read.hit.version)} initialTimestamp={videoTimestamp}
          onMemory={onMemory ? (id) => { onClose(); onMemory(id); } : undefined} />
          : read.source?.previewUrl && <img src={read.source.previewUrl} alt={read.hit.title} className="max-h-80 max-w-full object-contain" />}
        <p className="whitespace-pre-wrap break-words text-sm">{read.source?.text ?? read.observation?.text ?? read.hit.excerpt}</p>
        <div className="flex flex-wrap gap-2">{offset > 0 && <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>回到开头</Button>}
          {read.nextOffset != null && <Button variant="outline" size="sm" onClick={() => setOffset(read.nextOffset!)}>下一段</Button>}
          {read.hit.memoryId && onMemory && <Button variant="outline" size="sm" onClick={() => { onClose(); onMemory(read.hit.memoryId!); }}>核对记录</Button>}
          {onUse && <Button size="sm" onClick={() => { const ids = [...new Set(read.hit.sources.flatMap((source) => source.type === "asset" ? [source.assetId] : []))]; onClose(); onUse(ids); }}>用于任务</Button>}
        </div>
      </>}
    </div>}
  </DialogContent></Dialog>;
}
