"use client";
import { useEffect, useState } from "react";
import type {
  Artifact as ArtifactRecord,
  Asset,
  MemoryEntry,
} from "@memory/contracts";
import {
  ArrowDownToLine,
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactActions,
  ArtifactAction,
  ArtifactContent,
} from "@/components/ai-elements/artifact";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { api, assetUrl, formatBytes } from "@/lib/api";
import { downloadText, type InspectorTarget } from "@/lib/workbench";
import { Markdown, SourceLinks } from "./run-thread";

export function AssetPreview({
  asset,
  start = 0,
  end,
}: {
  asset: Asset;
  start?: number;
  end?: number;
}) {
  start = Number.isSafeInteger(start) && start >= 0 ? start : 0;
  end = Number.isSafeInteger(end) && end! > start ? end : undefined;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [offset, setOffset] = useState(start);
  useEffect(() => setOffset(start), [asset.id, start]);
  useEffect(() => {
    setText("");
    setError("");
    setLoaded(false);
    if (asset.kind !== "text") return;
    const controller = new AbortController();
    if (!asset.size) {
      setLoaded(true);
      return;
    }
    void fetch(assetUrl(asset.id), {
      headers: {
        Range: `bytes=${offset}-${Math.min(end ? end - 1 : offset + 23999, offset + 23999, asset.size - 1)}`,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("读取失败");
        const content = await response.text();
        if (!controller.signal.aborted) {
          setText(content);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("无法读取资料");
      });
    return () => controller.abort();
  }, [asset.id, asset.kind, asset.size, offset, end]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatBytes(asset.size)}</span>
        <Button variant="ghost" size="sm" asChild>
          <a href={assetUrl(asset.id, true)} download={asset.name}>
            <ArrowDownToLine />
            下载
          </a>
        </Button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : asset.kind === "text" ? (
        loaded ? (
          <>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
              {text}
            </pre>
            {offset + 24000 < Math.min(end || asset.size, asset.size) && (
              <Button
                variant="outline"
                onClick={() => setOffset(offset + 24000)}
              >
                下一段
              </Button>
            )}
          </>
        ) : (
          <LoaderCircle className="size-4 animate-spin" />
        )
      ) : asset.kind === "image" ? (
        <img
          src={assetUrl(asset.id)}
          alt={asset.name}
          className="max-h-[70vh] w-full rounded-md object-contain"
          onError={() => setError("无法预览，请下载原件")}
        />
      ) : asset.kind === "video" ? (
        <video
          controls
          src={assetUrl(asset.id)}
          className="w-full rounded-md"
          onError={() => setError("浏览器不支持此视频格式")}
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>下载原件查看</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

export function ArtifactEditor({
  id,
  onInspect,
  onChanged,
}: {
  id: string;
  onInspect: (target: InspectorTarget) => void;
  onChanged: () => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    setArtifact(null);
    setError("");
    setEditing(false);
    setSelected(0);
    void api<{ artifact: ArtifactRecord; versions: ArtifactRecord[] }>(
      "/artifacts/" + id,
    )
      .then((result) => {
        if (!disposed) {
          setArtifact(result.artifact);
          setVersions(result.versions);
        }
      })
      .catch((failure) => {
        if (!disposed) setError(failure.message);
      });
    return () => {
      disposed = true;
    };
  }, [id]);
  const current = selected
    ? versions.find((version) => version.version === selected) || artifact
    : artifact;
  async function save() {
    if (!artifact) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ artifact: ArtifactRecord }>(
        "/artifacts/" + id,
        {
          method: "PATCH",
          body: JSON.stringify({ title, content, version: artifact.version }),
        },
      );
      setArtifact(result.artifact);
      setVersions([result.artifact, ...versions]);
      setEditing(false);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="mb-3 text-sm">
          {error}
        </p>
      )}
      {current && (
        <Artifact className="rounded-none border-0 shadow-none">
          <ArtifactHeader className="gap-2 bg-transparent px-0">
            <ArtifactTitle className="truncate">{current.title}</ArtifactTitle>
            <ArtifactActions>
              <ArtifactAction
                icon={ArrowDownToLine}
                label="导出结果"
                onClick={() => downloadText(current.title, current.content)}
              />
              <ArtifactAction
                icon={Pencil}
                label="编辑结果"
                disabled={!!selected}
                onClick={() => {
                  setTitle(current.title);
                  setContent(current.content);
                  setEditing(true);
                }}
              />
            </ArtifactActions>
          </ArtifactHeader>
          <div className="flex items-center justify-between gap-2 py-3">
            <span className="text-xs text-muted-foreground">
              {current.author === "user" ? "你编辑了此版本" : "Agent 整理"}
            </span>
            <Select
              value={String(selected)}
              onValueChange={(value) => {
                setSelected(Number(value));
                setEditing(false);
              }}
            >
              <SelectTrigger aria-label="结果版本" size="sm" className="w-auto">
                <History className="size-3" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">最新 · v{artifact?.version}</SelectItem>
                {versions
                  .filter((version) => version.version !== artifact?.version)
                  .map((version) => (
                    <SelectItem
                      key={version.version}
                      value={String(version.version)}
                    >
                      v{version.version} ·{" "}
                      {version.author === "user" ? "你" : "Agent"}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <ArtifactContent className="px-0">
            {editing ? (
              <div className="space-y-4">
                <Input
                  aria-label="结果标题"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Textarea
                  aria-label="结果内容"
                  className="min-h-80 leading-7"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                  <Button
                    disabled={busy || !title.trim()}
                    onClick={() => void save()}
                  >
                    保存修改
                  </Button>
                </div>
              </div>
            ) : (
              <Markdown content={current.content} />
            )}
          </ArtifactContent>
          <Separator className="my-4" />
          <SourceLinks sources={current.sources} onInspect={onInspect} />
        </Artifact>
      )}
    </>
  );
}

export function MemoryEditor({
  id,
  onInspect,
  onChanged,
}: {
  id: string;
  onInspect: (target: InspectorTarget) => void;
  onChanged: () => void;
}) {
  const [memory, setMemory] = useState<MemoryEntry | null>(null);
  const [versions, setVersions] = useState<MemoryEntry[]>([]);
  const [conflicts, setConflicts] = useState<MemoryEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: "",
    content: "",
    occurredAt: "",
    reason: "",
    category: "fact",
    people: "",
    place: "",
    attributeKey: "none",
    attributeValue: "",
    uncertainty: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    let disposed = false;
    setMemory(null);
    setEditing(false);
    setError("");
    setShowHistory(false);
    setConflicts([]);
    void api<{
      memory: MemoryEntry;
      versions: MemoryEntry[];
      conflicts: MemoryEntry[];
    }>("/memories/" + id)
      .then((result) => {
        if (!disposed) {
          setMemory(result.memory);
          setVersions(result.versions);
          setConflicts(result.conflicts);
        }
      })
      .catch((failure) => {
        if (!disposed) setError(failure.message);
      });
    return () => {
      disposed = true;
    };
  }, [id]);
  async function update(patch: Record<string, unknown>) {
    if (!memory) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        memory: MemoryEntry;
        conflicts: MemoryEntry[];
      }>("/memories/" + id, {
        method: "PATCH",
        body: JSON.stringify({ ...patch, version: memory.version }),
      });
      setMemory(result.memory);
      setConflicts(result.conflicts);
      setVersions([result.memory, ...versions]);
      setEditing(false);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function resolveConflict() {
    if (!memory) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ memory: MemoryEntry }>(
        "/memories/" + memory.id + "/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            version: memory.version,
            replace: conflicts.map((entry) => ({
              id: entry.id,
              version: entry.version,
            })),
          }),
        },
      );
      setMemory(result.memory);
      setVersions([result.memory, ...versions]);
      setConflicts([]);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
      const latest = await api<{
        memory: MemoryEntry;
        versions: MemoryEntry[];
        conflicts: MemoryEntry[];
      }>("/memories/" + id).catch(() => null);
      if (latest) {
        setMemory(latest.memory);
        setVersions(latest.versions);
        setConflicts(latest.conflicts);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {memory && (
        <>
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium leading-6">{memory.title}</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="纠正记忆"
              onClick={() => {
                setForm({
                  title: memory.title,
                  content: memory.content,
                  occurredAt: memory.occurredAt,
                  reason: "",
                  category: memory.category || "fact",
                  people: (memory.people || []).join("、"),
                  place: memory.place || "",
                  attributeKey: memory.attribute?.key || "none",
                  attributeValue: memory.attribute?.value || "",
                  uncertainty: memory.uncertainty || "",
                });
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>
              {memory.supersededBy
                ? "历史记录"
                : memory.status === "draft"
                  ? "待核对"
                  : memory.status === "confirmed"
                    ? "已确认"
                    : "已排除"}
            </span>
            <span>·</span>
            <span>
              {memory.kind === "statement"
                ? "你的陈述"
                : memory.kind === "observation"
                  ? "资料观察"
                  : "推断"}
            </span>
            {memory.occurredAt && (
              <>
                <span>·</span>
                <span>{memory.occurredAt}</span>
              </>
            )}
          </div>
          {memory.space === "demo" && <Badge variant="outline">虚构示例</Badge>}
          {editing ? (
            <div className="space-y-3">
              <Input
                aria-label="记忆标题"
                value={form.title}
                onChange={(event) =>
                  setForm({ ...form, title: event.target.value })
                }
              />
              <Textarea
                aria-label="记忆内容"
                value={form.content}
                onChange={(event) =>
                  setForm({ ...form, content: event.target.value })
                }
                className="min-h-40 leading-7"
              />
              <Input
                aria-label="发生时间"
                placeholder="发生时间"
                value={form.occurredAt}
                onChange={(event) =>
                  setForm({ ...form, occurredAt: event.target.value })
                }
              />
              <Input
                aria-label="纠正原因"
                placeholder="纠正原因（可选）"
                value={form.reason}
                onChange={(event) =>
                  setForm({ ...form, reason: event.target.value })
                }
              />
              <Field>
                <FieldLabel>记忆分类</FieldLabel>
                <Select
                  value={form.category}
                  onValueChange={(category) => setForm({ ...form, category })}
                >
                  <SelectTrigger aria-label="记忆分类" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      ["profile", "关于我"],
                      ["event", "经历"],
                      ["relationship", "关系"],
                      ["fact", "记录"],
                    ].map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Input
                aria-label="相关人物"
                placeholder="相关人物，以顿号分隔"
                value={form.people}
                onChange={(event) =>
                  setForm({ ...form, people: event.target.value })
                }
              />
              <Input
                aria-label="经历地点"
                placeholder="地点"
                maxLength={120}
                value={form.place}
                onChange={(event) =>
                  setForm({ ...form, place: event.target.value })
                }
              />
              {form.category === "profile" && (
                <div className="space-y-2">
                  <Select
                    value={form.attributeKey}
                    onValueChange={(attributeKey) =>
                      setForm({ ...form, attributeKey })
                    }
                  >
                    <SelectTrigger aria-label="个人画像字段" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        ["none", "不设置单值属性"],
                        ["name", "我的姓名"],
                        ["home_city", "现居城市"],
                        ["occupation", "当前职业"],
                        ["employer", "工作单位"],
                      ].map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.attributeKey !== "none" && (
                    <Input
                      aria-label="个人画像属性值"
                      placeholder="当前值"
                      maxLength={120}
                      value={form.attributeValue}
                      onChange={(event) =>
                        setForm({ ...form, attributeValue: event.target.value })
                      }
                    />
                  )}
                </div>
              )}
              <Input
                aria-label="待核实信息"
                placeholder="待核实信息"
                maxLength={500}
                value={form.uncertainty}
                onChange={(event) =>
                  setForm({ ...form, uncertainty: event.target.value })
                }
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  取消
                </Button>
                <Button
                  disabled={busy || !form.title.trim() || !form.content.trim()}
                  onClick={() => {
                    const { attributeKey, attributeValue, people, ...patch } =
                      form;
                    void update({
                      ...patch,
                      people: [
                        ...new Set(
                          people
                            .split(/[、,，\n]/)
                            .map((value) => value.trim())
                            .filter(Boolean),
                        ),
                      ],
                      attribute:
                        form.category === "profile" &&
                        attributeKey !== "none" &&
                        attributeValue.trim()
                          ? { key: attributeKey, value: attributeValue.trim() }
                          : null,
                    });
                  }}
                >
                  保存纠正
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-7">
              {memory.content}
            </p>
          )}
          {!editing && (memory.people?.length || memory.place) ? (
            <p className="text-xs text-muted-foreground">
              {[memory.people?.join("、"), memory.place]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {memory.uncertainty && (
            <p className="text-sm text-muted-foreground">
              待核实 · {memory.uncertainty}
            </p>
          )}
          {memory.sources
            .filter((source) => source.quote)
            .map((source, index) => (
              <blockquote
                key={index}
                className="space-y-1 border-l-2 pl-3 text-sm leading-6 text-muted-foreground"
              >
                <p className="text-xs">原文 · {source.name}</p>
                <p className="whitespace-pre-wrap">{source.quote}</p>
              </blockquote>
            ))}
          <SourceLinks sources={memory.sources} onInspect={onInspect} />
          {memory.ingestion && (
            <p className="text-xs text-muted-foreground">
              {memory.ingestion.modelId.split("/").slice(1).join("/")} ·
              提取版本 {memory.ingestion.extractorVersion}
            </p>
          )}
          {memory.supersededBy && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onInspect({ tab: "memories", id: memory.supersededBy })
              }
            >
              查看当前记录
            </Button>
          )}
          {conflicts.length > 0 && !memory.supersededBy && (
            <Alert>
              <AlertTitle>与已确认信息不同</AlertTitle>
              <AlertDescription className="space-y-3">
                {conflicts.map((previous) => (
                  <div key={previous.id} className="space-y-1">
                    <p>{previous.content}</p>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      onClick={() =>
                        onInspect({ tab: "memories", id: previous.id })
                      }
                    >
                      查看原记忆
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  disabled={busy || editing}
                  onClick={() => void resolveConflict()}
                >
                  确认新记录并替代旧记录
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {memory.statement && (
            <blockquote className="border-l-2 pl-3 text-sm leading-6 text-muted-foreground">
              {memory.statement}
            </blockquote>
          )}
          <div className="flex flex-wrap gap-2">
            {memory.status !== "confirmed" &&
              !memory.supersededBy &&
              conflicts.length === 0 && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void update({ status: "confirmed" })}
                >
                  <Check />
                  确认记住
                </Button>
              )}
            {memory.status !== "rejected" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void update({ status: "rejected" })}
              >
                {memory.status === "confirmed" ? "停止使用" : "排除"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory(!showHistory)}
            >
              <History />
              修订记录
            </Button>
          </div>
          {showHistory && (
            <div className="space-y-4 border-t pt-4">
              {versions.map((version) => (
                <div key={version.version} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    v{version.version} ·{" "}
                    {new Date(version.updatedAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="text-sm leading-6">{version.content}</p>
                  {version.reason && (
                    <p className="text-xs text-muted-foreground">
                      {version.reason}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {version.status === "confirmed"
                      ? "已确认"
                      : version.status === "draft"
                        ? "待核对"
                        : "已排除"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function WorkbenchInspector({
  target,
  assets,
  artifacts,
  memories,
  onTarget,
  onClose,
  onChanged,
  onUseAsset,
}: {
  target: InspectorTarget;
  assets: Asset[];
  artifacts: ArtifactRecord[];
  memories: MemoryEntry[];
  onTarget: (target: InspectorTarget) => void;
  onClose: () => void;
  onChanged: () => void;
  onUseAsset: (asset: Asset) => void;
}) {
  const [resolvedAsset, setResolvedAsset] = useState<Asset>();
  const [assetError, setAssetError] = useState("");
  const listedAsset =
    target.tab === "assets"
      ? assets.find((asset) => asset.id === target.id)
      : undefined;
  useEffect(() => {
    setResolvedAsset(undefined);
    setAssetError("");
    if (listedAsset || target.tab !== "assets" || !target.id) return;
    const controller = new AbortController();
    void api<{ asset: Asset }>("/assets/" + target.id, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setResolvedAsset(result.asset);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setAssetError(
            failure instanceof Error ? failure.message : "读取失败",
          );
      });
    return () => controller.abort();
  }, [listedAsset, target.tab, target.id]);
  const asset =
    listedAsset ||
    (resolvedAsset?.id === target.id ? resolvedAsset : undefined);
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="workbench-inspector"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <Tabs
          value={target.tab}
          onValueChange={(tab) =>
            onTarget({ tab: tab as InspectorTarget["tab"] })
          }
        >
          <TabsList variant="line" className="h-12 gap-3 rounded-none px-0">
            <TabsTrigger value="assets">资料</TabsTrigger>
            <TabsTrigger value="artifacts">结果</TabsTrigger>
            <TabsTrigger value="memories">记忆</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="关闭工作区"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {target.id && (
          <Button
            size="sm"
            variant="ghost"
            className="mb-4 -ml-2"
            onClick={() => onTarget({ tab: target.tab })}
          >
            <ArrowLeft />
            返回列表
          </Button>
        )}
        {target.tab === "assets" &&
          (asset ? (
            <div>
              <h3 className="mb-3 break-words font-medium">{asset.name}</h3>
              <AssetPreview
                asset={asset}
                start={target.start}
                end={target.end}
              />
              {asset.memorySpace !== "demo" && (
                <Button
                  className="mt-5"
                  variant="outline"
                  size="sm"
                  onClick={() => onUseAsset(asset)}
                >
                  <Plus />
                  用于当前任务
                </Button>
              )}
            </div>
          ) : target.id ? (
            <p className="text-sm text-muted-foreground">
              {assetError || "正在读取资料…"}
            </p>
          ) : (
            <div className="space-y-1">
              {assets.map((asset) => (
                <Button
                  key={asset.id}
                  variant="ghost"
                  className="h-auto w-full justify-start py-3"
                  onClick={() => onTarget({ tab: "assets", id: asset.id })}
                >
                  <FileText />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {asset.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(asset.size)}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        {target.tab === "artifacts" &&
          (target.id ? (
            <ArtifactEditor
              key={target.id}
              id={target.id}
              onInspect={onTarget}
              onChanged={onChanged}
            />
          ) : (
            <div className="space-y-2">
              {artifacts.map((artifact) => (
                <Button
                  key={artifact.id}
                  variant="outline"
                  className="h-auto w-full justify-start py-4"
                  onClick={() =>
                    onTarget({ tab: "artifacts", id: artifact.id })
                  }
                >
                  <FileText />
                  <span className="truncate">{artifact.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    v{artifact.version}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        {target.tab === "memories" &&
          (target.id ? (
            <MemoryEditor
              key={target.id}
              id={target.id}
              onInspect={onTarget}
              onChanged={onChanged}
            />
          ) : (
            <div className="space-y-2">
              {memories.map((memory) => (
                <Button
                  key={memory.id}
                  variant="ghost"
                  className="h-auto w-full justify-start py-3"
                  onClick={() => onTarget({ tab: "memories", id: memory.id })}
                >
                  <BookOpen />
                  <span className="truncate">{memory.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {memory.status === "draft"
                      ? "待核对"
                      : memory.status === "confirmed"
                        ? "已确认"
                        : "已排除"}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        {!target.id &&
          !(target.tab === "assets"
            ? assets.length
            : target.tab === "artifacts"
              ? artifacts.length
              : memories.length) && (
            <Empty className="min-h-48">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {target.tab === "memories" ? <BookOpen /> : <FileText />}
                </EmptyMedia>
                <EmptyTitle className="text-sm">
                  {target.tab === "assets"
                    ? "还没有资料"
                    : target.tab === "artifacts"
                      ? "结果将保存在这里"
                      : "还没有相关记忆"}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
      </div>
    </div>
  );
}
