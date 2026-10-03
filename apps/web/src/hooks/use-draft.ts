"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { TaskDraft } from "@/lib/workbench";

const storageKey = "digital-memory.drafts";
let drafts: Record<string, TaskDraft> = {};
let loaded = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function persist() {
  clearTimeout(timer);
  try {
    localStorage.setItem(storageKey, JSON.stringify(drafts));
  } catch {
    // A full or disabled browser store must not block composing a message.
  }
}

export function loadDrafts() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (saved && typeof saved === "object") drafts = saved;
    if (drafts.new && !drafts["new-default"])
      drafts["new-default"] = drafts.new;
  } catch {
    // Ignore invalid local drafts.
  }
  window.addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
  });
  listeners.forEach((notify) => notify());
}

export function readDraft(key: string, fallback: TaskDraft) {
  return drafts[key] || fallback;
}

export function writeDraft(key: string, value: TaskDraft) {
  drafts = { ...drafts, [key]: value };
  listeners.forEach((notify) => notify());
  clearTimeout(timer);
  timer = setTimeout(persist, 300);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export function useDraft(key: string, fallback: TaskDraft) {
  const snapshot = useCallback(() => readDraft(key, fallback), [key, fallback]);
  return useSyncExternalStore(subscribe, snapshot, () => fallback);
}
