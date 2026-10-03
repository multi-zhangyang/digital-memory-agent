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
import { api } from "@/lib/api";
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
import { memo, useState } from "react";
import { AgentApprovals } from "./agent-approvals";

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
            key={source.assetId + ":" + source.start}
            href={
              "?panel=assets&item=" +
              source.assetId +
              "&start=" +
              source.start +
              "&end=" +
              source.end
            }
            onClick={(event) => {
              event.preventDefault();
              onInspect({
                tab: "assets",
                id: source.assetId,
                start: source.start,
                end: source.end,
              });
            }}
            title={source.name}
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">
              [{index + 1}] {source.name}
            </span>
            <ArrowUpRight className="size-3" />
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}

export function Markdown({ content }: { content: string }) {
  return (
    <MessageResponse
      skipHtml
      components={{
        img: () => null,
        a: ({ href, children }) => (
          <a
            href={
              href?.startsWith("http://") || href?.startsWith("https://")
                ? href
                : undefined
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </MessageResponse>
  );
}

function RunActivity({ run, tools }: { run: Run; tools: ToolInfo[] }) {
  const busy = isActive(run);
  const [open, setOpen] = useState<boolean | undefined>();
  const parts = run.parts.filter((part) => part.type === "tool");
  const reasoning = run.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("\n\n");
  const failed = parts.some((part) => part.state === "error");
  const current = parts.find((part) => part.state === "running");
  const expanded = open ?? (busy || failed);
  const seconds =
    run.startedAt && run.finishedAt
      ? Math.max(
          1,
          Math.round(
            (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000,
          ),
        )
      : null;
  const duration = seconds
    ? seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`
    : "";
  if (!parts.length && !reasoning && !run.plan.length) return null;
  const title = busy
    ? current
      ? tools.find((tool) => tool.name === current.name)?.label || "正在执行"
      : run.status === "waiting"
        ? "等待确认"
        : "正在思考"
    : failed
      ? `${parts.length} 项操作 · 有未完成项`
      : run.status === "stopped"
        ? "执行已停止"
        : parts.length
          ? `已执行 ${parts.length} 项操作${duration ? " · " + duration : ""}`
          : "思考过程";
  return (
    <ChainOfThought
      open={expanded}
      onOpenChange={setOpen}
      className="space-y-3"
    >
      <ChainOfThoughtHeader
        aria-label="执行记录"
        className="w-fit gap-1.5 text-xs [&>span]:flex-none [&>svg:first-child]:hidden [&>svg:last-child]:size-3"
      >
        {title}
      </ChainOfThoughtHeader>
      {expanded && (
        <ChainOfThoughtContent className="space-y-3 border-l pl-4 pt-1">
          {reasoning && (
            <Reasoning
              isStreaming={busy && run.parts.at(-1)?.type === "reasoning"}
              defaultOpen={false}
              className="mb-0"
            >
              <ReasoningTrigger
                className="text-xs"
                getThinkingMessage={(streaming) =>
                  streaming ? "思考中" : "思考过程"
                }
              />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          )}
          {!!run.plan.length && (
            <Plan
              defaultOpen
              className="gap-2 border-0 bg-transparent py-1 shadow-none"
            >
              <PlanHeader className="flex-row items-center px-0">
                <PlanTitle className="text-xs">执行步骤</PlanTitle>
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
              <PlanContent className="space-y-2 border-l px-4 pb-1">
                {run.plan.map((step, index) => (
                  <TaskItem
                    key={index}
                    className="flex items-center gap-2 text-xs text-foreground"
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
          )}
          <div className="space-y-0">
            {parts.map((part) => (
              <ToolActivity key={part.toolCallId} part={toolUI(part)} />
            ))}
          </div>
        </ChainOfThoughtContent>
      )}
    </ChainOfThought>
  );
}

export const RunThread = memo(function RunThread({
  run,
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
  const busy = isActive(run);
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
      className="space-y-6"
      data-testid="run-thread"
      data-run-status={run.status}
    >
      <Message from="user" className="ml-auto max-w-[90%]">
        <MessageContent className="rounded-2xl px-4 py-3">
          <p className="whitespace-pre-wrap leading-7">{run.text}</p>
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
      </Message>
      <Message from="assistant" className="max-w-full gap-3">
        <MessageContent className="w-full gap-4 overflow-visible">
          <RunActivity run={run} tools={tools} />
          {response && <Markdown content={response} />}
          {run.parts
            .filter((part) => part.type === "notice")
            .map((part, index) => (
              <p key={index} className="text-xs text-muted-foreground">
                {part.text}
              </p>
            ))}
          {!run.parts.length && busy && (
            <div role="status" className="text-sm">
              <Shimmer>
                {run.status === "queued" ? "等待前一项任务" : "正在处理"}
              </Shimmer>
            </div>
          )}
          <AgentApprovals run={run} onChanged={onRefresh} />
          {!!run.interventions?.length && (
            <Queue className="p-2 shadow-none">
              <QueueList className="m-0">
                {run.interventions.map((item) => (
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
                            : "未送达"}
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
                {memory.status === "draft"
                  ? "待核对"
                  : memory.status === "confirmed"
                    ? "已记住"
                    : "已排除"}
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
      </Message>
    </section>
  );
});
const BrainIcon = BookOpen;
