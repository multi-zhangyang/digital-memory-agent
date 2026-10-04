"use client";

import type { ProcessingAssetResult } from "@memory/contracts";
import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "@/components/ai-elements/attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { assetUrl, videoTime } from "@/lib/api";

const statusLabels = { completed: "已处理", reused: "已复用", failed: "处理失败", pending: "待完成", blocked: "已停用" };

export function ProcessingAssets({ assets, onAsset }: { assets: ProcessingAssetResult[]; onAsset?: (id: string) => void }) {
  return <Attachments variant="list">
    {assets.map((asset) => <Attachment key={asset.assetId} className="w-full flex-col items-stretch" data={{
      id: asset.assetId, type: "file", filename: asset.name, mediaType: "application/octet-stream", url: assetUrl(asset.assetId),
    }}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AttachmentPreview /><AttachmentInfo className="min-w-0 flex-1" />
        <Badge variant="outline">{statusLabels[asset.status]}</Badge>
        {onAsset ? <Button variant="ghost" size="sm" onClick={() => onAsset(asset.assetId)}>查看原件</Button>
          : <Button variant="ghost" size="sm" asChild><a href={`/?view=memory&panel=assets&item=${asset.assetId}`}>查看原件</a></Button>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>{asset.video ? "抽样画面" : "片段"} {asset.chunks.completed} / {asset.chunks.total}</span>
        <span>观察 {asset.observations}</span>
        {asset.video && <><span>时长 {videoTime(asset.video.duration)}</span><span>间隔 {Number(asset.video.sampleInterval.toFixed(3))} 秒</span></>}
      </div>
      {(asset.error || asset.reason) && <p>{asset.error || asset.reason}</p>}
    </Attachment>)}
  </Attachments>;
}
