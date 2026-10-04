"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import type { Asset, MemoryImportJob, ModelInfo } from "@memory/contracts";
import { ImagePlus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription, FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, formatBytes } from "@/lib/api";

export function PhotoImportDialog({ assets, models, defaultModelId, onClose, onStarted }: {
  assets: Asset[]; models: ModelInfo[]; defaultModelId?: string; onClose: () => void; onStarted: (job: MemoryImportJob) => void;
}) {
  const availableModels = models.filter((model) => model.supportsImages);
  const [modelId, setModelId] = useState(defaultModelId || availableModels[0]?.id || "");
  const [uploaded, setUploaded] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef("");
  const photos = [...new Map([...uploaded, ...assets].map((asset) => [asset.id, asset])).values()]
    .filter((asset) => asset.kind === "image" && (!asset.memorySpace || asset.memorySpace === "personal") &&
      ["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType));
  async function upload(files: File[]) {
    if (!files.length) return;
    setError("");
    if (files.length + selected.length > 20 || files.some((file) => file.size > 20 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      setError("每批最多 20 张 JPEG、PNG 或静态 WebP，每张不超过 20 MB"); return;
    }
    setBusy(true);
    try {
      for (const file of files) {
        const form = new FormData(); form.append("file", file);
        const { asset } = await api<{ asset: Asset }>("/assets?processing=requested", { method: "POST", body: form });
        setUploaded((values) => [...values, asset]);
        setSelected((values) => [...values, asset.id]);
        requestId.current = "";
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "上传失败"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function start() {
    setBusy(true); setError(""); requestId.current ||= crypto.randomUUID();
    try {
      const { job } = await api<{ job: MemoryImportJob }>("/memory-imports", { method: "POST", body: JSON.stringify({
        requestId: requestId.current, modelId, mode: "photos", assetIds: selected,
        thinkingLevel: availableModels.find((model) => model.id === modelId)?.thinkingLevel || "off",
      }) });
      onStarted(job);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "提取失败"); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>导入照片</DialogTitle><DialogDescription className="sr-only">选择照片和处理模型。</DialogDescription></DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="photo-upload">照片</FieldLabel>
          <Input ref={input} id="photo-upload" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy}
            onChange={(event) => void upload(Array.from(event.target.files || []))} />
          <FieldDescription>最多 20 张 · 20 MB/张</FieldDescription>
        </Field>
        <FieldSet>
          <FieldLegend>已选 {selected.length} 张</FieldLegend>
          <Input aria-label="查找照片" placeholder="查找资料库照片" value={query} onChange={(event) => setQuery(event.target.value)} />
          <FieldGroup className="max-h-72 overflow-y-auto">
            {photos.filter((asset) => selected.includes(asset.id) || asset.name.toLowerCase().includes(query.toLowerCase())).slice(0, 100).map((asset) =>
              <Field key={asset.id} orientation="horizontal">
                <Checkbox id={"photo-" + asset.id} checked={selected.includes(asset.id)} disabled={busy || (selected.length >= 20 && !selected.includes(asset.id))}
                  onCheckedChange={(checked) => { setSelected((values) => checked ? [...values, asset.id] : values.filter((id) => id !== asset.id)); requestId.current = ""; }} />
                <Image src={`/api/assets/${asset.id}/photo-preview`} unoptimized width={80} height={60} alt="" className="h-15 w-20 object-contain" />
                <FieldLabel htmlFor={"photo-" + asset.id} className="min-w-0 flex-1 truncate">{asset.name}</FieldLabel>
                <FieldDescription>{formatBytes(asset.size)}</FieldDescription>
              </Field>)}
            {!photos.length && <FieldDescription>暂无照片</FieldDescription>}
          </FieldGroup>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor="photo-model">处理模型</FieldLabel>
          <Select value={modelId} disabled={busy || !availableModels.length} onValueChange={(value) => { setModelId(value); requestId.current = ""; }}>
            <SelectTrigger id="photo-model"><SelectValue placeholder="未配置图片模型" /></SelectTrigger>
            <SelectContent><SelectGroup>
              {defaultModelId && !availableModels.some((model) => model.id === defaultModelId) && <SelectItem value={defaultModelId} disabled>当前模型未配置</SelectItem>}
              {availableModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          {!availableModels.length && <FieldDescription>请在模型设置中启用图片输入</FieldDescription>}
        </Field>
      </FieldGroup>
      {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
        <Button disabled={busy || !selected.length || !availableModels.some((model) => model.id === modelId)} onClick={() => void start()}>
          {busy ? <Spinner data-icon="inline-start" /> : <ImagePlus data-icon="inline-start" />}开始提取照片
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
