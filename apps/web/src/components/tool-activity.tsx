"use client";

import type { ToolUIPart } from "ai";
import type { EvidenceRead, ProcessingAssetResult, VideoSourceIndex } from "@memory/contracts";
import dynamic from "next/dynamic";
import { useState } from "react";
import { FileText } from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
  TerminalActions,
  TerminalCopyButton,
  TerminalStatus,
} from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from "@/components/ai-elements/sources";
import { assetUrl, datasetDownloadUrl, evidencePreviewUrl, formatBytes, videoTime } from "@/lib/api";
import { VideoPlayback } from "./video-evidence";
import { ProcessingAssets } from "./processing-assets";
import { VideoIndexFrames } from "./video-index-frames";

const CodeBlock = dynamic(() =>
  import("@/components/ai-elements/code-block").then(
    (module) => module.CodeBlock,
  ),
);

const labels: Record<string, string> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  bash: "执行命令",
  list_files: "查看项目",
  search_files: "搜索项目",
  web_search: "搜索网络",
  web_read: "阅读网页",
  search_assets: "查找资料",
  read_asset_text: "读取文字",
  search_evidence: "检索素材证据",
  read_evidence: "读取原始证据",
  update_plan: "更新步骤",
  write_artifact: "保存整理结果",
  read_artifact: "查看整理结果",
  propose_memory: "提出记忆草稿",
  search_memories: "检索个人记忆",
  inspect_memories: "查看记忆记录",
  change_memories: "修订记忆",
  manage_memory_links: "整理记忆关联",
  inspect_dataset: "检查训练样本",
  review_dataset: "核对训练样本",
  deliver_dataset: "交付训练文件",
  process_assets: "处理资料",
  read_job_result: "读取作业结果",
  manage_job: "管理后台作业",
  build_dataset: "构建训练资料",
  rebuild_dataset: "重建训练资料",
  audit_dataset: "批量核验训练样本",
  ask_user: "等待补充",
};

export function ToolActivity({ part }: { part: ToolUIPart }) {
  const [open, setOpen] = useState<boolean | undefined>();
  const name = part.type.slice(5);
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const failed =
    part.state === "output-error" || part.state === "output-denied";
  const input = part.input as
    | {
        query?: string;
        assetId?: string;
        path?: string;
        command?: string;
        url?: string;
      }
    | undefined;
  const summary =
    input?.path || input?.query || input?.command?.slice(0, 80) || input?.url;

  return (
    <Tool
      className="group/tool mb-0 overflow-hidden rounded-none border-0 bg-transparent"
      open={open ?? failed}
      onOpenChange={setOpen}
      data-testid="tool-activity"
      data-tool-state={running ? "running" : failed ? "error" : "complete"}
    >
      <ToolHeader
        className="gap-2 px-0 py-2 text-xs"
        type={part.type}
        state={part.state}
        title={
          (labels[name] || name) +
          (summary ? " · " + summary : "") +
          (failed
            ? part.errorText === "已停止"
              ? " · 已停止"
              : " · 失败"
            : "")
        }
      />
      <ToolContent>
        <Tabs
          defaultValue="output"
          className="rounded-md border bg-muted/20 p-3"
        >
          <TabsList
            variant="line"
            aria-label="工具详情"
            className="h-8 gap-3 p-0"
          >
            <TabsTrigger value="output">结果</TabsTrigger>
            <TabsTrigger value="input">参数</TabsTrigger>
          </TabsList>
          <TabsContent value="input" className="max-h-80 overflow-auto">
            <ToolInput input={part.input ?? {}} className="p-0" />
          </TabsContent>
          <TabsContent
            value="output"
            className="max-h-80 overflow-auto text-xs"
          >
            {running && part.output === undefined ? (
              <div role="status" className="py-2">
                <Shimmer>执行中…</Shimmer>
              </div>
            ) : (
              <ToolOutput
                className="p-0"
                errorText={
                  failed ? part.errorText || "工具执行失败" : undefined
                }
                output={
                  failed ? undefined : (
                    <ToolResult
                      output={part.output}
                      name={name}
                      running={running}
                    />
                  )
                }
              />
            )}
          </TabsContent>
        </Tabs>
      </ToolContent>
    </Tool>
  );
}

