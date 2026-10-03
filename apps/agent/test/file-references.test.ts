import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  fileReferenceContext,
  validateFileReferences,
} from "../src/file-references.js";
import { changesSince, snapshot } from "../src/project-files.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reference-boundary-"));
  const store = new Store(join(directory, "private"));
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { project } = await store.harness.openProject(directory);
  return { store, project, directory };
}

it("caps combined selected file content and excludes private application data inside the project root", async () => {
  const { store, project, directory } = await fixture();
  const refs = Array.from({ length: 6 }, (_, index) => ({
    path: `file-${index}.txt`,
  }));
  for (const ref of refs)
    await writeFile(
      join(directory, ref.path),
      "X".repeat(14000) + "UNREAD_TAIL",
    );
  const context = await fileReferenceContext(store, project.id, refs);
  const characters = context.reduce(
    (count, item) =>
      count +
      ("content" in item && typeof item.content === "string"
        ? item.content.length
        : 0),
    0,
  );
  expect(characters).toBeLessThanOrEqual(48000);
  expect(context).toHaveLength(6);
  expect(JSON.stringify(context)).not.toContain("UNREAD_TAIL");
  await writeFile(join(directory, "private", "secret.txt"), "PRIVATE_APP_DATA");
  await expect(
    validateFileReferences(store, project.id, [{ path: "private/secret.txt" }]),
  ).rejects.toMatchObject({ code: "PRIVATE_PATH" });
});

it("retains the original content of a deleted file when a historical change is referenced", async () => {
  const { store, project, directory } = await fixture();
  const conversation = store.createConversation();
  store.harness.link(conversation.id, project.id);
  await writeFile(join(directory, "deleted.md"), "This was the original file.");
  const checkpoint = join(directory, "private", "checkpoints", "reference");
  await snapshot(
    directory,
    checkpoint,
    store.harness.excludedPaths(project.id),
  );
  await rm(join(directory, "deleted.md"));
  const run = store.work.createRun(conversation.id, {
    text: "Delete file",
    modelId: "test",
  });
  store.work.patchRun(run.id, {
    changes: await changesSince(
      directory,
      checkpoint,
      store.harness.excludedPaths(project.id),
    ),
    status: "completed",
  });
  const context = await fileReferenceContext(store, project.id, [
    { path: "deleted.md", runId: run.id },
  ]);
  expect(context).toMatchObject([
    {
      path: "deleted.md",
      version: "historical",
      status: "deleted",
      before: {
        content: { text: "This was the original file.", truncated: false },
      },
      after: null,
    },
  ]);
});
