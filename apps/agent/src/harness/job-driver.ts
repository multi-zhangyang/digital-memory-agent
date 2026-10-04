import type { Run, TaskJob } from "@memory/contracts";
export type JobSnapshot = Omit<TaskJob, "kind" | "toolCallId">;

export interface TaskJobDriver {
  get(id: string): JobSnapshot;
  result(id: string, offset: number, limit: number, maxBytes: number, section?: "assets" | "entries"): unknown;
  cancel(id: string): unknown;
  retry?(id: string, assetIds?: readonly string[]): unknown;
  authorize?(id: string, run: Run): void;
  delivered?(run: Run, result: unknown): void;
  problem?(id: string): string | undefined;
  subscribe(listener: (id: string) => void): () => void;
  list?(): JobSnapshot[];
}
