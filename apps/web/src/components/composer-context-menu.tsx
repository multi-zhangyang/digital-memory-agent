"use client";
import { File, FileText, LoaderCircle, Slash } from "lucide-react";
import { useMemo, type RefObject, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { matchingFiles, useProjectFiles } from "@/hooks/use-project-files";
import type { Asset } from "@memory/contracts";

export interface ComposerToken {
  kind: "file" | "command";
  query: string;
  start: number;
  end: number;
}
export type ContextChoice = {
  kind: "file" | "asset" | "command";
  value: string;
};
export const commandLabels: Record<string, string> = {
  "/files": "项目文件",
  "/review": "审阅改动",
  "/terminal": "终端输出",
  "/compact": "压缩上下文",
  "/fork": "创建会话分支",
  "/settings": "设置",
};

export function ComposerContextMenu({
  token,
  projectId,
  assets,
  commands,
  menuRef,
  textarea,
  onClose,
  onSelect,
  children,
}: {
  token: ComposerToken | null;
  projectId?: string;
  assets: Asset[];
  commands: string[];
  menuRef: RefObject<HTMLDivElement | null>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onSelect: (choice: ContextChoice) => void;
  children: ReactNode;
}) {
  const { files, loading, error } = useProjectFiles(
    projectId,
    token?.kind === "file",
  );
  const query = token?.query.toLocaleLowerCase() || "";
  const matches = useMemo(() => matchingFiles(files, query), [files, query]);
  const library = useMemo(
    () =>
      assets
        .filter((asset) => asset.name.toLocaleLowerCase().includes(query))
        .slice(0, 15),
    [assets, query],
  );
  return (
    <Popover
      open={!!token}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target === textarea.current) event.preventDefault();
        }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Command
          ref={menuRef}
          shouldFilter={false}
          label={token?.kind === "file" ? "引用文件" : "命令与 Skills"}
          loop
        >
          <CommandList
            label={token?.kind === "file" ? "文件引用建议" : "命令建议"}
            className="max-h-72"
          >
            {token?.kind === "file" ? (
              <>
                {loading && (
                  <div
                    role="status"
                    className="flex items-center gap-2 p-3 text-xs text-muted-foreground"
                  >
                    <LoaderCircle className="size-3 animate-spin" />
                    读取项目文件…
                  </div>
                )}
                {error && (
                  <p role="alert" className="p-3 text-xs">
                    {error}
                  </p>
                )}
                {!!matches.length && (
                  <CommandGroup heading="项目文件">
                    {matches.map((file) => (
                      <CommandItem
                        key={file.path}
                        value={"file:" + file.path}
                        onSelect={() =>
                          onSelect({ kind: "file", value: file.path })
                        }
                        className="py-2"
                      >
                        <File />
                        <span className="truncate">{file.path}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {!!library.length && (
                  <CommandGroup heading="资料库">
                    {library.map((asset) => (
                      <CommandItem
                        key={asset.id}
                        value={"asset:" + asset.id}
                        onSelect={() =>
                          onSelect({ kind: "asset", value: asset.id })
                        }
                        className="py-2"
                      >
                        <FileText />
                        <span className="truncate">{asset.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {!loading && !error && (
                  <CommandEmpty>没有匹配的文件</CommandEmpty>
                )}
              </>
            ) : (
              <>
                <CommandGroup heading="命令与 Skills">
                  {commands
                    .filter((command) =>
                      (command + " " + (commandLabels[command] || ""))
                        .toLocaleLowerCase()
                        .includes(query),
                    )
                    .map((command) => (
                      <CommandItem
                        key={command}
                        value={command}
                        onSelect={() =>
                          onSelect({ kind: "command", value: command })
                        }
                        className="py-2"
                      >
                        <Slash />
                        <span>{command}</span>
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {commandLabels[command] ||
                            (command.startsWith("/skill:")
                              ? "Skill"
                              : "提示模板")}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
                <CommandEmpty>没有匹配的命令</CommandEmpty>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
