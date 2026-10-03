"use client";
import { useCallback, useRef } from "react";

// Stable event handlers keep completed messages out of the streaming render path.
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
