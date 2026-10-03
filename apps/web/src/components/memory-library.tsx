"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type {
  Asset,
  MemoryEntry,
  MemoryOverview,
  MemorySpace,
  ModelInfo,
} from "@memory/contracts";
import {
  BookOpen,
  Check,
  GitMerge,
  Plus,
  Search,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { api } from "@/lib/api";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { MemoryImportList } from "./memory-import-list";
const MemoryImportDialog = dynamic(() =>
  import("./memory-import-dialog").then((module) => module.MemoryImportDialog),
);
const categories = {
  profile: "关于我",
  event: "经历",
  relationship: "关系",
  fact: "记录",
};

export function MemoryLibrary({
  memories: initialMemories,
  assets,
  models,
  onOpen,
  onChanged,
  onClearInspector,
}: {
  memories: MemoryEntry[];
  assets: Asset[];
  models: ModelInfo[];
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  onClearInspector: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"new" | "merge" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [space, setSpace] = useState<MemorySpace>("personal");
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [revision, setRevision] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [visible, setVisible] = useState(50);
  const memories =
    overview?.memories || (space === "personal" ? initialMemories : []);
  const jobs = overview?.jobs || [];
  const pending = memories.filter((memory) => memory.status === "draft").length;
  const confirmed = memories.filter(
    (memory) => memory.status === "confirmed" && !memory.supersededBy,
  ).length;
  useEffect(() => {
    if (new URL(window.location.href).searchParams.get("space") === "demo")
      setSpace("demo");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasActive = false;
    async function load() {
      try {
        const result = await api<MemoryOverview>(
          "/memory-overview?space=" + space,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setOverview(result);
        const active = result.jobs.some(
          (job) => job.status === "running" || job.status === "queued",
        );
        if (active) timer = setTimeout(() => void load(), 1500);
        if (wasActive && !active) void onChanged();
        wasActive = active;
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "读取失败");
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [space, revision, initialMemories, onChanged]);
  function changeSpace(value: MemorySpace) {
    onClearInspector();
    setSpace(value);
    setOverview(null);
    setSelected([]);
    setPerson("");
    setQuery("");
    setError("");
    setVisible(50);
    const url = new URL(window.location.href);
    if (value === "demo") url.searchParams.set("space", "demo");
    else url.searchParams.delete("space");
    window.history.replaceState({}, "", url);
  }
  function changeFilter(value: string) {
    setFilter(value);
    setSelected([]);
    setVisible(50);
  }
  const filtered = memories
    .filter(
      (memory) =>
        (filter === "all" || filter === "timeline" || filter === "profile"
          ? memory.status !== "rejected" &&
            (filter === "timeline" || !memory.supersededBy)
          : memory.status === filter) &&
        (filter !== "profile" ||
          (memory.category === "profile" && memory.status === "confirmed")) &&
        (!person || memory.people?.includes(person)) &&
        (filter !== "timeline" ||
          ((!from || memory.occurredAt >= from) &&
            (!to || (!!memory.occurredAt && memory.occurredAt <= to)))) &&
        (
          memory.title +
          memory.content +
          (memory.people || []).join(" ") +
          (memory.place || "")
        )
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      filter === "timeline"
        ? (b.occurredAt || b.createdAt).localeCompare(
            a.occurredAt || a.createdAt,
          )
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  async function save() {
    setBusy(true);
    setError("");
    try {
      const payload =
        mode === "merge"
          ? {
              title,
              content,
              entries: selected.map((id) => ({
                id,
                version: memories.find((memory) => memory.id === id)!.version,
              })),
            }
          : { title, content, occurredAt: date, space };
      const result = await api<{ memory: MemoryEntry }>(
        mode === "merge" ? "/memories/merge" : "/memories",
        { method: "POST", body: JSON.stringify(payload) },
      );
      setMode(null);
      setSelected([]);
      await onChanged();
      setRevision((value) => value + 1);
      onOpen(result.memory.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function review(status: "confirmed" | "rejected") {
    setBusy(true);
    setError("");
    try {
      await api("/memories/review", {
        method: "POST",
        body: JSON.stringify({
          status,
          entries: selected.map((id) => ({
            id,
            version: memories.find((memory) => memory.id === id)!.version,
          })),
        }),
      });
      setSelected([]);
      setRevision((value) => value + 1);
      await onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-10 sm:px-10 lg:px-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">个人记忆</h1>
            <p className="text-sm text-muted-foreground">
              {confirmed} 条已确认 · {pending} 条待核对
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={space}
              onValueChange={(value) => changeSpace(value as MemorySpace)}
            >
              <SelectTrigger
                aria-label="记忆空间"
                size="sm"
                className="border-0 shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">我的记忆</SelectItem>
                <SelectItem value="demo">虚构示例</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode("new");
                setTitle("");
                setContent("");
                setDate("");
                setError("");
              }}
            >
              <Plus />
              添加记忆
            </Button>
            <Button size="sm" onClick={() => setImportOpen(true)}>
              <Upload />
              导入经历
            </Button>
          </div>
        </div>
        {space === "demo" && (
          <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">虚构示例</Badge>
            <span>独立于你的个人记忆</span>
          </div>
        )}
        <div className="mb-6 space-y-4">
          <Tabs
            value={
              filter === "confirmed" || filter === "rejected" ? "all" : filter
            }
            onValueChange={changeFilter}
            className="min-w-0 overflow-x-auto border-b"
          >
            <TabsList variant="line" className="w-max gap-3 px-0">
              {[
                ["all", "全部"],
                ["profile", "关于我"],
                ["timeline", "时间线"],
                ["people", "人物"],
                ["draft", "待核对"],
                ["imports", "处理记录"],
              ].map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                  {value === "draft" &&
                    memories.some((memory) => memory.status === "draft") && (
                      <Badge variant="secondary">
                        {
                          memories.filter((memory) => memory.status === "draft")
                            .length
                        }
                      </Badge>
                    )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {filter !== "imports" && (
            <div className="flex flex-wrap items-center gap-3">
              <InputGroup className="min-w-0 flex-1 sm:max-w-72">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="搜索记忆"
                  placeholder="搜索记忆"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
              {filter === "all" ||
              filter === "confirmed" ||
              filter === "rejected" ? (
                <Select value={filter} onValueChange={changeFilter}>
                  <SelectTrigger aria-label="记忆状态" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="confirmed">已确认</SelectItem>
                    <SelectItem value="rejected">已排除</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {filter === "timeline" && (
                <div className="flex max-w-full items-center gap-2">
                  <Input
                    type="date"
                    aria-label="开始日期"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    className="w-36"
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="date"
                    aria-label="结束日期"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="w-36"
                  />
                </div>
              )}
              {person && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPerson("")}
                >
                  {person}
                  <X />
                </Button>
              )}
            </div>
          )}
        </div>
        {error && !mode && (
          <p role="alert" className="mb-4 text-sm">
            {error}
          </p>
        )}
        {selected.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="mr-2 text-xs text-muted-foreground">
              已选 {selected.length} 条
            </span>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void review("confirmed")}
            >
              <Check />
              确认所选
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void review("rejected")}
            >
              排除所选
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              取消选择
            </Button>
          </div>
        )}
        {selected.length >= 2 && (
          <Button
            variant="outline"
            size="sm"
            className="mb-4"
            onClick={() => {
              setMode("merge");
              const entries = memories.filter((memory) =>
                selected.includes(memory.id),
              );
              setTitle(entries[0].title);
              setContent(entries.map((memory) => memory.content).join("\n\n"));
              setError("");
            }}
          >
            <GitMerge />
            合并 {selected.length} 条记忆
          </Button>
        )}
        {filter === "imports" ? (
          <MemoryImportList
            jobs={jobs}
            memories={memories}
            onChanged={() => setRevision((value) => value + 1)}
            onOpen={onOpen}
            onImport={() => setImportOpen(true)}
          />
        ) : filter === "people" ? (
          !overview?.people.length ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>还没有提及的人物</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>人物称呼</TableHead>
                  <TableHead>已确认</TableHead>
                  <TableHead>关联记录</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.people
                  .filter((value) =>
                    value.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((value) => (
                    <TableRow key={value.name}>
                      <TableCell>
                        <Button
                          variant="ghost"
                          className="px-0"
                          onClick={() => {
                            setPerson(value.name);
                            setQuery("");
                            changeFilter("all");
                          }}
                        >
                          <Users className="text-muted-foreground" />
                          {value.name}
                        </Button>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {value.confirmedCount}
                      </TableCell>
                      <TableCell>{value.memoryIds.length}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )
        ) : !filtered.length ? (
          <Empty className="min-h-64 border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpen />
              </EmptyMedia>
              <EmptyTitle>
                {query ? "没有匹配的记忆" : "还没有这类记忆"}
              </EmptyTitle>
            </EmptyHeader>
            {!query && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportOpen(true)}
              >
                导入经历
              </Button>
            )}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="选择全部记忆"
                    checked={filtered
                      .slice(0, Math.min(visible, 50))
                      .every((memory) => selected.includes(memory.id))}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? filtered
                              .slice(0, Math.min(visible, 50))
                              .map((memory) => memory.id)
                          : [],
                      )
                    }
                  />
                </TableHead>
                <TableHead>记忆</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {filter === "timeline" ? "发生时间" : "来源"}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice(0, visible).map((memory) => (
                <TableRow key={memory.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={"选择记忆 " + memory.title}
                      checked={selected.includes(memory.id)}
                      disabled={
                        selected.length >= 50 && !selected.includes(memory.id)
                      }
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, memory.id]
                            : selected.filter((id) => id !== memory.id),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell className="max-w-80">
                    <Button
                      variant="ghost"
                      className="h-auto max-w-full flex-col items-start gap-1 whitespace-normal px-0 text-left"
                      onClick={() => onOpen(memory.id)}
                    >
                      <span className="font-medium">{memory.title}</span>
                      <span className="line-clamp-2 text-sm font-normal text-muted-foreground">
                        {memory.content}
                      </span>
                      {memory.category && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {categories[memory.category]}
                          {memory.people?.length
                            ? " · " + memory.people.join("、")
                            : ""}
                        </span>
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {memory.supersededBy
                        ? "历史记录"
                        : overview?.conflicts[memory.id]?.length
                          ? "待处理冲突"
                          : memory.status === "draft"
                            ? "待核对"
                            : memory.status === "confirmed"
                              ? "已确认"
                              : "已排除"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {filter === "timeline"
                      ? memory.occurredAt || "时间未确定"
                      : memory.sources.length
                        ? `${memory.sources.length} 处资料`
                        : "你的陈述"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {filter !== "imports" &&
          filter !== "people" &&
          filtered.length > visible && (
            <Button
              variant="ghost"
              className="mt-4 w-full"
              onClick={() => setVisible((value) => value + 50)}
            >
              加载更多 · 还有 {filtered.length - visible} 条
            </Button>
          )}
        {importOpen && (
          <MemoryImportDialog
            space={space}
            assets={assets}
            models={models}
            onClose={() => setImportOpen(false)}
            onStarted={(job) => {
              if (job.space !== space) changeSpace(job.space);
              setImportOpen(false);
              changeFilter("imports");
              setRevision((value) => value + 1);
              void onChanged();
            }}
          />
        )}
        <Dialog
          open={!!mode}
          onOpenChange={(open) => {
            if (!open) setMode(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {mode === "merge" ? "合并记忆" : "添加个人记忆"}
              </DialogTitle>
              <DialogDescription>
                {mode === "merge"
                  ? "原记录保留修订历史，合并后的内容待核对。"
                  : "你填写的信息会作为已确认记忆保存。"}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Field>
                <FieldLabel htmlFor="new-memory-title">标题</FieldLabel>
                <Input
                  id="new-memory-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={120}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-memory-content">内容</FieldLabel>
                <Textarea
                  id="new-memory-content"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  required
                  maxLength={4000}
                  className="min-h-40"
                />
              </Field>
              {mode === "new" && (
                <Field>
                  <FieldLabel htmlFor="new-memory-date">发生时间</FieldLabel>
                  <Input
                    id="new-memory-date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    placeholder="可选"
                  />
                </Field>
              )}
              {error && <p role="alert">{error}</p>}
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={busy || !title.trim() || !content.trim()}
                >
                  保存记忆
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
