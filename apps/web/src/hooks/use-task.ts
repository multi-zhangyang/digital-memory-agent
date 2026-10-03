"use client";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RunEvent, WorkspaceDetail } from "@memory/contracts";
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
function reconcile(
  previous: WorkspaceDetail | undefined,
  next: WorkspaceDetail,
) {
  if (!previous) return next;
  const known = new Map(previous.runs.map((run) => [run.id, run]));
  return {
    ...next,
    runs: next.runs.map((run) => {
      const local = known.get(run.id);
      return local && local.cursor >= run.cursor && local.status === run.status
        ? local
        : local && local.cursor > run.cursor
          ? local
          : run;
    }),
  };
}

export function useTask(id: string | null, onChanged: () => void) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<
    "idle" | "connected" | "reconnecting"
  >("idle");
  const current = useRef(id);
  current.current = id;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const requests = useRef(new Map<string, Promise<void>>());
  const refresh = useCallback(async () => {
    if (!id) return;
    // A mutation may arrive while a previous read is in flight; read again
    // after it completes, so an explicit refresh cannot miss that mutation.
    await requests.current.get(id);
    const request = (async () => {
      try {
        const result = await api<WorkspaceDetail>(
          "/conversations/" + id + "/workspace",
        );
        const next = reconcile(cache.get(id), result);
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
      const next = {
        ...previous,
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
  return { detail: visible || null, error, refresh, connection };
}
