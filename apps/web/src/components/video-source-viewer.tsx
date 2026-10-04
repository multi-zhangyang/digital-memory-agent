"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { EvidenceRead, FrameMemoryDraftInput, MemoryEntry } from "@memory/contracts";
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo } from "@/components/ai-elements/attachments";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, assetUrl, videoTime } from "@/lib/api";

export function VideoSourceViewer({ assetId, name, version, initialTimestamp = 0, onMemory }: { assetId: string; name: string; version: string; initialTimestamp?: number; onMemory?: (id: string) => void }) {
  const formId = useId();
  const player = useRef<HTMLVideoElement>(null);
  const [timestamp, setTimestamp] = useState(initialTimestamp), [requested, setRequested] = useState(initialTimestamp);
  const [read, setRead] = useState<EvidenceRead>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draftRead, setDraftRead] = useState<EvidenceRead>(), [saved, setSaved] = useState<MemoryEntry>();
  const [draft, setDraft] = useState({ title: "", content: "", occurredAt: "" }), [saving, setSaving] = useState(false), [draftError, setDraftError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(""); setRead(undefined);
    void api<EvidenceRead>(`/evidence/${encodeURIComponent("asset:" + assetId)}?` + new URLSearchParams({ version, timestamp: String(requested) }), { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setRead(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [assetId, version, requested, revision]);
  const source = read?.source;
  useEffect(() => {
    if (source?.video && player.current?.readyState) player.current.currentTime = source.video.timestamp;
  }, [source?.video]);
  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!draftRead?.source?.video || !draftRead.source.view) return;
    setSaving(true); setDraftError("");
    try {
      const input: FrameMemoryDraftInput = { title: draft.title.trim(), content: draft.content.trim(),
        version: draftRead.source.sha256, viewSha256: draftRead.source.view.sha256, timestamp: draftRead.source.video.requestedTimestamp,
        ...(draft.occurredAt ? { occurredAt: draft.occurredAt } : {}) };
      const result = await api<{ memory: MemoryEntry }>(`/evidence/${encodeURIComponent("asset:" + assetId)}/drafts`, { method: "POST", body: JSON.stringify(input) });
      setSaved(result.memory); setDraftRead(undefined);
    } catch (failure) { setDraftError(failure instanceof Error ? failure.message : "草稿未保存"); }
    finally { setSaving(false); }
  }
  const savedForFrame = saved && saved.sources.some((value) => value.view?.sha256 === source?.view?.sha256 && value.video?.timestamp === source?.video?.timestamp);
  return <div className="flex w-full flex-col gap-4" data-testid="video-source-viewer">
    <video ref={player} controls playsInline preload="metadata" src={assetUrl(assetId)} className="max-h-[50dvh] w-full"
      poster={source?.previewUrl} onLoadedMetadata={(event) => { event.currentTarget.currentTime = source?.video?.timestamp ?? initialTimestamp; }}
      onError={() => setError("浏览器无法播放此视频，可核对画面或下载原件")}>浏览器无法播放此视频</video>
    <form onSubmit={(event) => { event.preventDefault(); setRequested(timestamp); setRevision((value) => value + 1); }}>
      <FieldGroup className="flex-row flex-wrap items-end gap-2">
      <Field className="w-40"><FieldLabel htmlFor={"video-time-" + assetId}>画面时间（秒）</FieldLabel>
        <Input id={"video-time-" + assetId} type="number" min={0} max={read?.video?.duration} step="any" value={timestamp} onChange={(event) => setTimestamp(Number(event.target.value))} />
      </Field>
      <Button type="submit" variant="outline" size="sm" disabled={busy}>读取画面</Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
        const time = Number((player.current?.currentTime || 0).toFixed(6)); setTimestamp(time); setRequested(time);
        setRevision((value) => value + 1);
      }}>读取当前画面</Button>
      </FieldGroup>
    </form>
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    {busy ? <Skeleton className="h-32 w-full" /> : source?.previewUrl && source.video && <Attachments variant="list">
      <Attachment className="w-full flex-col items-stretch" data={{ id: source.view!.sha256, type: "file", mediaType: "image/jpeg", filename: name, url: source.previewUrl }}>
        <div className="flex min-w-0 items-center gap-2"><AttachmentPreview /><AttachmentInfo /></div>
        <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{videoTime(source.video.timestamp)} / {videoTime(source.video.duration)}</Badge>
        <Button variant="ghost" size="sm" asChild><a href={source.previewUrl} target="_blank" rel="noreferrer">查看画面</a></Button>
        <Button variant="outline" size="sm" onClick={() => {
          setDraftRead(read); setDraft({ title: "", content: "", occurredAt: "" }); setDraftError("");
        }}>保存记忆草稿</Button>
        {savedForFrame && <><Badge variant="outline">待核对</Badge>{onMemory
          ? <Button variant="ghost" size="sm" onClick={() => onMemory(saved.id)}>核对草稿</Button>
          : <Button variant="ghost" size="sm" asChild><a href={`/?view=memory&panel=memories&item=${saved.id}`}>核对草稿</a></Button>}</>}
        </div>
      </Attachment>
    </Attachments>}
    <Dialog open={!!draftRead} onOpenChange={(open) => { if (!open && !saving) setDraftRead(undefined); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>保存记忆草稿</DialogTitle></DialogHeader>
        {draftRead?.source?.video && <Badge variant="outline">{videoTime(draftRead.source.video.timestamp)} / {videoTime(draftRead.source.video.duration)}</Badge>}
        <form id={formId} onSubmit={saveDraft}>
          <FieldGroup>
            <Field><FieldLabel htmlFor={formId + "-title"}>标题</FieldLabel><Input id={formId + "-title"} required maxLength={120} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
            <Field><FieldLabel htmlFor={formId + "-content"}>内容</FieldLabel><Textarea id={formId + "-content"} required maxLength={4000} rows={4} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></Field>
            <Field><FieldLabel htmlFor={formId + "-date"}>事件日期（可选）</FieldLabel><Input id={formId + "-date"} type="date" value={draft.occurredAt} onChange={(event) => setDraft({ ...draft, occurredAt: event.target.value })} /></Field>
          </FieldGroup>
        </form>
        {draftError && <Alert><AlertTitle>{draftError}</AlertTitle></Alert>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDraftRead(undefined)}>取消</Button><Button type="submit" form={formId} disabled={saving || !draft.title.trim() || !draft.content.trim()}>{saving ? "保存中" : "保存草稿"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
