"use client";

import { Suggestion } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import type { Project } from "@memory/contracts";
import { ChevronDown, Code2, FileText, FolderOpen, Search } from "lucide-react";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function TaskLauncher({
  project,
  composer,
  onPrompt,
  onOpenFolder,
}: {
  project?: Project;
  composer: ReactNode;
  onPrompt: (text: string) => void;
  onOpenFolder: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pb-16"
      data-testid="task-launcher"
    >
      <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-10">
        <div className="mb-7 flex flex-col items-start gap-3 px-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenFolder}
                aria-label="选择工作目录"
                className="h-7 max-w-full gap-2 px-0 text-xs font-normal text-muted-foreground hover:bg-transparent"
              >
                <FolderOpen className="size-3.5" />
                <span className="truncate">{project?.name || "项目文件"}</span>
                <ChevronDown className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm break-all">
              {project?.directory || "打开文件夹"}
            </TooltipContent>
          </Tooltip>
          <h1 className="text-3xl font-medium tracking-tight">新任务</h1>
        </div>
        {composer}
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            {
              label: "研究问题",
              text: "帮我研究一个问题，搜索可靠资料并整理有来源的结论：",
              icon: Search,
            },
            {
              label: "处理文件",
              text: "检查我提供的文件，分析内容并生成整理结果。",
              icon: FileText,
            },
            {
              label: "探索项目",
              text: "检查项目文件，告诉我目前的结构",
              icon: FolderOpen,
            },
            {
              label: "编写脚本",
              text: "帮我编写并运行一个脚本，完成以下任务：",
              icon: Code2,
            },
          ].map(({ label, text, icon: Icon }) => (
            <Suggestion
              key={label}
              variant="ghost"
              suggestion={text}
              onClick={onPrompt}
              className="h-8 gap-2 rounded-lg border-transparent bg-transparent px-3 text-xs font-normal text-muted-foreground shadow-none hover:bg-muted"
            >
              <Icon className="size-3.5" />
              {label}
            </Suggestion>
          ))}
        </div>
      </div>
    </div>
  );
}
