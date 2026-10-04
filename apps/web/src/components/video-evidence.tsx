"use client";

import { useState } from "react";
import type { SourceRef, VideoFrame } from "@memory/contracts";
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { api, assetUrl, videoTime } from "@/lib/api";

export function VideoPlayback({ assetId, name, video, previewUrl }: { assetId: string; name: string; video: VideoFrame; previewUrl?: string }) {
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>播放 {videoTime(video.timestamp)}</Button>
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setError(""); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{name} · {videoTime(video.timestamp)}</DialogTitle></DialogHeader>
        <video controls playsInline preload="metadata" src={assetUrl(assetId)} poster={previewUrl}
          className="max-h-[65dvh] w-full" onLoadedMetadata={(event) => { event.currentTarget.currentTime = video.timestamp; }}
          onError={() => setError("浏览器无法播放此视频，可下载原件")}>浏览器无法播放此视频</video>
        {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
        <Button variant="ghost" asChild><a href={assetUrl(assetId, true)} download={name}>下载原件</a></Button>
      </DialogContent>
    </Dialog>
  </>;
}

export function VideoEvidence({ memoryId, index, source }: { memoryId: string; index: number; source: SourceRef }) {
  const [verified, setVerified] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const url = `/api/memories/${memoryId}/evidence/${index}/image`, video = source.video!;
  return <div className="flex flex-col gap-3" data-testid="video-evidence">
    <Attachments variant="list" onErrorCapture={() => setError("此画面已不可用，请核对原件")}>
      <Attachment data={{ id: `${source.assetId}:${video.timestamp}`, type: "file", mediaType: "image/jpeg", filename: `${source.name} · ${videoTime(video.timestamp)}`, url }}>
        <AttachmentPreview /><AttachmentInfo />
        <Button variant="ghost" size="sm" asChild><a href={url} target="_blank" rel="noreferrer">查看画面</a></Button>
      </Attachment>
    </Attachments>
    {source.visual?.transcript && <blockquote className="whitespace-pre-wrap">{source.visual.transcript}</blockquote>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <div className="flex flex-wrap gap-2">
      <VideoPlayback assetId={source.assetId} name={source.name} video={video} previewUrl={url} />
      <Button variant="outline" size="sm" disabled={busy || verified} onClick={async () => {
        setBusy(true); setError("");
        try {
          const result = await api<{ verified: boolean; previewMatches: boolean }>(`/memories/${memoryId}/evidence/${index}`);
          setVerified(result.verified && result.previewMatches);
          if (!result.previewMatches) setError("画面版本已改变，请重新核对原件");
        } catch (failure) { setError(failure instanceof Error ? failure.message : "核验失败"); }
        finally { setBusy(false); }
      }}>{verified ? "原件校验通过" : "核对原件"}</Button>
    </div>
  </div>;
}
