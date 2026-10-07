"use client";
import {
  Conversation as AIConversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueList,
} from "@/components/ai-elements/queue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { loadDrafts, readDraft, writeDraft } from "@/hooks/use-draft";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTask } from "@/hooks/use-task";
import { useWorkbenchData } from "@/hooks/use-workbench-data";
import { api } from "@/lib/api";
import {
  emptyDraft,
  type InspectorTarget,
  type TaskDraft,
} from "@/lib/workbench";
import type {
  Conversation,
  Project,
  ProjectFileReference,
  Run,
  RunInput,
} from "@memory/contracts";
import {
  Archive,
  Brain,
  Clock3,
  ChevronDown,
  Download,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Star,
  TerminalSquare,
  Trash2,
  X,
  Search,
  SquarePen,
  Settings2,
} from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { usePanelRef } from "react-resizable-panels";
import {
  Activity,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import { WorkSurface, type SurfaceTab } from "./work-surface";
import { SessionControls } from "./session-controls";
import { TimelineHistory } from "./timeline-history";
import { DatasetDeliveryPanel } from "./dataset-delivery";
import { TaskLauncher } from "./task-launcher";
import { WorkbenchPages, WorkbenchPageSkeleton, usePreloadWorkbenchPages } from "./workbench-pages";
import { WorkbenchCommandPalette } from "./workbench-command-palette";
import { ProjectMenu } from "./project-menu";
import { WorkbenchComposer } from "./workbench-composer";
import {
  WorkbenchNavigation,
  type WorkbenchPage,
} from "./workbench-navigation";
const TaskLibrary = dynamic(() => import("./task-library").then((m) => m.TaskLibrary));
const ProjectWorkspace = dynamic(
  () => import("./project-workspace").then((m) => m.ProjectWorkspace),
  { loading: WorkbenchPageSkeleton },
);
const WorkspaceFolderDialog = dynamic(() =>
  import("./workspace-folder-dialog").then((m) => m.WorkspaceFolderDialog),
  { loading: () => null },
);
const ProjectFilePicker = dynamic(() =>
  import("./project-file-picker").then((m) => m.ProjectFilePicker),
  { loading: () => null },
);
const WorkbenchInspector = dynamic(
  () => import("./workbench-inspector").then((m) => m.WorkbenchInspector),
  { loading: WorkbenchPageSkeleton },
);
const ArtifactLibrary = dynamic(() => import("./artifact-library").then((m) => m.ArtifactLibrary));
const RunThread = dynamic(() => import("./run-thread").then((m) => m.RunThread), { loading: () => <Skeleton className="h-24 w-full" /> });
const LegacyMessages = dynamic(() => import("./legacy-messages").then((m) => m.LegacyMessages), { loading: () => <Skeleton className="h-24 w-full" /> });
const AssetLibrary = dynamic(
  () => import("./asset-library").then((m) => m.AssetLibrary),
);
const MemoryLibrary = dynamic(
  () => import("./memory-home").then((m) => m.MemoryHome),
);
const ActivityInspector = dynamic(() => import("./memory-activities").then((m) => m.ActivityInspector));
const MemoryActivitiesPage = dynamic(() => import("./memory-activities").then((m) => m.MemoryActivitiesPage));
const MemoryDatasetsPage = dynamic(() => import("./memory-datasets").then((module) => module.MemoryDatasetsPage));
const ProcessingCenter = dynamic(() => import("./processing-center").then((module) => module.ProcessingCenter));
const SettingsPanel = dynamic(
  () => import("./settings-panel").then((m) => m.SettingsPanel),
);

type Page = WorkbenchPage;
interface Navigation {
  view: Page;
  memoryView: "activities" | "records";
  task: string | null;
  target: InspectorTarget | null;
  collection: string | null;
}
const initialNavigation: Navigation = {
  view: "chat",
  memoryView: "activities",
  task: null,
  target: null,
  collection: null,
};
const navItems = [
  { id: "chat" as const, label: "新任务", icon: TerminalSquare },
  { id: "tasks" as const, label: "任务", icon: MessageSquare },
  { id: "assets" as const, label: "资料库", icon: FolderOpen },
  { id: "memory" as const, label: "记忆", icon: Brain },
  { id: "datasets" as const, label: "数据集", icon: Database },
  { id: "processing" as const, label: "处理与核对", icon: Clock3 },
  { id: "artifacts" as const, label: "整理结果", icon: FileText },
];

export function Workspace() {
  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={
        {
          "--sidebar-width": "15rem",
          "--sidebar-width-icon": "3rem",
        } as CSSProperties
      }
    >
      <WorkspaceContent />
    </SidebarProvider>
  );
}

