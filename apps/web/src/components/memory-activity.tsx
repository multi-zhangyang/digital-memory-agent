"use client";

import { useEffect, useRef, useState } from "react";
import type {
  MemoryCaptureJob,
  MemoryEntry,
  MemoryEvidence,
  Run,
} from "@memory/contracts";
import { BookOpen, ChevronDown, RotateCcw, Square } from "lucide-react";
import {
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
} from "@/components/ai-elements/task";
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from "@/components/ai-elements/sources";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { api } from "@/lib/api";
import type { InspectorTarget } from "@/lib/workbench";
import { PhotoEvidence } from "./photo-evidence";
import { VideoEvidence } from "./video-evidence";

type MemorySummary = Pick<
  MemoryEntry,
  "id" | "title" | "status" | "forgottenAt" | "acceptedBy" | "reason"
>;
const active = (job: MemoryCaptureJob) =>
  ["waiting", "queued", "running"].includes(job.status);
const labels: Record<MemoryCaptureJob["status"], string> = {
  waiting: "等待对话结束",
  queued: "排队中",
  running: "正在记录",
  completed: "已处理",
  failed: "未完成",
  cancelled: "已取消",
  skipped: "已跳过",
};
export const memoryLabel = (memory: MemorySummary) =>
  memory.forgottenAt
    ? "已停用"
    : memory.status === "draft"
      ? "待核对"
      : memory.status === "rejected"
        ? "已排除"
        : memory.reason?.includes("纠正")
          ? "已纠正"
          : "已记住";

