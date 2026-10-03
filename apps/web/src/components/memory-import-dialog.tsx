"use client";
import { useRef, useState } from "react";
import type {
  Asset,
  MemoryImportJob,
  MemorySpace,
  ModelInfo,
  ThinkingLevel,
} from "@memory/contracts";
import { FileText, LoaderCircle, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { api, formatBytes } from "@/lib/api";

export function MemoryImportDialog({
  space,
  assets,
  models,
  onClose,
  onStarted,
}: {
  space: MemorySpace;
  assets: Asset[];
  models: ModelInfo[];
  onClose: () => void;
  onStarted: (job: MemoryImportJob) => void;
}) {
  const [mode, setMode] = useState("write");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [modelId, setModelId] = useState(models[0]?.id || "");
  const [thinking, setThinking] = useState<ThinkingLevel>("low");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef("");
  const model = models.find((item) => item.id === modelId);
  const ready =
    !!model &&
    (mode === "demo" ||
      (mode === "write" && !!name.trim() && !!text.trim()) ||
      (mode === "files" && files.length > 0) ||
      (mode === "library" && selected.length > 0));

  async function readFiles(values: File[]) {
    setReading(true);
    setError("");
    try {
      if (
        files.length + values.length > 20 ||
        values.some((file) => file.size > 256 * 1024)
      )
        throw new Error("每批最多 20 份文件，每份不超过 256 KB");
      const records = await Promise.all(
        values.map(async (file) => {
          const content = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(await file.arrayBuffer());
          if (!content.trim() || content.includes("\0"))
            throw new Error("请使用非空的 UTF-8 文本文件");
          return { name: file.name, text: content };
        }),
      );
      setFiles((previous) => [...previous, ...records]);
      requestId.current = "";
    } catch (failure) {
      setError(
        failure instanceof TypeError
          ? "文件不是有效的 UTF-8 编码"
          : failure instanceof Error
            ? failure.message
            : "无法读取文件",
      );
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await api<{ job: MemoryImportJob }>("/memory-imports", {
        method: "POST",
        body: JSON.stringify({
          requestId: requestId.current,
          modelId,
          thinkingLevel: model?.reasoning ? thinking : "off",
          space,
          ...(mode === "demo"
            ? { demo: true }
            : mode === "library"
              ? { assetIds: selected }
              : {
                  records:
                    mode === "write" ? [{ name: name.trim(), text }] : files,
                }),
        }),
      });
      onStarted(result.job);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导入经历</DialogTitle>
          <DialogDescription className="sr-only">
            选择文字记录和处理模型，生成可核对的记忆。
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            setMode(value);
            requestId.current = "";
            setError("");
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="write" disabled={busy}>
              写记录
            </TabsTrigger>
            <TabsTrigger value="files" disabled={busy}>
              文字文件
            </TabsTrigger>
            {space === "personal" && (
              <TabsTrigger value="library" disabled={busy}>
                资料库
              </TabsTrigger>
            )}
            <TabsTrigger value="demo" disabled={busy}>
              虚构示例
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === "write" && (
          <div className="space-y-4">
            <Field>
              <FieldLabel htmlFor="experience-title">记录标题</FieldLabel>
              <Input
                id="experience-title"
                placeholder="一次散步"
                value={name}
                maxLength={200}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  requestId.current = "";
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="experience-text">经历原文</FieldLabel>
              <Textarea
                id="experience-text"
                placeholder="记录发生的事情……"
                className="min-h-52 resize-y leading-7"
                value={text}
                maxLength={60000}
                disabled={busy}
                onChange={(event) => {
                  setText(event.target.value);
                  requestId.current = "";
                }}
              />
            </Field>
          </div>
        )}
        {mode === "files" && (
          <div className="space-y-3 py-3">
            <Input
              ref={input}
              className="sr-only"
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              aria-label="选择文字文件"
              onChange={(event) =>
                void readFiles(Array.from(event.target.files || []))
              }
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={reading || busy}
              onClick={() => input.current?.click()}
            >
              <Upload />
              选择文件
            </Button>
            <div className="max-h-60 overflow-y-auto divide-y">
              {files.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 py-3 text-sm"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(new TextEncoder().encode(file.text).length)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={"移除文件 " + file.name}
                    onClick={() => {
                      setFiles(files.filter((_, i) => i !== index));
                      requestId.current = "";
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
            {reading && (
              <LoaderCircle className="mx-auto size-4 animate-spin" />
            )}
          </div>
        )}
        {mode === "library" && (
          <div className="space-y-3">
            <Input
              aria-label="查找文字资料"
              placeholder="查找文字资料"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-64 overflow-y-auto divide-y">
              {assets
                .filter(
                  (asset) =>
                    asset.kind === "text" &&
                    asset.name.toLowerCase().includes(query.toLowerCase()),
                )
                .slice(0, 100)
                .map((asset) => (
                  <label
                    key={asset.id}
                    className="flex cursor-pointer items-center gap-3 py-3 text-sm"
                  >
                    <Checkbox
                      disabled={
                        busy ||
                        (selected.length >= 20 && !selected.includes(asset.id))
                      }
                      checked={selected.includes(asset.id)}
                      onCheckedChange={(checked) => {
                        setSelected(
                          checked
                            ? [...selected, asset.id]
                            : selected.filter((id) => id !== asset.id),
                        );
                        requestId.current = "";
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {asset.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(asset.size)}
                    </span>
                  </label>
                ))}
              {!assets.some((asset) => asset.kind === "text") && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  暂无文字资料
                </p>
              )}
            </div>
          </div>
        )}
        {mode === "demo" && (
          <div className="space-y-5 py-5">
            <div className="flex items-center justify-between">
              <span className="font-medium">林舟的经历</span>
              <Badge variant="outline">虚构 · 独立空间</Badge>
            </div>
            <div className="divide-y text-sm">
              {[
                "自述与生活习惯",
                "和朋友在运河边散步",
                "从杭州搬到苏州",
                "一张日期未明的旧便签",
              ].map((title, index) => (
                <div key={title} className="flex items-center gap-3 py-3">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    0{index + 1}
                  </span>
                  {title}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              由所选模型实际提取。示例不会进入你的个人记忆。
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Select
            value={modelId}
            onValueChange={(value) => {
              setModelId(value);
              requestId.current = "";
            }}
            disabled={busy || !models.length}
          >
            <SelectTrigger
              aria-label="记忆提取模型"
              className="min-w-0 max-w-full flex-1"
            >
              <SelectValue placeholder="请先配置模型" />
            </SelectTrigger>
            <SelectContent>
              {models.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model?.reasoning && (
            <Select
              value={thinking}
              onValueChange={(value) => {
                setThinking(value as ThinkingLevel);
                requestId.current = "";
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label="记忆提取思考强度" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ["off", "关闭思考"],
                  ["minimal", "最少思考"],
                  ["low", "低"],
                  ["medium", "中"],
                  ["high", "高"],
                  ["xhigh", "更高"],
                  ["max", "最高"],
                ].map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!ready || busy || reading}
            onClick={() => void start()}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
            开始提取
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
