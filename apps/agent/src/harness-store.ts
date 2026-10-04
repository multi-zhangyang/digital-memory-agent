import type { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentApproval,
  AgentResource,
  Project,
  McpConnection,
  HarnessSettings,
} from "@memory/contracts";
import { sandboxAvailable } from "./sandbox.js";
import { projectRoot } from "./config.js";
import {
  assertProjectDirectory,
  isWithin,
  requireExistingDirectory,
  resolveDirectory,
} from "./local-directories.js";

import { UserFacingError } from "./harness/runtime.js";

export interface PrivateHarnessSettings {
  searchEnabled: boolean;
  searchKey: string;
  resources: AgentResource[];
  mcp: Array<
    McpConnection & {
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  >;
  autoCompaction: boolean;
  retry: boolean;
}
export class HarnessStore {
  settings: PrivateHarnessSettings;
  readonly projectsDir: string;
  readonly privatePaths: string[];
  constructor(
    readonly dataDir: string,
    private readonly db: DatabaseSync,
  ) {
    this.projectsDir = join(dataDir, "projects");
    mkdirSync(this.projectsDir, { recursive: true, mode: 0o700 });
    this.privatePaths = [
      ...new Set(
        [dataDir, join(projectRoot, ".data"), join(projectRoot, ".env")].map(
          (path) => (existsSync(path) ? realpathSync(path) : resolve(path)),
        ),
      ),
    ];
    db.exec(
      "CREATE TABLE IF NOT EXISTS harness_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversation_projects (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, parentId TEXT);",
    );
    const path = join(dataDir, "harness.json");
    this.settings = {
      searchEnabled: false,
      searchKey: "",
      resources: [],
      mcp: [],
      autoCompaction: true,
      retry: false,
      ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}),
    };
    if (!this.get<Project>("project", "default"))
      this.save("project", {
        id: "default",
        name: "个人工作区",
        instructions: "",
        permissionMode: "auto",
        disabledTools: [],
        network: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    for (const project of this.list<Project>("project")) {
      if (project.directory) continue;
      const root = this.managedRoot(project.id);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.save("project", {
        ...project,
        directory: realpathSync(root),
        directoryKind: "managed",
      });
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM harness_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM harness_records WHERE kind=? ORDER BY rowid")
        .all(kind) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  save<T extends { id: string }>(kind: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO harness_records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, kind, JSON.stringify(value));
    return value;
  }
  project(id = "default") {
    const project = this.get<Project>("project", id);
    if (!project)
      throw new UserFacingError(404, "PROJECT_NOT_FOUND", "项目不存在");
    let available = true;
    try {
      this.validateDirectory(project);
    } catch {
      available = false;
    }
    return { ...project, available };
  }
  projects() {
    return this.list<Project>("project").map((project) =>
      this.project(project.id),
    );
  }
  private managedRoot(id: string) {
    return id === "default"
      ? join(this.dataDir, "workspace")
      : join(this.projectsDir, id, "workspace");
  }
  private validateDirectory(project: Project) {
    const root = requireExistingDirectory(project.directory);
    if (project.directoryKind === "local")
      assertProjectDirectory(root, this.privatePaths);
    return root;
  }
  root(id = "default") {
    return this.validateDirectory(this.project(id));
  }
  excludedPaths(id = "default") {
    const root = this.project(id).directory;
    return this.privatePaths.filter((path) => isWithin(root, path));
  }
  createProject(name: string) {
    name = name.trim();
    if (!name)
      throw new UserFacingError(400, "PROJECT_NAME_REQUIRED", "请输入项目名称");
    const now = new Date().toISOString();
    const id = randomUUID();
    const directory = this.managedRoot(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const project = this.save("project", {
      id,
      name,
      directory: realpathSync(directory),
      directoryKind: "managed" as const,
      instructions: "",
      permissionMode: "auto" as const,
      disabledTools: [],
      network: false,
      createdAt: now,
      updatedAt: now,
    });
    return this.project(project.id);
  }
  async openProject(path: string) {
    const directory = await resolveDirectory(path);
    const existing = this.projects().find(
      (project) => project.directory === directory,
    );
    if (existing) {
      this.root(existing.id);
      return { project: existing, created: false };
    }
    assertProjectDirectory(directory, this.privatePaths);
    const now = new Date().toISOString();
    const project = this.save("project", {
      id: randomUUID(),
      name: basename(directory).slice(0, 100),
      directory,
      directoryKind: "local" as const,
      instructions: "",
      permissionMode: "auto" as const,
      disabledTools: [],
      network: false,
      createdAt: now,
      updatedAt: now,
    });
    return { project: this.project(project.id), created: true };
  }
  link(conversationId: string, projectId: string, parentId?: string) {
    this.project(projectId);
    this.db
      .prepare(
        "INSERT INTO conversation_projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET projectId=excluded.projectId,parentId=excluded.parentId",
      )
      .run(conversationId, projectId, parentId || null);
  }
  association(id: string) {
    return (
      (this.db
        .prepare(
          "SELECT projectId,parentId FROM conversation_projects WHERE id=?",
        )
        .get(id) as
        | { projectId: string; parentId: string | null }
        | undefined) || {
        projectId: "default",
        parentId: null,
      }
    );
  }
  saveSettings(patch: Partial<PrivateHarnessSettings>) {
    const settings = { ...this.settings, ...patch };
    const path = join(this.dataDir, "harness.json"),
      tmp = path + "." + randomUUID();
    writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    this.settings = settings;
  }
  publicSettings(): HarnessSettings {
    const s = this.settings;
    return {
      search: { enabled: s.searchEnabled, configured: !!s.searchKey },
      resources: s.resources,
      mcp: s.mcp.map(({ headers, env, ...server }) => ({
        ...server,
        hasSecrets: !!(
          Object.keys(headers || {}).length || Object.keys(env || {}).length
        ),
      })),
      autoCompaction: s.autoCompaction,
      retry: s.retry,
      sandbox: { available: sandboxAvailable(), kind: "bubblewrap" },
    };
  }
  approvals(runId?: string) {
    return this.list<AgentApproval>("approval").filter(
      (item) => !runId || item.runId === runId,
    );
  }
}
