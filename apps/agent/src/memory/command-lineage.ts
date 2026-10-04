import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry } from "@memory/contracts";
import type { CommandReceipt } from "./commands.js";

/** User instructions remain separate from asset observations and follow the versions they changed. */
export function memoryCommandLineage(db: DatabaseSync, memory: Pick<MemoryEntry, "id" | "version">): CommandReceipt[] {
  return (db.prepare(`SELECT c.data FROM memory_command_versions v JOIN memory_commands c ON c.id=v.commandId
    WHERE v.recordId=? AND v.version<=? ORDER BY v.version,c.rowid`).all(memory.id, memory.version) as { data: string }[])
    .map((row) => JSON.parse(row.data) as CommandReceipt);
}
