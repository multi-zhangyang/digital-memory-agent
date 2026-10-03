"use client";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  ComposerContextMenu,
  type ComposerToken,
  type ContextChoice,
} from "./composer-context-menu";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDraft } from "@/hooks/use-draft";
import { api } from "@/lib/api";
import {
  fileData,
  type InspectorTarget,
  type TaskDraft,
} from "@/lib/workbench";
import type {
  Asset,
  ModelInfo,
  ProviderStatus,
  Run,
  ProjectFileReference,
  ThinkingLevel,
} from "@memory/contracts";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  ImageIcon,
  LoaderCircle,
  Paperclip,
  Settings2,
  Shield,
  Slash,
  Square,
  Upload,
  File,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  compact?: boolean;
  draftKey: string;
  fallbackDraft: TaskDraft;
  onDraft: (draft: TaskDraft) => void;
  assets: Asset[];
  models: ModelInfo[];
  providers?: Pick<ProviderStatus, "id" | "name">[];
  running?: Run;
  submitting: boolean;
  onSubmit: () => Promise<void>;
  onStop: () => void;
  onUploaded: (asset: Asset) => void;
  onInspect: (target: InspectorTarget) => void;
  onSettings: () => void;
  onSteer?: (mode?: "steer" | "followUp") => Promise<void>;
  commands?: string[];
  projectId?: string;
  onOpenFile?: (ref: ProjectFileReference) => void;
  onRecall?: () => void;
}
const thinkingLevels: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function WorkbenchComposer({
  compact = false,
  draftKey,
  fallbackDraft,
  onDraft,
  assets,
  models,
  providers = [],
  running,
  submitting,
  onSubmit,
  onStop,
  onUploaded,
  onInspect,
  onSettings,
  onSteer,
  commands = [],
  projectId,
  onOpenFile,
  onRecall,
}: Props) {
  const draft = useDraft(draftKey, fallbackDraft);
  const [sendMode, setSendMode] = useState("steer");
  const continuing = !!running && sendMode !== "queue";
  const [dialog, setDialog] = useState<
    "assets" | "commands" | "settings" | null
  >(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<ComposerToken | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const model =
    models.find(
      (item) => item.id === (continuing ? running.modelId : draft.modelId),
    ) || models[0];
  const level = continuing ? running.thinkingLevel : draft.thinkingLevel;
  const providerIds = [...new Set(models.map((item) => item.provider))];
  function patch(value: Partial<TaskDraft>) {
    latest.current = { ...latest.current, ...value };
    onDraft(latest.current);
  }
  useEffect(() => {
    if (running && (draft.fileReferences?.length || draft.assetIds.length))
      setSendMode("queue");
  }, [running?.id, draft.fileReferences?.length, draft.assetIds.length]);
  function updateToken(value: string, caret: number) {
    const before = value.slice(0, caret);
    const match = /(?:^|\s)([@/])([^\s]*)$/.exec(before);
    if (!match || (match[1] === "/" && before.trimStart()[0] !== "/")) {
      setToken(null);
      return;
    }
    setToken({
      kind: match[1] === "@" ? "file" : "command",
      query: match[2],
      start: caret - match[2].length - 1,
      end: caret,
    });
  }
  function selectContext(choice: ContextChoice) {
    if (!token) return;
    const current = latest.current;
    if (choice.kind === "file") {
      const refs = current.fileReferences || [];
      if (!refs.some((ref) => ref.path === choice.value && !ref.runId)) {
        if (refs.length >= 20) {
          setError("每次最多引用 20 个项目文件");
          return;
        }
        patch({ fileReferences: [...refs, { path: choice.value }] });
      }
      if (running) setSendMode("queue");
    } else if (
      choice.kind === "asset" &&
      !current.assetIds.includes(choice.value)
    ) {
      if (current.assetIds.length >= 30) {
        setError("每个任务最多选择 30 份资料");
        return;
      }
      toggle(choice.value);
    }
    const replacement = choice.kind === "command" ? choice.value + " " : "";
    patch({
      text:
        current.text.slice(0, token.start) +
        replacement +
        current.text.slice(token.end),
    });
    const caret = token.start + replacement.length;
    setToken(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(caret, caret);
    });
  }
  useEffect(() => {
    if (
      models.length &&
      !models.some((item) => item.id === latest.current.modelId)
    ) {
      patch({ modelId: models[0].id, thinkingLevel: models[0].thinkingLevel });
    }
  }, [models]);
  function toggle(id: string) {
    const selected = latest.current.assetIds;
    if (!selected.includes(id) && selected.length >= 30) {
      setError("每个任务最多选择 30 份资料");
      return;
    }
    if (running) setSendMode("queue");
    const ids = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id];
    patch({ assetIds: ids, scope: ids.length ? "selected" : "library" });
  }
  async function upload(files: FileList | File[]) {
    if (uploadLock.current) return;
    uploadLock.current = true;
    if (running) setSendMode("queue");
    setError("");
    try {
      for (const [index, file] of Array.from(files).entries()) {
        if (latest.current.assetIds.length >= 30)
          throw new Error("每个任务最多选择 30 份资料");
        setUploading(`${file.name} · ${index + 1}/${files.length}`);
        const form = new FormData();
        form.append("file", file);
        const { asset } = await api<{ asset: Asset }>("/assets", {
          method: "POST",
          body: form,
        });
        onUploaded(asset);
        patch({
          assetIds: [...new Set([...latest.current.assetIds, asset.id])],
          scope: "selected",
        });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "上传失败");
    } finally {
      uploadLock.current = false;
      setUploading("");
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }
  const thinkingSelect = (compact = false) => (
    <Select
      disabled={continuing}
      value={level}
      onValueChange={(value) =>
        patch({ thinkingLevel: value as ThinkingLevel })
      }
    >
      <SelectTrigger
        aria-label="思考强度"
        size="sm"
        className={
          compact
            ? "h-7 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none dark:bg-transparent"
            : "w-full"
        }
      >
        {!compact && <Brain className="size-4" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {thinkingLevels.map((value) => (
          <SelectItem key={value} value={value}>
            {value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div
      className="@container w-full"
      data-testid="workbench-composer"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          void upload(event.dataTransfer.files);
        }
      }}
      onPasteCapture={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          event.stopPropagation();
          void upload(event.clipboardData.files);
        }
      }}
    >
      <input
        className="sr-only"
        ref={uploadInput}
        type="file"
        multiple
        aria-label="附加资料"
        onChange={(event) => {
          if (event.target.files) void upload(event.target.files);
        }}
      />
      {error && (
        <p role="alert" className="mb-2 text-sm">
          {error}
        </p>
      )}
      <ComposerContextMenu
        token={token}
        projectId={projectId}
        assets={assets}
        commands={commands}
        menuRef={menuRef}
        textarea={textarea}
        onClose={() => setToken(null)}
        onSelect={selectContext}
      >
        <div className="w-full">
          <PromptInput
            maxFiles={0}
            resetOnSubmit={false}
            className="[&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-border [&>[data-slot=input-group]]:bg-muted/20 [&>[data-slot=input-group]]:shadow-xs [&>[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-1"
            onSubmit={async () => {
              if (uploadLock.current || submitting) return;
              const localCommand = [
                "/files",
                "/review",
                "/terminal",
                "/settings",
                "/compact",
                "/fork",
              ].includes(latest.current.text.trim());
              if (
                running &&
                onSteer &&
                sendMode !== "queue" &&
                !latest.current.fileReferences?.length &&
                !localCommand
              )
                await onSteer(sendMode as "steer" | "followUp");
              else await onSubmit();
            }}
            onError={() => undefined}
          >
            {!!draft.fileReferences?.length && (
              <div
                className="flex w-full flex-wrap gap-1.5 px-4 pt-3"
                data-testid="file-reference-chips"
              >
                {draft.fileReferences.map((ref) => (
                  <ButtonGroup
                    key={ref.path + (ref.runId || "")}
                    className="max-w-full"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 min-w-0 max-w-64 gap-1.5 bg-background px-2 text-xs font-normal"
                      title={ref.path}
                      onClick={() => onOpenFile?.(ref)}
                    >
                      <File className="size-3" />
                      <span className="truncate">{ref.path}</span>
                      {ref.runId && (
                        <span className="shrink-0 text-muted-foreground">
                          改动
                        </span>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      className="size-7 bg-background"
                      aria-label={"移除引用 " + ref.path}
                      onClick={() =>
                        patch({
                          fileReferences: latest.current.fileReferences?.filter(
                            (item) =>
                              item.path !== ref.path ||
                              item.runId !== ref.runId,
                          ),
                        })
                      }
                    >
                      <X className="size-3" />
                    </Button>
                  </ButtonGroup>
                ))}
              </div>
            )}
            {!!draft.assetIds.length && (
              <Attachments
                variant="inline"
                className="w-full justify-start px-4 pt-4"
              >
                {draft.assetIds
                  .map((id) => assets.find((asset) => asset.id === id))
                  .filter((asset): asset is Asset => !!asset)
                  .map((asset) => (
                    <Attachment
                      key={asset.id}
                      data={fileData(asset)}
                      onRemove={() => toggle(asset.id)}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto max-w-48 gap-2 p-0"
                        onClick={() =>
                          onInspect({ tab: "assets", id: asset.id })
                        }
                      >
                        <AttachmentPreview />
                        <AttachmentInfo />
                      </Button>
                      <AttachmentRemove aria-label={"移除 " + asset.name} />
                    </Attachment>
                  ))}
              </Attachments>
            )}
            <PromptInputBody>
              <PromptInputTextarea
                ref={textarea}
                aria-label="任务指令"
                placeholder={
                  running
                    ? "补充指令，或安排下一项任务…"
                    : "描述任务，@ 引用文件，/ 选择命令"
                }
                value={draft.text}
                className={
                  compact
                    ? "min-h-16 max-h-48 px-4 pb-3 pt-4 text-base leading-6 md:text-sm"
                    : "min-h-28 max-h-60 px-5 pb-4 pt-5 text-base leading-7 md:text-sm"
                }
                onChange={(event) => {
                  patch({ text: event.target.value });
                  updateToken(event.target.value, event.target.selectionStart);
                }}
                onClick={(event) =>
                  updateToken(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                  )
                }
                onKeyDownCapture={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) {
                    if (event.key === "Enter") event.stopPropagation();
                    return;
                  }
                  if (
                    token &&
                    ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(
                      event.key,
                    ) &&
                    !event.shiftKey
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Escape") setToken(null);
                    else
                      menuRef.current?.dispatchEvent(
                        new KeyboardEvent("keydown", {
                          key: event.key,
                          bubbles: true,
                          cancelable: true,
                        }),
                      );
                  } else if (
                    event.key === "ArrowUp" &&
                    !draft.text &&
                    onRecall &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    onRecall();
                  }
                }}
              />
            </PromptInputBody>
            {uploading && (
              <div
                role="status"
                className="flex items-center gap-2 px-5 pb-3 text-xs text-muted-foreground"
              >
                <LoaderCircle className="size-3 animate-spin" />
                <span className="truncate">{uploading}</span>
              </div>
            )}
            <PromptInputFooter className="gap-2 px-3 pb-2.5">
              <PromptInputTools className="min-w-0 gap-1">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger
                    aria-label="添加附件与工具"
                    className="rounded-lg text-muted-foreground"
                  />
                  <PromptInputActionMenuContent
                    className="w-52"
                    onCloseAutoFocus={(event) => {
                      if (dialog) event.preventDefault();
                    }}
                  >
                    <PromptInputActionMenuItem
                      onSelect={() => uploadInput.current?.click()}
                    >
                      <Upload />
                      上传文件
                    </PromptInputActionMenuItem>
                    <PromptInputActionMenuItem
                      onSelect={() => setDialog("assets")}
                    >
                      <Paperclip />
                      选择资料
                    </PromptInputActionMenuItem>
                    <PromptInputActionMenuItem
                      onSelect={() => {
                        const value = latest.current.text;
                        const next =
                          value +
                          (value && !/\s$/.test(value) ? " " : "") +
                          "@";
                        patch({ text: next });
                        updateToken(next, next.length);
                        requestAnimationFrame(() => textarea.current?.focus());
                      }}
                    >
                      <File />
                      引用项目文件
                      <span className="ml-auto text-xs text-muted-foreground">
                        @
                      </span>
                    </PromptInputActionMenuItem>
                    <DropdownMenuSeparator />
                    <PromptInputActionMenuItem
                      onSelect={() => setDialog("commands")}
                    >
                      <Slash />
                      命令与 Skills
                      <span className="ml-auto text-xs text-muted-foreground">
                        /
                      </span>
                    </PromptInputActionMenuItem>
                    <PromptInputActionMenuItem
                      onSelect={() => setDialog("settings")}
                    >
                      <Settings2 />
                      任务设置
                    </PromptInputActionMenuItem>
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                {model ? (
                  <ModelSelector open={modelOpen} onOpenChange={setModelOpen}>
                    <ModelSelectorTrigger asChild>
                      <PromptInputButton
                        aria-label="选择对话模型"
                        disabled={continuing}
                        className="h-8 min-w-0 max-w-40 shrink gap-1.5 px-2 text-xs font-medium @md:max-w-52"
                      >
                        <span className="truncate">{model.name}</span>
                        <ChevronDown className="size-3 text-muted-foreground" />
                      </PromptInputButton>
                    </ModelSelectorTrigger>
                    <ModelSelectorContent
                      title="选择模型"
                      className="sm:max-w-md"
                    >
                      <ModelSelectorInput placeholder="搜索模型或供应商…" />
                      <ModelSelectorList>
                        <ModelSelectorEmpty>没有匹配的模型</ModelSelectorEmpty>
                        {providerIds.map((id) => (
                          <ModelSelectorGroup
                            key={id}
                            heading={
                              providers.find((provider) => provider.id === id)
                                ?.name || id
                            }
                          >
                            {models
                              .filter((item) => item.provider === id)
                              .map((item) => (
                                <ModelSelectorItem
                                  key={item.id}
                                  value={item.name + " " + item.provider}
                                  onSelect={() => {
                                    patch({
                                      modelId: item.id,
                                      thinkingLevel: item.thinkingLevel,
                                    });
                                    setModelOpen(false);
                                  }}
                                  className="gap-3 px-3 py-3"
                                >
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <ModelSelectorName className="block text-sm font-medium">
                                      {item.name}
                                    </ModelSelectorName>
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                      <span>
                                        {Math.round(item.contextWindow / 1000)}k
                                        上下文
                                      </span>
                                      {item.reasoning && (
                                        <span className="inline-flex items-center gap-1">
                                          <Brain className="size-3" />
                                          思考
                                        </span>
                                      )}
                                      {item.supportsImages && (
                                        <ImageIcon
                                          className="size-3"
                                          aria-label="支持图片"
                                        />
                                      )}
                                    </div>
                                  </div>
                                  {item.id === model.id && (
                                    <Check className="size-4" />
                                  )}
                                </ModelSelectorItem>
                              ))}
                          </ModelSelectorGroup>
                        ))}
                      </ModelSelectorList>
                      <div className="border-t p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs text-muted-foreground"
                          onClick={() => {
                            setModelOpen(false);
                            onSettings();
                          }}
                        >
                          <Settings2 className="size-3.5" />
                          管理模型连接
                        </Button>
                      </div>
                    </ModelSelectorContent>
                  </ModelSelector>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onSettings}
                  >
                    连接模型
                  </Button>
                )}
                {model?.reasoning && (
                  <div className="hidden border-l pl-1 @lg:block">
                    {thinkingSelect(true)}
                  </div>
                )}
              </PromptInputTools>
              <PromptInputTools className="shrink-0 gap-1">
                <Select
                  disabled={continuing}
                  value={
                    (continuing
                      ? running.permissionMode
                      : draft.permissionMode) || "auto"
                  }
                  onValueChange={(value) =>
                    patch({
                      permissionMode: value as TaskDraft["permissionMode"],
                    })
                  }
                >
                  <SelectTrigger
                    aria-label="本次权限"
                    size="sm"
                    className="h-8 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none dark:bg-transparent"
                  >
                    <Shield className="hidden size-3 @xl:block" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">只读</SelectItem>
                    <SelectItem value="ask">询问</SelectItem>
                    <SelectItem value="auto">自动</SelectItem>
                  </SelectContent>
                </Select>
                {running && onSteer && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <PromptInputButton
                        aria-label="选择发送方式"
                        className="gap-1 text-xs text-muted-foreground"
                      >
                        <span className="hidden @2xl:inline">
                          {sendMode === "steer"
                            ? "立即补充"
                            : sendMode === "followUp"
                              ? "完成后补充"
                              : "加入队列"}
                        </span>
                        <ChevronDown className="size-3" />
                      </PromptInputButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={sendMode}
                        onValueChange={setSendMode}
                      >
                        <DropdownMenuRadioItem value="steer">
                          立即补充指令
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="followUp">
                          本任务完成后补充
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="queue">
                          作为新任务排队
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {running && (
                  <PromptInputButton
                    aria-label="停止任务"
                    onClick={onStop}
                    className="rounded-full"
                  >
                    <Square className="size-3.5" />
                  </PromptInputButton>
                )}
                <PromptInputSubmit
                  aria-label={
                    running
                      ? sendMode === "steer"
                        ? "立即补充指令"
                        : sendMode === "followUp"
                          ? "本任务完成后补充"
                          : "加入队列"
                      : "开始任务"
                  }
                  status={submitting ? "submitted" : "ready"}
                  disabled={
                    submitting || !!uploading || !draft.text.trim() || !model
                  }
                  className="ml-1 rounded-full"
                >
                  <ArrowUp className="size-4" />
                </PromptInputSubmit>
              </PromptInputTools>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </ComposerContextMenu>
      {(dialog === "assets" || dialog === "commands") && (
        <CommandDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={dialog === "assets" ? "选择资料" : "命令与 Skills"}
          description={
            dialog === "assets"
              ? "选择当前任务可使用的资料"
              : "使用项目命令与技能"
          }
        >
          <CommandInput
            placeholder={dialog === "assets" ? "搜索资料…" : "搜索命令…"}
          />
          <CommandList>
            <CommandEmpty>没有匹配结果</CommandEmpty>
            {dialog === "assets" ? (
              <CommandGroup>
                {assets.map((asset) => (
                  <CommandItem
                    key={asset.id}
                    value={asset.name + " " + asset.id}
                    onSelect={() => {
                      toggle(asset.id);
                      if (latest.current.text.endsWith("@"))
                        patch({ text: latest.current.text.slice(0, -1) });
                    }}
                  >
                    <FileText />
                    <span className="truncate">{asset.name}</span>
                    {draft.assetIds.includes(asset.id) && (
                      <Check className="ml-auto" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <CommandGroup>
                {commands.map((command) => (
                  <CommandItem
                    key={command}
                    onSelect={() => {
                      patch({ text: command + " " });
                      setDialog(null);
                      requestAnimationFrame(() => textarea.current?.focus());
                    }}
                  >
                    <Slash />
                    {command}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {dialog === "assets" && (
            <div className="flex items-center justify-between border-t p-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => uploadInput.current?.click()}
              >
                <Upload />
                上传文件
              </Button>
              <Button size="sm" onClick={() => setDialog(null)}>
                完成{draft.assetIds.length ? ` · ${draft.assetIds.length}` : ""}
              </Button>
            </div>
          )}
        </CommandDialog>
      )}
      <Dialog
        open={dialog === "settings"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>任务设置</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-2">
            {model?.reasoning && (
              <Field>
                <FieldLabel>思考强度</FieldLabel>
                {thinkingSelect()}
              </Field>
            )}
            <Field>
              <FieldLabel>资料范围</FieldLabel>
              <Select
                disabled={continuing}
                value={draft.scope}
                onValueChange={(value) =>
                  patch({ scope: value as TaskDraft["scope"] })
                }
              >
                <SelectTrigger aria-label="资料范围" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="library">按需查询资料库</SelectItem>
                  <SelectItem
                    value="selected"
                    disabled={!draft.assetIds.length}
                  >
                    仅所选资料
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Brain className="size-4 text-muted-foreground" />
              <FieldLabel htmlFor="use-personal-memory">
                检索个人记忆
              </FieldLabel>
              <Switch
                id="use-personal-memory"
                disabled={continuing}
                checked={draft.useMemory}
                onCheckedChange={(useMemory) => patch({ useMemory })}
              />
            </Field>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
