import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionNode } from "@memory/contracts";

export function sessionTree(manager: SessionManager): SessionNode[] {
  const entries = manager.getEntries();
  const active = new Set(manager.getBranch().map((entry) => entry.id));
  const visible = (entry: SessionEntry) => entry.type === "message" || entry.type === "compaction" ||
    entry.type === "branch_summary" || (entry.type === "custom_message" && entry.display);
  const shown = new Set(entries.filter(visible).map((entry) => entry.id));
  return entries.filter(visible).map((entry) => {
    let parentId = entry.parentId;
    while (parentId && !shown.has(parentId)) parentId = manager.getEntry(parentId)?.parentId || null;
    const content = entry.type === "message" ? ("content" in entry.message ? entry.message.content : "output" in entry.message ? entry.message.output : "") : entry.type === "custom_message" ? entry.content
      : entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary : "";
    const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text]
      : part.type === "toolCall" ? [part.name] : []).join("\n");
    return { id: entry.id, parentId, kind: entry.type,
      role: entry.type === "message" ? entry.message.role : "system", text: text.slice(0, 2000),
      createdAt: entry.timestamp, active: active.has(entry.id) };
  });
}
