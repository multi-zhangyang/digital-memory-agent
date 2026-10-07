"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionNode, SessionState } from "@memory/contracts";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Context, ContextContent, ContextContentHeader, ContextTrigger } from "@/components/ai-elements/context";
import { GitBranch, LoaderCircle, CornerDownRight, Scissors, RefreshCw, Wrench } from "lucide-react";

const roleLabel = (node: SessionNode) => node.kind === "compaction" ? "上下文压缩" : node.kind === "branch_summary" ? "分支摘要"
  : node.role === "assistant" ? "Agent" : node.role === "user" ? "你" : node.role === "toolResult" ? "工具结果" : "系统";

export function SessionControls({ conversationId, busy, revision, onNavigate, onFork, onCompact, onUseResource }: {
  conversationId: string; busy: boolean; revision?: string;
  onNavigate: (editorText?: string) => Promise<void>;
  onFork: (entryId: string) => Promise<void>;
  onCompact: (instructions?: string) => Promise<void>;
  onUseResource: (command: string) => void;
}) {
  const [open, setOpen] = useState(false), [state, setState] = useState<SessionState>(), [selected, setSelected] = useState("");
  const [working, setWorking] = useState(false), [error, setError] = useState(""), [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("tree"), [instructions, setInstructions] = useState("");
  const [notice, setNotice] = useState("");
  const version = `${conversationId}:${revision}:${busy}`;
  const loadedVersion = useRef("");
  const load = useCallback(async () => {
    try {
      const next = await api<SessionState>("/conversations/" + conversationId + "/session");
      setState(next); setLoadError("");
      loadedVersion.current = version;
      setSelected((previous) => next.nodes.some((node) => node.id === previous) ? previous
        : next.nodes.find((node) => node.id === next.leafId)?.id || next.nodes.filter((node) => node.active).at(-1)?.id || "");
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "读取会话失败"); }
  }, [conversationId, version]);
  useEffect(() => { if (open || loadedVersion.current !== version) void load(); }, [load, version, open]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(timer);
  }, [open, load]);
  const nodes = useMemo(() => {
    const children = new Map<string | null, SessionNode[]>();
    for (const node of state?.nodes || []) children.set(node.parentId, [...(children.get(node.parentId) || []), node]);
    const result: { node: SessionNode; depth: number }[] = [];
    const visit = (parent: string | null, depth: number) => {
      const siblings = children.get(parent) || [];
      const level = depth + (siblings.length > 1 ? 1 : 0);
      for (const node of siblings) { result.push({ node, depth: level }); visit(node.id, level); }
    };
    visit(null, 0);
    return result;
  }, [state?.nodes]);
  const node = state?.nodes.find((item) => item.id === selected);
  const lastCompaction = state?.nodes.filter((item) => item.kind === "compaction" && item.active).at(-1);
  async function act(action: "navigate" | "fork" | "compact") {
    setWorking(true); setError(""); setNotice("");
    try {
      if (action === "fork") { await onFork(selected); setOpen(false); }
      else if (action === "navigate") {
        const result = await api<{ editorText?: string; cancelled?: boolean; aborted?: boolean }>("/conversations/" + conversationId + "/navigate",
          { method: "POST", body: JSON.stringify({ entryId: selected }) });
        if (!result.cancelled && !result.aborted) { await onNavigate(result.editorText); await load(); setOpen(false); }
      } else { await onCompact(instructions.trim() || undefined); await load(); setNotice("上下文已压缩"); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setWorking(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <div className="flex items-center gap-1">
      {state?.context?.tokens != null && <div className="hidden sm:block"><Context usedTokens={state.context.tokens} maxTokens={state.context.contextWindow}>
        <ContextTrigger aria-label="会话上下文用量" size="sm" /><ContextContent><ContextContentHeader /></ContextContent>
      </Context></div>}
      <Button variant="ghost" size="sm" aria-label="压缩上下文" title="压缩上下文" disabled={busy || working || !nodes.length} onClick={() => {
        setTab("context"); setOpen(true); void act("compact");
      }}><Scissors data-icon="inline-start" /><span className="hidden lg:inline">压缩</span></Button>
      <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label="会话与能力" title="会话树与分支" onClick={() => setTab("tree")}><GitBranch data-icon="inline-start" /><span className="hidden lg:inline">会话</span></Button></DialogTrigger>
      <Button aria-label="工具与扩展" title="工具与扩展" size="sm" variant="ghost" onClick={() => { setTab("capabilities"); setOpen(true); }}><Wrench data-icon="inline-start" /><span className="hidden xl:inline">工具与扩展</span></Button>
    </div>
    <DialogContent className="flex h-[min(42rem,90dvh)] flex-col gap-4 sm:max-w-4xl" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>会话与能力</DialogTitle></DialogHeader>
      {(error || loadError) && <Alert variant="destructive"><AlertDescription>{error || loadError}</AlertDescription></Alert>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <TabsList variant="line"><TabsTrigger value="tree">会话树</TabsTrigger><TabsTrigger value="capabilities">能力</TabsTrigger><TabsTrigger value="context">上下文</TabsTrigger></TabsList>
          <Button variant="ghost" size="icon-sm" aria-label="刷新会话状态" onClick={() => void load()}><RefreshCw /></Button>
        </div>
        <TabsContent value="tree" className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          <ScrollArea className="min-h-24 flex-1 rounded-md border sm:max-w-1/2" aria-label="会话树节点">
            <div className="flex flex-col gap-1 p-2">
              {!nodes.length && <p className="p-3 text-sm text-muted-foreground">暂无会话记录</p>}
              {nodes.map(({ node: item, depth }) => <Button key={item.id} variant={selected === item.id ? "secondary" : "ghost"}
                className={"h-auto min-h-11 w-full justify-start gap-2 py-2 text-left " + ["pl-2", "pl-5", "pl-8", "pl-11", "pl-14"][Math.min(depth, 4)]} aria-pressed={selected === item.id}
                onClick={() => setSelected(item.id)}>
                {depth > 0 && <CornerDownRight className="size-3 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{roleLabel(item)}</span>
                  {item.active && <span>当前路径</span>}</div><p className="truncate text-xs font-normal">{item.text || "无文字内容"}</p></div>
              </Button>)}
            </div>
          </ScrollArea>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {node && <><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{roleLabel(node)}</span><time>{new Date(node.createdAt).toLocaleString("zh-CN")}</time></div>
              <ScrollArea className="min-h-20 flex-1 rounded-md border p-3"><p className="whitespace-pre-wrap break-words text-sm">{node.text || "无文字内容"}</p></ScrollArea>
              <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || working || node.id === state?.leafId} onClick={() => void act("navigate")}>{working && <LoaderCircle className="animate-spin" />}从此处继续</Button>
                <Button size="sm" variant="outline" disabled={busy || working} onClick={() => void act("fork")}><GitBranch />新建分支会话</Button></div></>}
          </div>
        </TabsContent>
        <TabsContent value="capabilities" className="flex min-h-0 flex-1 flex-col gap-3">
          <Input placeholder="搜索工具、Skills 或连接…" aria-label="搜索能力" value={search} onChange={(event) => setSearch(event.target.value)} />
          <ScrollArea className="min-h-0 flex-1"><div className="divide-y">
            {state?.tools.filter((tool) => (tool.name + tool.description).toLowerCase().includes(search.toLowerCase())).map((tool) => <div key={tool.name} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0"><p className="break-all text-sm font-medium">{tool.name}</p><p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p></div>
              <Badge variant={tool.active ? "secondary" : "outline"} className="shrink-0">{tool.disabled ? "已禁用" : tool.active ? "已激活" : tool.exposure === "deferred" ? "按需发现" : "已加载"}</Badge>
            </div>)}
            {state?.resources?.filter((resource) => resource.name.toLowerCase().includes(search.toLowerCase())).map((resource) => <div key={resource.kind + resource.name} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0"><p className="text-sm">{resource.name}</p><p className="text-xs text-muted-foreground">{resource.kind} {resource.detail}</p></div>
              <div className="flex shrink-0 items-center gap-2"><Badge variant="outline">{{ configured: "已配置", loaded: "已加载", error: "连接异常" }[resource.state]}</Badge>
                {resource.kind !== "mcp" && resource.state === "loaded" && <Button size="sm" variant="ghost" onClick={() => {
                  onUseResource(resource.kind === "skill" ? "/skill:" + resource.name : "/" + resource.name); setOpen(false);
                }}>使用</Button>}</div>
            </div>)}
          </div></ScrollArea>
        </TabsContent>
        <TabsContent value="context" className="flex min-h-0 flex-1 flex-col gap-5 py-3">
          {state?.context?.tokens != null && <Context usedTokens={state.context.tokens} maxTokens={state.context.contextWindow}>
            <ContextTrigger aria-label="会话上下文用量" /><ContextContent><ContextContentHeader /></ContextContent>
          </Context>}
          <p className="text-sm text-muted-foreground">{state?.context?.tokens == null ? "本次上下文用量尚未统计" : `${state.context.tokens.toLocaleString()} / ${state.context.contextWindow.toLocaleString()} tokens`}</p>
          <FieldGroup><Field><FieldLabel htmlFor="compaction-instructions">压缩时保留的重点（可选）</FieldLabel>
            <Textarea id="compaction-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={2000} placeholder="例如：保留当前目标、已完成的操作和待处理的问题" rows={2} disabled={working} />
          </Field></FieldGroup>
          <Button className="self-start" size="sm" variant="outline" disabled={busy || working || !nodes.length} onClick={() => void act("compact")}><Scissors />{working ? "正在压缩…" : "压缩当前上下文"}</Button>
          {lastCompaction && <div className="flex min-h-0 flex-1 flex-col gap-2"><p className="text-xs text-muted-foreground">最近压缩 · {new Date(lastCompaction.createdAt).toLocaleString("zh-CN")}</p>
            <ScrollArea className="min-h-16 flex-1 rounded-md border p-3"><p className="whitespace-pre-wrap break-words text-sm">{lastCompaction.text}</p></ScrollArea></div>}
          {Object.entries(state?.statuses || {}).map(([key, value]) => <p key={key} className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{value}</p>)}
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
}
