"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Artifact, Asset } from "@memory/contracts";
import type { InspectorTarget } from "@/lib/workbench";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { FileText, FolderOpen, GitCompareArrows, Maximize2, Minimize2, TerminalSquare, X } from "lucide-react";

export type SurfaceTab = { id: string; target?: InspectorTarget; view?: string; delivery?: { runId: string; toolCallId: string }; file?: { projectId: string; path: string; nonce: number } };
const files: SurfaceTab = { id: "files", view: "files" };
type SurfaceState = { tabs: SurfaceTab[]; active: string };
const defaults = (): SurfaceState => ({ tabs: [files], active: files.id });
const resourceId = (target: InspectorTarget) => target.tab + ":" + (target.id || "all");

export function WorkSurface({ sessionKey, target, request, assets, artifacts, renderResource, renderProject, expanded, onExpand, onSelect, onClose }: {
  sessionKey: string;
  target: InspectorTarget | null;
  request: SurfaceTab | null;
  assets: Asset[];
  artifacts: Artifact[];
  renderResource: (target: InspectorTarget, close: () => void) => ReactNode;
  renderProject: (tab: SurfaceTab, active: boolean) => ReactNode;
  expanded?: boolean;
  onExpand?: () => void;
  onSelect: (tab: SurfaceTab) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<SurfaceState>(defaults);
  const [loaded, setLoaded] = useState(false);
  const [visited, setVisited] = useState(() => new Set<string>());
  const storageKey = "digital-memory.surface." + sessionKey;
  useEffect(() => {
    let next = defaults();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as SurfaceState | null;
      if (saved?.tabs?.length && saved.tabs.every((tab) => typeof tab.id === "string" &&
        (tab.target ? ["assets", "artifacts", "memories", "activities"].includes(tab.target.tab) : ["files", "changes", "terminal", "delivery"].includes(tab.view || "")))) {
        const tabs = [files, ...saved.tabs.filter((tab) => tab.id !== "files").slice(-11)];
        next = { tabs, active: tabs.some((t) => t.id === saved.active) ? saved.active : files.id };
      }
    } catch { /* A browser preference is not execution state. */ }
    if (target) {
      const tab = { id: resourceId(target), target };
      next = { tabs: [files, ...next.tabs.filter((t) => t.id !== "files" && t.id !== tab.id).slice(-10), tab], active: tab.id };
    }
    setState(next); setLoaded(true);
  // Each instance belongs to one session. The parent keys it by that session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
  }, [loaded, state, storageKey]);
  useEffect(() => { if (loaded) setVisited((previous) => previous.has(state.active) ? previous : new Set([...previous, state.active])); }, [loaded, state.active]);
  function open(tab: SurfaceTab, focus = true) {
    setState((previous) => {
      const found = previous.tabs.find((t) => t.id === tab.id);
      if (found && JSON.stringify(found) === JSON.stringify(tab) && previous.active === tab.id) return previous;
      const tabs = found ? previous.tabs.map((t) => t.id === tab.id ? tab : t) : [...previous.tabs, tab];
      if (tabs.length > 12) tabs.splice(tabs.findIndex((item) => item.id !== "files" && item.id !== previous.active && item.id !== tab.id), 1);
      return { tabs, active: focus ? tab.id : previous.active };
    });
  }
  // A menu/link requests an object; reopening the workspace restores its last tab.
  useEffect(() => { if (loaded && request) open(request); }, [request, loaded]);
  useEffect(() => { if (loaded && target) open({ id: resourceId(target), target }); }, [target, loaded]);
  function close(id: string) {
    const remaining = state.tabs.filter((tab) => tab.id !== id);
    const tabs = remaining.length ? remaining : [files];
    const active = id === state.active ? tabs.at(-1)!.id : state.active;
    setState({ tabs, active });
    onSelect(tabs.find((tab) => tab.id === active)!);
  }
  const title = (tab: SurfaceTab) => tab.file?.path.split("/").at(-1) || (tab.target
    ? tab.target.tab === "assets" ? assets.find((a) => a.id === tab.target?.id)?.name || "来源"
      : tab.target.tab === "artifacts" ? artifacts.find((a) => a.id === tab.target?.id)?.title || "成果"
        : tab.target.tab === "activities" ? "活动" : "记忆"
    : ({ files: "文件", changes: "改动", terminal: "终端", delivery: "训练文件" }[tab.view || "files"] || "工作区"));
  return <Tabs value={state.active} onValueChange={(id) => { setState({ ...state, active: id }); onSelect(state.tabs.find((t) => t.id === id)!); }}
    className="h-full min-h-0 gap-0" data-testid="work-surface">
    <div className="flex min-w-0 shrink-0 items-center gap-1 border-b pr-2">
      <TabsList variant="line" className="h-12 min-w-0 flex-1 justify-start overflow-x-auto rounded-none px-2" aria-label="工作区标签">
        {state.tabs.map((tab) => <div key={tab.id} className="flex shrink-0 items-center">
          <TabsTrigger value={tab.id} className="max-w-52 gap-2" title={title(tab)}>
            {tab.view === "terminal" ? <TerminalSquare /> : tab.view === "changes" ? <GitCompareArrows /> : tab.id === "files" ? <FolderOpen /> : <FileText />}
            <span className="truncate">{title(tab)}</span>
          </TabsTrigger>
          {tab.id !== "files" && <Button variant="ghost" size="icon-xs" aria-label={"关闭标签 " + title(tab)} onClick={() => close(tab.id)}><X /></Button>}
        </div>)}
      </TabsList>
      {onExpand && <Button variant="ghost" size="icon-sm" aria-label={expanded ? "恢复分栏" : "展开工作区"} onClick={onExpand}>
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>}
      <Button variant="ghost" size="icon-sm" aria-label="关闭工作区" onClick={onClose}><X /></Button>
    </div>
    {state.tabs.map((tab) => <TabsContent key={tab.id} value={tab.id} forceMount
      className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
      {loaded && (visited.has(tab.id) || tab.id === state.active) && (tab.target ? renderResource(tab.target, () => close(tab.id)) : renderProject(tab, tab.id === state.active))}
    </TabsContent>)}
  </Tabs>;
}
