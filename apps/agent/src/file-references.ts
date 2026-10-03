import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { relative } from "node:path";
import type { FileChange, ProjectFileReference, Run } from "@memory/contracts";
import type { Store } from "./store.js";
import { safePath } from "./project-files.js";
import { UserFacingError } from "./runtime.js";

const fileLimit = 12000;
const contextLimit = 48000;

function historicalChange(
  store: Store,
  projectId: string,
  ref: ProjectFileReference,
): FileChange {
  const run = store.work.get<Run>("run", ref.runId!);
  const conversation = run && store.conversation(run.conversationId);
  const change = run?.changes?.find((item) => item.path === ref.path);
  if (
    !conversation ||
    store.harness.association(conversation.id).projectId !== projectId ||
    !change
  )
    throw new UserFacingError(
      400,
      "INVALID_FILE_REFERENCE",
      "文件改动不属于当前项目，请重新选择",
    );
  return change;
}

export async function validateFileReferences(
  store: Store,
  projectId: string,
  references: ProjectFileReference[],
) {
  const root = store.harness.root(projectId);
  const excluded = store.harness.excludedPaths(projectId);
  const result: ProjectFileReference[] = [];
  for (const ref of references) {
    const target = await safePath(root, ref.path, !!ref.runId, excluded).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new UserFacingError(
            404,
            "FILE_REFERENCE_MISSING",
            "引用文件已不存在，请重新选择",
          );
        throw error;
      },
    );
    const value = {
      path: relative(root, target),
      ...(ref.runId ? { runId: ref.runId } : {}),
    };
    if (ref.runId) historicalChange(store, projectId, value);
    else if (!(await lstat(target)).isFile())
      throw new UserFacingError(
        400,
        "INVALID_FILE_REFERENCE",
        "请选择项目中的文件",
      );
    if (
      !result.some(
        (item) => item.path === value.path && item.runId === value.runId,
      )
    )
      result.push(value);
  }
  return result;
}

export async function fileReferenceContext(
  store: Store,
  projectId: string,
  references: ProjectFileReference[],
) {
  const refs = await validateFileReferences(store, projectId, references);
  let remaining = contextLimit;
  const excerpt = (content: string | null) => {
    if (content === null) return null;
    const text = content.slice(0, Math.min(fileLimit, remaining));
    remaining -= text.length;
    return { text, truncated: text.length < content.length };
  };
  const root = store.harness.root(projectId);
  const result = [];
  for (const ref of refs) {
    if (ref.runId) {
      const change = historicalChange(store, projectId, ref);
      result.push({
        ...ref,
        version: "historical",
        status: change.status,
        before: change.before && {
          hash: change.before.hash,
          content: excerpt(change.before.content),
        },
        after: change.after && {
          hash: change.after.hash,
          content: excerpt(change.after.content),
        },
      });
      continue;
    }
    const target = await safePath(
      root,
      ref.path,
      false,
      store.harness.excludedPaths(projectId),
    );
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile())
        throw new UserFacingError(
          400,
          "INVALID_FILE_REFERENCE",
          "请选择项目中的文件",
        );
      const buffer = Buffer.alloc(Math.min(info.size, fileLimit, remaining));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const binary = bytes.includes(0);
      const text = binary
        ? null
        : new TextDecoder().decode(bytes, { stream: bytesRead < info.size });
      remaining -= bytesRead;
      result.push({
        ...ref,
        version: "current",
        size: info.size,
        binary,
        content: text,
        truncated: bytesRead < info.size,
      });
    } finally {
      await file.close();
    }
  }
  return result;
}
