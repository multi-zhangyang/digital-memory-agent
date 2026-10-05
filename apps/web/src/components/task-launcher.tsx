"use client";

import { Suggestion } from "@/components/ai-elements/suggestion";
import { Database, Images, Search, SquarePen } from "lucide-react";
import { productTasks } from "@/lib/product-tasks";
import type { ReactNode } from "react";

const taskIcons = [Images, Search, SquarePen, Database];

export function TaskLauncher({ composer, onPrompt }: {
  composer: ReactNode;
  onPrompt: (text: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pb-12 sm:pb-24" data-testid="task-launcher">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6">
        <h1 className="text-center text-3xl font-medium tracking-tight">新对话</h1>
        {composer}
        <div className="flex flex-wrap justify-center gap-2">
          {productTasks.slice(1).map(({ label, prompt }, index) => {
            const Icon = taskIcons[index];
            return (
              <Suggestion key={label} suggestion={prompt} onClick={onPrompt}>
                <Icon data-icon="inline-start" />{label}
              </Suggestion>
            );
          })}
        </div>
      </div>
    </div>
  );
}
