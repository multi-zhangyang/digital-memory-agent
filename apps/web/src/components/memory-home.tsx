"use client";
import type { ComponentProps } from "react";
import dynamic from "next/dynamic";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MemoryActivitiesPage } from "./memory-activities";
import type { InspectorTarget } from "@/lib/workbench";
const MemoryLibrary = dynamic(() => import("./memory-library").then((m) => m.MemoryLibrary));

export function MemoryHome({ onInspect, onStart, view, onViewChange, ...props }: ComponentProps<typeof MemoryLibrary> & {
  onInspect: (target: InspectorTarget) => void; onStart: () => void; view: "activities" | "records"; onViewChange: (view: "activities" | "records") => void;
}) {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight">记忆</h1>
      <Tabs value={view} onValueChange={(value) => onViewChange(value === "records" ? "records" : "activities")}><TabsList><TabsTrigger value="activities">活动</TabsTrigger><TabsTrigger value="records">记忆记录</TabsTrigger></TabsList></Tabs>
    </div>
    {view === "activities" ? <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 sm:px-8"><MemoryActivitiesPage assets={props.assets} onInspect={onInspect} onStart={onStart} /></div> : <MemoryLibrary {...props} />}
  </div>;
}