function ToolResult({
  output,
  name,
  running,
}: {
  output: unknown;
  name: string;
  running: boolean;
}) {
  const value = output as
    | {
        assets?: Array<{ id: string; name: string; size: number }>;
        results?: Array<{ title?: string; url: string; text?: string }>;
        url?: string;
        total?: number;
        text?: string;
        name?: string;
        assetId?: string;
        files?: Array<{ name: string; href: string; bytes: number; records?: number; sha256: string }>;
      }
    | undefined;
  if (name === "bash") {
    const text =
      typeof output === "string"
        ? output
        : typeof value?.text === "string"
          ? value.text
          : JSON.stringify(output ?? "", null, 2);
    return (
      <Terminal output={text} isStreaming={running}>
        <TerminalHeader>
          <TerminalTitle>终端输出</TerminalTitle>
          <TerminalActions>
            <TerminalStatus>执行中</TerminalStatus>
            <TerminalCopyButton aria-label="复制终端输出" />
          </TerminalActions>
        </TerminalHeader>
        <TerminalContent className="text-xs" />
      </Terminal>
    );
  }
  if (name === "deliver_dataset" && Array.isArray(value?.files))
    return (
      <Attachments variant="list">
        {value.files.filter((file) => datasetDownloadUrl(file.href)).map((file) => (
          <Attachment key={file.href} className="w-full" data={{ id: file.href, type: "file", mediaType: "application/octet-stream", filename: file.name, url: file.href }}>
            <Button asChild variant="ghost" className="h-auto w-full justify-start px-0 text-xs font-normal">
              <a href={file.href} download={file.name} title={`SHA-256: ${file.sha256}`}>
                <AttachmentPreview />
                <AttachmentInfo />
                <span className="ml-auto shrink-0 text-muted-foreground">{file.records === undefined ? "" : `${file.records} 条 · `}{formatBytes(file.bytes)}</span>
              </a>
            </Button>
          </Attachment>
        ))}
      </Attachments>
    );
  if (name === "read_evidence" && (output as EvidenceRead | undefined)?.source?.view)
    return <EvidencePreview output={output as EvidenceRead & { imageDelivered?: boolean }} />;
  if (name === "read_job_result") {
    const job = output as { title: string; result?: Partial<VideoSourceIndex> & { assets?: ProcessingAssetResult[]; assetId?: string; sourceHash?: string } };
    return <div className="flex flex-col gap-3">
      {!!job.result?.assets?.length && <ProcessingAssets assets={job.result.assets} />}
      {job.result?.frames && job.result.assetId && job.result.sourceHash && <VideoIndexFrames frames={job.result.frames} assetId={job.result.assetId}
        version={job.result.sourceHash} name={job.title} />}
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    </div>;
  }
  if (Array.isArray(value?.results))
    return (
      <Sources>
        <SourcesTrigger count={value.results.length}>
          {value.results.length} 个网页来源
        </SourcesTrigger>
        <SourcesContent>
          {value.results
            .filter((item) => /^https?:\/\//.test(item.url))
            .map((item) => (
              <div key={item.url} className="space-y-1">
                <Source href={item.url} title={item.title || item.url} />
                {item.text && (
                  <p className="line-clamp-3 text-muted-foreground">
                    {item.text}
                  </p>
                )}
              </div>
            ))}
        </SourcesContent>
      </Sources>
    );
  if (Array.isArray(value?.assets))
    return (
      <div>
        <div className="mb-2 text-xs text-muted-foreground">
          {value.total ?? value.assets.length} 个文件
        </div>
        <Attachments variant="list">
          {value.assets.map((asset) => (
            <Attachment
              key={asset.id}
              className="w-full"
              data={{
                id: asset.id,
                type: "file",
                mediaType: "application/octet-stream",
                filename: asset.name,
                url: assetUrl(asset.id, true),
              }}
            >
              <Button
                asChild
                variant="ghost"
                className="h-auto w-full justify-start px-0 text-xs font-normal"
              >
                <a href={assetUrl(asset.id, true)} download={asset.name}>
                  <AttachmentPreview />
                  <AttachmentInfo />
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {formatBytes(asset.size)}
                  </span>
                </a>
              </Button>
            </Attachment>
          ))}
        </Attachments>
      </div>
    );
  if (typeof value?.text === "string")
    return (
      <div>
        {value.url && /^https?:\/\//.test(value.url) && (
          <Source href={value.url} title={value.url} />
        )}
        {value.name && value.assetId && (
          <a
            href={assetUrl(value.assetId, true)}
            download={value.name}
            className="mb-3 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <FileText size={12} />
            {value.name}
          </a>
        )}
        <CodeBlock code={value.text} language="text" />
      </div>
    );
  return (
    <CodeBlock
      code={
        typeof output === "string"
          ? output
          : JSON.stringify(output ?? null, null, 2)
      }
      language={typeof output === "string" ? "text" : "json"}
    />
  );
}

function EvidencePreview({ output }: { output: EvidenceRead & { imageDelivered?: boolean } }) {
  const [failed, setFailed] = useState(false);
  const source = output.source!, view = source.view!;
  const url = evidencePreviewUrl(source.previewUrl);
  const label = view.region ? "查看局部" : source.video ? "查看画面" : "查看整图";
  return <div className="flex flex-col gap-3" data-testid="evidence-preview">
    {url && !failed && <Attachments variant="list" onErrorCapture={() => setFailed(true)}>
      <Attachment data={{ id: view.sha256, type: "file", mediaType: "image/jpeg", filename: `${output.hit.title} · ${source.video ? videoTime(source.video.timestamp) : view.region ? "局部" : "整图"}`, url }}>
        <AttachmentPreview /><AttachmentInfo />
        <Button asChild variant="outline" size="sm"><a href={url} target="_blank" rel="noreferrer">{label}</a></Button>
        {source.video && <VideoPlayback assetId={source.assetId} name={output.hit.title} video={source.video} previewUrl={url} />}
      </Attachment>
    </Attachments>}
    {failed && <Alert><AlertTitle>此版本的图片已不可用，请重新读取原件。</AlertTitle></Alert>}
    {!output.imageDelivered && <Alert><AlertTitle>当前任务模型未读取图片像素。</AlertTitle></Alert>}
    <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
  </div>;
}
