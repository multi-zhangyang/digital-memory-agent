"use client";
import { useEffect, useRef, useState } from "react";
import type { MemoryOverview } from "@memory/contracts";
import { api, ApiRequestError } from "@/lib/api";
import { useLatestCallback } from "./use-latest-callback";

const unique = <T,>(values: T[], key: (value: T) => string) => [...new Map(values.map((value) => [key(value), value])).values()];

export function useMemoryCatalog(params: string, refresh: unknown, revision: number, onChanged: () => Promise<void>) {
  const [snapshot, setSnapshot] = useState<{ params: string; value: MemoryOverview } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestMore = useRef<(cursor: string) => void>(() => {});
  const changed = useLatestCallback(onChanged);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasActive = false;
    let requesting = false;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    async function load(cursor?: string, polling = false) {
      if (requesting || controller.signal.aborted) return;
      requesting = true;
      clearTimeout(timer);
      if (cursor) setLoadingMore(true);
      try {
        const query = new URLSearchParams(params);
        if (cursor) query.set("cursor", cursor);
        let result: MemoryOverview;
        try { result = await api<MemoryOverview>("/memory-overview?" + query, { signal: controller.signal }); }
        catch (failure) {
          if (!cursor || !(failure instanceof ApiRequestError) || failure.code !== "MEMORY_CURSOR_EXPIRED") throw failure;
          result = await api<MemoryOverview>("/memory-overview?" + params, { signal: controller.signal });
          cursor = undefined;
          setError("记忆有更新，列表已刷新。");
        }
        if (controller.signal.aborted) return;
        setSnapshot((previous) => {
          if (previous?.params === params && previous.value.revision === result.revision) {
            if (cursor) return { params, value: { ...result,
              memories: unique([...previous.value.memories, ...result.memories], (entry) => entry.id),
              people: unique([...previous.value.people, ...result.people], (person) => person.id || "name:" + person.name),
              conflicts: { ...previous.value.conflicts, ...result.conflicts },
            } };
            if (polling) return { params, value: { ...result, memories: previous.value.memories, people: previous.value.people,
              conflicts: previous.value.conflicts, pagination: previous.value.pagination, peoplePagination: previous.value.peoplePagination } };
          }
          return { params, value: result };
        });
        if (result.activeJobs) timer = setTimeout(() => void load(undefined, true), 1500);
        if (wasActive && !result.activeJobs) void changed();
        wasActive = !!result.activeJobs;
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败");
      } finally {
        requesting = false;
        if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false); }
      }
    }
    requestMore.current = (cursor) => void load(cursor);
    timer = setTimeout(() => void load(), 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [params, refresh, revision, changed]);
  const overview = snapshot?.params === params ? snapshot.value : null;
  return { overview, loading: loading || (!overview && !error), loadingMore, error, loadMore: (cursor: string) => requestMore.current(cursor) };
}
