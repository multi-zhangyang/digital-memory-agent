"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuButton,
  SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Conversation } from "@memory/contracts";
import {
  Archive, Brain, ChevronRight, CircleAlert, Database, FileText, Folder,
  FolderOpen, Keyboard, Layers3, ListTodo, LoaderCircle, MessageSquare,
  Moon, PanelsTopLeft, Search, Settings2, SquarePen, Star, Sun,
} from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

export type WorkbenchPage =
  | "chat" | "tasks" | "assets" | "memory" | "artifacts"
  | "datasets" | "processing" | "settings";

export const WorkbenchNavigation = memo(function WorkbenchNavigation({
  view, taskId, conversations, collections, collectionId, dark,
  onTheme, onView, onTask, onCollection, onSearch, onShortcuts, onArchive, menu,
}: {
  view: WorkbenchPage;
  taskId: string | null;
  conversations: Conversation[];
  collections: { id: string; title: string; assetIds: string[] }[];
  collectionId: string | null;
  dark: boolean;
  onTheme: () => void;
  onView: (view: WorkbenchPage) => void;
  onTask: (id: string | null, projectId?: string) => void;
  onCollection: (id: string | null) => void;
  onSearch: () => void;
  onShortcuts: () => void;
  onArchive: () => void;
  menu: (conversation: Conversation) => ReactNode;
}) {
  const recent = useMemo(() => {
    const sorted = conversations.filter((item) => !item.archived).sort((a, b) =>
      Number(b.running) - Number(a.running) || Number(b.pinned) - Number(a.pinned) ||
      b.updatedAt.localeCompare(a.updatedAt));
    const visible = sorted.slice(0, 18);
    const active = sorted.find((item) => item.id === taskId);
    if (active && !visible.includes(active)) visible.push(active);
    return visible;
  }, [conversations, taskId]);

  return (
    <Sidebar variant="inset" collapsible="icon" data-testid="workbench-navigation">
      <SidebarHeader className="gap-4 px-3 pb-0 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="digital memory" aria-label="digital memory" onClick={() => onTask(null)} size="lg">
              <Layers3 />
              <span>digital memory</span>
            </SidebarMenuButton>
            <SidebarMenuAction aria-label="搜索工作空间" title="搜索 · Ctrl/Cmd K" onClick={onSearch}>
              <Search />
            </SidebarMenuAction>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="新对话" aria-label="新任务" onClick={() => onTask(null)}
              isActive={view === "chat" && !taskId} className="h-10">
              <SquarePen /><span>新对话</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-4">
        <SidebarGroup className="px-3">
          <SidebarMenu>
            {[
              { id: "tasks", label: "全部对话", aria: "所有任务", icon: MessageSquare },
              { id: "memory", label: "记忆", aria: "记忆", icon: Brain },
              { id: "assets", label: "资料库", aria: "资料库", icon: FolderOpen },
            ].map(({ id, label, aria, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton tooltip={label} aria-label={aria} isActive={view === id}
                  onClick={() => onView(id as WorkbenchPage)} className="h-10">
                  <Icon /><span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {view === "assets" && collections.length > 0 && (
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>资料集合</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={!collectionId} onClick={() => onCollection(null)}>
                  <FolderOpen /><span>全部资料</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {collections.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton aria-label={item.title} isActive={collectionId === item.id} onClick={() => onCollection(item.id)}>
                    <Folder /><span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {recent.length > 0 && (
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>最近对话</SidebarGroupLabel>
            <SidebarMenu>
              {recent.map((item) => (
                <SidebarMenuItem key={item.id} className="group/conversation">
                  <SidebarMenuButton aria-label={item.title} data-pinned={!!item.pinned}
                    isActive={view === "chat" && taskId === item.id}
                    onClick={() => onTask(item.id, item.projectId || "default")}
                    title={item.title} className="h-9 pr-9">
                    {item.running ? item.status === "waiting" && item.waitingFor !== "jobs"
                      ? <CircleAlert aria-label="等待确认" />
                      : <LoaderCircle className="animate-spin" aria-label={item.waitingFor === "jobs" ? "等待后台作业" : "执行中"} />
                      : item.status === "failed" ? <CircleAlert aria-label="失败" />
                        : item.pinned ? <Star /> : null}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  <div className="absolute right-0 top-0.5 opacity-0 focus-within:opacity-100 group-hover/conversation:opacity-100 [@media(hover:none)]:opacity-100">
                    {menu(item)}
                  </div>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-3 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip="管理" aria-label="打开管理菜单" isActive={["processing", "artifacts", "datasets"].includes(view)} className="h-10">
                  <PanelsTopLeft /><span>管理</span><ChevronRight className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onView("processing")}><ListTodo />处理与核对</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onView("artifacts")}><FileText />整理结果</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onView("datasets")}><Database />数据集</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onArchive}><Archive />已归档</DropdownMenuItem>
                  <DropdownMenuItem onSelect={onShortcuts}><Keyboard />快捷键</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        <Separator />
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton aria-label="设置" tooltip="设置" isActive={view === "settings"} onClick={() => onView("settings")}>
                <Settings2 /><span>设置</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={dark ? "切换浅色主题" : "切换深色主题"} onClick={onTheme}>
                {dark ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{dark ? "浅色主题" : "深色主题"}</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
});
