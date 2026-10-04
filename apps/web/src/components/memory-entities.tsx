"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { EntityObservation, MemoryEntityPage, MemoryEntitySummary, MemoryPeoplePage, MemorySpace } from "@memory/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { api, ApiRequestError, assetUrl, videoTime } from "@/lib/api";
import { VideoPlayback } from "./video-evidence";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { EvidenceSearchDialog } from "./evidence-search";

export function MemoryEntitiesButton({ space, onChanged }: { space: MemorySpace; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" variant="outline" onClick={() => setOpen(true)}>素材人物</Button>
    {open && <EntityList key={space} space={space} onClose={() => setOpen(false)} onChanged={onChanged} />}</>;
}
function EntityList({ space, onClose, onChanged }: { space: MemorySpace; onClose: () => void; onChanged: () => void }) {
  const [page, setPage] = useState<MemoryEntityPage>();
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [entity, setEntity] = useState<MemoryEntitySummary>();
  const more = useRef<(cursor?: string) => void>(() => {});
  const changed = () => { setSelected([]); setRevision((value) => value + 1); onChanged(); };
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function load(cursor?: string) {
      if (running) return; running = true; setLoading(true); setError("");
      try {
        let result: MemoryEntityPage;
        try { result = await api(`/memory-entities?space=${space}&limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, { signal: controller.signal }); }
        catch (failure) {
          if (!cursor || !(failure instanceof ApiRequestError) || failure.code !== "MEMORY_CURSOR_EXPIRED") throw failure;
          result = await api(`/memory-entities?space=${space}&limit=20`, { signal: controller.signal }); cursor = undefined;
        }
        if (controller.signal.aborted) return;
        setPage((previous) => cursor && previous?.revision === result.revision ? { ...result, entities: [...previous.entities, ...result.entities] } : result);
        if (!cursor) setSelected([]);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { running = false; if (!controller.signal.aborted) setLoading(false); }
    }
    more.current = (cursor) => void load(cursor); void load();
    return () => controller.abort();
  }, [space, revision]);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>素材人物</DialogTitle><DialogDescription>{page?.total ?? "—"} 组</DialogDescription></DialogHeader>
      {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
      {!page && loading ? <Skeleton className="h-32 w-full" /> : <Table>
        <TableHeader><TableRow><TableHead>选择</TableHead><TableHead>出现区域</TableHead><TableHead>人物</TableHead><TableHead>出现次数</TableHead><TableHead>核对</TableHead></TableRow></TableHeader>
        <TableBody>{page?.entities.map((value) => <TableRow key={value.id} data-testid="entity-group">
          <TableCell><Checkbox aria-label={`选择人物组 ${value.personName || value.id.slice(0, 6)}`} checked={selected.includes(value.id)}
            disabled={!selected.includes(value.id) && selected.length >= 20} onCheckedChange={(checked) => setSelected(checked ? [...selected, value.id] : selected.filter((id) => id !== value.id))} /></TableCell>
          <TableCell>{value.observations[0] && <FacePreview item={value.observations[0]} />}</TableCell>
          <TableCell>{value.personName || "待命名"}<Badge className="ml-2" variant="outline">{value.state === "identified" ? "已有身份依据" : "身份未知"}</Badge></TableCell>
          <TableCell>{value.observationCount}</TableCell>
          <TableCell><Button variant="ghost" size="sm" onClick={() => setEntity(value)}>核对这一组</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table>}
      {page && !page.total && <Empty><EmptyHeader><EmptyTitle>暂无人物出现</EmptyTitle></EmptyHeader></Empty>}
      {page?.nextCursor && <Button variant="outline" disabled={loading} onClick={() => more.current(page.nextCursor!)}>加载更多人物</Button>}
      {selected.length >= 2 && <FieldGroup><Field><FieldLabel htmlFor="entity-merge-reason">合并依据</FieldLabel>
        <Textarea id="entity-merge-reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <Button disabled={busy || !reason.trim()} onClick={async () => {
          setBusy(true); setError("");
          try { await api("/memory-entities/merge", { method: "POST", body: JSON.stringify({ reason,
            entities: page!.entities.filter((value) => selected.includes(value.id)).map(({ id, version }) => ({ id, version })) }) }); changed(); setReason(""); }
          catch (failure) { setError(failure instanceof Error ? failure.message : "合并失败"); }
          finally { setBusy(false); }
        }}>合并所选人物组</Button></FieldGroup>}
      <DialogFooter><Button variant="ghost" disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>刷新</Button><Button variant="outline" onClick={onClose} disabled={busy}>关闭</Button></DialogFooter>
      {entity && <EntityReview entity={entity} onClose={() => setEntity(undefined)} onSaved={() => { setEntity(undefined); changed(); }} />}
    </DialogContent>
  </Dialog>;
}
function FacePreview({ item }: { item: EntityObservation }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="text-xs text-muted-foreground">原件不可用</span> : <Image width={80} height={80} unoptimized
    src={`/api/memory-observations/${item.observationId}/preview`} alt="待核对的人物区域" className="h-20 w-20 rounded-md object-contain" onError={() => setFailed(true)} />;
}
function EntityReview({ entity, onClose, onSaved }: { entity: MemoryEntitySummary; onClose: () => void; onSaved: () => void }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [items, setItems] = useState(entity.observations), [selected, setSelected] = useState<string[]>([]);
  const [personId, setPersonId] = useState(entity.personId || "new"), [name, setName] = useState("");
  const [query, setQuery] = useState(""), [people, setPeople] = useState<MemoryPeoplePage["people"]>([]);
  const [reason, setReason] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState<number | null>(entity.observations.length < entity.observationCount ? entity.observations.length : null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void api<MemoryPeoplePage>("/memory-people?space=personal&limit=50&query=" + encodeURIComponent(query), { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPeople(result.people.filter((person) => person.id)); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); }); }, 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query]);
  async function act(action: "identify" | "split") {
    setBusy(true); setError("");
    try { await api(`/memory-entities/${entity.id}/${action}`, { method: "POST", body: JSON.stringify({ version: entity.version, reason,
      ...(action === "split" ? { observationIds: selected } : personId === "new" ? { name: name.trim() } : { personId }) }) }); onSaved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{entity.personName || "核对人物"}</DialogTitle><DialogDescription>{entity.observationCount} 处出现</DialogDescription></DialogHeader>
    {entity.space === "personal" && <Button variant="outline" onClick={() => setSearchOpen(true)}>查找人物出现</Button>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <div className="flex flex-wrap gap-4">{items.map((item) => {
      const source = item.observation.evidence[0];
      return <div key={item.observationId} className="flex flex-col gap-2">
      <FacePreview item={item} />
      <Field orientation="horizontal"><Checkbox id={item.observationId} checked={selected.includes(item.observationId)}
        disabled={!selected.includes(item.observationId) && selected.length >= 50} onCheckedChange={(checked) => setSelected(checked ? [...selected, item.observationId] : selected.filter((id) => id !== item.observationId))} />
        <FieldLabel htmlFor={item.observationId}>选择</FieldLabel></Field>
      <Badge variant="outline">{item.status === "confirmed" ? "已确认" : "待核对"}</Badge>
      {source?.type === "asset" && source.video && <><Badge variant="outline">{videoTime(source.video.timestamp)}</Badge>
        <VideoPlayback assetId={source.assetId} name={source.name} video={source.video} previewUrl={`/api/memory-observations/${item.observationId}/preview`} /></>}
      {item.observation.assetId && <Button variant="link" size="sm" asChild><a href={assetUrl(item.observation.assetId)} target="_blank" rel="noopener noreferrer">原件</a></Button>}
    </div>; })}</div>
    {offset !== null && <Button variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { const result = await api<{ observations: EntityObservation[]; nextOffset: number | null }>(`/memory-entities/${entity.id}/observations?revision=${entity.version}&offset=${offset}`);
        setItems((previous) => [...previous, ...result.observations]); setOffset(result.nextOffset); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { setBusy(false); }
    }}>查看更多出现</Button>}
    {entity.space === "personal" && <FieldGroup><Field><FieldLabel htmlFor="entity-person-query">查找已有称呼</FieldLabel><Input id="entity-person-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={80} /></Field>
      <Field><FieldLabel>关联人物</FieldLabel><Select value={personId} onValueChange={setPersonId}><SelectTrigger aria-label="关联已有人物"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="new">建立新人物</SelectItem>{entity.personId && !people.some((person) => person.id === entity.personId) && <SelectItem value={entity.personId}>{entity.personName || "当前人物"}</SelectItem>}
          {people.map((person) => <SelectItem key={person.id} value={person.id!}>{person.name}{person.aliases?.length ? ` · ${person.aliases.join("、")}` : ""}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      {personId === "new" && <Field><FieldLabel htmlFor="entity-name">人物称呼</FieldLabel><Input id="entity-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>}
    </FieldGroup>}
    <Field><FieldLabel htmlFor="entity-reason">确认或纠正依据</FieldLabel><Textarea id="entity-reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="outline" disabled={busy || !selected.length || !reason.trim()} onClick={() => void act("split")}>分离所选出现</Button>
      {entity.space === "personal" && <Button disabled={busy || !reason.trim() || (personId === "new" && !name.trim())} onClick={() => void act("identify")}>确认整组身份 · {entity.observationCount}</Button>}
    </DialogFooter>
    {searchOpen && <EvidenceSearchDialog entityId={entity.id} onClose={() => setSearchOpen(false)} />}
  </DialogContent></Dialog>;
}
