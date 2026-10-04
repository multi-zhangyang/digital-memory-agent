"use client";
import { useState } from "react";
import type { VideoIndexFrame } from "@memory/contracts";
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo } from "@/components/ai-elements/attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { videoTime } from "@/lib/api";
import { VideoSourceViewer } from "./video-source-viewer";

const labels = { queued: "待处理", running: "处理中", completed: "已索引", failed: "未完成" };

export function VideoIndexFrames({ frames, assetId, version, name, onMemory }: { frames: VideoIndexFrame[]; assetId: string; version: string; name: string; onMemory?: (id: string) => void }) {
  const [selected, setSelected] = useState<VideoIndexFrame>();
  return <>
    <Attachments variant="list">{frames.map((frame) => {
      const url = frame.status === "completed" ? `/api/evidence/${encodeURIComponent("frame:" + frame.id)}/preview?` + new URLSearchParams({ version, view: frame.viewSha256! }) : undefined;
      return <Attachment key={frame.id} className="w-full flex-col items-stretch" data={{ id: frame.id, type: "file", mediaType: url ? "image/jpeg" : "application/octet-stream", filename: videoTime(frame.video?.timestamp ?? frame.requestedTimestamp), url: url || "" }}>
        <div className="flex min-w-0 flex-wrap items-center gap-2"><AttachmentPreview /><AttachmentInfo /><Badge variant="outline">{labels[frame.status]}</Badge>
          <Button variant="outline" size="sm" disabled={frame.status !== "completed"} onClick={() => setSelected(frame)}>核对画面</Button></div>
        {frame.error && <p>{frame.error}</p>}
      </Attachment>;
    })}</Attachments>
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(undefined); }}><DialogContent aria-describedby={undefined} className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>{name} · {selected ? videoTime(selected.video?.timestamp ?? selected.requestedTimestamp) : ""}</DialogTitle></DialogHeader>
      {selected && <VideoSourceViewer key={selected.id} assetId={assetId} name={name} version={version} initialTimestamp={selected.requestedTimestamp}
        onMemory={onMemory ? (id) => { setSelected(undefined); onMemory(id); } : undefined} />}
    </DialogContent></Dialog>
  </>;
}
