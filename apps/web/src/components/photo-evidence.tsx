"use client";

import { useState } from "react";
import Image from "next/image";
import type { SourceRef } from "@memory/contracts";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { TaskItem } from "@/components/ai-elements/task";
import { api, assetUrl } from "@/lib/api";

// The region coordinates are model output on the oriented preview, not a face identity.
export function PhotoEvidence({ memoryId, index, source }: { memoryId: string; index: number; source: SourceRef }) {
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visual = source.visual!;
  const region = source.view?.region ? undefined : visual.region;
  return <div className="flex flex-col gap-2" data-testid="photo-evidence">
    <div className="relative w-full" style={{ aspectRatio: `${visual.width}/${visual.height}` }}>
      <Image src={`/api/memories/${memoryId}/evidence/${index}/image`} unoptimized fill sizes="600px" alt={source.name}
        className="object-contain" onError={() => setError("照片无法预览，请核对原图或下载原件")} />
      {region && <div aria-label="模型标注的观察区域" className="pointer-events-none absolute border-2 border-primary"
        style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
    </div>
    {visual.transcript && <TaskItem>图中文字<blockquote className="whitespace-pre-wrap">{visual.transcript}</blockquote></TaskItem>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy || verified} onClick={async () => {
        setBusy(true); setError("");
        try {
          const result = await api<{ verified: boolean; previewMatches: boolean }>(`/memories/${memoryId}/evidence/${index}`);
          setVerified(result.verified);
          if (!result.previewMatches) setError("原件一致，但预处理版本已改变，请下载原图核验");
        } catch (failure) { setError(failure instanceof Error ? failure.message : "核验失败"); }
        finally { setBusy(false); }
      }}>{verified ? "原图校验通过" : "核对原图"}</Button>
      <Button variant="ghost" size="sm" asChild><a href={assetUrl(source.assetId, true)} download={source.name}>下载原图</a></Button>
    </div>
  </div>;
}