function WorkspaceContent() {
  const { setOpenMobile } = useSidebar();
  const mobile = useIsMobile(1100);
  const [nav, setNav] = useState<Navigation>(initialNavigation);
  const [navigating, startNavigation] = useTransition();
  const navRef = useRef(nav);
  const { snapshot, setSnapshot, refreshVersion, configuration, projects, setProjects, harness, tools, ready, error, setError, refresh, refreshSnapshot } = useWorkbenchData();
  usePreloadWorkbenchPages(ready);
  const [projectId, setProjectId] = useState("default");
  const [projectOpen, setProjectOpen] = useState(false);
  const [surfaceExpanded, setSurfaceExpanded] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [surfaceRequest, setSurfaceRequest] = useState<{ sessionKey: string; tab: SurfaceTab } | null>(null);
  const mainPanel = usePanelRef();
  const inspectorPanel = usePanelRef();
  const [projectTab, selectProjectTab] = useState("files");
  const setProjectTab = (tab: string) => {
    selectProjectTab(tab);
    setSurfaceRequest({ sessionKey: draftKey, tab: { id: tab, view: tab } });
  };
  const [reviewRunId, setReviewRunId] = useState("latest");
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  useEffect(() => {
    setReviewRunId("latest");
    setReviewPath(null);
  }, [nav.task]);
  const [submitting, setSubmitting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState("recent");
  const [dialog, setDialog] = useState<{
    type: "rename" | "delete" | "collection" | "project";
    id?: string;
    assetIds?: string[];
  } | null>(null);
  const [dialogTitle, setDialogTitle] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const dark = !mounted || resolvedTheme === "dark";
  const navigate = useCallback(
    (patch: Partial<Navigation>) => {
      const next = { ...navRef.current, ...patch };
      navRef.current = next;
      startNavigation(() => setNav(next));
      setOpenMobile(false);
      const params = new URLSearchParams();
      if (next.view !== "chat") params.set("view", next.view);
      if (next.view === "memory" && next.memoryView === "records") params.set("memoryView", "records");
      if (
        next.view === "memory" && next.memoryView === "records" &&
        new URL(window.location.href).searchParams.get("space") === "demo"
      )
        params.set("space", "demo");
      if (next.task) params.set("task", next.task);
      if (next.collection) params.set("collection", next.collection);
      if (next.target) {
        params.set("panel", next.target.tab);
        if (next.target.id) params.set("item", next.target.id);
        if (next.target.start !== undefined)
          params.set("start", String(next.target.start));
        if (next.target.end !== undefined)
          params.set("end", String(next.target.end));
        if (next.target.timestamp !== undefined)
          params.set("timestamp", String(next.target.timestamp));
      }
      window.history.pushState({}, "", "/" + (params.size ? "?" + params : ""));
    },
    [setOpenMobile],
  );
  const task = useTask(nav.task, refreshSnapshot);
  const shortcut = useLatestCallback((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.isComposing || event.altKey)
      return;
    const key = event.key.toLowerCase();
    if (key === "k" || (key === "p" && event.shiftKey)) {
      event.preventDefault();
      setFilePickerOpen(false);
      setSearchOpen((open) => !open);
    } else if (key === "p") {
      event.preventDefault();
      setSearchOpen(false);
      setFilePickerOpen(true);
    } else if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      setOpenMobile(false);
      setFolderOpen(true);
    } else if (key === "o" && event.shiftKey) {
      event.preventDefault();
      setProjectOpen(false);
      navigate({ view: "chat", task: null, target: null, collection: null });
    } else if (key === "j" || (key === "g" && event.shiftKey)) {
      event.preventDefault();
      const tab = key === "j" ? "terminal" : "changes";
      setProjectOpen(!(projectOpen && projectTab === tab && !nav.target));
      setProjectTab(tab);
      navigate({ view: "chat", target: null });
    } else if (key === ",") {
      event.preventDefault();
      navigate({ view: "settings", target: null });
    } else if (key === "/") {
      event.preventDefault();
      setShortcutsOpen(true);
    }
  });
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setProjectOpen(params.get("workspace") === "1");
      const view = params.get("view") as Page;
      const tab = params.get("panel") as InspectorTarget["tab"];
      const next: Navigation = {
        view: [...navItems.map((item) => item.id), "settings"].includes(view)
          ? view
          : "chat",
        task: params.get("task"),
        memoryView: params.get("memoryView") === "records" || params.get("space") === "demo" || (view === "memory" && tab === "memories") ? "records" : "activities",
        collection: params.get("collection"),
        target: ["assets", "artifacts", "memories", "activities"].includes(tab)
          ? {
              tab,
              id: params.get("item") || undefined,
              start: params.has("start")
                ? Number(params.get("start"))
                : undefined,
              end: params.has("end") ? Number(params.get("end")) : undefined,
              timestamp: params.has("timestamp") ? Number(params.get("timestamp")) : undefined,
            }
          : null,
      };
      navRef.current = next;
      setNav(next);
    };
    setMounted(true);
    setProjectId(localStorage.getItem("digital-memory.project") || "default");
    readLocation();
    loadDrafts();
    void refresh();
    window.addEventListener("popstate", readLocation);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("popstate", readLocation);
      window.removeEventListener("keydown", shortcut);
    };
  }, [refresh]);
  useEffect(() => {
    if (!mounted) return;
    const url = new URL(window.location.href);
    if (nav.view === "chat" && projectOpen) url.searchParams.set("workspace", "1");
    else url.searchParams.delete("workspace");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [mounted, nav, projectOpen]);
  useEffect(() => {
    if (
      !snapshot.conversations.some(
        (item) => item.running && item.id !== nav.task,
      )
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshSnapshot();
    }, 10000);
    return () => clearInterval(timer);
  }, [snapshot.conversations, nav.task, refreshSnapshot]);
  const project =
    projects.find(
      (p) =>
        p.id ===
        (snapshot.conversations.find((c) => c.id === nav.task)?.projectId ||
          projectId),
    ) || projects[0];
  useEffect(() => {
    if (nav.task && project) {
      setProjectId(project.id);
      localStorage.setItem("digital-memory.project", project.id);
    }
  }, [nav.task, project?.id]);
  const draftKey = nav.task || "new-" + (project?.id || "default");
  const defaultModel =
    configuration?.models.find(
      (model) => model.id === task.detail?.runs.at(-1)?.modelId,
    ) || configuration?.models[0];
  const fallbackDraft = useMemo(
    () => ({
      ...emptyDraft(),
      permissionMode: project?.permissionMode || "auto",
      modelId: defaultModel?.id || "",
      thinkingLevel: defaultModel?.thinkingLevel || "medium",
    }),
    [project?.permissionMode, defaultModel?.id, defaultModel?.thinkingLevel],
  );
  const draft = readDraft(draftKey, fallbackDraft);
  function setDraft(next: TaskDraft, key = draftKey) {
    writeDraft(key, next);
  }
  function consumeDraft(
    sent: TaskDraft,
    source = draftKey,
    destination = source,
    filesSent = false,
  ) {
    const current = readDraft(source, sent);
    setDraft(
      {
        ...current,
        text: current.text === sent.text ? "" : current.text,
        fileReferences: filesSent
          ? (current.fileReferences || []).filter(
              (ref) =>
                !sent.fileReferences?.some(
                  (item) => item.path === ref.path && item.runId === ref.runId,
                ),
            )
          : current.fileReferences,
      },
      destination,
    );
    if (source !== destination)
      setDraft({ ...sent, text: "", fileReferences: [] }, source);
  }
  const inspect = useCallback(
    (target: InspectorTarget) => {
      setSurfaceRequest(null);
      navigate({ target });
    },
    [navigate],
  );
  const running = task.detail?.runs.find(
    (run) => run.status === "running" || run.status === "waiting",
  );
  const latest = task.detail?.runs.at(-1);
  const queued =
    task.detail?.runs.filter((run) => run.status === "queued") || [];
  const model =
    configuration?.models.find(
      (model) => model.id === (latest?.modelId || draft.modelId),
    ) || configuration?.models[0];
  const selectedConversation = snapshot.conversations.find(
    (item) => item.id === nav.task,
  );
  async function submit(input?: RunInput) {
    if (submitting) return;
    const draft = readDraft(draftKey, fallbackDraft);
    const payload: RunInput = input || {
      text: draft.text.trim(),
      modelId: draft.modelId || model?.id || "",
      thinkingLevel: draft.thinkingLevel,
      assetIds: draft.assetIds,
      fileReferences: draft.fileReferences,
      scope: draft.scope,
      useMemory: draft.useMemory,
      captureMemory: draft.captureMemory,
      permissionMode: draft.permissionMode || project?.permissionMode,
    };
    if ((!payload.text && !payload.assetIds?.length) || !payload.modelId) return;
    setSubmitting(true);
    setError("");
    try {
      let id = nav.task;
      if (!id) {
        const result = await api<{ conversation: Conversation }>(
          "/conversations",
          {
            method: "POST",
            body: JSON.stringify({ projectId: project?.id || "default" }),
          },
        );
        id = result.conversation.id;
      }
      await api("/conversations/" + id + "/runs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!input) consumeDraft(draft, draftKey, id, true);
      if (nav.task !== id) navigate({ task: id, view: "chat" });
      else await task.refresh();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法开始任务");
    } finally {
      setSubmitting(false);
    }
  }
  async function stop(run: Run) {
    try {
      await api("/runs/" + run.id + "/stop", { method: "POST" });
      await task.refresh();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "停止失败");
    }
  }
  async function changeConversation(
    id: string,
    patch: Record<string, unknown>,
  ) {
    await api("/conversations/" + id, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await refresh();
    await task.refresh();
  }
  const change = (id: string, patch: Record<string, unknown>) =>
    void changeConversation(id, patch).catch((failure) =>
      setError(failure.message),
    );
  async function saveDialog() {
    if (!dialog) return;
    setDialogBusy(true);
    try {
      if (dialog.type === "project") {
        const result = await api<{ project: Project }>("/projects", {
          method: "POST",
          body: JSON.stringify({ name: dialogTitle }),
        });
        useProject(result.project);
      } else if (dialog.type === "collection")
        await api("/collections", {
          method: "POST",
          body: JSON.stringify({
            title: dialogTitle,
            assetIds: dialog.assetIds,
          }),
        });
      else if (dialog.type === "rename")
        await changeConversation(dialog.id!, { title: dialogTitle });
      else {
        await api("/conversations/" + dialog.id, { method: "DELETE" });
        if (nav.task === dialog.id) navigate({ task: null, target: null });
      }
      setDialog(null);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败");
    } finally {
      setDialogBusy(false);
    }
  }
  function openProjectFolder() {
    setOpenMobile(false);
    setFolderOpen(true);
  }
  function selectProject(id: string) {
    setProjectId(id);
    localStorage.setItem("digital-memory.project", id);
    setSurfaceRequest(null);
    setProjectOpen(false);
    navigate({ view: "chat", task: null, target: null, collection: null });
  }
  function useProject(project: Project) {
    setProjects((current) =>
      current.some((item) => item.id === project.id)
        ? current.map((item) => (item.id === project.id ? project : item))
        : [...current, project],
    );
    setProjectId(project.id);
    localStorage.setItem("digital-memory.project", project.id);
    selectProjectTab("files");
    setSurfaceRequest({ sessionKey: "new-" + project.id, tab: { id: "files", view: "files" } });
    setProjectOpen(true);
    navigate({ view: "chat", task: null, target: null, collection: null });
  }
  function useAssets(ids: string[]) {
    const draft = readDraft(draftKey, fallbackDraft);
    setDraft({
      ...draft,
      assetIds: [...new Set([...draft.assetIds, ...ids])].slice(0, 30),
      scope: "selected",
    });
    navigate({
      view: "chat",
      target: { tab: "assets", id: ids.length === 1 ? ids[0] : undefined },
    });
  }
  const taskMenu = (conversation: Conversation, label = "任务菜单", trigger?: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger || <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label + " " + conversation.title}
        >
          <MoreHorizontal />
        </Button>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            setDialog({ type: "rename", id: conversation.id });
            setDialogTitle(conversation.title);
          }}
        >
          <Pencil />
          重命名
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            change(conversation.id, { pinned: !conversation.pinned })
          }
        >
          <Star />
          {conversation.pinned ? "取消收藏" : "收藏"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            change(conversation.id, { archived: !conversation.archived })
          }
        >
          <Archive />
          {conversation.archived ? "取消归档" : "归档"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={conversation.running}
          onClick={() => void forkConversation(conversation.id)}
        >
          <GitBranch />
          创建分支
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={"/api/conversations/" + conversation.id + "/export"}
            download
          >
            <Download />
            导出会话
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={conversation.running}
          onClick={() => setDialog({ type: "delete", id: conversation.id })}
        >
          <Trash2 />
          删除任务
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  async function forkConversation(id: string, entryId?: string) {
    try {
      const result = await api<{ conversation: Conversation }>(
        "/conversations/" + id + "/fork",
        { method: "POST", body: JSON.stringify({ entryId }) },
      );
      await refresh();
      navigate({ task: result.conversation.id, view: "chat", target: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建分支失败");
    }
  }
  async function steer(mode: "steer" | "followUp" = "steer") {
    const draft = readDraft(draftKey, fallbackDraft);
    if (!nav.task || !draft.text.trim()) return;
    setSubmitting(true);
    try {
      await api("/conversations/" + nav.task + "/steer", {
        method: "POST",
        body: JSON.stringify({ text: draft.text.trim(), mode }),
      });
      consumeDraft(draft);
      await task.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSubmitting(false);
    }
  }
  const clearQueue = useLatestCallback(async () => {
    if (!nav.task) return;
    try {
      const result = await api<{ texts: string[] }>("/conversations/" + nav.task + "/queue/clear", { method: "POST" });
      const current = readDraft(draftKey, fallbackDraft);
      setDraft({ ...current, text: [current.text, ...result.texts].filter(Boolean).join("\n\n") });
      await task.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "撤回失败"); }
  });
  const retryRun = useLatestCallback(
    (run: Run) =>
      void submit({
        text: run.text,
        modelId: run.modelId,
        assetIds: run.assetIds,
        fileReferences: run.fileReferences,
        scope: run.scope,
        thinkingLevel: run.thinkingLevel,
        useMemory: run.useMemory,
        captureMemory: run.captureMemory,
        permissionMode: run.permissionMode,
        retryOf: run.id,
      }),
  );
  const forkRun = useLatestCallback(
    (run: Run) => void forkConversation(run.conversationId, run.entryId),
  );
  const openDelivery = useLatestCallback((runId: string, toolCallId: string) => {
    setSurfaceRequest({ sessionKey: draftKey, tab: { id: "delivery:" + runId + ":" + toolCallId, view: "delivery", delivery: { runId, toolCallId } } });
    setProjectOpen(true); navigate({ view: "chat", target: null });
  });
  const openFiles = useLatestCallback(
    (runId?: string, path?: string) => {
      setReviewRunId(runId || "latest");
      navigate({ target: null });
      setProjectTab("changes");
      setReviewPath(path || null);
      setProjectOpen(true);
    },
  );
  const openProjectFile = useLatestCallback((path: string) => {
    if (!project) return;
    selectProjectTab("files");
    setSurfaceRequest({ sessionKey: draftKey, tab: { id: "file:" + project.id + ":" + path, view: "files", file: { projectId: project.id, path, nonce: Date.now() } } });
    navigate({ view: "chat", target: null });
    setProjectOpen(true);
  });
  const openReference = useLatestCallback((ref: ProjectFileReference) => {
    if (ref.runId) openFiles(ref.runId, ref.path);
    else openProjectFile(ref.path);
  });
  const focusComposer = () =>
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="任务指令"]')
        ?.focus(),
    );
  const reuseRequest = useLatestCallback((run: Run) => {
    const current = readDraft(draftKey, fallbackDraft);
    const refs = [...(current.fileReferences || [])];
    for (const ref of run.fileReferences || [])
      if (
        !refs.some((item) => item.path === ref.path && item.runId === ref.runId)
      )
        refs.push(ref);
    if (refs.length > 20) {
      setError("每次最多引用 20 个项目文件");
      return;
    }
    setDraft({
      ...current,
      text: current.text ? current.text + "\n\n" + run.text : run.text,
      assetIds: [...new Set([...current.assetIds, ...run.assetIds])].slice(
        0,
        30,
      ),
      fileReferences: refs,
    });
    mainPanel.current?.expand();
    focusComposer();
  });
  const reviewComment = useLatestCallback(
    (runId: string, path: string, text: string) => {
      const current = readDraft(draftKey, fallbackDraft);
      const refs = [...(current.fileReferences || [])];
      if (!refs.some((ref) => ref.path === path && ref.runId === runId))
        refs.push({ path, runId });
      if (refs.length > 20) {
        setError("每次最多引用 20 个项目文件");
        return false;
      }
      setDraft({
        ...current,
        text:
          (current.text ? current.text + "\n\n" : "") + path + "：\n" + text,
        fileReferences: refs,
      });
      mainPanel.current?.expand();
      if (mobile) setProjectOpen(false);
      setSurfaceExpanded(false);
      focusComposer();
      return true;
    },
  );
  const refreshTask = useLatestCallback(() => {
    void task.refresh();
    void refresh();
  });
  const projectMenu = <ProjectMenu project={project} projects={projects} onSelect={selectProject}
    onOpenFolder={openProjectFolder} onCreate={() => { setDialog({ type: "project" }); setDialogTitle(""); }} />;
  async function compactConversation(instructions?: string) {
    if (!nav.task) return;
    setCompacting(true);
    try {
      await api("/conversations/" + nav.task + "/compact", { method: "POST", body: JSON.stringify({ instructions }) });
      setSessionRevision((value) => value + 1);
    } finally { setCompacting(false); }
  }
  const composer = ready ? (
    <WorkbenchComposer
      projectMenu={projectMenu}
      key={draftKey}
      compact={!!nav.task}
      draftKey={draftKey}
      conversationId={nav.task || undefined}
      presentation={task.detail?.presentation}
      fallbackDraft={fallbackDraft}
      projectId={project?.id}
      onOpenFile={openReference}
      onRecall={latest ? () => reuseRequest(latest) : undefined}
      onDraft={setDraft}
      assets={snapshot.assets}
      models={configuration?.models || []}
      providers={configuration?.providers || []}
      running={running}
      submitting={submitting || compacting}
      onSubmit={async () => {
        const draft = readDraft(draftKey, fallbackDraft);
        const command = draft.text.trim();
        if (/^\/compact(?:\s|$)/.test(command) && nav.task) {
          try {
            await compactConversation(command.slice("/compact".length).trim() || undefined);
            consumeDraft(draft);
          } catch (e) {
            setError(e instanceof Error ? e.message : "压缩失败");
          }
          return;
        }
        if (command === "/fork" && nav.task) {
          await forkConversation(nav.task);
          consumeDraft(draft);
          return;
        }
        if (command === "/files") {
          setProjectTab("files");
          navigate({ target: null });
          setProjectOpen(true);
          consumeDraft(draft);
          return;
        }
        if (command === "/review" || command === "/terminal") {
          setProjectTab(command === "/review" ? "changes" : "terminal");
          navigate({ target: null });
          setProjectOpen(true);
          consumeDraft(draft);
          return;
        }
        if (command === "/settings") {
          navigate({ view: "settings", target: null });
          consumeDraft(draft);
          return;
        }
        await submit();
      }}
      onSteer={steer}
      commands={[
        "/files",
        "/review",
        "/terminal",
        ...(nav.task && !running ? ["/compact", "/fork"] : []),
        "/settings",
        ...(harness?.resources
          .filter((r) => r.enabled)
          .map((r) =>
            r.kind === "skill" ? "/skill:" + r.name : "/" + r.name,
          ) || []),
      ]}
      onStop={() => {
        if (running) void stop(running);
      }}
      onUploaded={(asset) =>
        setSnapshot((previous) => ({
          ...previous,
          assets: [
            asset,
            ...previous.assets.filter((item) => item.id !== asset.id),
          ],
        }))
      }
      onInspect={inspect}
      onSettings={() => navigate({ view: "settings" })}
    />
  ) : (
    <Skeleton className="h-32 w-full rounded-lg" />
  );
  const renderResource = (target: InspectorTarget, close: () => void) => target.tab === "activities" ? (target.id ? <ActivityInspector key={target.id} id={target.id} onInspect={inspect}
    onClose={close} onChanged={() => { void refresh(); void task.refresh(); }} onReference={(text, assetIds) => {
      const current = readDraft(draftKey, fallbackDraft);
      setDraft({ ...current, useMemory: true, assetIds: [...new Set([...current.assetIds, ...(assetIds || [])])],
        text: [current.text, text].filter(Boolean).join("\n\n") }); navigate({ view: "chat", ...(mobile ? { target: null } : {}) });
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务指令"]')?.focus());
    }} /> : <div className="h-full overflow-auto p-6"><MemoryActivitiesPage assets={snapshot.assets} onInspect={inspect} /></div>) : target ? (
    <WorkbenchInspector
      embedded={nav.view === "chat"}
      target={target}
      assets={snapshot.assets}
      artifacts={
        nav.task && nav.view === "chat"
          ? snapshot.artifacts.filter(
              (item) => item.conversationId === nav.task,
            )
          : snapshot.artifacts
      }
      memories={
        nav.task && nav.view === "chat"
          ? snapshot.memories.filter(
              (item) =>
                item.conversationId === nav.task ||
                task.detail?.runs.some((run) =>
                  run.memoryIds.includes(item.id),
                ),
            )
          : snapshot.memories
      }
      onTarget={inspect}
      onClose={close}
      onChanged={() => {
        void refresh();
        void task.refresh();
      }}
      onUseAsset={(asset) => useAssets([asset.id])}
    />
  ) : null;
  const renderProject = (surface: SurfaceTab, active: boolean) => surface.delivery ? <DatasetDeliveryPanel {...surface.delivery} active={active} refreshVersion={refreshVersion}
    onMemory={(id) => inspect({ tab: "memories", id })} onRequest={(text) => { const current = readDraft(draftKey, fallbackDraft); setDraft({ ...current, text: [current.text, text].filter(Boolean).join("\n\n") }); }} /> : project ? (
    <ProjectWorkspace
      key={project.id}
      project={project}
      visible={active}
      tab={surface.view || "files"}
      onOpenFile={(path) => openReference({ path })}
      reviewRunId={reviewRunId}
      reviewPath={reviewPath}
      onReviewPathChange={setReviewPath}
      onReviewComment={reviewComment}
      fileRequest={surface.file || null}
      onReviewRunChange={setReviewRunId}
      onTabChange={setProjectTab}
      runs={nav.task ? task.detail?.runs || [] : []}
      onOpenFolder={openProjectFolder}
      onChanged={() => {
        void task.refresh();
        void refresh();
      }}
    />
  ) : null;
  const inspector = nav.view === "chat" && project && (projectOpen || nav.target) ? (
    <WorkSurface key={nav.task || "new-" + project.id} sessionKey={nav.task || "new-" + project.id}
      target={nav.target} request={surfaceRequest?.sessionKey === draftKey ? surfaceRequest.tab : null}
      assets={snapshot.assets} artifacts={snapshot.artifacts.filter((a) => a.conversationId === nav.task)}
      renderResource={renderResource} renderProject={renderProject}
      expanded={surfaceExpanded}
      onExpand={mobile ? undefined : () => {
        if (surfaceExpanded) mainPanel.current?.expand();
        else mainPanel.current?.collapse();
        setSurfaceExpanded(!surfaceExpanded);
      }}
      onSelect={(surface) => { setSurfaceRequest(null); if (surface.target) navigate({ target: surface.target }); else { navigate({ target: null }); selectProjectTab(surface.view || "files"); setProjectOpen(true); } }}
      onClose={() => { setSurfaceRequest(null); navigate({ target: null }); setProjectOpen(false); focusComposer(); }} />
  ) : nav.target ? renderResource(nav.target, () => navigate({ target: null })) : null;
  const renderPage = (view: Page) =>
    view === "settings" ? (
      <SettingsPanel
        configuration={configuration}
        tools={tools}
        project={project}
        onRefresh={refresh}
      />
    ) : view === "assets" ? (
      <AssetLibrary
        key={nav.collection || "all"}
        title={
          snapshot.collections.find((item) => item.id === nav.collection)
            ?.title || "资料库"
        }
        assets={
          nav.collection
            ? snapshot.assets.filter((asset) =>
                snapshot.collections
                  .find((item) => item.id === nav.collection)
                  ?.assetIds.includes(asset.id),
              )
            : snapshot.assets
        }
        onChanged={refresh}
        onUse={useAssets}
        onPreview={(asset) => inspect({ tab: "assets", id: asset.id })}
        onMemory={(id) => inspect({ tab: "memories", id })}
        onProcessing={() => navigate({ view: "processing", target: null })}
        onCollection={(assetIds) => {
          setDialog({ type: "collection", assetIds });
          setDialogTitle("");
        }}
      />
    ) : view === "memory" ? (
      <MemoryLibrary
        view={nav.memoryView}
        onViewChange={(memoryView) => navigate({ memoryView, target: null })}
        onInspect={inspect}
        onStart={() => {
          const key = "new-" + (project?.id || "default");
          writeDraft(key, { ...readDraft(key, fallbackDraft), text: "请按具体活动整理我提交的照片和文字，关联已有资料，并集中列出需要核对的疑点。", scope: "library" });
          navigate({ view: "chat", task: null, target: null });
        }}
        memories={snapshot.memories}
        assets={snapshot.assets}
        models={configuration?.models || []}
        onOpen={(id) => inspect({ tab: "memories", id })}
        onChanged={refresh}
        onClearInspector={() => navigate({ target: null })}
      />
    ) : view === "datasets" ? (
      <MemoryDatasetsPage models={configuration?.models || []} onOpen={(id) => inspect({ tab: "memories", id })} />
    ) : view === "processing" ? (
      <ProcessingCenter onMemory={(id) => inspect({ tab: "memories", id })} onAsset={(id) => inspect({ tab: "assets", id })}
        onActivity={(id) => inspect({ tab: "activities", id })}
        onDatasets={() => navigate({ view: "datasets", target: null })} onSettings={() => navigate({ view: "settings", target: null })} />
    ) : view === "artifacts" ? (
      <ArtifactLibrary
        artifacts={snapshot.artifacts}
        onOpen={(id) => inspect({ tab: "artifacts", id })}
        onStart={() => navigate({ view: "chat", task: null })}
      />
    ) : view === "tasks" ? (
      <TaskLibrary
        key={project?.id}
        project={project}
        conversations={snapshot.conversations}
        filter={taskFilter}
        onFilter={setTaskFilter}
        onTask={(id) => navigate({ view: "chat", task: id, target: null })}
        onNew={() => navigate({ view: "chat", task: null, target: null })}
        artifacts={snapshot.artifacts}
        onArtifact={(id) => inspect({ tab: "artifacts", id })}
        onPrompt={(text) => {
          const key = "new-" + (project?.id || "default");
          writeDraft(key, { ...readDraft(key, fallbackDraft), text });
          navigate({ view: "chat", task: null, target: null });
        }}
        menu={(item) => taskMenu(item, "管理任务")}
      />
    ) : nav.task ? (
      <div className="flex h-full min-h-0 flex-col">
        {task.detail ? (
          <>
            <AIConversation
              key={nav.task}
              initial="instant"
              className="min-h-0 flex-1"
            >
              <ConversationContent className="mx-auto w-full max-w-3xl gap-10 px-5 py-8 sm:px-6">
                <TimelineHistory hasMore={!!task.detail.page?.hasMore} loading={task.loadingMore}
                  version={(task.detail.page?.before || "") + task.detail.runs.length} onLoad={task.loadMore} />
                {!!task.detail.legacyMessages.length && <LegacyMessages messages={task.detail.legacyMessages} />}
                {task.detail.runs
                  .filter((run) => run.status !== "queued")
                  .map((run) => (
                    <RunThread
                      key={run.id}
                      run={run}
                      activeEntryIds={task.detail?.activeEntryIds}
                      onClearQueue={clearQueue}
                      onDelivery={openDelivery}
                      assets={snapshot.assets}
                      artifacts={snapshot.artifacts}
                      memories={snapshot.memories}
                      tools={tools}
                      onInspect={inspect}
                      onRetry={retryRun}
                      onFork={forkRun}
                      onFiles={openFiles}
                      onOpenFile={openReference}
                      onReuse={reuseRequest}
                      onRefresh={refreshTask}
                    />
                  ))}
                {!task.detail.runs.length &&
                  !task.detail.legacyMessages.length && (
                    <ConversationEmptyState
                      title="开始任务"
                      description=""
                      icon={<MessageSquare className="size-6" />}
                    />
                  )}
              </ConversationContent>
              <ConversationScrollButton />
            </AIConversation>
            <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 pt-3 sm:px-6">
              {!!queued.length && (
                <Queue className="mb-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock3 className="size-3" />
                    待执行 · {queued.length}
                  </div>
                  <QueueList>
                    {queued.map((run) => (
                      <QueueItem key={run.id}>
                        <QueueItemContent>{run.text}</QueueItemContent>
                        <QueueItemActions>
                          <QueueItemAction
                            aria-label="撤回排队指令"
                            onClick={() => void stop(run)}
                          >
                            <X className="size-3" />
                          </QueueItemAction>
                        </QueueItemActions>
                      </QueueItem>
                    ))}
                  </QueueList>
                </Queue>
              )}
              {composer}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            {task.error ? (
              <div className="space-y-3">
                <p>{task.error}</p>
                <Button variant="outline" onClick={() => void task.refresh()}>
                  重试
                </Button>
              </div>
            ) : (
              <LoaderCircle className="size-5 animate-spin" />
            )}
          </div>
        )}
      </div>
    ) : (
      <TaskLauncher
        composer={composer}
        conversations={snapshot.conversations}
        onTask={(id) => navigate({ view: "chat", task: id, target: null })}
        onPrompt={(text) => {
          setDraft({ ...readDraft(draftKey, fallbackDraft), text });
          document
            .querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="任务指令"]',
            )
            ?.focus();
        }}
      />
    );

  useEffect(() => {
    if (inspector && !mobile) inspectorPanel.current?.resize("50%");
    else inspectorPanel.current?.collapse();
    if (!inspector || mobile) {
      mainPanel.current?.expand();
      setSurfaceExpanded(false);
    }
  }, [!!inspector, mobile, mainPanel, inspectorPanel]);
  const navigationActions = {
    onTheme: useLatestCallback(() => setTheme(dark ? "light" : "dark")),
    onView: useLatestCallback((view: WorkbenchPage) =>
      navigate({
        view,
        task: view === "chat" ? null : navRef.current.task,
        target: null,
        collection: null,
      }),
    ),
    onTask: useLatestCallback((id: string | null, projectId?: string) => {
      setSurfaceRequest(null);
      setProjectOpen(false);
      const nextProjectId =
        projectId ||
        (id
          ? snapshot.conversations.find((item) => item.id === id)?.projectId
          : project?.id);
      if (nextProjectId) {
        setProjectId(nextProjectId);
        localStorage.setItem("digital-memory.project", nextProjectId);
      }
      setTaskFilter("recent");
      navigate({ view: "chat", task: id, target: null, collection: null });
    }),
    onCreateProject: useLatestCallback(() => {
      setDialog({ type: "project" });
      setDialogTitle("");
    }),
    onCollection: useLatestCallback((id: string | null) =>
      navigate({ view: "assets", collection: id, target: null }),
    ),
    onSearch: useLatestCallback(() => {
      setSearchOpen(true);
    }),
    onShortcuts: useLatestCallback(() => setShortcutsOpen(true)),
    onArchive: useLatestCallback(() => {
      setTaskFilter("archived");
      navigate({ view: "tasks", task: null, target: null });
    }),
    menu: useLatestCallback((item: Conversation) => taskMenu(item, "管理任务")),
  };

  return (
    <>
      <WorkbenchNavigation
        view={navRef.current.view}
        taskId={navRef.current.task}
        conversations={snapshot.conversations}
        collections={snapshot.collections}
        collectionId={navRef.current.collection}
        dark={dark}
        {...navigationActions}
      />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger aria-label="切换侧栏" />
            {nav.view === "chat" && selectedConversation ? taskMenu(selectedConversation, "任务菜单", (
              <Button variant="ghost" size="sm" className="min-w-0 max-w-24 sm:max-w-56 lg:max-w-80"
                aria-label={"任务菜单 " + selectedConversation.title}>
                <span className="truncate">{task.detail?.presentation?.title || selectedConversation.title}</span>
                <ChevronDown data-icon="inline-end" />
              </Button>
            )) : nav.view !== "chat" ? (
              <span className="truncate text-sm text-muted-foreground">{nav.view === "settings" ? "设置" : nav.view === "tasks" ? "全部对话" : navItems.find((item) => item.id === nav.view)?.label}</span>
            ) : <span className="text-sm text-muted-foreground">新对话</span>}
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            {nav.view === "chat" && running && (
              <span role="status" className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex">
                <LoaderCircle className="size-3.5 animate-spin" />
                {running.stopRequestedAt ? "正在停止…" : running.status === "waiting" ? running.waitingFor === "jobs" ? "等待后台作业" : "等待确认" : ({ compacting: "压缩上下文", retrying: "重试连接", tools: "执行工具", generating: "生成中", settled: "整理结果" }[running.phase || "generating"])}
              </span>
            )}
            {task.connection === "reconnecting" && <span role="status" className="text-xs text-muted-foreground">重新连接…</span>}
            {!ready && <span role="status" className="text-xs text-muted-foreground">连接中</span>}
            {nav.view === "chat" && compacting && <span role="status" className="text-xs text-muted-foreground">正在压缩…</span>}
            {nav.task && task.detail && model && <Activity mode={nav.view === "chat" ? "visible" : "hidden"}><SessionControls key={nav.task} conversationId={nav.task}
              busy={!!running || !!queued.length || submitting || compacting} revision={`${latest?.finishedAt || ""}:${sessionRevision}`} onCompact={compactConversation}
              onUseResource={(command) => {
                const current = readDraft(draftKey, fallbackDraft);
                setDraft({ ...current, text: [command, current.text].filter(Boolean).join(" ") }); focusComposer();
              }}
              onNavigate={async (text) => {
                if (text) { const current = readDraft(draftKey, fallbackDraft); setDraft({ ...current, text: [current.text, text].filter(Boolean).join("\n\n") }); }
                await task.refresh(true); await refreshSnapshot();
              }} onFork={(entryId) => forkConversation(nav.task!, entryId)} /></Activity>}
            {nav.view === "chat" && (
              <ButtonGroup>
                <Button variant={inspector ? "secondary" : "ghost"} size="sm" aria-label="切换工作区" aria-expanded={!!inspector}
                  onClick={() => {
                    setSurfaceRequest(null);
                    if (inspector) { navigate({ target: null }); setProjectOpen(false); }
                    else setProjectOpen(true);
                  }}>
                  <PanelRight data-icon="inline-start" /><span className="hidden sm:inline">工作区</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="工作区选项"><ChevronDown /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={(event) => {
                    if (document.activeElement?.matches("input, textarea") || folderOpen || filePickerOpen || dialog) event.preventDefault();
                  }}>
                    <DropdownMenuGroup>
                      {[
                        { tab: "files", label: "项目文件", icon: FolderOpen },
                        { tab: "changes", label: "审阅文件改动", icon: GitCompareArrows },
                        { tab: "terminal", label: "打开终端输出", icon: TerminalSquare },
                      ].map(({ tab, label, icon: Icon }) => (
                        <DropdownMenuItem key={tab} onSelect={() => {
                          navigate({ target: null }); setProjectTab(tab); setProjectOpen(true);
                        }}><Icon />{label}</DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onSelect={() => setFilePickerOpen(true)}><Search />查找文件</DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      {projectMenu}
                      <DropdownMenuItem onSelect={openProjectFolder}><FolderOpen />打开本地文件夹</DropdownMenuItem>
                      <DropdownMenuItem onSelect={navigationActions.onCreateProject}><SquarePen />新建工作目录</DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ButtonGroup>
            )}
          </div>
        </header>
        {error && (
          <Alert className="rounded-none border-x-0 border-t-0">
            <AlertDescription className="flex items-center justify-between">
              {error}
              <Button size="sm" variant="ghost" onClick={() => setError("")}>
                关闭
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="min-h-0 flex-1" aria-busy={navigating}>
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel
                id="main"
                defaultSize="100%"
                minSize={mobile ? "0px" : "360px"}
                collapsible
                collapsedSize="0%"
                panelRef={mainPanel}
                className="flex min-h-0 flex-col"
              >
                <WorkbenchPages current={nav.view} renderPage={renderPage} />
              </ResizablePanel>
              <ResizableHandle className={mobile || !inspector ? "hidden" : undefined} />
              <ResizablePanel
                id="inspector"
                defaultSize="0%"
                minSize="360px"
                collapsible
                collapsedSize="0%"
                panelRef={inspectorPanel}
              >
                {!mobile && inspector && <div className="h-full min-w-0 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200">{inspector}</div>}
              </ResizablePanel>
            </ResizablePanelGroup>
        </div>
      </SidebarInset>
      <Sheet
        open={mobile && !!inspector}
        onOpenChange={(open) => {
          if (!open) {
            setSurfaceRequest(null);
            navigate({ target: null });
            setProjectOpen(false);
          }
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-none gap-0 p-0 sm:max-w-none"
          showCloseButton={false}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>工作区</SheetTitle>
            <SheetDescription>资料、结果与个人记忆</SheetDescription>
          </SheetHeader>
          {mobile && inspector}
        </SheetContent>
      </Sheet>
      {searchOpen && <WorkbenchCommandPalette snapshot={snapshot} onClose={() => setSearchOpen(false)}
        onTask={(id) => navigate({ view: "chat", task: id, target: null })} onInspect={inspect}
        actions={[
          { name: "新任务", icon: SquarePen, keys: "⇧ ⌘ O", action: () => navigationActions.onTask(null) },
          { name: "快速打开文件", icon: Search, keys: "⌘ P", action: () => setFilePickerOpen(true) },
          { name: "打开文件夹", icon: FolderOpen, keys: "⌘ O", action: openProjectFolder },
          { name: "审阅文件改动", icon: GitCompareArrows, keys: "⇧ ⌘ G", action: () => openFiles() },
          { name: "终端输出", icon: TerminalSquare, keys: "⌘ J", action: () => { navigate({ view: "chat", target: null }); setProjectTab("terminal"); setProjectOpen(true); } },
          { name: "处理与核对", icon: Clock3, keys: "", action: () => navigate({ view: "processing", target: null }) },
          { name: "数据集", icon: Database, keys: "", action: () => navigate({ view: "datasets", target: null }) },
          { name: "模型与 Agent 设置", icon: Settings2, keys: "⌘ ,", action: () => navigate({ view: "settings", target: null }) },
        ]} />}
      {filePickerOpen && project && (
        <ProjectFilePicker
          key={project.id}
          project={project}
          onClose={() => setFilePickerOpen(false)}
          onSelect={openProjectFile}
        />
      )}
      {folderOpen && (
        <WorkspaceFolderDialog
          initialPath={
            project?.directoryKind === "local" && project.available
              ? project.directory
              : undefined
          }
          onClose={() => setFolderOpen(false)}
          onProject={useProject}
        />
      )}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>快捷键</DialogTitle>
          </DialogHeader>
          <div className="divide-y text-sm">
            {[
              ["命令与搜索", "⌘ / Ctrl K"],
              ["快速打开文件", "⌘ / Ctrl P"],
              ["新任务", "⌘ / Ctrl ⇧ O"],
              ["打开文件夹", "⌘ / Ctrl O"],
              ["切换侧栏", "⌘ / Ctrl B"],
              ["审阅改动", "⌘ / Ctrl ⇧ G"],
              ["终端输出", "⌘ / Ctrl J"],
              ["设置", "⌘ / Ctrl ,"],
              ["发送", "Enter"],
              ["换行", "Shift Enter"],
              ["复用上次请求（输入为空）", "↑"],
            ].map(([label, keys]) => (
              <div
                key={label}
                className="flex items-center justify-between py-3"
              >
                <span>{label}</span>
                <kbd className="text-xs text-muted-foreground">{keys}</kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.type === "project"
                ? "新建项目"
                : dialog?.type === "delete"
                  ? "删除任务"
                  : dialog?.type === "collection"
                    ? "保存资料集合"
                    : "重命名任务"}
            </DialogTitle>
            <DialogDescription
              className={dialog?.type === "delete" ? "" : "sr-only"}
            >
              {dialog?.type === "delete"
                ? "删除此任务的对话、执行记录和整理结果。原始资料与独立保存的记忆会保留。"
                : dialog?.type === "collection"
                  ? `包含 ${dialog.assetIds?.length || 0} 份资料`
                  : "为任务设置一个容易找到的名称"}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveDialog();
            }}
          >
            {dialog?.type !== "delete" && (
              <Input
                aria-label={
                  dialog?.type === "project"
                    ? "项目名称"
                    : dialog?.type === "collection"
                      ? "集合名称"
                      : "任务名称"
                }
                autoFocus
                value={dialogTitle}
                onChange={(event) => setDialogTitle(event.target.value)}
                required
                maxLength={120}
              />
            )}
            <DialogFooter className="mt-5">
              <Button
                variant="outline"
                type="button"
                onClick={() => setDialog(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  dialogBusy ||
                  (dialog?.type !== "delete" && !dialogTitle.trim())
                }
              >
                {dialog?.type === "delete" ? "删除" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
