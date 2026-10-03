import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ConnectionSettings,
  ConnectionUpdate,
  ModelConfiguration,
  ModelInfo,
  ProviderId,
} from "@memory/contracts";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnv({ path: resolve(projectRoot, ".env"), quiet: true });

export interface StoredConnection extends ConnectionSettings {
  id: ProviderId;
  apiKey: string;
  supportsImages: boolean;
}
export interface ProviderConfig {
  id: ProviderId;
  model: ModelInfo;
  baseUrl: string;
  apiKey: string;
  protocol: ConnectionSettings["protocol"];
}
export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  uploadLimit: number;
  connections: StoredConnection[];
  providers: ProviderConfig[];
  publicModels: ModelConfiguration;
}
const definitions = [
  {
    id: "openai-compatible" as const,
    name: "OpenAI 兼容接口",
    prefix: "MEMORY_OPENAI",
    defaultUrl: "https://api.openai.com/v1",
    protocol: "openai-completions" as const,
  },
  {
    id: "anthropic" as const,
    name: "Anthropic",
    prefix: "MEMORY_ANTHROPIC",
    defaultUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages" as const,
  },
];

function validateConnection(connection: StoredConnection) {
  const url = new URL(connection.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入不含凭据和查询参数的 HTTP(S) 接口地址");
  if (
    !Number.isInteger(connection.contextWindow) ||
    connection.contextWindow < 8192 ||
    connection.contextWindow > 2000000
  )
    throw new Error("上下文长度须在 8192 到 2000000 之间");
  if (
    !Number.isInteger(connection.maxTokens) ||
    connection.maxTokens < 256 ||
    connection.maxTokens > 128000 ||
    connection.maxTokens >= connection.contextWindow
  )
    throw new Error("最大输出须小于上下文长度，且在 256 到 128000 之间");
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      connection.thinkingLevel,
    )
  )
    throw new Error("思考强度无效");
  if (
    !["anthropic-messages", "openai-completions", "openai-responses"].includes(
      connection.protocol,
    )
  )
    throw new Error("接口协议不匹配");
}

function modelsFrom(connections: StoredConnection[]) {
  const providers: ProviderConfig[] = [];
  const statuses: ModelConfiguration["providers"] = [];
  for (const connection of connections) {
    validateConnection(connection);
    const definition = definitions.find((item) => item.id === connection.id)!;
    const missing = [
      !connection.modelName && "模型名称",
      !connection.apiKey && "API key",
    ].filter(Boolean) as string[];
    const { apiKey, supportsImages, ...publicSettings } = connection;
    const configured = connection.enabled && missing.length === 0;
    statuses.push({
      ...publicSettings,
      name: definition?.name || connection.modelName || connection.id,
      configured,
      missing,
      hasApiKey: !!apiKey,
    });
    if (configured)
      providers.push({
        id: connection.id,
        baseUrl: connection.baseUrl,
        apiKey,
        protocol: connection.protocol,
        model: {
          id: connection.id + "/" + connection.modelName,
          name: connection.modelName,
          provider: connection.id,
          supportsImages,
          contextWindow: connection.contextWindow,
          maxTokens: connection.maxTokens,
          reasoning: connection.reasoning,
          thinkingLevel: connection.reasoning
            ? connection.thinkingLevel
            : "off",
        },
      });
  }
  return {
    providers,
    publicModels: {
      models: providers.map((provider) => provider.model),
      providers: statuses,
    },
  };
}

export function updateConnection(
  config: AppConfig,
  id: ProviderId,
  input: ConnectionUpdate,
) {
  const previous = config.connections.find(
    (connection) => connection.id === id,
  );

  const connection: StoredConnection = {
    supportsImages: false,
    ...previous,
    ...input,
    id,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    modelName: input.modelName.trim(),
    apiKey: input.apiKey?.trim() || previous?.apiKey || "",
  };
  const connections = previous
    ? config.connections.map((item) => (item.id === id ? connection : item))
    : [...config.connections, connection];
  const models = modelsFrom(connections);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const target = resolve(config.dataDir, "settings.json");
  const temporary = target + "." + randomUUID() + ".tmp";
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, connections }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  renameSync(temporary, target);
  Object.assign(config, { connections, ...models });
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(projectRoot, env.MEMORY_DATA_DIR || ".data");
  const settingsPath = resolve(dataDir, "settings.json");
  const saved = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as {
        version: number;
        connections: StoredConnection[];
      })
    : undefined;
  if (saved && (saved.version !== 1 || !Array.isArray(saved.connections)))
    throw new Error("模型配置文件格式无效");
  const connections: StoredConnection[] = definitions.map((definition) => ({
    id: definition.id,
    enabled: true,
    protocol: definition.protocol,
    baseUrl:
      env[definition.prefix + "_BASE_URL"]?.trim() || definition.defaultUrl,
    modelName: env[definition.prefix + "_MODEL"]?.trim() || "",
    apiKey: env[definition.prefix + "_API_KEY"]?.trim() || "",
    supportsImages: env[definition.prefix + "_VISION"] === "true",
    contextWindow: 32768,
    maxTokens: 4096,
    reasoning: false,
    thinkingLevel: "off",
    ...saved?.connections.find((connection) => connection.id === definition.id),
  }));
  for (const connection of saved?.connections || [])
    if (!connections.some((c) => c.id === connection.id))
      connections.push(connection);
  const port = Number(env.AGENT_PORT || 4310);
  const uploadLimit = Number(env.MEMORY_UPLOAD_LIMIT || 1024 ** 3);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AGENT_PORT 无效");
  if (!Number.isSafeInteger(uploadLimit) || uploadLimit < 1)
    throw new Error("MEMORY_UPLOAD_LIMIT 无效");
  return {
    dataDir,
    host: env.AGENT_HOST || "127.0.0.1",
    port,
    uploadLimit,
    connections,
    allowedOrigins: (
      env.MEMORY_ALLOWED_ORIGINS ||
      "http://localhost:3000,http://127.0.0.1:3000"
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    ...modelsFrom(connections),
  };
}
