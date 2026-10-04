"use client";
import { useState } from "react";
import type { MemoryEntry, MemoryImportJob } from "@memory/contracts";
import { ChevronDown, FileText, RotateCcw, Square, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Task, TaskTrigger, TaskContent } from "@/components/ai-elements/task";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolOutput,
  ToolInput,
} from "@/components/ai-elements/tool";
import { api, videoTime } from "@/lib/api";

const labels = {
  queued: "排队中",
  running: "提取中",
  completed: "已完成",
  failed: "部分未完成",
  cancelled: "已取消",
};
const stages = {
  read: "校验来源",
  extract: "模型提取",
  validate: "核对证据",
  save: "保存候选",
};
export function MemoryImportList({
  jobs,
  memories,
  onChanged,
  onOpen,
  onImport,
}: {
  jobs: MemoryImportJob[];
  memories: MemoryEntry[];
  onChanged: () => void;
  onOpen: (id: string) => void;
  onImport: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(id: string, action: "cancel" | "retry") {
    setBusy(id);
    setError("");
    try {
      await api("/memory-imports/" + id + "/" + action, { method: "POST" });
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作未完成");
    } finally {
      setBusy("");
    }
  }
  if (!jobs.length)
    return (
      <Empty className="min-h-72">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Upload />
          </EmptyMedia>
          <EmptyTitle>从一段经历开始</EmptyTitle>
        </EmptyHeader>
        <Button size="sm" onClick={onImport}>
          导入经历
        </Button>
      </Empty>
    );
  return (
    <div className="divide-y">
      {error && (
        <p role="alert" className="pb-4 text-sm">
          {error}
        </p>
      )}
      {jobs.map((job) => {
        const active = job.status === "running" || job.status === "queued";
        const finished = job.chunks.filter(
          (chunk) => chunk.status === "completed" || chunk.status === "skipped",
        ).length;
        const count = new Set(job.chunks.flatMap((chunk) => chunk.memoryIds))
          .size;
        return (
          <Task
            key={job.id}
            defaultOpen={false}
            className="py-5"
            data-testid="memory-import-job"
            data-job-status={job.status}
          >
            <div className="flex items-center gap-3">
              <TaskTrigger title={job.title}>
                <Button
                  variant="ghost"
                  className="h-auto min-w-0 flex-1 justify-start gap-3 px-0 text-left"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium">{job.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.modelId.split("/").slice(1).join("/")} · {finished}/
                      {job.chunks.length} {job.mode === "photos" ? "张照片" : job.mode === "auto" ? "项" : "段"} · {count} 条记忆
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {labels[job.status]}
                  </Badge>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              </TaskTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy === job.id}
                aria-label={
                  active ? "取消导入 " + job.title : "重试导入 " + job.title
                }
                onClick={() => void act(job.id, active ? "cancel" : "retry")}
                className={job.status === "completed" ? "invisible" : ""}
              >
                {active ? <Square /> : <RotateCcw />}
              </Button>
            </div>
            {active && (
              <Progress
                aria-label="经历处理进度"
                value={
                  job.chunks.length ? (finished / job.chunks.length) * 100 : 0
                }
                className="mt-4 h-1"
              />
            )}
            <TaskContent>
              {job.chunks.map((chunk, index) => (
                <Tool key={chunk.id} className="mb-2 last:mb-0">
                  <ToolHeader
                    title={`${chunk.name} · ${chunk.video ? videoTime(chunk.video.timestamp) : index + 1}${chunk.stage ? " · " + stages[chunk.stage] : chunk.reason ? " · 已停止取用" : chunk.status === "skipped" ? " · 已处理，复用记录" : ""}`}
                    type={chunk.media ? "tool-extract_photo_memories" : "tool-extract_memories"}
                    state={
                      chunk.status === "completed" || chunk.status === "skipped"
                        ? "output-available"
                        : chunk.status === "failed" ||
                            job.status === "cancelled"
                          ? "output-error"
                          : chunk.status === "running"
                            ? "input-available"
                            : "input-streaming"
                    }
                  />
                  <ToolContent>
                    {chunk.media && <ToolInput input={{ assetId: chunk.assetId, source: chunk.name, modelId: chunk.modelId || job.modelId, ...(chunk.video ? { video: chunk.video } : {}) }} />}
                    <div className="space-y-3 border-t p-4">
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {chunk.media === "video" ? "视频原件" : chunk.media === "image" ? "图片原件" : "原文"} {chunk.start}–{chunk.end} 字节
                        </span>
                        <span>调用 {chunk.attempts} 次</span>
                        {chunk.usage && (
                          <span>
                            输入 {chunk.usage.input.toLocaleString()} · 输出{" "}
                            {chunk.usage.output.toLocaleString()} tokens
                          </span>
                        )}
                      </div>
                      {chunk.reason && <p>{chunk.reason}</p>}
                      {chunk.error && (
                        <ToolOutput
                          className="p-0"
                          output={undefined}
                          errorText={chunk.error}
                        />
                      )}
                      {chunk.memoryIds.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {chunk.memoryIds.map((id) => (
                            <Button
                              key={id}
                              variant="outline"
                              size="sm"
                              onClick={() => onOpen(id)}
                            >
                              {memories.find((memory) => memory.id === id)
                                ?.title || "查看记忆"}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        (chunk.status === "completed" ||
                          chunk.status === "skipped") && (
                          <p className="text-sm text-muted-foreground">
                            {chunk.media === "video" ? "此画面没有新增观察" : chunk.media === "image" ? "未生成新的照片记忆" : "本段没有提取出个人记忆"}
                          </p>
                        )
                      )}
                    </div>
                  </ToolContent>
                </Tool>
              ))}
            </TaskContent>
          </Task>
        );
      })}
    </div>
  );
}
