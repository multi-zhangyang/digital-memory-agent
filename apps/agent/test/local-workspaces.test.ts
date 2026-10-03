import { afterEach, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectoryListing, Project } from "@memory/contracts";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { executeSandbox } from "../src/sandbox.js";
import { snapshot } from "../src/project-files.js";
import { normalizeDirectoryInput } from "../src/local-directories.js";

const cleaners: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleaners.splice(0).reverse()) await clean();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workspace-folders-"));
  cleaners.push(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "private");
  const config = readConfig({ MEMORY_DATA_DIR: dataDir });
  const app = buildApp(config);
  await app.ready();
  cleaners.push(() => app.close());
  const open = (path: string) =>
    app.inject({
      method: "POST",
      url: "/api/projects/open",
      payload: { path },
    });
  return { directory, dataDir, app, open };
}

it("browses only directories, filters and paginates hidden entries, and normalizes local paths", async () => {
  const f = await fixture();
  const root = join(f.directory, "folders");
  await mkdir(root);
  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      mkdir(join(root, "folder-" + String(index).padStart(3, "0"))),
    ),
  );
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "visible.txt"), "file");
  const browse = async (extra: Record<string, string> = {}) => {
    const response = await f.app.inject(
      "/api/directories?" + new URLSearchParams({ path: root, ...extra }),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<DirectoryListing>();
  };
  const first = await browse();
  expect(first.path).toBe(root);
  expect(first.parent).toBe(f.directory);
  expect(first.entries).toHaveLength(100);
  expect(first.total).toBe(105);
  expect(first.nextOffset).toBe(100);
  const second = await browse({ offset: "100" });
  expect(second.entries).toHaveLength(5);
  expect(second.nextOffset).toBeNull();
  expect(
    (await browse({ query: "FOLDER-104" })).entries.map((entry) => entry.name),
  ).toEqual(["folder-104"]);
  expect(
    (await browse({ hidden: "true", query: "hidden" })).entries.map(
      (entry) => entry.name,
    ),
  ).toEqual([".hidden"]);
  expect(normalizeDirectoryInput("~/Documents")).toBe(
    join(homedir(), "Documents"),
  );
  if (process.platform === "linux" && /microsoft/i.test(release()))
    expect(normalizeDirectoryInput('"C:\\Users\\Example\\My Project"')).toBe(
      "/mnt/c/Users/Example/My Project",
    );
});

it("opens the canonical existing directory only once and writes to the original without copying it", async () => {
  const f = await fixture();
  const root = join(f.directory, "原始 项目");
  await mkdir(root);
  await writeFile(join(root, "notes.md"), "original");
  const opened = await f.open(root);
  expect(opened.statusCode, opened.body).toBe(201);
  const { project } = opened.json<{ project: Project }>();
  expect(project).toMatchObject({
    name: "原始 项目",
    directory: root,
    directoryKind: "local",
    available: true,
  });
  const alias = join(f.directory, "alias");
  await symlink(root, alias);
  const repeated = await f.open(alias + "/../alias/");
  expect(repeated.statusCode, repeated.body).toBe(200);
  expect(repeated.json().project.id).toBe(project.id);
  const listing = (await f.app.inject("/api/projects")).json().projects;
  expect(listing).toHaveLength(2);
  const fileResponse = await f.app.inject(
    `/api/projects/${project.id}/file?path=notes.md`,
  );
  const file = fileResponse.json();
  expect(file.content).toBe("original");
  const updated = await f.app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}/file`,
    payload: { path: "notes.md", content: "updated", hash: file.hash },
  });
  expect(updated.statusCode, updated.body).toBe(200);
  expect(await readFile(join(root, "notes.md"), "utf8")).toBe("updated");
  await expect(
    access(join(f.dataDir, "projects", project.id)),
  ).rejects.toThrow();
  const ignoredChange = await f.app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}`,
    payload: { directory: f.directory },
  });
  expect(ignoredChange.json().project?.directory || project.directory).toBe(
    root,
  );
});

