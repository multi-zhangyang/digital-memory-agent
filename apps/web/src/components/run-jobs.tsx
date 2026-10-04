"use client";

import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { ToolInput } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskJob } from "@memory/contracts";
import { ChevronDown, ListTodo } from "lucide-react";

const labels: Record<TaskJob["status"], string> = {
  queued: "等待处理", running: "处理中", completed: "处理完成", failed: "处理失败", cancelled: "已取消", skipped: "已跳过",
};

export function RunJobs({ jobs }: { jobs: TaskJob[] }) {
  if (!jobs.length) return null;
  return (
    <Task defaultOpen data-testid="run-jobs">
      <TaskTrigger title="后台作业">
        <Button variant="ghost" size="sm">
          <ListTodo data-icon="inline-start" />
          后台作业 · {jobs.length}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </TaskTrigger>
      <TaskContent>
        {jobs.map((job) => (
          <TaskItem key={job.kind + job.id} className="flex flex-col gap-2" data-testid="run-job" data-job-status={job.status}>
            <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
              <span>{job.title}</span>
              <Badge variant="outline">{labels[job.status]}</Badge>
              {job.ownership === "library" && <Badge variant="outline">资料库作业</Badge>}
              <span>{job.progress.completed}/{job.progress.total}</span>
              {job.progress.failed > 0 && <span>失败 {job.progress.failed}</span>}
            </div>
            {job.coverage && <p>资料 {job.coverage.total} · 已处理 {job.coverage.completed} · 已复用 {job.coverage.reused} · 失败 {job.coverage.failed} · 待完成 {job.coverage.pending}{job.coverage.blocked > 0 ? ` · 已停用 ${job.coverage.blocked}` : ""}</p>}
            <ToolInput input={{ jobId: job.id, toolCallId: job.toolCallId }} />
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
