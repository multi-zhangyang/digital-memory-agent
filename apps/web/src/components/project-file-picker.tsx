"use client";
import { useMemo, useState } from "react";
import { File, LoaderCircle } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { matchingFiles, useProjectFiles } from "@/hooks/use-project-files";
import type { Project } from "@memory/contracts";

export function ProjectFilePicker({
  project,
  onSelect,
  onClose,
}: {
  project: Project;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const { files, loading, error } = useProjectFiles(project.id, true);
  const matches = useMemo(() => matchingFiles(files, query), [files, query]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>快速打开文件</DialogTitle>
        </DialogHeader>
        <Command label="搜索项目文件" shouldFilter={false}>
          <CommandInput
            placeholder="搜索项目文件…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-96" label="项目文件结果">
            {loading && (
              <div
                role="status"
                className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
              >
                <LoaderCircle className="size-4 animate-spin" />
                读取文件…
              </div>
            )}
            {error && (
              <p role="alert" className="p-5 text-sm">
                {error}
              </p>
            )}
            {!loading && !error && <CommandEmpty>没有匹配的文件</CommandEmpty>}
            <CommandGroup heading={project.name}>
              {matches.map((file) => (
                <CommandItem
                  key={file.path}
                  value={file.path}
                  onSelect={() => {
                    onSelect(file.path);
                    onClose();
                  }}
                  className="gap-3 px-3 py-2.5"
                >
                  <File className="size-4" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {file.path.split("/").at(-1)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {file.path}
                    </span>
                  </span>
                  <CommandShortcut>↵</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{files.filter((file) => !file.directory).length} 个文件</span>
            <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