export function MemoryCaptureList({
  jobs,
  memories,
  onOpen,
  onChanged,
}: {
  jobs: MemoryCaptureJob[];
  memories: MemorySummary[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(job: MemoryCaptureJob) {
    setBusy(job.id);
    setError("");
    try {
      await api(
        `/memory-captures/${job.id}/${active(job) ? "cancel" : "retry"}`,
        { method: "POST" },
      );
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作未完成");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="memory-capture-list">
      {error && (
        <Alert>
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      {jobs.map((job) => (
        <Task
          key={job.id}
          defaultOpen={false}
          data-testid="memory-capture-job"
          data-job-status={job.status}
        >
          <div className="flex items-center gap-2">
            <TaskTrigger title="自动记录">
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start"
              >
                <BookOpen data-icon="inline-start" />
                <span className="truncate">
                  {labels[job.status]}
                  {job.memoryIds.length
                    ? ` · ${job.memoryIds.length} 条记忆`
                    : ""}
                </span>
                <ChevronDown data-icon="inline-end" />
              </Button>
            </TaskTrigger>
            {(active(job) ||
              job.status === "failed" ||
              job.status === "cancelled") && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={active(job) ? "取消自动记录" : "重试自动记录"}
                disabled={busy === job.id}
                onClick={() => void act(job)}
              >
                {active(job) ? <Square /> : <RotateCcw />}
              </Button>
            )}
          </div>
          <TaskContent>
            <TaskItem>
              {new Date(job.createdAt).toLocaleString("zh-CN")} ·{" "}
              {job.modelId.split("/").slice(1).join("/") || job.modelId}
            </TaskItem>
            {job.error && (
              <Alert>
                <AlertTitle>{job.error}</AlertTitle>
              </Alert>
            )}
            {job.reason && <TaskItem>{job.reason}</TaskItem>}
            {job.status === "completed" && !job.memoryIds.length && (
              <TaskItem>没有新增个人记忆</TaskItem>
            )}
            {job.memoryIds.map((id) => {
              const memory = memories.find((entry) => entry.id === id);
              return (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => onOpen(id)}
                >
                  <span className="truncate">
                    {memory?.title || "查看记忆"}
                  </span>
                  {memory && (
                    <Badge variant="outline">{memoryLabel(memory)}</Badge>
                  )}
                </Button>
              );
            })}
            {job.usage && (
              <TaskItem>
                输入 {job.usage.input.toLocaleString()} · 输出{" "}
                {job.usage.output.toLocaleString()} tokens
              </TaskItem>
            )}
          </TaskContent>
        </Task>
      ))}
    </div>
  );
}

export function RunMemoryActivity({
  run,
  memories,
  onInspect,
  onRefresh,
}: {
  run: Run;
  memories: MemoryEntry[];
  onInspect: (target: InspectorTarget) => void;
  onRefresh: () => void;
}) {
  const [jobs, setJobs] = useState<MemoryCaptureJob[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const known = useRef("");
  useEffect(() => {
    if (!run.captureJobIds?.length && !revision) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api<{ jobs: MemoryCaptureJob[] }>(
          "/memory-captures?runId=" + run.id,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setJobs(result.jobs);
        setError("");
        const signature = JSON.stringify(
          result.jobs.map((job) => [job.id, job.status, job.memoryIds]),
        );
        if (
          signature !== known.current &&
          result.jobs.some((job) => job.status === "completed")
        )
          refresh.current();
        known.current = signature;
        if (result.jobs.some(active))
          timer = setTimeout(() => void load(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "读取失败");
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [run.id, run.status, run.captureJobIds?.length, revision]);
  return (
    <>
      {error && (
        <Alert>
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      {jobs.length > 0 && (
        <MemoryCaptureList
          jobs={jobs.filter(
            (job) => job.status !== "completed" || job.memoryIds.length,
          )}
          memories={memories}
          onOpen={(id) => onInspect({ tab: "memories", id })}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
      {!jobs.length &&
        ["completed", "failed", "stopped"].includes(run.status) && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="从这条消息补记"
            title="从这条消息补记"
            onClick={async () => {
              try {
                await api(`/runs/${run.id}/capture`, { method: "POST" });
                setRevision((value) => value + 1);
                refresh.current();
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : "补记失败",
                );
              }
            }}
          >
            <BookOpen />
          </Button>
        )}
    </>
  );
}

export function MemoryRecallSources({
  run,
  onInspect,
}: {
  run: Run;
  onInspect: (target: InspectorTarget) => void;
}) {
  const matches = [
    ...new Map(
      (run.memoryTraces || [])
        .flatMap((trace) => trace.matches)
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  if (!matches.length) return null;
  return (
    <Sources>
      <SourcesTrigger count={matches.length}>
        记忆依据 · {matches.length}
      </SourcesTrigger>
      <SourcesContent>
        {(run.memoryTraces || []).map((trace, index) => (
          <TaskItem key={index}>
            {trace.query.query || "画像与筛选"} · {trace.durationMs} ms
          </TaskItem>
        ))}
        {matches.map((match, index) => (
          <Button
            key={match.id}
            variant="ghost"
            size="sm"
            onClick={() => onInspect({ tab: "memories", id: match.id })}
          >
            记忆 {index + 1} · v{match.version}
            <Badge variant="outline">{match.evidence.length} 处来源</Badge>
          </Button>
        ))}
      </SourcesContent>
    </Sources>
  );
}

export function MemoryEvidenceList({
  memory,
  onInspect,
}: {
  memory: MemoryEntry;
  onInspect?: (target: InspectorTarget) => void;
}) {
  const evidence: MemoryEvidence[] =
    memory.evidence ||
    memory.sources.map((source) => ({ ...source, type: "asset" }));
  const [verified, setVerified] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    setVerified({});
    setError("");
  }, [memory.id, memory.version]);
  if (!evidence.length) return null;
  return (
    <Sources>
      <SourcesTrigger count={evidence.length}>
        原始依据 · {evidence.length}
      </SourcesTrigger>
      <SourcesContent>
        {error && (
          <Alert>
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}
        {evidence.map((source, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Source
              href={
                source.type === "message"
                  ? `/?view=chat&task=${source.conversationId}&run=${source.runId}#run-${source.runId}`
                  : `/?view=memory&panel=assets&item=${source.assetId}&start=${source.start}&end=${source.end}${source.video ? "&timestamp=" + source.video.requestedTimestamp : ""}${memory.space === "demo" ? "&space=demo" : ""}`
              }
              title={source.type === "message" ? "查看原始消息" : source.name}
              target="_self"
              onClick={(event) => {
                if (
                  source.type === "asset" &&
                  onInspect &&
                  !event.metaKey &&
                  !event.ctrlKey
                ) {
                  event.preventDefault();
                  onInspect({
                    tab: "assets",
                    id: source.assetId,
                    start: source.start,
                    end: source.end,
                    timestamp: source.video?.requestedTimestamp,
                  });
                }
              }}
            />
            {source.type === "asset" && source.video ? <VideoEvidence key={`${memory.id}-${memory.version}-${index}`} memoryId={memory.id} index={index} source={source} />
              : source.type === "asset" && source.visual ? <PhotoEvidence key={`${memory.id}-${memory.version}-${index}`} memoryId={memory.id} index={index} source={source} /> : <>
            <TaskItem>
              <blockquote>{verified[index] || source.quote}</blockquote>
            </TaskItem>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              disabled={!!verified[index]}
              onClick={async () => {
                setError("");
                try {
                  const result = await api<{
                    quote: string;
                    verified: boolean;
                  }>(`/memories/${memory.id}/evidence/${index}`);
                  if (result.verified)
                    setVerified((values) => ({
                      ...values,
                      [index]: result.quote,
                    }));
                } catch (failure) {
                  setError(
                    failure instanceof Error ? failure.message : "核对失败",
                  );
                }
              }}
            >
              {verified[index] ? "原文校验通过" : "核对原文"}
            </Button>
            </>}
          </div>
        ))}
      </SourcesContent>
    </Sources>
  );
}
