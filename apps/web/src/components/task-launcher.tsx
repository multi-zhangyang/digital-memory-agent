"use client";

import { Suggestion } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowUpRight, Images, MessageSquare, Search, SquarePen } from "lucide-react";
import { productTasks } from "@/lib/product-tasks";
import { shortDate } from "@/lib/api";
import type { Conversation } from "@memory/contracts";
import { useMemo, type ReactNode } from "react";

const actions = [
  { ...productTasks[1], icon: Images, description: "把照片和文字，整理成活动" },
  { ...productTasks[2], icon: Search, description: "找到经历，也找到原始资料" },
  { ...productTasks[3], icon: SquarePen, description: "说出变化，更新已有记录" },
];

export function TaskLauncher({ composer, onPrompt, conversations, onTask }: {
  composer: ReactNode;
  onPrompt: (text: string) => void;
  conversations: Conversation[];
  onTask: (id: string) => void;
}) {
  const recent = useMemo(() => conversations.filter((item) => !item.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3), [conversations]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="task-launcher">
      <div className="@container mx-auto my-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-12 sm:px-8 sm:py-16">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">你的个人记忆</p>
          <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">今天，想记住什么？</h1>
          <p className="text-sm leading-6 text-muted-foreground">放入照片、写下经历，或找回一段记忆。</p>
        </div>
        <div className="flex flex-col gap-4">
          {composer}
          <div className="grid gap-2 @xl:grid-cols-3">
            {actions.map(({ label, prompt, icon: Icon, description }) => (
              <Suggestion key={label} suggestion={prompt} onClick={onPrompt} aria-label={label}
                variant="ghost" className="h-auto justify-start gap-3 rounded-xl px-3 py-4 text-left @xl:flex-col @xl:items-start @xl:gap-2">
                <Icon data-icon="inline-start" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span>{label}</span>
                  <span className="whitespace-normal text-xs font-normal leading-5 text-muted-foreground">{description}</span>
                </span>
              </Suggestion>
            ))}
          </div>
        </div>
        {!!recent.length && <div className="flex flex-col gap-4">
          <Separator />
          <h2 className="text-xs text-muted-foreground">继续最近的对话</h2>
          <div className="flex flex-col gap-1">
            {recent.map((item) => <Button key={item.id} variant="ghost" className="h-11 w-full justify-start gap-3" onClick={() => onTask(item.id)}>
              <MessageSquare data-icon="inline-start" /><span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">{shortDate(item.updatedAt)}</span><ArrowUpRight data-icon="inline-end" />
            </Button>)}
          </div>
        </div>}
      </div>
    </div>
  );
}
