"use client";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { ToolOutput } from "@/components/ai-elements/tool";
import { api } from "@/lib/api";
import type { AgentApproval, Run } from "@memory/contracts";
import { ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const CodeBlock = dynamic(() =>
  import("@/components/ai-elements/code-block").then(
    (module) => module.CodeBlock,
  ),
);
export function AgentApprovals({
  run,
  onChanged,
}: {
  run: Run;
  onChanged: () => void;
}) {
  const [approvals, setApprovals] = useState<AgentApproval[]>([]),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let done = false;
    const load = async () => {
      try {
        const r = await api<{ approvals: AgentApproval[] }>(
          "/runs/" + run.id + "/approvals",
        );
        if (!done) setApprovals(r.approvals);
      } catch (e) {
        if (!done) setError(e instanceof Error ? e.message : "读取审批失败");
      }
    };
    void load();
    const timer =
      run.status === "waiting"
        ? setInterval(() => void load(), 500)
        : undefined;
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [run.id, run.status]);
  async function answer(a: AgentApproval, approved: boolean, text?: string) {
    setBusy(true);
    setError("");
    try {
      await api("/approvals/" + a.id, {
        method: "POST",
        body: JSON.stringify({ approved, answer: text ?? answers[a.id] }),
      });
      setApprovals((prev) =>
        prev.map((p) =>
          p.id === a.id
            ? {
                ...p,
                status: approved ? "approved" : "denied",
                answer: text ?? answers[a.id],
              }
            : p,
        ),
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "审批失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {approvals.map((a) => (
        <Confirmation
          key={a.id}
          data-testid="agent-approval"
          data-approval-status={a.status}
          approval={
            a.status === "pending"
              ? { id: a.id }
              : {
                  id: a.id,
                  approved: a.status === "approved",
                }
          }
          state={
            a.status === "pending" ? "approval-requested" : "approval-responded"
          }
          role={a.status === "pending" ? "alert" : "status"}
          className={
            a.status === "pending"
              ? "gap-4 p-4"
              : "border-0 bg-transparent px-0 py-1"
          }
        >
          <ConfirmationRequest>
            <div>
              <ConfirmationTitle className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                {a.kind === "tool" ? "允许执行 " + a.title : a.title}
              </ConfirmationTitle>
            </div>
            <div className="space-y-3">
              {a.detail && (
                <div className="max-h-48 overflow-auto">
                  <CodeBlock code={a.detail} language="text" />
                </div>
              )}
              {a.kind === "input" && (
                <PromptInput
                  resetOnSubmit={false}
                  maxFiles={0}
                  onSubmit={({ text }) => {
                    if (text.trim() && !busy) return answer(a, true, text);
                  }}
                >
                  <PromptInputBody>
                    <PromptInputTextarea
                      aria-label="扩展请求回答"
                      placeholder="输入回答"
                      disabled={busy}
                      value={answers[a.id] || ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [a.id]: e.target.value })
                      }
                    />
                  </PromptInputBody>
                  <PromptInputFooter className="justify-end">
                    <PromptInputSubmit
                      aria-label="提交回答"
                      size="sm"
                      status={busy ? "submitted" : "ready"}
                      disabled={busy || !answers[a.id]?.trim()}
                    >
                      继续
                    </PromptInputSubmit>
                  </PromptInputFooter>
                </PromptInput>
              )}
              <ConfirmationActions className="w-full flex-wrap">
                {a.options.map((option) => (
                  <ConfirmationAction
                    key={option}
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void answer(a, true, option)}
                  >
                    {option}
                  </ConfirmationAction>
                ))}
                <ConfirmationAction
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void answer(a, false)}
                >
                  拒绝
                </ConfirmationAction>
                {!a.options.length && a.kind !== "input" && (
                  <ConfirmationAction
                    size="sm"
                    disabled={busy}
                    onClick={() => void answer(a, true)}
                  >
                    允许本次
                  </ConfirmationAction>
                )}
              </ConfirmationActions>
            </div>
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <ConfirmationTitle className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{a.title}</span>
              <span className="shrink-0">{a.answer ? "已回答" : "已允许"}</span>
            </ConfirmationTitle>
            {a.answer && (
              <p className="whitespace-pre-wrap text-sm">{a.answer}</p>
            )}
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <ConfirmationTitle className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldX className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{a.title}</span>
              <span className="shrink-0">已拒绝</span>
            </ConfirmationTitle>
          </ConfirmationRejected>
        </Confirmation>
      ))}
      {error && (
        <ToolOutput className="p-0" output={undefined} errorText={error} />
      )}
    </>
  );
}
