"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  LoaderCircle,
} from "lucide-react";
import type { DirectoryListing, Project } from "@memory/contracts";
import { api } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function WorkspaceFolderDialog({
  initialPath,
  onClose,
  onProject,
}: {
  initialPath?: string;
  onClose: () => void;
  onProject: (project: Project) => void;
}) {
  const [requestedPath, setRequestedPath] = useState(initialPath || "");
  const [path, setPath] = useState(initialPath || "");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const selectedPath = path.trim() || listing?.path || "";

  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    const timer = window.setTimeout(
      () => {
        const params = new URLSearchParams({ hidden: String(hidden), query });
        if (requestedPath) params.set("path", requestedPath);
        void api<DirectoryListing>("/directories?" + params, {
          signal: controller.signal,
        })
          .then((result) => {
            if (controller.signal.aborted) return;
            setListing(result);
          })
          .catch((failure) => {
            if (!controller.signal.aborted) {
              setError(failure.message);
              setListing(null);
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [requestedPath, hidden, query, revision]);

  function browse(next: string) {
    setPath(next);
    setRequestedPath(next);
    setQuery("");
    setRevision((value) => value + 1);
  }
  async function loadMore() {
    if (!listing || listing.nextOffset === null || loadingMore) return;
    const currentGeneration = generation.current;
    const offset = listing.nextOffset;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        path: listing.path,
        query,
        hidden: String(hidden),
        offset: String(offset),
      });
      const next = await api<DirectoryListing>("/directories?" + params);
      if (currentGeneration === generation.current)
        setListing((current) =>
          current?.nextOffset === offset
            ? { ...next, entries: [...current.entries, ...next.entries] }
            : current,
        );
    } catch (failure) {
      if (currentGeneration === generation.current)
        setError(failure instanceof Error ? failure.message : "读取失败");
    } finally {
      if (currentGeneration === generation.current) setLoadingMore(false);
    }
  }
  async function open() {
    if (opening || !selectedPath) return;
    setOpening(true);
    setError("");
    try {
      const result = await api<{ project: Project }>("/projects/open", {
        method: "POST",
        body: JSON.stringify({ path: selectedPath }),
      });
      onProject(result.project);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "打开失败");
    } finally {
      setOpening(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !opening) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90svh] gap-0 overflow-y-auto p-0 sm:max-w-xl"
        data-testid="workspace-folder-dialog"
      >
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="size-4" />
            打开文件夹
          </DialogTitle>
          <DialogDescription className="sr-only">
            选择 Agent
            所在设备上的工作目录。可浏览文件夹，也可直接输入完整路径。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 pb-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              browse(selectedPath);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="上级目录"
                  disabled={!listing?.parent || loading || opening}
                  onClick={() => listing?.parent && browse(listing.parent)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>上级目录</TooltipContent>
            </Tooltip>
            <Input
              aria-label="文件夹路径"
              placeholder={listing?.path || "输入文件夹路径…"}
              autoComplete="off"
              spellCheck={false}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onFocus={(event) => event.target.select()}
              className="min-w-0 font-mono text-xs"
              disabled={opening}
            />
            <Button
              type="submit"
              variant="outline"
              size="icon"
              aria-label="转到路径"
              disabled={!selectedPath || opening}
            >
              <ArrowRight className="size-4" />
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-1">
            {listing?.shortcuts.map((shortcut, index) => {
              const Icon =
                index === 0
                  ? Home
                  : shortcut.name === "项目"
                    ? Folder
                    : HardDrive;
              return (
                <Button
                  key={shortcut.path}
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
                  disabled={opening}
                  onClick={() => browse(shortcut.path)}
                >
                  <Icon className="size-3.5" />
                  {shortcut.name}
                </Button>
              );
            })}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto text-muted-foreground"
                  aria-label="显示隐藏文件夹"
                  aria-pressed={hidden}
                  disabled={opening}
                  onClick={() => setHidden((value) => !value)}
                >
                  {hidden ? (
                    <Eye className="size-4" />
                  ) : (
                    <EyeOff className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {hidden ? "隐藏点号目录" : "显示隐藏文件夹"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <Command
          label="筛选文件夹"
          shouldFilter={false}
          className="rounded-none border-y bg-transparent"
        >
          <CommandInput
            aria-label="筛选文件夹"
            placeholder="筛选文件夹…"
            value={query}
            onValueChange={setQuery}
            disabled={opening}
            className="text-xs"
          />
          <CommandList
            label="文件夹列表"
            className="h-64 max-h-64 scroll-py-2 sm:h-72 sm:max-h-72"
          >
            {loading ? (
              <div
                className="space-y-3 p-4"
                role="status"
                aria-label="正在读取目录"
              >
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-7 w-full" />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className="py-16 text-center text-xs text-muted-foreground">
                  {error
                    ? "目录未打开"
                    : query
                      ? "没有匹配的文件夹"
                      : "没有子文件夹"}
                </CommandEmpty>
                <CommandGroup className="p-2">
                  {listing?.entries.map((entry) => (
                    <CommandItem
                      key={entry.path}
                      value={entry.path}
                      onSelect={() => browse(entry.path)}
                      disabled={opening}
                      className="gap-3 rounded-md px-3 py-2.5"
                    >
                      <Folder className="size-4" />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.name}
                      </span>
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </CommandItem>
                  ))}
                </CommandGroup>
                {listing?.nextOffset !== null &&
                  listing?.nextOffset !== undefined && (
                    <div className="px-4 pb-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs text-muted-foreground"
                        onClick={() => void loadMore()}
                        disabled={loadingMore || opening}
                      >
                        {loadingMore ? (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        ) : null}
                        加载更多 · {listing.entries.length}/{listing.total}
                      </Button>
                    </div>
                  )}
              </>
            )}
          </CommandList>
        </Command>
        {error && (
          <Alert className="mx-4 mt-3 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="flex-row items-center justify-between gap-3 p-4 sm:justify-between">
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={listing?.host}
          >
            <HardDrive className="mr-1.5 inline size-3.5" />
            Agent 主机
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={onClose} disabled={opening}>
              取消
            </Button>
            <Button
              onClick={() => void open()}
              disabled={
                opening ||
                !selectedPath ||
                (selectedPath === listing?.path && !listing.canOpen)
              }
            >
              {opening ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              打开文件夹
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
