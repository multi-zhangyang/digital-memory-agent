"use client";
import { useCallback, useRef, useState } from "react";
import type { HarnessSettings, ModelConfiguration, Project, ToolInfo } from "@memory/contracts";
import type { WorkbenchSnapshot } from "@/lib/workbench";
import { api } from "@/lib/api";

/** Workspace data refresh is independent of navigation and the active task's streaming state. */
export function useWorkbenchData() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({ conversations: [], assets: [], collections: [], artifacts: [], memories: [] });
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [harness, setHarness] = useState<HarnessSettings | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [workspace, models, catalog, projectList, harnessSettings] = await Promise.all([
        api<WorkbenchSnapshot>("/workspace"), api<ModelConfiguration>("/models"), api<{ tools: ToolInfo[] }>("/tools"),
        api<{ projects: Project[] }>("/projects"), api<HarnessSettings>("/harness"),
      ]);
      setSnapshot(workspace); setConfiguration(models); setTools(catalog.tools); setProjects(projectList.projects); setHarness(harnessSettings);
      setError(""); setReady(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取失败"); }
  }, []);
  const request = useRef<Promise<void> | null>(null);
  const refreshSnapshot = useCallback(() => {
    return request.current ??= api<WorkbenchSnapshot>("/workspace").then(setSnapshot).catch((failure) => setError(failure.message))
      .finally(() => { request.current = null; });
  }, []);
  return { snapshot, setSnapshot, configuration, projects, setProjects, harness, tools, ready, error, setError, refresh, refreshSnapshot };
}
