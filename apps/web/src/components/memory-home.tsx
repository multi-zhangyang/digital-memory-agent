"use client";
import { Activity, useState, type ComponentProps } from "react";
import dynamic from "next/dynamic";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MemoryActivitiesPage } from "./memory-activities";
import { WorkbenchPageSkeleton } from "./workbench-pages";
import type { InspectorTarget } from "@/lib/workbench";
const MemoryLibrary = dynamic(() => import("./memory-library").then((m) => m.MemoryLibrary), { loading: WorkbenchPageSkeleton });

export function MemoryHome({ onInspect, onStart, view, onViewChange, ...props }: ComponentProps<typeof MemoryLibrary> & {
  onInspect: (target: InspectorTarget) => void; onStart: () => void; view: "activities" | "records"; onViewChange: (view: "activities" | "records") => void;
}) {
  const [recordsVisited, setRecordsVisited] = useState(view === "records");
  if (view === "records" && !recordsVisited) setRecordsVisited(true);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pb-5 pt-8 sm:px-8">
      <div className="flex flex-col gap-2"><h1 className="text-2xl font-medium tracking-tight">记忆</h1><p className="text-sm text-muted-foreground">按活动回看照片与经历。</p></div>
      <Tabs value={view} onValueChange={(value) => onViewChange(value === "records" ? "records" : "activities")}>
        <TabsList variant="line"><TabsTrigger value="activities">生活活动</TabsTrigger><TabsTrigger value="records">记忆记录</TabsTrigger></TabsList>
      </Tabs>
    </div>
    <Activity mode={view === "activities" ? "visible" : "hidden"}>
      <div className="min-h-0 flex-1 overflow-auto"><div className="mx-auto w-full max-w-6xl px-6 pb-8 sm:px-8"><MemoryActivitiesPage assets={props.assets} onInspect={onInspect} onStart={onStart} /></div></div>
    </Activity>
    {recordsVisited && <Activity mode={view === "records" ? "visible" : "hidden"}><MemoryLibrary {...props} /></Activity>}
  </div>;
}