it("keeps application data outside file tools, snapshots and the sandbox even when its parent is opened", async () => {
  const f = await fixture();
  await writeFile(join(f.dataDir, "credential.txt"), "PRIVATE_TEST_SENTINEL");
  await writeFile(join(f.directory, "project.txt"), "public project file");
  const opened = await f.open(f.directory);
  expect(opened.statusCode, opened.body).toBe(201);
  const project = opened.json().project;
  const files = (await f.app.inject(`/api/projects/${project.id}/files`)).json()
    .files;
  expect(files.map((file: any) => file.path)).toEqual(["project.txt"]);
  const blocked = await f.app.inject(
    `/api/projects/${project.id}/file?path=private/credential.txt`,
  );
  expect(blocked.statusCode).toBe(403);
  const blockedWrite = await f.app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}/file`,
    payload: {
      path: "private/credential.txt",
      content: "replacement",
      hash: null,
    },
  });
  expect(blockedWrite.statusCode).toBe(403);
  const checkpoint = join(f.dataDir, "checkpoint-test");
  const revisions = await snapshot(f.directory, checkpoint, [f.dataDir]);
  expect(Object.keys(revisions)).toEqual(["project.txt"]);
  let output = "";
  const run = await executeSandbox(
    f.directory,
    "cat private/credential.txt; test ! -e private/credential.txt && printf PRIVATE_HIDDEN; cat project.txt",
    (chunk) => {
      output += chunk.toString();
    },
    undefined,
    10,
    false,
    [f.dataDir],
  );
  expect(run.exitCode, output).toBe(0);
  expect(output).toContain("PRIVATE_HIDDEN");
  expect(output).toContain("public project file");
  expect(output).not.toContain("PRIVATE_TEST_SENTINEL");
  expect(await readFile(join(f.dataDir, "credential.txt"), "utf8")).toBe(
    "PRIVATE_TEST_SENTINEL",
  );
  expect((await f.open(f.dataDir)).statusCode).toBe(403);
  expect((await f.open("/etc")).statusCode).toBe(403);
  expect((await f.open("/")).statusCode).toBe(400);
  expect(
    (
      await f.app.inject(
        "/api/directories?" + new URLSearchParams({ path: f.dataDir }),
      )
    ).statusCode,
  ).toBe(403);
});

it("reports missing or replaced directories without recreating them and preserves old managed projects", async () => {
  const f = await fixture();
  const root = join(f.directory, "external");
  await mkdir(root);
  const project = (await f.open(root)).json().project;
  const moved = root + "-moved";
  await rename(root, moved);
  expect(
    (await f.app.inject(`/api/projects/${project.id}/files`)).statusCode,
  ).toBe(404);
  await expect(access(root)).rejects.toThrow();
  expect(
    (await f.app.inject("/api/projects"))
      .json()
      .projects.find((p: Project) => p.id === project.id).available,
  ).toBe(false);
  await symlink(moved, root);
  expect(
    (await f.app.inject(`/api/projects/${project.id}/files`)).statusCode,
  ).toBe(409);
  expect((await f.open("./relative")).statusCode).toBe(400);
  expect((await f.open(join(f.directory, "missing"))).statusCode).toBe(404);
  await writeFile(join(f.directory, "ordinary-file"), "data");
  expect((await f.open(join(f.directory, "ordinary-file"))).statusCode).toBe(
    400,
  );

  await f.app.close();
  const old = new Store(f.dataDir);
  const legacy = old.harness.project("default");
  const { directory, directoryKind, available, ...record } = legacy;
  old.harness.save("project", record);
  await writeFile(join(directory, "keep.txt"), "keep");
  old.close();
  const migrated = new Store(f.dataDir);
  expect(migrated.harness.project("default")).toMatchObject({
    directory,
    directoryKind: "managed",
    available: true,
  });
  expect(
    await readFile(join(migrated.harness.root(), "keep.txt"), "utf8"),
  ).toBe("keep");
  migrated.close();
});
