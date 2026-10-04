"use client";
import { useEffect, useState } from "react";
import type { MemoryEntry, MemorySpace } from "@memory/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

type Event = { id: string; version: number; title: string; matchedMemories: number };
type EventPage = { events: Event[]; total: number; revision: number; nextCursor: string | null;
  coverage: { undatedEventsInSpace: number; assets: { total: number; withExtractedClaims: number } } };
export function MemoryEventsButton({ space, onChanged, onOpen }: { space: MemorySpace; onChanged: () => void; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" variant="outline" onClick={() => setOpen(true)}>事件归组</Button>
    {open && <EventList key={space} space={space} onClose={() => setOpen(false)} onChanged={onChanged} onOpen={(id) => { setOpen(false); onOpen(id); }} />}</>;
}
function EventList({ space, onClose, onChanged, onOpen }: { space: MemorySpace; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const [page, setPage] = useState<EventPage>(), [cursor, setCursor] = useState(""), [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [title, setTitle] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [event, setEvent] = useState<Event>();
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(""); setSelected([]);
    void api<EventPage>(`/memory-events?space=${space}&limit=20&query=${encodeURIComponent(query)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setPage(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [space, cursor, revision, query]);
  const changed = () => { setCursor(""); setRevision((value) => value + 1); setSelected([]); setTitle(""); setReason(""); onChanged(); };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
    <DialogHeader><DialogTitle>事件归组</DialogTitle><DialogDescription>{page?.total ?? "—"} 个已确认事件 · {page?.coverage.undatedEventsInSpace ?? "—"} 个日期未知</DialogDescription></DialogHeader>
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <Input aria-label="搜索事件" value={query} maxLength={200} placeholder="搜索事件记录" onChange={(e) => { setQuery(e.target.value); setCursor(""); }} />
    {!page ? <Skeleton className="h-32 w-full" /> : <><p className="text-xs text-muted-foreground">已整理来源 {page.coverage.assets.withExtractedClaims} / {page.coverage.assets.total}</p><Table>
      <TableHeader><TableRow><TableHead>选择</TableHead><TableHead>事件</TableHead><TableHead>记录</TableHead><TableHead>核对</TableHead></TableRow></TableHeader>
      <TableBody>{page.events.map((item) => <TableRow key={item.id} data-testid="event-group">
        <TableCell><Checkbox checked={selected.includes(item.id)} disabled={busy} aria-label={`选择事件 ${item.title}`}
          onCheckedChange={(checked) => setSelected(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /></TableCell>
        <TableCell>{item.title}</TableCell><TableCell>{item.matchedMemories}</TableCell><TableCell><Button size="sm" variant="ghost" onClick={() => setEvent(item)}>查看记录</Button></TableCell>
      </TableRow>)}</TableBody></Table></>}
    {selected.length > 1 && <><Field><FieldLabel htmlFor="event-merge-title">合并后的事件名称</FieldLabel><Input id="event-merge-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field><FieldLabel htmlFor="event-merge-reason">合并依据</FieldLabel><Textarea id="event-merge-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
      <Button disabled={busy || !title.trim() || !reason.trim()} onClick={async () => {
        setBusy(true); setError(""); try { await api("/memory-events/merge", { method: "POST", body: JSON.stringify({ title, reason,
          events: page!.events.filter((item) => selected.includes(item.id)).map(({ id, version }) => ({ id, version })) }) }); changed(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "合并失败"); } finally { setBusy(false); }
      }}>合并所选事件</Button></>}
    <DialogFooter>{page?.nextCursor && <Button variant="outline" disabled={busy} onClick={() => setCursor(page.nextCursor!)}>下一批事件</Button>}
      <Button variant="ghost" disabled={busy} onClick={changed}>刷新</Button><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>
    {event && page && <EventMembers event={event} revision={page.revision} onClose={() => setEvent(undefined)} onOpen={onOpen} onChanged={() => { setEvent(undefined); changed(); }} />}
  </DialogContent></Dialog>;
}
function EventMembers({ event, revision, onClose, onOpen, onChanged }: { event: Event; revision: number; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ memories: MemoryEntry[]; nextCursor: string | null }>(), [cursor, setCursor] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [title, setTitle] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setSelected([]);
    void api<NonNullable<typeof data>>(`/memory-events/${event.id}/memories?revision=${revision}${cursor ? "&after=" + cursor : ""}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [event.id, revision, cursor]);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{event.title}</DialogTitle><DialogDescription>{event.matchedMemories} 条确认记录</DialogDescription></DialogHeader>
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    {!data ? <Skeleton className="h-32 w-full" /> : <Table><TableBody>{data.memories.map((memory) => <TableRow key={memory.id}>
      <TableCell><Checkbox aria-label={`分离记录 ${memory.title}`} checked={selected.includes(memory.id)} disabled={busy} onCheckedChange={(checked) => setSelected(checked ? [...selected, memory.id] : selected.filter((id) => id !== memory.id))} /></TableCell>
      <TableCell><Button variant="link" onClick={() => onOpen(memory.id)}>{memory.title}</Button><p className="text-xs text-muted-foreground">{memory.occurredAt || "日期未知"} · v{memory.version}</p></TableCell>
    </TableRow>)}</TableBody></Table>}
    {selected.length > 0 && <><Field><FieldLabel htmlFor="event-split-title">新事件名称</FieldLabel><Input id="event-split-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field><FieldLabel htmlFor="event-split-reason">分离依据</FieldLabel><Textarea id="event-split-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
      <Button disabled={busy || !title.trim() || !reason.trim()} onClick={async () => {
        setBusy(true); setError(""); try { await api(`/memory-events/${event.id}/split`, { method: "POST", body: JSON.stringify({ version: event.version, memoryIds: selected, title, reason }) }); onChanged(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "分离失败"); } finally { setBusy(false); }
      }}>分为新事件</Button></>}
    <DialogFooter>{data?.nextCursor && <Button variant="outline" disabled={busy} onClick={() => setCursor(data.nextCursor!)}>下一批记录</Button>}
      <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>
  </DialogContent></Dialog>;
}
