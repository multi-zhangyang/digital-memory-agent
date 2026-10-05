"use client";

import { useEffect, useState } from "react";
import type { MemoryDataset, Run, TrainingSample } from "@memory/contracts";
import { api, downloadFile, datasetDownloadUrl, formatBytes } from "@/lib/api";
import { Artifact, ArtifactHeader, ArtifactTitle, ArtifactContent, ArtifactActions, ArtifactAction } from "@/components/ai-elements/artifact";
import { Attachments, Attachment, AttachmentInfo, AttachmentPreview } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, ArrowUpRight, RefreshCw, LoaderCircle } from "lucide-react";

type Delivery = { datasetId: string; revision: number; verified: boolean; files: { kind: string; name: string; href: string; bytes: number; records?: number; sha256: string }[] };
export function DatasetDeliveryPanel({ runId, toolCallId, active, refreshVersion, onMemory, onRequest }: {
  runId: string; toolCallId: string; active: boolean; refreshVersion: number;
  onMemory: (id: string) => void; onRequest: (text: string) => void;
}) {
  const [delivery, setDelivery] = useState<Delivery>(), [data, setData] = useState<{ dataset: MemoryDataset; samples: TrainingSample[]; matchingSamples: number; nextCursor?: string | null }>();
  const [error, setError] = useState(""), [downloadError, setDownloadError] = useState("");
  const [loading, setLoading] = useState(true), [downloading, setDownloading] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDelivery(undefined); setData(undefined); setError(""); setLoading(true);
    void (async () => {
      try {
        const { run } = await api<{ run: Run }>("/runs/" + runId, { signal: controller.signal });
        const part = run.parts.find((part) => part.type === "tool" && part.toolCallId === toolCallId && part.name === "deliver_dataset" && part.state === "complete");
        const output = part?.type === "tool" ? part.output as Delivery : undefined;
        if (!output?.datasetId || !Array.isArray(output.files)) throw new Error("此记录没有已完成的训练文件交付");
        if (!controller.signal.aborted) setDelivery(output);
      } catch (failure) { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "读取交付失败"); setLoading(false); } }
    })();
    return () => controller.abort();
  }, [runId, toolCallId, reload]);
  useEffect(() => {
    if (!delivery || !active) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<NonNullable<typeof data>>("/memory-datasets/" + delivery.datasetId + "/samples?view=ready", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取样本失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [delivery, active, refreshVersion]);
  const current = !!delivery && !!data && !data.dataset.stale && data.dataset.status === "completed" &&
    delivery.verified && data.dataset.revision === delivery.revision && !["queued", "running"].includes(data.dataset.audit?.status || "");
  async function download(file: Delivery["files"][number]) {
    setDownloading(file.kind); setDownloadError("");
    try {
      await downloadFile(file.href.slice(4), file.name, file.sha256);
    } catch (failure) {
      setDownloadError(failure instanceof Error ? failure.message : "下载失败"); setReload((value) => value + 1);
    } finally { setDownloading(""); }
  }
  return <Artifact className="h-full rounded-none border-0 shadow-none" data-testid="dataset-delivery">
    <ArtifactHeader className="bg-background"><ArtifactTitle>{data?.dataset.title || "训练文件"}</ArtifactTitle>
      <ArtifactActions>{delivery && <Badge variant="outline">{loading ? "读取中" : error ? "读取失败" : current ? "已核验交付" : "交付后已变更"} · v{delivery.revision}</Badge>}
        <ArtifactAction icon={RefreshCw} label="刷新交付" disabled={loading || !!downloading} onClick={() => { setDownloadError(""); setReload((value) => value + 1); }} />
      </ArtifactActions>
    </ArtifactHeader>
    <ScrollArea className="min-h-0 flex-1"><ArtifactContent className="flex flex-col gap-5 p-4">
      {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
      {downloadError && <Alert><AlertTitle>{downloadError}</AlertTitle></Alert>}
      {!delivery && !error && <Skeleton className="h-40" />}
      {delivery && <>
        {!current && !loading && <Button size="sm" variant="outline" className="self-start" onClick={() => onRequest(`重新核验并交付数据集 ${delivery.datasetId}，检查来源变化与训练文件内容。`)}>交给 Agent 核验</Button>}
        <Attachments variant="list">{delivery.files.filter((file) => datasetDownloadUrl(file.href)).map((file) => <Attachment key={file.kind} className="w-full" data={{ id: file.href, type: "file", mediaType: "application/octet-stream", filename: file.name, url: file.href }}>
          <Button variant="ghost" className="h-auto w-full justify-start gap-3 p-2" disabled={!current || loading || !!error || !!downloading}
            onClick={() => void download(file)} title={"SHA-256: " + file.sha256}><AttachmentPreview /><AttachmentInfo />
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{file.records === undefined ? "" : file.records + " 条 · "}{formatBytes(file.bytes)}</span>
              {downloading === file.kind ? <LoaderCircle className="animate-spin" /> : <Download />}
          </Button>
        </Attachment>)}</Attachments>
        {current && <><div className="flex items-center justify-between text-xs text-muted-foreground"><span>可用样本 · {data?.matchingSamples ?? 0}</span><span>预览 {data?.samples.length || 0} 条</span></div>
        <div className="divide-y">{data?.samples.map((sample) => <article key={sample.id} className="flex flex-col gap-2 py-4">
          <Badge variant="outline" className="self-start">{sample.intendedUse === "evaluation" ? "评测" : "训练"} · v{sample.version}</Badge>
          <p className="text-sm font-medium">{sample.question || "叙述样本"}</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{sample.answer}</p>
          <div className="flex flex-wrap gap-2">{sample.memoryRefs.map((memory) => <Button key={memory.id} size="sm" variant="ghost" onClick={() => onMemory(memory.id)}>记忆来源 · v{memory.version}<ArrowUpRight /></Button>)}</div>
        </article>)}</div>
        </>}
      </>}
    </ArtifactContent></ScrollArea>
  </Artifact>;
}
