import { backupMemory, restoreMemory } from "../src/memory-archive.js";
import { UserFacingError } from "../src/runtime.js";

const [action, source, destination] = process.argv.slice(2);
if (!source || !destination || !["backup", "restore"].includes(action)) {
  process.stderr.write("用法：archive-memory.ts backup <资料目录> <新备份目录> 或 restore <备份目录> <新恢复目录>\n");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await (action === "backup" ? backupMemory(source, destination) : restoreMemory(source, destination)), null, 2)); }
  catch (error) { process.stderr.write((error instanceof UserFacingError ? error.message : "备份或恢复未完成，请检查目录和文件是否可用") + "\n"); process.exitCode = 1; }
}
