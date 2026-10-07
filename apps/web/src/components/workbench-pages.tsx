"use client";

import { Activity, Suspense, memo, useEffect, useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkbenchPage } from "./workbench-navigation";

const pageTitles: Record<WorkbenchPage, string> = {
  chat: "对话", tasks: "全部对话", memory: "记忆", assets: "资料库",
  settings: "设置", processing: "处理与核对", artifacts: "整理结果", datasets: "数据集",
};

// Activity keeps DOM and local state, suspending effects on hidden pages.
export function WorkbenchPages({ current, renderPage }: {
  current: WorkbenchPage;
  renderPage: (page: WorkbenchPage) => ReactNode;
}) {
  const [visited, setVisited] = useState<WorkbenchPage[]>([current]);
  if (!visited.includes(current)) setVisited([...visited, current]);
  return <Suspense fallback={<WorkbenchPageSkeleton />}>{visited.map((page) => (
    <Activity key={page} mode={page === current ? "visible" : "hidden"}>
      <section aria-label={pageTitles[page] + "页面"} data-workbench-page={page}
        className="flex h-full min-h-0 min-w-0 flex-col">
        <PageContent active={page === current} page={page} renderPage={renderPage} />
      </section>
    </Activity>
  ))}</Suspense>;
}

// Hidden pages receive fresh application props when shown again. Avoid scheduling
// an offscreen tree update for every navigation or streamed token in another view.
const PageContent = memo(function PageContent({ page, renderPage }: {
  active: boolean;
  page: WorkbenchPage;
  renderPage: (page: WorkbenchPage) => ReactNode;
}) {
  return renderPage(page);
}, (previous, next) => !next.active || previous.renderPage === next.renderPage);

export function WorkbenchPageSkeleton() {
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 sm:p-8" role="status" aria-label="正在加载页面">
    <Skeleton className="h-7 w-36" />
    <Skeleton className="h-9 w-full max-w-sm" />
    <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div>
  </div>;
}

// Load code only; data and effects still start when the user visits the page.
const loaders: Partial<Record<WorkbenchPage, () => Promise<unknown>>> = {
    chat: () => import("./run-thread"),
    tasks: () => import("./task-library"),
    memory: () => import("./memory-home"),
    assets: () => import("./asset-library"),
    settings: () => import("./settings-panel"),
    processing: () => import("./processing-center"),
    artifacts: () => import("./artifact-library"),
    datasets: () => import("./memory-datasets"),
};

export function preloadWorkbenchPage(page: WorkbenchPage) {
  return loaders[page]?.().catch(() => { /* The visible page retries its own import. */ });
}

export function usePreloadWorkbenchPages(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const pages: WorkbenchPage[] = ["chat", "memory", "assets", "tasks", "settings"];
    let cancelled = false;
    let cancelPending: (() => void) | undefined;
    const next = () => {
      const page = pages.shift();
      if (cancelled || !page) return;
      const load = () => { void preloadWorkbenchPage(page)?.finally(next); };
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(load);
        cancelPending = () => window.cancelIdleCallback(id);
      } else {
        const id = setTimeout(load, 300);
        cancelPending = () => clearTimeout(id);
      }
    };
    next();
    return () => { cancelled = true; cancelPending?.(); };
  }, [ready]);
}
