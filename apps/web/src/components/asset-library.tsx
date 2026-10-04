"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  File,
  FileText,
  Film,
  FolderOpen,
  ImageIcon,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import type { Asset } from "@memory/contracts";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, assetUrl, formatBytes, shortDate } from "@/lib/api";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import dynamic from "next/dynamic";
const EvidenceSearchDialog = dynamic(() => import("./evidence-search").then((module) => module.EvidenceSearchDialog));
const VideoSourceViewer = dynamic(() => import("./video-source-viewer").then((module) => module.VideoSourceViewer));

export function AssetLibrary({
  assets,
  onChanged,
  onUse,
  onPreview,
  onCollection,
  title = "资料库",
  onProcessing,
  onMemory,
}: {
  assets: Asset[];
  onChanged: () => Promise<void>;
  onUse?: (ids: string[]) => void;
  onPreview?: (asset: Asset) => void;
  onCollection?: (ids: string[]) => void;
  title?: string;
  onProcessing?: () => void;
  onMemory?: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [grid, setGrid] = useState(false);
  const [uploading, setUploading] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  function openPreview(asset: Asset) {
    if (onPreview) onPreview(asset);
    else {
      setPreview(asset);
      setPreviewError(false);
    }
  }
  const filtered = assets.filter(
    (asset) =>
      (filter === "all" || asset.kind === filter) &&
      asset.name.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    setTextPreview(null);
    if (preview?.kind !== "text") return;
    const controller = new AbortController();
    void fetch(assetUrl(preview.id), {
      headers: { Range: "bytes=0-23999" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok && response.status !== 416)
          throw new Error("读取失败");
        const text = await response.text();
        if (!controller.signal.aborted) setTextPreview(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewError(true);
      });
    return () => controller.abort();
  }, [preview]);

  async function upload(files: FileList | globalThis.File[] | null) {
    if (!files?.length || uploading) return;
    setNotice("");
    const list = Array.from(files);
    let saved = 0;
    try {
      for (const [index, file] of list.entries()) {
        setUploading(index + 1 + " / " + list.length);
        const form = new FormData();
        form.append("file", file);
        await api("/assets", { method: "POST", body: form });
        saved++;
      }
      setNotice("已导入 " + saved + " 个文件");
    } catch (error) {
      setNotice(
        (saved ? "已导入 " + saved + " 个文件；" : "") +
          (error instanceof Error ? error.message : "上传失败"),
      );
    } finally {
      setUploading("");
      if (input.current) input.current.value = "";
      await onChanged();
    }
  }

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-10 lg:px-12",
        dragging && "bg-muted",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(event.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-3 text-2xl font-medium tracking-tight">
            {title}
            <Badge variant="secondary">{assets.length}</Badge>
          </h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setSearchOpen(true)}>检索内容</Button>
          {onProcessing && <Button variant="ghost" size="sm" onClick={onProcessing}>处理与核对</Button>}
          <Button
            onClick={() => input.current?.click()}
            disabled={!!uploading}
            className="h-8 gap-1.5 rounded-lg px-3 text-xs"
          >
            {uploading ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {uploading || "导入"}
          </Button>
          </div>
        </div>
        {!!selected.length && (
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-3">
            <Badge variant="secondary">已选 {selected.length} 份</Badge>
            {onUse && (
              <Button size="sm" onClick={() => onUse(selected)}>
                交给 Agent
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={processing} onClick={async () => {
              setProcessing(true); setNotice("");
              try {
                await api("/asset-processing", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), assetIds: selected }) });
                setNotice(`已提交 ${selected.length} 份资料`); await onChanged();
              } catch (failure) { setNotice(failure instanceof Error ? failure.message : "提交失败"); }
              finally { setProcessing(false); }
            }}>{processing ? "正在提交" : "处理所选"}</Button>
            {onCollection && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCollection(selected)}
              >
                保存为集合
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              清除选择
            </Button>
          </div>
        )}
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          aria-label="选择要上传的资料"
          onChange={(event) => void upload(event.target.files)}
        />
        <div className="mb-6 mt-8 flex flex-wrap items-center justify-between gap-3 border-b pb-5">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="按文件名筛选"
              placeholder="搜索文件"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger aria-label="文件类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ["all", "全部类型"],
                ["image", "图片"],
                ["video", "视频"],
                ["text", "文字"],
                ["file", "其他"],
              ].map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ButtonGroup className="rounded-lg border p-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="列表视图"
              aria-pressed={!grid}
              onClick={() => setGrid(false)}
              className={cn("size-7", !grid && "bg-accent")}
            >
              <List size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="网格视图"
              aria-pressed={grid}
              onClick={() => setGrid(true)}
              className={cn("size-7", grid && "bg-accent")}
            >
              <LayoutGrid size={14} />
            </Button>
          </ButtonGroup>
        </div>
        {notice && (
          <Alert className="mb-5">
            <AlertDescription className="flex items-center justify-between">
              {notice}
              <Button variant="ghost" size="sm" onClick={() => setNotice("")}>
                关闭
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!filtered.length ? (
          <Empty className="min-h-80 border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>
                {assets.length ? "没有匹配的文件" : "拖放文件至此"}
              </EmptyTitle>
            </EmptyHeader>
            {!assets.length && (
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => input.current?.click()}
                >
                  选择文件
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : grid ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {filtered.map((asset) => {
              const Icon =
                asset.kind === "image"
                  ? ImageIcon
                  : asset.kind === "video"
                    ? Film
                    : asset.kind === "text"
                      ? FileText
                      : File;
              return (
                <Button
                  key={asset.id}
                  variant="outline"
                  onClick={() => openPreview(asset)}
                  className="h-auto flex-col overflow-hidden p-0"
                >
                  <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted">
                    {asset.kind === "image" ? (
                      <img
                        src={assetUrl(asset.id)}
                        alt={asset.name}
                        className="size-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Icon className="size-8 text-muted-foreground" />
                    )}
                  </div>
                  <div className="w-full p-3 text-left">
                    <p className="truncate text-xs">{asset.name}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {formatBytes(asset.size)} · {shortDate(asset.createdAt)}
                    </p>
                  </div>
                </Button>
              );
            })}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {onUse && (
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="全选资料"
                      checked={
                        !!filtered.length &&
                        filtered.every((asset) => selected.includes(asset.id))
                      }
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked ? filtered.map((asset) => asset.id) : [],
                        )
                      }
                    />
                  </TableHead>
                )}
                <TableHead>文件名</TableHead>
                <TableHead className="hidden sm:table-cell">添加日期</TableHead>
                <TableHead className="text-right">大小</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((asset) => {
                const Icon =
                  asset.kind === "image"
                    ? ImageIcon
                    : asset.kind === "video"
                      ? Film
                      : asset.kind === "text"
                        ? FileText
                        : File;
                return (
                  <TableRow key={asset.id}>
                    {onUse && (
                      <TableCell>
                        <Checkbox
                          aria-label={"选择 " + asset.name}
                          checked={selected.includes(asset.id)}
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked
                                ? [...selected, asset.id]
                                : selected.filter((id) => id !== asset.id),
                            )
                          }
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-56">
                      <Button
                        variant="ghost"
                        className="max-w-full justify-start"
                        onClick={() => openPreview(asset)}
                      >
                        <Icon className="text-muted-foreground" />
                        <span className="truncate">{asset.name}</span>
                      </Button>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {shortDate(asset.createdAt)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatBytes(asset.size)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-6 text-sm font-medium">
              {preview?.name}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              {preview && formatBytes(preview.size)}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg border bg-background">
                {preview.kind === "image" && !previewError ? (
                  <img
                    src={assetUrl(preview.id)}
                    alt={preview.name}
                    onError={() => setPreviewError(true)}
                    className="max-h-[60dvh] max-w-full object-contain"
                  />
                ) : preview.kind === "video" &&
                  ["video/mp4", "video/webm", "video/ogg"].includes(
                    preview.mimeType,
                  ) &&
                  !previewError ? (
                  <VideoSourceViewer key={preview.id} assetId={preview.id} name={preview.name} version={preview.sha256}
                    onMemory={onMemory ? (id) => { setPreview(null); void onChanged(); onMemory(id); } : undefined} />
                ) : preview.kind === "text" && !previewError ? (
                  textPreview === null ? (
                    <LoaderCircle
                      size={18}
                      className="animate-spin text-muted-foreground"
                    />
                  ) : (
                    <pre className="max-h-[60dvh] w-full overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-7">
                      {textPreview}
                    </pre>
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">
                    无法预览
                  </span>
                )}
              </div>
              <div className="flex justify-end">
                <Button asChild variant="outline" className="h-8 text-xs">
                  <a href={assetUrl(preview.id, true)} download={preview.name}>
                    <ArrowDownToLine size={13} />
                    下载原件
                  </a>
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {searchOpen && <EvidenceSearchDialog onClose={() => setSearchOpen(false)} onUse={onUse} onMemory={onMemory} />}
    </div>
  );
}
