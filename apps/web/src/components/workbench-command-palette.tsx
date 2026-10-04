"use client";
import { useState } from "react";
import { Brain, FileText, MessageSquare, type LucideIcon } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import type { InspectorTarget, WorkbenchSnapshot } from "@/lib/workbench";

export function WorkbenchCommandPalette({ snapshot, actions, onClose, onTask, onInspect }: {
  snapshot: WorkbenchSnapshot;
  actions: { name: string; icon: LucideIcon; keys: string; action: () => void }[];
  onClose: () => void;
  onTask: (id: string) => void;
  onInspect: (target: InspectorTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = (text: string) => query.toLocaleLowerCase().trim().split(/\s+/).every((word) => text.toLocaleLowerCase().includes(word));
  const select = (action: () => void) => { onClose(); action(); };
  return <CommandDialog open onOpenChange={(open) => { if (!open) onClose(); }} title="搜索工作空间" description="命令、任务、项目文件与资料">
    <CommandInput placeholder="搜索任务、资料、结果、记忆…" value={query} onValueChange={setQuery} />
    <CommandList><CommandEmpty>没有匹配结果</CommandEmpty>
      <CommandGroup heading="操作">{actions.map(({ name, icon: Icon, keys, action }) => <CommandItem key={name} value={name} onSelect={() => select(action)}>
        <Icon /><span>{name}</span><CommandShortcut>{keys.replaceAll("⌘", "Ctrl/⌘")}</CommandShortcut>
      </CommandItem>)}</CommandGroup>
      <CommandGroup heading="任务">{snapshot.conversations.filter((item) => matches("任务 " + item.title)).slice(0, 40).map((item) =>
        <CommandItem key={item.id} value={"任务 " + item.title + " " + item.id} onSelect={() => select(() => onTask(item.id))}><MessageSquare />{item.title}</CommandItem>)}</CommandGroup>
      <CommandGroup heading="资料">{snapshot.assets.filter((item) => matches("资料 " + item.name)).slice(0, 30).map((item) =>
        <CommandItem key={item.id} value={"资料 " + item.name + " " + item.id} onSelect={() => select(() => onInspect({ tab: "assets", id: item.id }))}><FileText />{item.name}</CommandItem>)}</CommandGroup>
      <CommandGroup heading="结果">{snapshot.artifacts.filter((item) => matches("结果 " + item.title)).slice(0, 30).map((item) =>
        <CommandItem key={item.id} value={"结果 " + item.title + " " + item.id} onSelect={() => select(() => onInspect({ tab: "artifacts", id: item.id }))}><FileText />{item.title}</CommandItem>)}</CommandGroup>
      <CommandGroup heading="记忆">{snapshot.memories.filter((item) => item.status !== "rejected" && !item.forgottenAt && matches("记忆 " + item.title + " " + item.content)).slice(0, 30).map((item) =>
        <CommandItem key={item.id} value={"记忆 " + item.title + " " + item.content} onSelect={() => select(() => onInspect({ tab: "memories", id: item.id }))}><Brain />{item.title}</CommandItem>)}</CommandGroup>
    </CommandList>
  </CommandDialog>;
}
