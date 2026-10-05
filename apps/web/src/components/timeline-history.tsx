"use client";
import { useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";

/** Keep the reader on the same message when a server page is prepended. */
export function TimelineHistory({ hasMore, loading, version, onLoad }: { hasMore: boolean; loading: boolean; version: string; onLoad: () => Promise<void> }) {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const anchor = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!loading && anchor.current && element) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [loading, version, scrollRef]);
  if (!hasMore) return null;
  return <Button variant="ghost" size="sm" className="mx-auto text-xs text-muted-foreground" disabled={loading}
    onClick={() => {
      stopScroll();
      const element = scrollRef.current;
      if (element) anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      void onLoad();
    }}>{loading ? "正在加载…" : "加载更早记录"}</Button>;
}
