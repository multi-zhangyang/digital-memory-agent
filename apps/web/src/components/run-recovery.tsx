"use client";
import { useState } from "react";
import type { Run } from "@memory/contracts";
import { Play, RefreshCw } from "lucide-react";
import { Confirmation, ConfirmationRequest, ConfirmationTitle } from "@/components/ai-elements/confirmation";
import { Tool, ToolContent, ToolHeader, ToolInput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { api } from "@/lib/api";

export function RunRecovery({ run, onChanged }: { run: Run; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [decisions, setDecisions] = useState<Record<string, "skip" | "retry">>({});
  const [acceptConfiguration, setAcceptConfiguration] = useState(false);
  if (!["stopped", "failed"].includes(run.status) && !(run.status === "waiting" && run.waitingFor === "recovery")) return null;
  const pending = run.parts.filter((p) => p.type === "tool" && run.recovery?.pendingToolIds.includes(p.toolCallId));
  const blocked = run.recovery?.state === "blocked";
  async function resume() {
    setBusy(true); setError("");
    try { await api(`/runs/${run.id}/resume`, { method: "POST", body: JSON.stringify({ acceptConfiguration,
      decisions: pending.flatMap((part) => part.type === "tool" ? [{ toolCallId: part.toolCallId, action: decisions[part.toolCallId] || "skip" }] : []) }) }); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "任务未恢复"); } finally { setBusy(false); }
  }
  return <Confirmation approval={{ id: run.id }} state="approval-requested" data-testid="run-recovery">
    <ConfirmationRequest>
      <div className="flex flex-col gap-4">
        <ConfirmationTitle>{pending.length ? "核对中断操作后继续" : "继续这项任务"}</ConfirmationTitle>
        {run.recovery?.reason && <p className="text-sm text-muted-foreground">{run.recovery.reason}</p>}
        <FieldGroup>{pending.map((part) => part.type === "tool" ? <Field key={part.toolCallId}>
          <Tool defaultOpen><ToolHeader title={part.name} type={`tool-${part.name}`} state="output-error" /><ToolContent><ToolInput input={part.input} /></ToolContent></Tool>
          <FieldLabel>这项操作的结果尚未核实</FieldLabel>
          <ToggleGroup type="single" value={decisions[part.toolCallId] || "skip"} onValueChange={(value) => { if (value) setDecisions({ ...decisions, [part.toolCallId]: value as "skip" | "retry" }); }} aria-label={`恢复决定 ${part.name}`}>
            <ToggleGroupItem value="skip">本次跳过此工具</ToggleGroupItem><ToggleGroupItem value="retry">允许重试</ToggleGroupItem>
          </ToggleGroup><FieldDescription>重试可能重复中断前已产生的改动。</FieldDescription>
        </Field> : null)}
          {blocked && <Field orientation="horizontal"><Checkbox id={`configuration-${run.id}`} checked={acceptConfiguration} onCheckedChange={(checked) => setAcceptConfiguration(checked === true)} /><FieldLabel htmlFor={`configuration-${run.id}`}>已核对当前执行配置，按当前权限继续</FieldLabel></Field>}
        </FieldGroup>
        {error && <Alert variant="destructive"><AlertTitle>暂时无法继续</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <Button className="self-start" disabled={busy || (blocked && !acceptConfiguration)} onClick={() => void resume()}>{busy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}继续任务</Button>
      </div>
    </ConfirmationRequest>
  </Confirmation>;
}
