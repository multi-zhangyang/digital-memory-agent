import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Asset } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { UserFacingError } from "../errors.js";

const verified = new Map<string, string>();

/** Bounded UTF-8 pages after verification of the complete original, including large text files. */
export async function readTextPage(data: Pick<MemoryData, "assetsDir">, asset: Asset,
  options: { offset?: number; limit?: number; signal?: AbortSignal } = {}) {
  const start = options.offset ?? 0, limit = options.limit ?? 6000;
  if (!Number.isSafeInteger(start) || start < 0 || start > asset.size)
    throw new UserFacingError(400, "INVALID_OFFSET", "读取位置超出原件范围");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24000)
    throw new UserFacingError(400, "INVALID_LIMIT", "读取长度须为 1 至 24000 字节");
  options.signal?.throwIfAborted();
  const path = join(data.assetsDir, asset.id), key = path + ":" + asset.sha256;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      const stamp = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (!before.isFile() || before.size !== asset.size)
        throw new UserFacingError(409, "SOURCE_CHANGED", "原件已经改变");
      if (verified.get(key) !== stamp(before)) {
        const hash = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
          options.signal?.throwIfAborted(); hash.update(chunk);
        }
        if (hash.digest("hex") !== asset.sha256)
          throw new UserFacingError(409, "SOURCE_CHANGED", "原件校验不一致");
      }
      const buffer = Buffer.alloc(Math.min(limit + 4, asset.size - start));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      options.signal?.throwIfAborted();
      if (bytesRead < Math.min(limit, asset.size - start) || stamp(before) !== stamp(await file.stat()))
        throw new UserFacingError(409, "SOURCE_CHANGED", "原件在读取期间发生改变");
      if (bytesRead && (buffer[0] & 0xc0) === 0x80)
        throw new UserFacingError(400, "INVALID_OFFSET", "读取位置必须在 UTF-8 字符边界");
      let length = Math.min(limit, bytesRead);
      while (length > 0 && length < bytesRead && (buffer[length] & 0xc0) === 0x80) length--;
      if (!length && start < asset.size)
        throw new UserFacingError(400, "INVALID_LIMIT", "读取长度不足一个字符");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { throw new UserFacingError(400, "INVALID_TEXT", "证据不是有效的 UTF-8 文字"); }
      verified.set(key, stamp(before));
      if (verified.size > 256) verified.delete(verified.keys().next().value!);
      const end = start + length;
      return { start, end, text, nextOffset: end < asset.size ? end : null };
    } finally { await file.close(); }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError(409, "SOURCE_UNAVAILABLE", "原件不可用，请核对素材后重试");
  }
}
