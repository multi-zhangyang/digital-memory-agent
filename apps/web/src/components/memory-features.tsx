"use client";
import { useState } from "react";
import type { MemoryFeatureStatus } from "@memory/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { api } from "@/lib/api";

export function MemoryFeatures({ status, onChanged }: { status?: MemoryFeatureStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!status) return null;
  const pending = status.jobs.queued + status.jobs.running;
  const label = status.state === "not_configured" ? "语义检索未配置" : status.state === "starting" ? "正在准备检索"
    : status.state === "unavailable" ? "检索处理器不可用" : pending ? `正在准备检索 · ${pending} 条待处理`
      : status.jobs.failed ? `检索准备未完成 · ${status.jobs.failed} 条失败` : "检索准备完成";
  return <div className="flex flex-wrap items-center gap-2" data-testid="memory-feature-status">
    <Badge variant="outline">{label}</Badge>
    {(status.jobs.failed > 0 || status.state === "unavailable") && <Button variant="ghost" size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await api("/memory-features/retry", { method: "POST" }); onChanged(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "重试失败"); }
      finally { setBusy(false); }
    }}>重试</Button>}
    {error && <Alert><AlertTitle>{error}</AlertTitle></Alert>}
  </div>;
}
