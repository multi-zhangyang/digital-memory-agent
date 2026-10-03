"use client";
import {
  Context,
  ContextContentHeader,
} from "@/components/ai-elements/context";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, formatBytes } from "@/lib/api";
import { isActive } from "@/lib/workbench";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  readEditorDraft,
  saveEditorDraft,
  type ProjectDocument,
} from "@/lib/editor-drafts";
import type {
  FileChange,
  Project,
  ProjectFile,
  Run,
  SessionState,
} from "@memory/contracts";
import {
  ArrowLeft,
  ChevronRight,
  Cpu,
  Download,
  Files,
  FolderOpen,
  Copy,
  Check,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  Minimize2,
  Plus,
  RefreshCw,
  Save,
  TerminalSquare,
  Upload,
  X,
  MessageSquarePlus,
  Maximize2,
  File,
  Search,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
const FileDiff = dynamic(
  () => import("./file-diff").then((module) => module.FileDiff),
  { loading: () => <Skeleton className="m-3 h-32" /> },
);
const CodeBlock = dynamic(
  () => import("@/components/ai-elements/code-block").then((m) => m.CodeBlock),
  { loading: () => <Skeleton className="h-40 w-full" /> },
);
function fileTree(files: ProjectFile[]): React.ReactNode {
  const children = new Map<string, ProjectFile[]>();
  for (const file of files) {
    const parent = file.path.split("/").slice(0, -1).join("/");
    const siblings = children.get(parent) || [];
    siblings.push(file);
    children.set(parent, siblings);
  }
  const render = (parent: string): React.ReactNode =>
    (children.get(parent) || []).map((f) =>
      f.directory ? (
        <FileTreeFolder
          key={f.path}
          path={f.path}
          name={f.path.split("/").at(-1)!}
        >
          {render(f.path)}
        </FileTreeFolder>
      ) : (
        <FileTreeFile
          key={f.path}
          path={f.path}
          name={f.path.split("/").at(-1)!}
        />
      ),
    );
  return render("");
}
function language(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase() || "";
  return (
    (
      {
        py: "python",
        js: "javascript",
        jsx: "jsx",
        ts: "typescript",
        tsx: "tsx",
        json: "json",
        md: "markdown",
        html: "html",
        css: "css",
        sh: "bash",
        yaml: "yaml",
        yml: "yaml",
        sql: "sql",
        rs: "rust",
      } as const
    )[extension as "py"] || "text"
  );
}
function ChangeView({
  change,
  onRevert,
  disabled,
  onComment,
  viewed,
  onViewed,
}: {
  change: FileChange;
  onRevert: () => void;
  disabled: boolean;
  onComment: (text: string) => boolean;
  viewed: boolean;
  onViewed: (viewed: boolean) => void;
}) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  return (
    <section className="min-w-0" aria-label={"文件差异 " + change.path}>
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={change.path}
        >
          {change.path}
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            aria-label={"已查看 " + change.path}
            checked={viewed}
            onCheckedChange={(value) => onViewed(value === true)}
          />
          已查看
        </label>
        <Popover open={commentOpen} onOpenChange={setCommentOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={"评论 " + change.path}
            >
              <MessageSquarePlus className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 max-w-[calc(100vw-2rem)] p-3"
          >
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (comment.trim() && onComment(comment.trim())) {
                  setComment("");
                  setCommentOpen(false);
                }
              }}
            >
              <p className="truncate font-mono text-xs text-muted-foreground">
                {change.path}
              </p>
              <Textarea
                aria-label="审阅意见"
                placeholder="希望 Agent 如何调整…"
                value={comment}
                maxLength={10000}
                onChange={(event) => setComment(event.target.value)}
                className="min-h-24"
              />
              <div className="flex justify-end">
                <Button size="sm" type="submit" disabled={!comment.trim()}>
                  加入对话
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
        <Button
          aria-label={"回退 " + change.path}
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          onClick={onRevert}
        >
          <RefreshCw />
        </Button>
      </div>
      <FileDiff change={change} />
    </section>
  );
}
export function ProjectWorkspace({
  project,
  tab,
  reviewRunId,
  reviewPath,
  onReviewRunChange,
  onReviewPathChange,
  onReviewComment,
  fileRequest,
  expanded: workspaceExpanded,
  onExpand,
  onFindFile,
  onTabChange: setTab,
  conversationId,
  runs,
  onClose,
  onOpenFolder,
  onChanged,
  onFork,
}: {
  project: Project;
  tab: string;
  reviewRunId: string;
  reviewPath: string | null;
  onReviewRunChange: (id: string) => void;
  onReviewPathChange: (path: string) => void;
  onReviewComment: (runId: string, path: string, text: string) => boolean;
  fileRequest?: { projectId: string; path: string; nonce: number } | null;
  expanded?: boolean;
  onExpand?: () => void;
  onFindFile: () => void;
  onTabChange: (tab: string) => void;
  conversationId: string | null;
  runs: Run[];
  onClose: () => void;
  onOpenFolder: () => void;
  onChanged: () => void;
  onFork: (id: string) => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  useEffect(() => {
    if (!copiedPath) return;
    const timer = window.setTimeout(() => setCopiedPath(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const draft = readEditorDraft(project.id);
  const [selected, setSelected] = useState<string | undefined>(
    draft?.document.path,
  );
  const [file, setFile] = useState<ProjectDocument | null>(
    draft?.document || null,
  );
  const fileCache = useRef(new Map<string, ProjectDocument>());
  const [content, setContent] = useState(draft?.content || "");
  const [editing, setEditing] = useState(!!draft);
  const [newFile, setNewFile] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<SessionState | null>(null);
  const [error, setError] = useState("");
  const [viewed, setViewed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("digital-memory.reviewed." + project.id) || "[]",
      );
      if (Array.isArray(saved))
        setViewed(
          saved
            .filter((item): item is string => typeof item === "string")
            .slice(-1000),
        );
    } catch {
      /* Ignore invalid browser preferences. */
    }
  }, [project.id]);
  const [busy, setBusy] = useState(false);
  const [historicalRun, setHistoricalRun] = useState<Run | null>(null);
  const [changeCursor, setChangeCursor] = useState("");
  const runId = reviewRunId;
  const setRunId = onReviewRunChange;
  const upload = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const active = runs.some(isActive);
  const current =
    runId === "latest"
      ? runs.at(-1)
      : runs.find((r) => r.id === runId) ||
        (historicalRun?.id === runId ? historicalRun : undefined);
  const loadHistorical =
    runId !== "latest" && !runs.some((run) => run.id === runId);
  useEffect(() => {
    if (!loadHistorical) return;
    let cancelled = false;
    void api<{ run: Run }>("/runs/" + runId)
      .then(({ run }) => {
        if (!cancelled) setHistoricalRun(run);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, loadHistorical]);
  const selectedChange =
    current?.changes?.find((change) => change.path === reviewPath) ||
    current?.changes?.[0];
  useEffect(() => {
    setChangeCursor(selectedChange?.path || "");
  }, [current?.id, selectedChange?.path]);
  const revisionKey = (change: FileChange) =>
    [current?.id, change.path, change.before?.hash, change.after?.hash].join(
      ":",
    );
  function markViewed(change: FileChange, value: boolean) {
    const key = revisionKey(change);
    const next = value
      ? [...new Set([...viewed, key])].slice(-1000)
      : viewed.filter((item) => item !== key);
    setViewed(next);
    try {
      localStorage.setItem(
        "digital-memory.reviewed." + project.id,
        JSON.stringify(next),
      );
    } catch {
      /* Reviewing still works without browser storage. */
    }
  }
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ files: ProjectFile[] }>(
        "/projects/" + project.id + "/files",
      );
      setFiles(result.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    }
  }, [project.id]);
  useEffect(() => {
    void refresh();
  }, [runs.at(-1)?.status, refresh]);
  useEffect(() => {
    if (!contextOpen) return;
    let cancelled = false;
    async function load() {
      if (!conversationId) {
        setState(null);
        return;
      }
      try {
        const result = await api<SessionState>(
          "/conversations/" + conversationId + "/session",
        );
        if (!cancelled) setState(result);
      } catch {
        if (!cancelled) setState(null);
      }
    }
    void load();
    const timer = active
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, 5000)
      : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conversationId, active, busy, contextOpen]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function openFile(path: string) {
    if (files.find((f) => f.path === path)?.directory) return;
    if (editing && content !== file?.content) {
      setError("请先保存当前修改");
      return;
    }
    setSelected(path);
    selectedRef.current = path;
    setEditing(false);
    const cached = fileCache.current.get(path);
    setFile(cached || null);
    setContent(cached?.content || "");
    setLoadingFile(true);
    setError("");
    try {
      const result = await api<NonNullable<typeof file>>(
        "/projects/" + project.id + "/file?path=" + encodeURIComponent(path),
      );
      fileCache.current.set(path, result);
      if (selectedRef.current === path) {
        setFile(result);
        setContent(result.content || "");
      }
    } catch (e) {
      if (selectedRef.current === path)
        setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      if (selectedRef.current === path) setLoadingFile(false);
    }
  }
  const requestFile = useLatestCallback(openFile);
  useEffect(() => {
    if (fileRequest?.projectId === project.id)
      void requestFile(fileRequest.path);
  }, [fileRequest, project.id, requestFile]);
  async function saveCurrentFile() {
    if (!file || active || busy) return;
    await action(async () => {
      await api("/projects/" + project.id + "/file", {
        method: "PUT",
        body: JSON.stringify({ path: file.path, content, hash: file.hash }),
      });
      const updated = await api<NonNullable<typeof file>>(
        "/projects/" +
          project.id +
          "/file?path=" +
          encodeURIComponent(file.path),
      );
      fileCache.current.set(file.path, updated);
      setFile(updated);
      setContent(updated.content || "");
      setEditing(false);
      saveEditorDraft(project.id);
    });
  }
  const treeNodes = useMemo(() => fileTree(files), [files]);
  const expanded = useMemo(
    () => new Set(files.filter((f) => f.directory).map((f) => f.path)),
    [files],
  );
  const terminals = runs
    .flatMap((r) =>
      r.parts
        .filter((p) => p.type === "tool" && p.name === "bash")
        .map((p) => ({ runId: r.id, part: p })),
    )
    .filter((t) => t.part.type === "tool");
  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background"
      data-testid="project-workspace"
    >
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <TabsList
            variant="line"
            className="h-full min-w-0 shrink-0 justify-start gap-1 rounded-none p-0"
          >
            <TabsTrigger value="files" className="px-2 text-xs">
              <Files className="size-3.5" />
              文件
            </TabsTrigger>
            <TabsTrigger value="changes" className="px-2 text-xs">
              <GitCompareArrows className="size-3.5" />
              改动{current?.changes?.length ? ` ${current.changes.length}` : ""}
            </TabsTrigger>
            <TabsTrigger value="terminal" className="px-2 text-xs">
              <TerminalSquare className="size-3.5" />
              终端
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="快速打开文件"
              onClick={onFindFile}
              className="text-muted-foreground"
            >
              <Search className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="会话控制"
              disabled={!conversationId}
              onClick={() => setContextOpen(true)}
              className="text-muted-foreground"
            >
              <Cpu className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="刷新项目文件"
              onClick={() => void refresh()}
              className="text-muted-foreground"
            >
              <RefreshCw className="size-3.5" />
            </Button>
            {onExpand && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={workspaceExpanded ? "恢复分栏" : "展开工作区"}
                onClick={onExpand}
                className="text-muted-foreground"
              >
                {workspaceExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭项目面板"
              onClick={onClose}
              className="text-muted-foreground"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenFolder}
            aria-label="打开其他文件夹"
            title={project.directory}
            className="h-7 min-w-0 flex-1 justify-start gap-2 px-0 text-xs font-normal text-muted-foreground"
          >
            <FolderOpen className="size-3.5 shrink-0" />
            <span
              className="truncate font-mono"
              data-testid="workspace-directory"
            >
              {project.directory}
            </span>
          </Button>
          {project.available === false && (
            <Badge variant="outline">未连接</Badge>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copiedPath ? "已复制工作目录" : "复制工作目录"}
            className="shrink-0 text-muted-foreground"
            onClick={() =>
              void navigator.clipboard
                .writeText(project.directory)
                .then(() => setCopiedPath(true))
                .catch(() => setError("复制失败，请手动复制目录路径"))
            }
          >
            {copiedPath ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
        <TabsContent value="files" className="min-h-0 overflow-y-auto">
          <input
            className="sr-only"
            type="file"
            multiple
            ref={upload}
            aria-label="导入项目文件"
            onChange={(e) => {
              const imported = Array.from(e.target.files || []);
              void action(async () => {
                for (const f of imported) {
                  const form = new FormData();
                  form.append("file", f);
                  await api("/projects/" + project.id + "/files", {
                    method: "POST",
                    body: form,
                  });
                }
                if (upload.current) upload.current.value = "";
              });
            }}
          />
          {!file && (
            <>
              <div className="flex h-12 items-center gap-1 border-b px-3">
                <Input
                  aria-label="搜索项目文件"
                  className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs shadow-none dark:bg-transparent"
                  placeholder="查找文件…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  aria-label="新建项目文件"
                  variant="ghost"
                  size="icon-sm"
                  disabled={active}
                  onClick={() => {
                    setNewFile(true);
                    setNewPath("");
                  }}
                >
                  <Plus className="size-3.5" />
                </Button>
                <Button
                  aria-label="上传项目文件"
                  variant="ghost"
                  size="icon-sm"
                  disabled={active || busy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload className="size-3.5" />
                </Button>
              </div>
              <FileTree
                className="rounded-none border-0 px-2 py-3"
                selectedPath={selected}
                onSelect={(path) => void openFile(path)}
                defaultExpanded={expanded}
              >
                {search
                  ? files
                      .filter(
                        (f) =>
                          !f.directory &&
                          f.path.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((f) => (
                        <FileTreeFile
                          key={f.path}
                          path={f.path}
                          name={f.path}
                        />
                      ))
                  : treeNodes}
              </FileTree>
              {!files.length && (
                <div className="flex min-h-64 flex-col items-center justify-center gap-4">
                  <Files className="size-7 text-muted-foreground" />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={active}
                    onClick={() => upload.current?.click()}
                  >
                    <Upload className="size-3.5" />
                    添加文件
                  </Button>
                </div>
              )}
            </>
          )}
          {loadingFile && !file && <Skeleton className="m-4 h-48" />}
          {file && (
            <div className="flex min-h-full flex-col">
              <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="返回文件列表"
                  onClick={() => {
                    if (editing && content !== file.content) {
                      setError("请先保存或取消当前修改");
                      return;
                    }
                    setFile(null);
                    setSelected(undefined);
                    setEditing(false);
                  }}
                >
                  <ArrowLeft className="size-3.5" />
                </Button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {file.path}
                </span>
                {editing && content !== file.content && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    未保存
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="下载项目文件"
                  asChild
                >
                  <a
                    href={
                      "/api/projects/" +
                      project.id +
                      "/file?download=1&path=" +
                      encodeURIComponent(file.path)
                    }
                  >
                    <Download className="size-3.5" />
                  </a>
                </Button>
                {editing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setContent(file.content || "");
                      setEditing(false);
                      saveEditorDraft(project.id);
                    }}
                  >
                    取消
                  </Button>
                )}
                {file.content !== null && (
                  <Button
                    size="sm"
                    variant={editing ? "default" : "outline"}
                    disabled={active || busy}
                    onClick={() =>
                      editing ? void saveCurrentFile() : setEditing(true)
                    }
                  >
                    {editing ? (
                      <>
                        <Save className="size-3.5" />
                        保存
                      </>
                    ) : (
                      "编辑"
                    )}
                  </Button>
                )}
              </div>
              {editing ? (
                <Textarea
                  aria-label="文件内容"
                  className="min-h-96 flex-1 resize-none rounded-none border-0 bg-transparent p-5 font-mono text-xs leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    saveEditorDraft(project.id, {
                      document: file,
                      content: e.target.value,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      e.key.toLowerCase() === "s"
                    ) {
                      e.preventDefault();
                      if (!active && !busy) void saveCurrentFile();
                    }
                  }}
                />
              ) : (
                <CodeBlock
                  className="rounded-none border-0"
                  code={file.content ?? "下载查看 · " + formatBytes(file.size)}
                  language={
                    file.content && file.content.length > 20000
                      ? "text"
                      : language(file.path)
                  }
                />
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Select value={runId} onValueChange={setRunId}>
              <SelectTrigger
                aria-label="选择变更轮次"
                className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-xs shadow-none dark:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">最近一次任务</SelectItem>
                {loadHistorical && (
                  <SelectItem value={runId}>
                    {historicalRun?.id === runId
                      ? historicalRun.text.slice(0, 30)
                      : "读取历史改动…"}
                  </SelectItem>
                )}
                {runs.map((r, i) => (
                  <SelectItem key={r.id} value={r.id}>
                    {i + 1}. {r.text.slice(0, 30)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!!current?.changes?.length && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {
                  current.changes.filter((change) =>
                    viewed.includes(revisionKey(change)),
                  ).length
                }
                /{current.changes.length} 已查看
              </span>
            )}
          </div>
          {!!current?.changes?.length && (
            <Command
              shouldFilter={false}
              value={changeCursor}
              onValueChange={setChangeCursor}
              tabIndex={0}
              className="h-auto rounded-none border-b bg-transparent"
              label="选择改动文件"
            >
              <CommandList className="max-h-44" label="改动文件">
                <CommandGroup>
                  {current.changes.map((change) => (
                    <CommandItem
                      key={change.path}
                      value={change.path}
                      onSelect={() => onReviewPathChange(change.path)}
                      className="gap-2 px-3 py-2 text-xs"
                    >
                      {viewed.includes(revisionKey(change)) ? (
                        <Check className="size-3.5" />
                      ) : (
                        <File className="size-3.5" />
                      )}
                      <span className="flex-1 truncate font-mono">
                        {change.path}
                      </span>
                      <span className="text-muted-foreground">
                        {change.status === "added"
                          ? "新增"
                          : change.status === "deleted"
                            ? "删除"
                            : "修改"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
          {current && selectedChange && (
            <ChangeView
              key={current.id + selectedChange.path}
              change={selectedChange}
              viewed={viewed.includes(revisionKey(selectedChange))}
              onViewed={(value) => markViewed(selectedChange, value)}
              onComment={(text) =>
                onReviewComment(current.id, selectedChange.path, text)
              }
              disabled={active || busy}
              onRevert={() =>
                void action(() =>
                  api("/runs/" + current.id + "/revert", {
                    method: "POST",
                    body: JSON.stringify({ path: selectedChange.path }),
                  }),
                )
              }
            />
          )}
          {!current?.changes?.length && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {active ? "执行完成后生成变更记录" : "没有文件改动"}
            </p>
          )}
        </TabsContent>
        <TabsContent
          value="terminal"
          className="min-h-0 space-y-4 overflow-y-auto p-3"
        >
          {terminals.map(
            ({ part }) =>
              part.type === "tool" && (
                <Terminal
                  key={part.toolCallId}
                  output={
                    typeof part.output === "string"
                      ? part.output
                      : JSON.stringify(part.output ?? "")
                  }
                  isStreaming={part.state === "running"}
                >
                  <TerminalHeader>
                    <TerminalTitle>
                      {(part.input as { command?: string })?.command || "bash"}
                    </TerminalTitle>
                    <TerminalActions>
                      <TerminalStatus>执行中</TerminalStatus>
                      <TerminalCopyButton aria-label="复制终端输出" />
                    </TerminalActions>
                  </TerminalHeader>
                  <TerminalContent className="max-h-96" />
                </Terminal>
              ),
          )}
          {!terminals.length && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              暂无终端记录
            </p>
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent
          className="flex max-h-[80svh] flex-col sm:max-w-xl"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>会话控制</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 space-y-6 overflow-y-auto px-1">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span>上下文</span>
                <span className="text-xs text-muted-foreground">
                  {state?.context?.tokens?.toLocaleString() ?? "—"} /{" "}
                  {state?.context?.contextWindow.toLocaleString() ?? "—"}
                </span>
              </div>
              {state?.context?.tokens != null &&
                state.context.contextWindow > 0 && (
                  <Context
                    usedTokens={state.context.tokens}
                    maxTokens={state.context.contextWindow}
                  >
                    <ContextContentHeader className="px-0" />
                  </Context>
                )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!conversationId || active || busy}
                  onClick={() =>
                    void action(() =>
                      api("/conversations/" + conversationId + "/compact", {
                        method: "POST",
                        body: "{}",
                      }),
                    )
                  }
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Minimize2 />
                  )}
                  压缩上下文
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!conversationId}
                  asChild
                >
                  <a
                    href={"/api/conversations/" + conversationId + "/export"}
                    download
                  >
                    <Download />
                    导出
                  </a>
                </Button>
              </div>
            </div>
            {state && (
              <>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    可用工具 · {state.tools.filter((t) => t.active).length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {state.tools.map((t) => (
                      <Badge
                        key={t.name}
                        variant={t.active ? "secondary" : "outline"}
                      >
                        {t.name}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Skills 与提示词
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {state.skills.map((s) => (
                      <Badge key={s} variant="outline">
                        /skill:{s}
                      </Badge>
                    ))}
                    {state.prompts.map((s) => (
                      <Badge key={s} variant="outline">
                        /{s}
                      </Badge>
                    ))}
                  </div>
                </div>
                {Object.entries(state.statuses).map(([key, value]) => (
                  <p
                    key={key}
                    className="break-words text-xs text-muted-foreground"
                  >
                    {value.replace(/\x1b\[[0-9;]*m/g, "")}
                  </p>
                ))}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    会话历史 · {state.nodes.length}
                  </p>
                  {state.nodes.map((node) => (
                    <div
                      key={node.id}
                      className="flex items-start gap-2 border-l py-2 pl-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground">
                          {node.role === "user" ? "你" : "digital memory"}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5">
                          {node.text || "工具调用"}
                        </p>
                      </div>
                      <Button
                        aria-label="从此节点分支"
                        title="从此节点分支"
                        variant="ghost"
                        size="icon-sm"
                        disabled={active || busy}
                        onClick={() =>
                          void action(async () => {
                            const result = await api<{
                              conversation: { id: string };
                            }>("/conversations/" + conversationId + "/fork", {
                              method: "POST",
                              body: JSON.stringify({ entryId: node.id }),
                            });
                            onFork(result.conversation.id);
                          })
                        }
                      >
                        <GitBranch />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>{" "}
        </DialogContent>
      </Dialog>
      {error && (
        <div role="alert" className="border-t p-3 text-sm">
          {error}
        </div>
      )}
      <Dialog open={newFile} onOpenChange={setNewFile}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文件</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="新文件路径"
            placeholder="notes/example.md"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <DialogFooter>
            <Button
              disabled={busy || !newPath.trim()}
              onClick={() =>
                void action(async () => {
                  await api("/projects/" + project.id + "/file", {
                    method: "PUT",
                    body: JSON.stringify({
                      path: newPath,
                      content: "",
                      hash: null,
                    }),
                  });
                  setNewFile(false);
                  await openFile(newPath);
                  setEditing(true);
                })
              }
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
