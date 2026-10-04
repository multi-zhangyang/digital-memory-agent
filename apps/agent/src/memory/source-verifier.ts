import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryEvidence, Run } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { contentHash, evidenceOf } from "./values.js";
import { UserFacingError } from "../errors.js";
import { memoryCommandLineage } from "./command-lineage.js";

export class SourceVerificationError extends UserFacingError {
  constructor(readonly kind: "asset" | "memory", readonly parentId: string) {
    super(409, "SOURCE_CHANGED", "来源不可用或与冻结版本不一致");
  }
}

/** Verifies bytes, not model agreement. Cache entries are bound to file identity and change time. */
export class MemorySourceVerifier {
  private readonly hashes = new Map<string, string>();
  constructor(private readonly store: MemoryData) {}

  async verify(memory: MemoryEntry, signal?: AbortSignal) {
    const instructions = memoryCommandLineage(this.store.db, memory).flatMap((command) => command.instruction ? [command.instruction] : []);
    for (const source of [...evidenceOf(memory), ...instructions]) {
      signal?.throwIfAborted();
      if (source.type === "message") {
        const run = this.store.memories.get<Run>("run", source.runId);
        const text = run && run.conversationId === source.conversationId && (source.messageId === run.id ? run.text
          : source.messageId === run.id + ":answer" ? run.question?.answer : run.interventions?.find((item) => item.id === source.messageId)?.text);
        const bytes = typeof text === "string" ? Buffer.from(text) : undefined;
        if (!bytes || contentHash(bytes) !== source.sha256 || !this.range(source, bytes.length)
          || bytes.subarray(source.start, source.end).toString("utf8") !== source.quote)
          throw new SourceVerificationError("memory", memory.id);
        continue;
      }
      const asset = this.store.asset(source.assetId);
      if (!asset || asset.sha256 !== source.sha256 || (asset.memorySpace || "personal") !== (memory.space || "personal")
        || this.store.memories.ledger.sourceBlocked(source.sha256) || !this.range(source, asset.size))
        throw new SourceVerificationError("asset", source.assetId);
      try {
        const file = await open(join(this.store.assetsDir, asset.id), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const key = asset.id + ":" + source.sha256;
          if (!stat.isFile() || stat.size !== asset.size) throw new Error();
          if (this.hashes.get(key) !== stamp) {
            const hash = createHash("sha256");
            for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
              signal?.throwIfAborted(); hash.update(chunk);
            }
            if (hash.digest("hex") !== source.sha256) throw new Error();
          }
          if (asset.kind === "text" && source.quote !== undefined) {
            if (source.end - source.start > 2 * 1024 * 1024) throw new Error();
            const buffer = Buffer.alloc(source.end - source.start);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, source.start);
            if (bytesRead !== buffer.length || buffer.toString("utf8") !== source.quote) throw new Error();
          }
          const after = await file.stat();
          if (stamp !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`) throw new Error();
          this.hashes.set(key, stamp);
          if (this.hashes.size > 512) this.hashes.delete(this.hashes.keys().next().value!);
        } finally { await file.close(); }
      } catch { signal?.throwIfAborted(); throw new SourceVerificationError("asset", source.assetId); }
    }
  }
  private range(source: MemoryEvidence, bytes: number) {
    return Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) && source.start >= 0 && source.end > source.start && source.end <= bytes;
  }
}
