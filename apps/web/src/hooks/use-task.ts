"use client";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Run, RunEvent, WorkspaceDetail } from "@memory/contracts";
import { api } from "@/lib/api";
import { applyRunEvent } from "@/lib/workbench";

// Bounded session cache: switching back shows the last snapshot immediately,
// then reconciles with the durable server state.
const cache = new Map<string, WorkspaceDetail>();
function remember(detail: WorkspaceDetail) {
  cache.delete(detail.conversation.id);
  cache.set(detail.conversation.id, detail);
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
}
function mergeRun(a: Run, b: Run): Run {
  const latest = a.cursor > b.cursor ? a : b;
  const early = (a.window?.start || 0) <= (b.window?.start || 0) ? a : b;
  const late = early === a ? b : a;
  const start = early.window?.start || 0;
  const split = (late.window?.start || 0) - start;
  const parts = split ? [...early.parts.slice(0, split), ...late.parts] : latest.parts;
  return { ...latest, parts, window: { start, end: start + parts.length } };
}
function reconcile(previous: WorkspaceDetail | undefined, next: WorkspaceDetail, older = false) {
  if (!previous) return next;
  // A snapshot after a long disconnect may leave an unloaded gap. Keep its
  // real pagination cursor instead of concatenating non-adjacent part ranges.
  if (!older && next.runs.some((run) => {
    const saved = previous.runs.find((item) => item.id === run.id);
    return saved && (saved.window?.start || 0) + saved.parts.length < (run.window?.start || 0);
  })) return next;
  if (!older && previous.runs.length && next.runs.length && next.page?.hasMore &&
    !next.runs.some((run) => previous.runs.some((saved) => saved.id === run.id))) return next;
  const runs = new Map(previous.runs.map((run) => [run.id, run]));
  for (const run of next.runs) runs.set(run.id, runs.has(run.id) ? mergeRun(runs.get(run.id)!, run) : run);
  // The server's durable insertion order is authoritative; timestamps can tie.
  const order = [...new Set((older ? [...next.runs, ...previous.runs] : [...previous.runs, ...next.runs]).map((run) => run.id))];
  const legacy = new Map((older ? [...next.legacyMessages, ...previous.legacyMessages] : [...previous.legacyMessages, ...next.legacyMessages]).map((message) => [message.id, message]));
  return { ...next, conversation: older ? previous.conversation : next.conversation,
    runs: order.map((id) => runs.get(id)!),
    assets: [...new Map([...previous.assets, ...next.assets].map((asset) => [asset.id, asset])).values()],
    presentation: older ? previous.presentation : next.presentation,
    activeEntryIds: older ? previous.activeEntryIds : next.activeEntryIds,
    legacyMessages: [...legacy.values()],
    page: older ? next.page : previous.page || next.page,
  };
}

export function useTask(id: string | null, onChanged: () => void) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [connection, setConnection] = useState<
    "idle" | "connected" | "reconnecting"
  >("idle");
  const current = useRef(id);
  current.current = id;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const requests = useRef(new Map<string, Promise<void>>());
  const refresh = useCallback(async (replace = false) => {
    if (!id) return;
    // A mutation may arrive while a previous read is in flight; read again
    // after it completes, so an explicit refresh cannot miss that mutation.
    await requests.current.get(id);
    const request = (async () => {
      try {
        const result = await api<WorkspaceDetail>(
          "/conversations/" + id + "/timeline",
        );
        const next = reconcile(replace ? undefined : cache.get(id), result);
        remember(next);
        if (current.current === id) {
          setDetail(next);
          setError("");
        }
      } catch (failure) {
        if (current.current === id)
          setError(failure instanceof Error ? failure.message : "读取失败");
      }
    })();
    requests.current.set(id, request);
    await request;
    if (requests.current.get(id) === request) requests.current.delete(id);
  }, [id]);
  const loadMore = useCallback(async () => {
    const previous = id ? cache.get(id) : undefined;
    if (!id || !previous?.page?.before || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<WorkspaceDetail>("/conversations/" + id + "/timeline?before=" + encodeURIComponent(previous.page.before));
      const next = reconcile(cache.get(id), page, true);
      remember(next);
      if (current.current === id) setDetail(next);
    } catch (failure) { if (current.current === id) setError(failure instanceof Error ? failure.message : "读取失败"); }
    finally { setLoadingMore(false); }
  }, [id, loadingMore]);
  useEffect(() => {
    setDetail(id ? cache.get(id) || null : null);
    setError("");
    void refresh();
  }, [id, refresh]);
  const visible =
    detail?.conversation.id === id ? detail : id ? cache.get(id) : null;
  const running =
    visible?.runs.find(
      (run) => run.status === "running" || run.status === "waiting",
    ) || visible?.runs.find((run) => run.status === "queued");
  useEffect(() => {
    if (!running || !id) return;
    let pending: RunEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let closed = false;
    const source = new EventSource(
      "/api/runs/" + running.id + "/events?after=" + running.cursor,
    );
    function flush() {
      clearTimeout(timer);
      timer = undefined;
      const events = pending;
      pending = [];
      const previous = cache.get(id!);
      if (!previous || !events.length) return;
      const entryIds = events.flatMap((event) => { const data = event.data as { entryId?: string }; return event.type === "message-entry" && typeof data.entryId === "string" ? [data.entryId] : []; });
      const next = {
        ...previous,
        presentation: events.reduce((value, event) => (event.data as Partial<Run>).extensionUI || value, previous.presentation),
        activeEntryIds: previous.activeEntryIds && entryIds.length ? [...new Set([...previous.activeEntryIds, ...entryIds])] : previous.activeEntryIds,
        runs: previous.runs.map((run) =>
          run.id === running!.id ? events.reduce(applyRunEvent, run) : run,
        ),
      };
      remember(next);
      if (current.current === id) startTransition(() => setDetail(next));
    }
    source.onopen = () => {
      connected = true;
      setConnection("connected");
    };
    source.onmessage = (message) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      pending.push(event);
      // Smooth text updates; permission, tool and lifecycle changes remain prompt.
      if (
        event.type === "text" ||
        event.type === "reasoning" ||
        event.type === "tool-update"
      ) {
        timer ??= setTimeout(flush, 50);
      } else flush();
      if (
        [
          "artifact",
          "memory",
          "finished",
          "failed",
          "stopped",
          "interrupted",
        ].includes(event.type)
      )
        changed.current();
      if (["finished", "failed", "stopped", "interrupted"].includes(event.type))
        void refresh();
    };
    source.addEventListener("settled", () => {
      flush();
      closed = true;
      source.close();
      void refresh();
      changed.current();
    });
    source.onerror = () => {
      connected = false;
      setConnection("reconnecting");
      flush();
    };
    // EventSource reconnects with Last-Event-ID. Poll only as a fallback when
    // that connection is unavailable, and never in a hidden tab.
    const fallback = setInterval(() => {
      if (!connected && !closed && document.visibilityState === "visible")
        void refresh();
    }, 5000);
    return () => {
      flush();
      source.close();
      clearTimeout(timer);
      clearInterval(fallback);
      setConnection("idle");
    };
    // Cursor is the initial replay position; deltas must not reopen the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id, id, refresh]);
  return { detail: visible || null, error, refresh, connection, loadMore, loadingMore };
}
