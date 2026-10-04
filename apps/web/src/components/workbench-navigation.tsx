"use client";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Conversation, Project } from "@memory/contracts";
import {
  Archive,
  Brain,
  ChevronRight,
  CircleAlert,
  Database,
  FileText,
  Folder,
  FolderOpen,
  Keyboard,
  Layers3,
  ListTodo,
  LoaderCircle,
  Moon,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Star,
  Sun,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

export type WorkbenchPage =
  | "chat"
  | "tasks"
  | "assets"
  | "memory"
  | "artifacts"
  | "datasets"
  | "processing"
  | "settings";

function taskTime(value: string) {
  const date = new Date(value);
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 60000),
  );
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export const WorkbenchNavigation = memo(function WorkbenchNavigation({
  view,
  taskId,
  project,
  projects,
  conversations,
  collections,
  collectionId,
  dark,
  onTheme,
  onView,
  onTask,
  onProject,
  onCreateProject,
  onOpenFolder,
  onCollection,
  onSearch,
  onShortcuts,
  onArchive,
  menu,
}: {
  view: WorkbenchPage;
  taskId: string | null;
  project?: Project;
  projects: Project[];
  conversations: Conversation[];
  collections: { id: string; title: string; assetIds: string[] }[];
  collectionId: string | null;
  dark: boolean;
  onTheme: () => void;
  onView: (view: WorkbenchPage) => void;
  onTask: (id: string | null, projectId?: string) => void;
  onProject: (id: string) => void;
  onCreateProject: () => void;
  onOpenFolder: () => void;
  onCollection: (id: string | null) => void;
  onSearch: () => void;
  onShortcuts: () => void;
  onArchive: () => void;
  menu: (conversation: Conversation) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (project) setExpanded((value) => ({ ...value, [project.id]: true }));
  }, [project?.id]);
  const groups = useMemo(
    () =>
      projects.map((item) => ({
        project: item,
        tasks: conversations
          .filter(
            (task) =>
              !task.archived && (task.projectId || "default") === item.id,
          )
          .sort(
            (a, b) =>
              Number(b.running) - Number(a.running) ||
              Number(b.pinned) - Number(a.pinned) ||
              b.updatedAt.localeCompare(a.updatedAt),
          ),
      })),
    [projects, conversations],
  );
  return (
    <Sidebar
      collapsible="icon"
      className="border-r-0"
      data-testid="workbench-navigation"
    >
      <SidebarHeader className="gap-1 px-3 pb-1 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="digital memory"
              aria-label="digital memory"
              onClick={() => onTask(null)}
              className="h-9 gap-2.5 font-medium tracking-tight"
            >
              <Layers3 className="size-4" />
              <span>digital memory</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="mt-3">
            <SidebarMenuButton
              aria-label="新任务"
              tooltip="新任务"
              onClick={() => onTask(null)}
              isActive={view === "chat" && !taskId}
              className="h-9 gap-2.5"
            >
              <SquarePen />
              <span>新任务</span>
            </SidebarMenuButton>
            <SidebarMenuAction
              aria-label="搜索工作空间"
              onClick={onSearch}
              title="命令与搜索 · Ctrl/Cmd K"
            >
              <Search />
            </SidebarMenuAction>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="所有任务"
              aria-label="所有任务"
              isActive={view === "tasks"}
              onClick={() => onView("tasks")}
              className="h-8 gap-2.5 text-muted-foreground data-[active=true]:text-foreground"
            >
              <ListTodo />
              <span>所有任务</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1">
        <SidebarGroup className="px-3">
          <SidebarMenu>
            {[
              { id: "assets", label: "资料库", icon: FolderOpen },
              { id: "memory", label: "个人记忆", icon: Brain },
              { id: "datasets", label: "数据集", icon: Database },
            ].map(({ id, label, icon: Icon }) => <SidebarMenuItem key={id}>
              <SidebarMenuButton tooltip={label} aria-label={label} isActive={view === id} onClick={() => onView(id as WorkbenchPage)}>
                <Icon /><span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>)}
          </SidebarMenu>
        </SidebarGroup>
        {view === "assets" ? (
          <SidebarGroup className="mt-4 px-3 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className="font-normal">
              资料集合
            </SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={!collectionId}
                  onClick={() => onCollection(null)}
                >
                  <FolderOpen />
                  <span>全部资料</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {collections.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    aria-label={item.title}
                    isActive={collectionId === item.id}
                    onClick={() => onCollection(item.id)}
                  >
                    <Folder />
                    <span className="truncate">{item.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {item.assetIds.length}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : (
          <SidebarGroup className="mt-4 px-3 group-data-[collapsible=icon]:hidden">
            <div className="mb-1 flex items-center justify-between pl-2">
              <SidebarGroupLabel className="h-7 px-0 font-normal text-muted-foreground/70">
                工作目录
              </SidebarGroupLabel>
              <div className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="打开文件夹"
                      onClick={onOpenFolder}
                      className="size-7 text-muted-foreground"
                    >
                      <FolderOpen className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>打开文件夹</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="创建项目"
                      onClick={onCreateProject}
                      className="size-7 text-muted-foreground"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>创建项目</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <SidebarMenu className="gap-2">
              {groups.map(({ project: item, tasks }) => {
                const open = expanded[item.id] ?? item.id === project?.id;
                const visible = tasks.slice(0, 8);
                const activeTask = tasks.find((task) => task.id === taskId);
                if (activeTask && !visible.includes(activeTask))
                  visible.push(activeTask);
                return (
                  <Collapsible
                    key={item.id}
                    open={open}
                    onOpenChange={(value) =>
                      setExpanded((old) => ({ ...old, [item.id]: value }))
                    }
                    asChild
                  >
                    <SidebarMenuItem>
                      <div className="group/project relative flex items-center">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={
                            (open ? "折叠项目 " : "展开项目 ") + item.name
                          }
                          aria-expanded={open}
                          onClick={() =>
                            setExpanded((old) => ({ ...old, [item.id]: !open }))
                          }
                          className="absolute left-0 z-10 size-7 text-muted-foreground"
                        >
                          <ChevronRight
                            className={
                              "size-3 transition-transform motion-reduce:transition-none " +
                              (open ? "rotate-90" : "")
                            }
                          />
                        </Button>
                        <SidebarMenuButton
                          aria-label={"打开项目 " + item.name}
                          title={item.directory}
                          onClick={() => onProject(item.id)}
                          isActive={
                            view === "chat" &&
                            !taskId &&
                            item.id === project?.id
                          }
                          className="h-8 gap-2 pl-7 pr-7 text-xs font-medium"
                        >
                          <Folder className="size-3.5" />
                          <span className="truncate">{item.name}</span>
                          {item.available === false && (
                            <CircleAlert
                              className="ml-auto size-3"
                              aria-label="目录未连接"
                            />
                          )}
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          aria-label={"在 " + item.name + " 新建任务"}
                          onClick={() => onTask(null, item.id)}
                          showOnHover
                          className="top-0.5"
                        >
                          <Plus />
                        </SidebarMenuAction>
                      </div>
                      <CollapsibleContent>
                        <SidebarMenuSub className="mx-3.5 mt-1 gap-0.5 border-sidebar-border/50 px-1.5">
                          {visible.map((task) => (
                            <SidebarMenuSubItem
                              key={task.id}
                              className="group/task"
                            >
                              <SidebarMenuSubButton
                                asChild
                                isActive={taskId === task.id && view === "chat"}
                                className="h-8 w-full gap-2 pr-2 text-[13px] font-normal"
                              >
                                <button
                                  type="button"
                                  aria-label={task.title}
                                  onClick={() => onTask(task.id)}
                                  title={task.title}
                                  data-pinned={!!task.pinned}
                                >
                                  {task.running ? (
                                    task.status === "waiting" && task.waitingFor !== "jobs" ? (
                                      <CircleAlert
                                        className="size-3.5 shrink-0"
                                        aria-label="等待确认"
                                      />
                                    ) : (
                                      <LoaderCircle
                                        className="size-3.5 shrink-0 animate-spin"
                                        aria-label={task.waitingFor === "jobs" ? "等待后台作业" : "执行中"}
                                      />
                                    )
                                  ) : task.pinned ? (
                                    <Star className="size-3 shrink-0" />
                                  ) : task.status === "failed" ? (
                                    <CircleAlert
                                      className="size-3 shrink-0"
                                      aria-label="失败"
                                    />
                                  ) : null}
                                  <span className="min-w-0 flex-1 truncate">
                                    {task.title}
                                  </span>
                                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 group-hover/task:invisible group-focus-within/task:invisible [@media(hover:none)]:invisible">
                                    {taskTime(task.updatedAt)}
                                  </span>
                                </button>
                              </SidebarMenuSubButton>
                              <div className="absolute right-0 top-0 opacity-0 focus-within:opacity-100 group-hover/task:opacity-100 [@media(hover:none)]:opacity-100 [&_button]:size-8">
                                {menu(task)}
                              </div>
                            </SidebarMenuSubItem>
                          ))}
                          {!tasks.length && (
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton
                                asChild
                                className="h-8 w-full text-xs text-muted-foreground"
                              >
                                <button
                                  type="button"
                                  onClick={() => onTask(null, item.id)}
                                >
                                  <Plus className="size-3" />
                                  <span>新任务</span>
                                </button>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          )}
                          {tasks.length > visible.length && (
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton
                                asChild
                                className="h-7 w-full text-xs text-muted-foreground"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    onProject(item.id);
                                    onView("tasks");
                                  }}
                                >
                                  查看全部 {tasks.length} 项
                                </button>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          )}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
            </SidebarMenu>
            <SidebarMenuButton
              onClick={onArchive}
              className="mt-4 h-8 gap-2.5 text-xs text-muted-foreground"
            >
              <Archive className="size-3.5" />
              <span>已归档</span>
            </SidebarMenuButton>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-2 p-3">
        <SidebarMenu className="gap-0.5">
          {[
            { id: "processing", label: "处理与核对", icon: ListTodo },
            { id: "artifacts", label: "整理结果", icon: FileText },
          ].map(({ id, label, icon: Icon }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                tooltip={label}
                aria-label={label}
                isActive={view === id}
                onClick={() => onView(id as WorkbenchPage)}
                className="h-8 gap-2.5 text-xs text-muted-foreground data-[active=true]:text-foreground"
              >
                <Icon className="size-3.5" />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="flex items-center gap-0.5 border-t border-sidebar-border/50 pt-2 group-data-[collapsible=icon]:flex-col">
          <SidebarMenuButton
            aria-label="设置"
            tooltip="设置"
            isActive={view === "settings"}
            onClick={() => onView("settings")}
            className="min-w-0 flex-1 gap-2.5 text-xs text-muted-foreground"
          >
            <Settings2 className="size-3.5" />
            <span>设置</span>
          </SidebarMenuButton>
          {[
            { label: "快捷键", icon: Keyboard, action: onShortcuts },
            {
              label: dark ? "切换浅色主题" : "切换深色主题",
              icon: dark ? Sun : Moon,
              action: onTheme,
            },
          ].map(({ label, icon: Icon, action }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  onClick={action}
                  className="text-muted-foreground"
                >
                  <Icon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
});
