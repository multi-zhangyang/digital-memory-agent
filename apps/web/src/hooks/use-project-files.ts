"use client";
import { useEffect, useState } from "react";
import type { ProjectFile } from "@memory/contracts";
import { api } from "@/lib/api";

const cache = new Map<string, { files: ProjectFile[]; time: number }>();
const pending = new Map<string, Promise<ProjectFile[]>>();

export function useProjectFiles(
  projectId: string | undefined,
  enabled: boolean,
) {
  const [state, setState] = useState<{
    projectId?: string;
    files: ProjectFile[];
    loading: boolean;
    error: string;
  }>({ files: [], loading: false, error: "" });
  useEffect(() => {
    if (!enabled || !projectId) return;
    let cancelled = false;
    const saved = cache.get(projectId);
    setState({
      projectId,
      files: saved?.files || [],
      loading: !saved,
      error: "",
    });
    if (saved && Date.now() - saved.time < 5000) return;
    let request = pending.get(projectId);
    if (!request) {
      request = api<{ files: ProjectFile[] }>(
        "/projects/" + projectId + "/files",
      )
        .then(({ files }) => {
          cache.set(projectId, { files, time: Date.now() });
          if (cache.size > 12) cache.delete(cache.keys().next().value!);
          return files;
        })
        .finally(() => pending.delete(projectId));
      pending.set(projectId, request);
    }
    void request
      .then((files) => {
        if (!cancelled)
          setState({ projectId, files, loading: false, error: "" });
      })
      .catch((error: Error) => {
        if (!cancelled)
          setState({
            projectId,
            files: [],
            loading: false,
            error: error.message,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled]);
  return state.projectId === projectId
    ? state
    : { files: [], loading: enabled, error: "" };
}

export function matchingFiles(files: ProjectFile[], query: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return files
    .filter(
      (file) =>
        !file.directory &&
        words.every((word) => file.path.toLocaleLowerCase().includes(word)),
    )
    .sort((a, b) => {
      const basename = (path: string) =>
        path.split("/").at(-1)!.toLocaleLowerCase();
      return (
        Number(basename(b.path).startsWith(words[0] || "")) -
          Number(basename(a.path).startsWith(words[0] || "")) ||
        a.path.localeCompare(b.path)
      );
    })
    .slice(0, 60);
}
