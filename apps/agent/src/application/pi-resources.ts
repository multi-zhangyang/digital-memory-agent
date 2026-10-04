import { join } from "node:path";
import {
  createMcpExtension,
  createSyntheticSourceInfo,
  createToolSearchExtension,
  type ExtensionUIContext,
  type Skill,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.js";
import { permissionExtension, requestApproval } from "../permissions.js";
import {
  safePath,
  writeProjectFile,
  readProjectFile,
} from "../project-files.js";
import { sandboxArguments } from "../sandbox.js";
import { digitalMemoryProfile } from "../harness/product-profile.js";
export async function prepareResources(
  store: Store,
  conversationId: string,
  statuses: Record<string, string>,
) {
  const project = store.harness.project(
    store.harness.association(conversationId).projectId,
  );
  const root = store.harness.root(project.id);
  const privatePaths = store.harness.excludedPaths(project.id);
  const skills: Skill[] = [],
    prompts: PromptTemplate[] = [],
    agentsFiles: Array<{ path: string; content: string }> = [];
  try {
    const content = (
      await readProjectFile(root, "AGENTS.md", 20000, privatePaths)
    ).toString("utf8");
    agentsFiles.push({ path: join(root, "AGENTS.md"), content });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const productResources = digitalMemoryProfile.tasks.flatMap((task) => [
    { ...task, kind: "skill" as const, enabled: true,
      content: `---\nname: ${task.name}\ndescription: ${task.description}\n---\n\n${task.content}\n\n产品规则版本：${digitalMemoryProfile.version}\n` },
    { ...task, kind: "prompt" as const, enabled: true },
  ]);
  const configuredResources = store.harness.settings.resources;
  for (const resource of [...productResources.filter((builtIn) =>
    !configuredResources.some((custom) => custom.name === builtIn.name && custom.kind === builtIn.kind)), ...configuredResources].filter(
    (r) => r.enabled,
  )) {
    const filePath = join(
      root,
      ".digital-memory",
      resource.kind === "skill" ? "skills" : "prompts",
      resource.name,
      resource.kind === "skill" ? "SKILL.md" : "prompt.md",
    );
    await safePath(root, filePath, true, privatePaths);
    await writeProjectFile(root, filePath, resource.content, privatePaths);
    const sourceInfo = createSyntheticSourceInfo(filePath, {
      source: "digital-memory",
      scope: "project",
    });
    if (resource.kind === "skill")
      skills.push({
        name: resource.name,
        description: resource.description,
        filePath,
        baseDir: join(filePath, ".."),
        sourceInfo,
        disableModelInvocation: false,
      });
    else
      prompts.push({
        name: resource.name,
        description: resource.description,
        content: resource.content,
        filePath,
        sourceInfo,
      });
  }
  const setStatus = (key: string, value?: string) => {
    if (value) statuses[key] = value;
    else delete statuses[key];
  };
  const ui = new Proxy(
    {
      select: async (title: string, options: string[]) => {
        const a = await requestApproval(store, conversationId, {
          title,
          detail: "",
          kind: "select",
          options,
        });
        return a.status === "approved" ? a.answer : undefined;
      },
      confirm: async (title: string, detail: string) =>
        (
          await requestApproval(store, conversationId, {
            title,
            detail,
            kind: "confirm",
            options: [],
          })
        ).status === "approved",
      input: async (title: string, placeholder?: string) => {
        const a = await requestApproval(store, conversationId, {
          title,
          detail: placeholder || "",
          kind: "input",
          options: [],
        });
        return a.status === "approved" ? a.answer : undefined;
      },
      editor: async (title: string, prefill?: string) => {
        const a = await requestApproval(store, conversationId, {
          title,
          detail: prefill || "",
          kind: "input",
          options: [],
        });
        return a.status === "approved" ? a.answer : undefined;
      },
      notify: (message: string) => setStatus("notification", message),
      setStatus,
      custom: async () => {
        throw new Error("此扩展使用终端专属界面，请通过 Web 设置管理 MCP");
      },
      getEditorText: () => "",
      getAllThemes: () => [],
      getToolsExpanded: () => false,
      setTheme: () => ({ success: false, error: "主题由 WebUI 管理" }),
      onTerminalInput: () => () => {},
    },
    {
      get(target, key) {
        return key in target ? target[key as keyof typeof target] : () => {};
      },
    },
  ) as unknown as ExtensionUIContext;
  const mcp = createMcpExtension({
    loadConfig: () => ({
      errors: [],
      autoEnableCodemode: false,
      servers: store.harness.settings.mcp.map((server) => ({
        name: server.name,
        source: join(store.harness.dataDir, "harness.json"),
        scope: "global" as const,
        config:
          server.transport === "http"
            ? {
                type: "http" as const,
                url: server.url,
                headers: server.headers,
                enabled: server.enabled,
                exposure: "direct" as const,
                timeout: 60,
              }
            : {
                type: "stdio" as const,
                command: "bwrap",
                args: sandboxArguments(
                  root,
                  [
                    ...Object.entries(server.env || {}).flatMap(([k, v]) => [
                      "--setenv",
                      k,
                      v,
                    ]),
                    "--",
                    server.command,
                    ...server.args,
                  ],
                  project.network,
                  true,
                  privatePaths,
                ),
                cwd: root,
                enabled: server.enabled,
                exposure: "direct" as const,
                timeout: 60,
              },
      })),
    }),
    logPath: join(store.harness.dataDir, "mcp.log"),
    openUrl: () =>
      setStatus("mcp-auth", "此连接需要 OAuth；请使用支持静态认证的 MCP 连接"),
    updateConfig: () => {
      throw new Error("请通过 Web 设置修改 MCP 连接");
    },
  });
  return {
    skills,
    prompts,
    agentsFiles,
    ui,
    extensions: [
      permissionExtension(store, conversationId),
      createToolSearchExtension(),
      mcp,
    ],
  };
}
