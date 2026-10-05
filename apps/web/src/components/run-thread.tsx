"use client";
import {
  Artifact as AIArtifact,
  ArtifactDescription,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought";
import { CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@/components/ai-elements/message";
import {
  Plan,
  PlanContent,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueList,
} from "@/components/ai-elements/queue";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { ToolOutput } from "@/components/ai-elements/tool";
import { ToolActivity } from "@/components/tool-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, datasetDownloadUrl, videoTime } from "@/lib/api";
import { RunMemoryActivity, MemoryRecallSources, memoryLabel } from "./memory-activity";
import { toolUI } from "@/lib/tool-ui";
import { fileData, isActive, type InspectorTarget } from "@/lib/workbench";
import type {
  Artifact,
  Asset,
  MemoryEntry,
  Run,
  SourceRef,
  ToolInfo,
} from "@memory/contracts";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  GitBranch,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { AgentApprovals } from "./agent-approvals";
import { RunJobs } from "./run-jobs";
import { RunActivities } from "./memory-activities";
import { RunRecovery } from "./run-recovery";

export function SourceLinks({
  sources,
  onInspect,
}: {
  sources: SourceRef[];
  onInspect: (target: InspectorTarget) => void;
}) {
  if (!sources.length) return null;
  return (
    <Sources className="mb-0">
      <SourcesTrigger count={sources.length}>
        <BookOpen className="size-3.5" />
        <span>{sources.length} 处来源</span>
        <ChevronDown className="size-3.5" />
      </SourcesTrigger>
      <SourcesContent>
        {sources.map((source, index) => (
          <Source
            key={source.assetId + ":" + source.start + ":" + index}
            href={
              "?panel=assets&item=" +
              source.assetId +
              "&start=" +
              source.start +
              "&end=" +
              source.end + (source.video ? "&timestamp=" + source.video.timestamp : "")
            }
            onClick={(event) => {
              event.preventDefault();
              onInspect({
                tab: "assets",
                id: source.assetId,
                start: source.start,
                end: source.end,
                timestamp: source.video?.timestamp,
              });
            }}
            title={source.name}
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">
              [{index + 1}] {source.name}{source.video ? ` · ${videoTime(source.video.timestamp)}` : ""}
            </span>
            <ArrowUpRight className="size-3" />
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}

export { Markdown } from "./markdown";
import { Markdown } from "./markdown";
import { ExecutionTimeline } from "./execution-timeline";

function RunPlan({ run }: { run: Run }) {
  if (!run.plan.length) return null;
  return (
            <Plan
              defaultOpen
              className="gap-2 border-0 bg-transparent py-1 shadow-none"
            >
              <PlanHeader className="flex-row items-center px-0">
                <PlanTitle >执行步骤</PlanTitle>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {
                      run.plan.filter((step) => step.status === "completed")
                        .length
                    }
                    /{run.plan.length}
                  </span>
                  <PlanTrigger />
                </div>
              </PlanHeader>
              <PlanContent className="flex flex-col gap-2 border-l px-4 pb-1">
                {run.plan.map((step, index) => (
                  <TaskItem
                    key={step.id || index}
                    className="flex items-center gap-2"
                  >
                    {step.status === "completed" ? (
                      <Check className="size-3.5" />
                    ) : step.status === "running" ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Circle className="size-3 text-muted-foreground" />
                    )}
                    <span
                      className={
                        step.status === "pending" ? "text-muted-foreground" : ""
                      }
                    >
                      {step.title}
                    </span>
                  </TaskItem>
                ))}
              </PlanContent>
            </Plan>
  );
}

export const RunThread = memo(function RunThread({
  run,
  activeEntryIds,
  onClearQueue,
  onDelivery,
  assets,
  artifacts,
  memories,
  tools,
  onInspect,
  onRetry,
  onRefresh,
  onFork,
  onFiles,
  onOpenFile,
  onReuse,
}: {
  run: Run;
  activeEntryIds?: string[];
  onClearQueue?: () => Promise<void>;
  onDelivery?: (runId: string, toolCallId: string) => void;
  assets: Asset[];
  artifacts: Artifact[];
  memories: MemoryEntry[];
  tools: ToolInfo[];
  onInspect: (target: InspectorTarget) => void;
  onRetry: (run: Run) => void;
  onRefresh: () => void;
  onFork?: (run: Run) => void;
  onFiles?: (runId: string, path?: string) => void;
  onOpenFile?: (ref: { path: string; runId?: string }) => void;
  onReuse?: (run: Run) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState(false);
  useEffect(() => {
    if (window.location.hash !== "#run-" + run.id) return;
    const timer = setTimeout(() => document.getElementById("run-" + run.id)?.scrollIntoView({ block: "center" }), 100);
    return () => clearTimeout(timer);
  }, [run.id]);
  const busy = isActive(run);
  const branch = activeEntryIds && new Set(activeEntryIds);
  const showDelivery = !branch || !run.entryId || branch.has(run.entryId) || busy;
  const response = run.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const results = artifacts.filter((artifact) => artifact.runId === run.id);
  const drafts = memories.filter((memory) => memory.runId === run.id);
  async function reply(value: string) {
    if (!value.trim() || answering || run.status !== "waiting") return;
    setAnswering(true);
    setError("");
    try {
      await api("/runs/" + run.id + "/answer", {
        method: "POST",
        body: JSON.stringify({ answer: value }),
      });
      setAnswer("");
      onRefresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "回答失败");
    } finally {
      setAnswering(false);
    }
  }
  return (
    <section
      id={"run-" + run.id}
      className="flex flex-col gap-6"
      data-testid="run-thread"
      data-run-status={run.status}
    >
      {!run.window?.start && (!branch || !run.inputEntryId || branch.has(run.inputEntryId)) && <Message from="user" className="ml-auto max-w-[90%]">
        <MessageContent className="rounded-2xl px-4 py-3">
          {run.text && <p className="whitespace-pre-wrap leading-7">{run.text}</p>}
          {!!run.fileReferences?.length && (
            <div
              className="mt-2 flex flex-wrap gap-1"
              data-testid="message-file-references"
            >
              {run.fileReferences.map((ref) => (
                <Button
                  key={ref.path + (ref.runId || "")}
                  variant="outline"
                  size="sm"
                  className="h-7 max-w-full gap-1.5 bg-transparent px-2 text-xs font-normal"
                  onClick={() => onOpenFile?.(ref)}
                  title={ref.path}
                >
                  <FileText className="size-3" />
                  <span className="truncate">{ref.path}</span>
                  {ref.runId && (
                    <span className="text-muted-foreground">改动</span>
                  )}
                </Button>
              ))}
            </div>
          )}
          {!!run.assetIds.length && (
            <Attachments variant="inline">
              {run.assetIds
                .map((id) => assets.find((asset) => asset.id === id))
                .filter((asset): asset is Asset => !!asset)
                .map((asset) => (
                  <Attachment key={asset.id} data={fileData(asset)}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onInspect({ tab: "assets", id: asset.id })}
                    >
                      <AttachmentPreview />
                      <AttachmentInfo />
                    </Button>
                  </Attachment>
                ))}
            </Attachments>
          )}
        </MessageContent>
        {onReuse && (
          <MessageActions className="ml-auto text-muted-foreground">
            <MessageAction
              label="复用请求"
              tooltip="复用请求"
              onClick={() => onReuse(run)}
            >
              <RotateCcw className="size-3.5" />
            </MessageAction>
          </MessageActions>
        )}
      </Message>}
      {showDelivery && <RunPlan run={run} />}
      <ExecutionTimeline run={run} activeEntryIds={activeEntryIds} />
      {showDelivery && <Message from="assistant" className="max-w-full gap-3">
        <MessageContent className="w-full gap-4 overflow-visible">
          <RunJobs jobs={(run.jobs || []).filter((job) => !run.parts.some((part) => part.type === "tool" && part.toolCallId === job.toolCallId))} />
          <RunActivities run={run} assets={assets} onInspect={onInspect} />
          {run.parts.flatMap((part) => part.type === "tool" && part.name === "deliver_dataset" && part.state === "complete" ? [part] : []).map((part) =>
            <Button key={part.toolCallId} size="sm" variant="outline" className="self-start" onClick={() => onDelivery?.(run.id, part.toolCallId)}>查看训练文件</Button>)}
          {!run.parts.length && busy && (
            <div role="status" className="text-sm">
              <Shimmer>
                {run.status === "queued" ? "等待前一项任务" : "正在处理"}
              </Shimmer>
            </div>
          )}
          <AgentApprovals run={run} onChanged={onRefresh} />
          <RunRecovery run={run} onChanged={onRefresh} />
          {!!run.interventions?.length && (
            <Queue className="p-2 shadow-none">
              {run.interventions.some((item) => item.status === "queued") && onClearQueue && <div className="flex items-center justify-between px-2 pb-2">
                <span className="text-xs text-muted-foreground">待发送指令</span><Button size="sm" variant="ghost" onClick={() => void onClearQueue()}>撤回到输入框</Button>
              </div>}
              <QueueList className="m-0">
                {run.interventions.filter((item) => item.status !== "delivered" || !run.parts.some((part) => part.type === "message" && part.role === "user" && part.text === item.text)).map((item) => (
                  <QueueItem key={item.id}>
                    <div className="flex items-center gap-2">
                      <QueueItemContent className="line-clamp-none whitespace-pre-wrap text-foreground">
                        {item.text}
                      </QueueItemContent>
                      <Badge variant="outline" className="shrink-0">
                        {item.status === "queued"
                          ? "等待送达"
                          : item.status === "delivered"
                            ? "已送达"
                            : item.status === "handled" ? "扩展已处理" : "已退回"}
                      </Badge>
                    </div>
                  </QueueItem>
                ))}
              </QueueList>
            </Queue>
          )}
          {run.question && (
            <Confirmation
              approval={
                run.question.answer
                  ? { id: run.id, approved: true }
                  : { id: run.id }
              }
              state={
                run.question.answer
                  ? "approval-responded"
                  : "approval-requested"
              }
              role={run.question.answer ? "status" : "alert"}
              className="gap-3 p-4"
            >
              <ConfirmationTitle className="text-sm font-medium leading-6">
                {run.question.text}
              </ConfirmationTitle>
              <ConfirmationAccepted>
                <p className="whitespace-pre-wrap text-sm">
                  {run.question.answer}
                </p>
              </ConfirmationAccepted>
              <ConfirmationRequest>
                <Suggestions className="w-full flex-wrap">
                  {run.question.options.map((option) => (
                    <Suggestion
                      key={option}
                      suggestion={option}
                      disabled={answering || run.status !== "waiting"}
                      onClick={(value) => void reply(value)}
                    />
                  ))}
                </Suggestions>
                <PromptInput
                  resetOnSubmit={false}
                  maxFiles={0}
                  onSubmit={({ text }) => reply(text)}
                >
                  <PromptInputBody>
                    <PromptInputTextarea
                      aria-label="补充回答"
                      disabled={answering || run.status !== "waiting"}
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      placeholder="补充你的回答"
                    />
                  </PromptInputBody>
                  <PromptInputFooter className="justify-end">
                    <PromptInputSubmit
                      aria-label="继续"
                      size="sm"
                      status={answering ? "submitted" : "ready"}
                      disabled={
                        answering || run.status !== "waiting" || !answer.trim()
                      }
                    >
                      继续
                    </PromptInputSubmit>
                  </PromptInputFooter>
                </PromptInput>
              </ConfirmationRequest>
            </Confirmation>
          )}
          {(run.error || error) && (
            <ToolOutput
              className="p-0"
              output={undefined}
              errorText={run.error || error}
            />
          )}
          {results.map((artifact) => (
            <AIArtifact
              key={artifact.id}
              className="w-full max-w-lg shadow-none"
            >
              <Button
                variant="ghost"
                className="h-auto w-full flex-col items-stretch gap-3 whitespace-normal p-4 text-left"
                onClick={() => onInspect({ tab: "artifacts", id: artifact.id })}
              >
                <div className="flex items-center gap-3">
                  <FileText className="size-4 shrink-0" />
                  <ArtifactTitle className="min-w-0 flex-1 truncate">
                    {artifact.title}
                  </ArtifactTitle>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">
                    v{artifact.version}
                  </span>
                  <ArrowUpRight className="size-3.5 text-muted-foreground" />
                </div>
                <ArtifactDescription className="line-clamp-2 text-xs font-normal leading-5">
                  {artifact.content.replace(/[#*`]/g, "").trim().slice(0, 180)}
                </ArtifactDescription>
              </Button>
            </AIArtifact>
          ))}
          {drafts.map((memory) => (
            <Button
              key={memory.id}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => onInspect({ tab: "memories", id: memory.id })}
            >
              <BookOpen />
              <span className="truncate">{memory.title}</span>
              <Badge variant="secondary" className="ml-auto">
                {memoryLabel(memory)}
              </Badge>
            </Button>
          ))}
          {!busy && !!run.changes?.length && (
            <Task
              defaultOpen={run.changes.length <= 3}
              className="overflow-hidden rounded-xl border border-border/60 bg-muted/20"
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <TaskTrigger title={`${run.changes.length} 个文件改动`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="展开修改文件"
                    className="h-7 min-w-0 flex-1 justify-start gap-2 px-0 text-xs font-normal [&[data-state=open]>svg]:rotate-90"
                  >
                    <ChevronRight className="size-3.5" />
                    {run.changes.length} 个文件改动
                  </Button>
                </TaskTrigger>
                <CheckpointTrigger
                  aria-label={`${run.changes.length} 个文件改动`}
                  onClick={() => onFiles?.(run.id)}
                  className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
                >
                  审阅
                  <ArrowUpRight className="size-3" />
                </CheckpointTrigger>
              </div>
              <TaskContent>
                <div className="divide-y divide-border/50 border-t border-border/50">
                  {run.changes.map((change) => (
                    <Button
                      key={change.path}
                      variant="ghost"
                      aria-label={"审阅 " + change.path}
                      className="h-10 w-full justify-start gap-2.5 rounded-none px-4 text-xs font-normal"
                      onClick={() => onFiles?.(run.id, change.path)}
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono">{change.path}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {change.status === "added"
                          ? "新增"
                          : change.status === "deleted"
                            ? "删除"
                            : "修改"}
                      </span>
                    </Button>
                  ))}
                </div>
              </TaskContent>
            </Task>
          )}
        </MessageContent>
        <MessageToolbar className="mt-1 flex-wrap gap-2">
          <SourceLinks sources={run.sources} onInspect={onInspect} />
          <MemoryRecallSources run={run} onInspect={onInspect} />
          <RunMemoryActivity run={run} memories={memories} onInspect={onInspect} onRefresh={onRefresh} />
          <MessageActions className="text-muted-foreground">
            {!busy && (
              <>
                <MessageAction
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制回复"
                  tooltip="复制回复"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        run.parts
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("\n\n"),
                      );
                      setCopied(true);
                    } catch {
                      setError("复制失败");
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                </MessageAction>
                <MessageAction
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重新运行"
                  tooltip="重新运行"
                  onClick={() => onRetry(run)}
                >
                  <RotateCcw />
                </MessageAction>
                {run.entryId && (
                  <MessageAction
                    variant="ghost"
                    size="icon-sm"
                    aria-label="从这里分支"
                    tooltip="从这里分支"
                    onClick={() => onFork?.(run)}
                  >
                    <GitBranch />
                  </MessageAction>
                )}
              </>
            )}
            {run.memoryIds.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onInspect({ tab: "memories", id: run.memoryIds[0] })
                }
              >
                <BrainIcon />
                已取用 {run.memoryIds.length} 条记忆
              </Button>
            )}
          </MessageActions>
        </MessageToolbar>
      </Message>}
    </section>
  );
});
const BrainIcon = BookOpen;
