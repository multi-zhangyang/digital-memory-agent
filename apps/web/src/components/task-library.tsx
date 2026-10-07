"use client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Artifact, Conversation, Project } from "@memory/contracts";
import { productTasks } from "@/lib/product-tasks";
import { Suggestion } from "@/components/ai-elements/suggestion";
import {
  Archive,
  Check,
  Circle,
  Clock3,
  LoaderCircle,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { useDeferredValue, useState, type ReactNode } from "react";

export function TaskLibrary({
  project,
  conversations,
  filter,
  onFilter,
  onTask,
  onNew,
  menu,
  artifacts = [],
  onArtifact,
  onPrompt,
}: {
  project?: Project;
  conversations: Conversation[];
  filter: string;
  onFilter: (value: string) => void;
  onTask: (id: string) => void;
  onNew: () => void;
  menu: (conversation: Conversation) => ReactNode;
  artifacts?: Artifact[];
  onArtifact?: (id: string) => void;
  onPrompt?: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const tasks = conversations
    .filter((item) =>
      filter === "archived"
        ? item.archived
        : !item.archived && (filter !== "running" || item.running),
    )
    .filter((item) => item.title.toLowerCase().includes(deferredQuery))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="task-library">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
        <div className="mb-8 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-medium tracking-tight">全部对话</h1>
          <Button size="sm" onClick={onNew}>
            <Plus className="size-4" />
            创建任务
          </Button>
        </div>
        {onPrompt && <div className="mb-6 flex flex-wrap gap-2">{productTasks.map((task) =>
          <Suggestion key={task.label} suggestion={task.prompt} onClick={onPrompt}>{task.label}</Suggestion>)}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <Tabs
            value={filter}
            onValueChange={(value) => {
              onFilter(value);
              setLimit(20);
            }}
          >
            <TabsList variant="line" className="h-8 gap-5 p-0">
              <TabsTrigger value="recent" className="px-0 text-xs">
                最近
              </TabsTrigger>
              <TabsTrigger value="running" className="px-0 text-xs">
                进行中
              </TabsTrigger>
              <TabsTrigger value="archived" className="px-0 text-xs">
                已归档
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <InputGroup className="h-8 w-40 shadow-none sm:w-56">
            <InputGroupAddon>
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="搜索任务"
              placeholder="搜索任务"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="text-xs"
            />
          </InputGroup>
        </div>
        {tasks.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="text-xs">任务</TableHead>
                <TableHead className="hidden text-right text-xs sm:table-cell">
                  更新于
                </TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.slice(0, limit).map((item) => {
                const Status = item.running
                  ? LoaderCircle
                  : item.pinned
                    ? Star
                    : item.archived
                      ? Archive
                      : item.status === "completed"
                        ? Check
                        : item.status === "failed"
                          ? Circle
                          : Clock3;
                return (
                  <TableRow
                    key={item.id}
                    className="group/task border-border/60"
                  >
                    <TableCell className="w-8 pr-0">
                      <Status
                        className={
                          "size-3.5 text-muted-foreground " +
                          (item.running ? "animate-spin" : "")
                        }
                      />
                    </TableCell>
                    <TableCell className="w-full max-w-0 py-2">
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start px-1 py-2 text-sm font-normal"
                        onClick={() => onTask(item.id)}
                      >
                        <span className="truncate">{item.title}</span>
                      </Button>
                      {onArtifact && artifacts.filter((artifact) => artifact.conversationId === item.id).slice(-1).map((artifact) =>
                        <Button key={artifact.id} size="sm" variant="link" className="max-w-full text-xs text-muted-foreground" onClick={() => onArtifact(artifact.id)}>
                          <span className="truncate">{artifact.title}</span>
                        </Button>)}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                      {item.running
                        ? "进行中"
                        : item.status === "failed"
                          ? "未完成"
                          : new Date(item.updatedAt).toLocaleDateString(
                              "zh-CN",
                              { month: "short", day: "numeric" },
                            )}
                    </TableCell>
                    <TableCell className="w-8 px-1">{menu(item)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyMedia>
                <Archive className="size-5 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle className="text-sm font-normal text-muted-foreground">
                {query
                  ? "没有匹配的任务"
                  : filter === "running"
                    ? "没有进行中的任务"
                    : filter === "archived"
                      ? "没有归档任务"
                      : "暂无任务"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {tasks.length > limit && (
          <Button
            variant="ghost"
            className="mt-4 w-full text-xs text-muted-foreground"
            onClick={() => setLimit((value) => value + 20)}
          >
            加载更多任务
          </Button>
        )}
      </div>
    </div>
  );
}
