import type { ChatMessage, Run, WorkspaceDetail } from "@memory/contracts";
import type { Store } from "../store.js";
import { UserFacingError } from "../errors.js";

type Cursor = { runId?: string; messageId?: string; legacyId?: string };
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export async function timelinePage(store: Store, conversationId: string, history: () => Promise<ChatMessage[]>, before?: string, limit = 50, activeEntryIds?: string[]) {
  let cursor: Cursor = {};
  if (before) {
    try { cursor = JSON.parse(Buffer.from(before, "base64url").toString()); }
    catch { throw new UserFacingError(400, "CURSOR", "无效的历史位置"); }
    if (!cursor || Array.isArray(cursor) || typeof cursor !== "object" || (!cursor.runId && !cursor.legacyId) ||
      Object.entries(cursor).some(([key, value]) => !["runId", "messageId", "legacyId"].includes(key) || typeof value !== "string" || !value || value.length > 200) ||
      (cursor.runId && cursor.legacyId) || (cursor.messageId && !cursor.runId)) throw new UserFacingError(400, "CURSOR", "无效的历史位置");
  }
  let upper: number | null = null;
  if (cursor.runId) {
    const row = store.db.prepare("SELECT rowid FROM workspace_records WHERE kind='run' AND conversationId=? AND id=?").get(conversationId, cursor.runId) as { rowid: number } | undefined;
    if (!row) throw new UserFacingError(400, "CURSOR", "历史位置不属于此会话");
    upper = row.rowid;
  }
  const branch = activeEntryIds && new Set(activeEntryIds);
  const runs: Run[] = [];
  let remaining = limit;
  let next: string | null = null;
  let exhausted = !!cursor.legacyId;
  while (!exhausted && remaining) {
    const rows = store.db.prepare("SELECT rowid,data FROM workspace_records WHERE kind='run' AND conversationId=? AND (? IS NULL OR rowid<=?) ORDER BY rowid DESC LIMIT 64")
      .all(conversationId, upper, upper) as { rowid: number; data: string }[];
    exhausted = rows.length < 64;
    for (const row of rows) {
      upper = row.rowid - 1;
      const run: Run = JSON.parse(row.data);
      const live = ["queued", "running", "waiting"].includes(run.status);
      if (branch && run.inputEntryId && !branch.has(run.inputEntryId) && !live &&
        !run.parts.some((part) => part.entryId && branch.has(part.entryId))) continue;
      let end = run.parts.length;
      if (run.id === cursor.runId) {
        end = cursor.messageId ? run.parts.findIndex((part) => part.type === "message" && part.id === cursor.messageId) : 0;
        if (end < 0) throw new UserFacingError(409, "CURSOR_EXPIRED", "历史位置已变化，请重新打开会话");
        if (!end) continue;
      }
      const boundaries = [0, ...run.parts.flatMap((part, i) => i > 0 && i < end && part.type === "message" ? [i] : [])];
      const starts = boundaries.filter((index) => !branch || live || !run.parts[index]?.entryId || branch.has(run.parts[index].entryId!));
      if (!starts.length) continue;
      const start = starts[Math.max(0, starts.length - remaining)];
      const last = starts.at(-1)!;
      const finish = boundaries.find((index) => index > last) ?? end;
      const used = Math.min(remaining, starts.length);
      runs.unshift({ ...run, parts: run.parts.slice(start, finish), window: { start, end: finish } });
      remaining -= used;
      if (!remaining) {
        next = encode({ runId: run.id, ...(start > 0 ? { messageId: run.parts[start].id } : {}) });
        break;
      }
    }
  }
  let legacyMessages: ChatMessage[] = [];
  if (remaining) {
    const first = store.db.prepare("SELECT json_extract(data,'$.createdAt') AS createdAt FROM workspace_records WHERE kind='run' AND conversationId=? ORDER BY rowid LIMIT 1")
      .get(conversationId) as { createdAt: string } | undefined;
    const legacy = (await history()).filter((message) => !first || message.createdAt < first.createdAt);
    let end = cursor.legacyId ? legacy.findIndex((message) => message.id === cursor.legacyId) : legacy.length;
    if (end < 0) throw new UserFacingError(400, "CURSOR", "历史消息不存在");
    legacyMessages = legacy.slice(Math.max(0, end - remaining), end);
    if (end > remaining) next = encode({ legacyId: legacyMessages[0].id });
  }
  return { runs, legacyMessages, page: { before: next, hasMore: !!next } satisfies WorkspaceDetail["page"] };
}
