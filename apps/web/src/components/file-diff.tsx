"use client";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { parsePatchFiles } from "@pierre/diffs";
import {
  FileDiff as PierreFileDiff,
  type DiffBasePropsReact,
} from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { downloadText } from "@/lib/workbench";
import type { FileChange } from "@memory/contracts";
import { createTwoFilesPatch } from "diff";
import { Columns2, Download, Rows3 } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
const CodeBlock = dynamic(
  () =>
    import("@/components/ai-elements/code-block").then(
      (module) => module.CodeBlock,
    ),
  { loading: () => <Skeleton className="h-32" /> },
);

export function FileDiff({ change }: { change: FileChange }) {
  const { resolvedTheme } = useTheme();
  const [split, setSplit] = useState(false);
  const options = useMemo<DiffBasePropsReact<undefined>["options"]>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: resolvedTheme === "light" ? "light" : "dark",
      diffStyle: split ? "split" : "unified",
      diffIndicators: "classic",
      disableBackground: true,
      disableFileHeader: true,
      overflow: "wrap",
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
      tokenizeMaxLength: 40000,
    }),
    [resolvedTheme, split],
  );
  const canCompare =
    (!change.before || change.before.content !== null) &&
    (!change.after || change.after.content !== null);
  const patch = useMemo(() => {
    if (!canCompare) return undefined;
    const before = change.before?.content || "",
      after = change.after?.content || "";
    if (before.length + after.length > 240000) return undefined;
    return createTwoFilesPatch(
      "a/" + change.path,
      "b/" + change.path,
      before,
      after,
      undefined,
      undefined,
      { context: 3, timeout: 40, maxEditLength: 4000 },
    );
  }, [change, canCompare]);
  const revision = JSON.stringify([
    change.path,
    change.before?.hash,
    change.after?.hash,
  ]);
  // Diffs treats cacheKey as revision identity; a filename alone reuses stale hunks.
  const fileDiff = useMemo(
    () => (patch ? parsePatchFiles(patch, revision)[0]?.files[0] : undefined),
    [patch, revision],
  );
  const render = (text: string | null | undefined) =>
    text === null || text === undefined ? (
      <p className="p-4 text-xs text-muted-foreground">此版本没有文本预览</p>
    ) : text.length > 20000 ? (
      <pre className="overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6">
        {text}
      </pre>
    ) : (
      <CodeBlock
        code={text}
        language="text"
        className="rounded-none border-0"
      />
    );
  return (
    <Tabs
      defaultValue={patch ? "diff" : change.after ? "after" : "before"}
      className="gap-0"
    >
      <div className="flex items-center justify-between border-b px-3">
        <TabsList variant="line" className="h-10 gap-3 px-0">
          <TabsTrigger value="diff" className="px-0 text-xs">
            差异
          </TabsTrigger>
          {change.before && (
            <TabsTrigger value="before" className="px-0 text-xs">
              修改前
            </TabsTrigger>
          )}
          {change.after && (
            <TabsTrigger value="after" className="px-0 text-xs">
              修改后
            </TabsTrigger>
          )}
        </TabsList>
        <div className="flex items-center gap-1">
          <ButtonGroup>
            <Button
              variant={split ? "ghost" : "secondary"}
              size="icon-sm"
              aria-label="逐行对比"
              aria-pressed={!split}
              onClick={() => setSplit(false)}
            >
              <Rows3 className="size-3.5" />
            </Button>
            <Button
              variant={split ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="并排对比"
              aria-pressed={split}
              onClick={() => setSplit(true)}
            >
              <Columns2 className="size-3.5" />
            </Button>
          </ButtonGroup>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={"导出补丁 " + change.path}
            disabled={!patch}
            onClick={() => {
              if (patch) downloadText(change.path, patch, "patch");
            }}
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      </div>
      <TabsContent value="diff" className="min-w-0">
        {fileDiff ? (
          <PierreFileDiff
            fileDiff={fileDiff}
            options={options}
            className="block min-w-0"
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            无法生成行级差异，请查看对应版本。
          </p>
        )}
      </TabsContent>
      {change.before && (
        <TabsContent value="before" className="min-w-0">
          {render(change.before.content)}
        </TabsContent>
      )}
      {change.after && (
        <TabsContent value="after" className="min-w-0">
          {render(change.after.content)}
        </TabsContent>
      )}
    </Tabs>
  );
}
