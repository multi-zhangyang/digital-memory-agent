import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FeatureChannel, FeatureConnectionSettings, FeatureConnectionUpdate, FeatureModelConfiguration } from "@memory/contracts";
import { UserFacingError } from "./errors.js";

export type StoredFeatureConnection = FeatureConnectionSettings & { apiKey: string };
export interface FeatureSettings {
  connections: Record<FeatureChannel, StoredFeatureConnection>;
  faceMatchThreshold: number;
  faceMatchMargin: number;
}
export const featureChannels = ["text", "image", "face"] as const;
function invalid(message: string): never { throw new UserFacingError(400, "INVALID_FEATURE_CONFIGURATION", message); }

function validate(channel: FeatureChannel, value: StoredFeatureConnection) {
  if (typeof value.enabled !== "boolean" || !["openai-embeddings", "memory-features-v1"].includes(value.protocol) ||
    (channel !== "text" && value.protocol === "openai-embeddings")) invalid("所选协议不支持这项能力");
  if ([value.baseUrl, value.modelName, value.revision, value.apiKey].some((v) => typeof v !== "string") ||
    value.baseUrl.length > 2048 || value.modelName.length > 256 || value.revision.length > 128 || value.apiKey.length > 4096)
    invalid("模型连接字段无效");
  if (value.baseUrl) {
    let url: URL;
    try { url = new URL(value.baseUrl); } catch { invalid("请输入有效的 HTTP(S) 服务地址"); }
    if (!["http:", "https:"].includes(url!.protocol) || url!.username || url!.password || url!.search || url!.hash)
      invalid("服务地址不能包含凭据或查询参数");
  }
  if (value.enabled && (!value.baseUrl || !value.modelName || !value.revision)) invalid("启用前请填写服务地址、模型名称和版本标记");
}

export function readFeatureSettings(dataDir: string): FeatureSettings {
  const path = join(dataDir, "feature-models.json");
  const defaults: FeatureSettings = {
    connections: Object.fromEntries(featureChannels.map((channel) => [channel, { enabled: false,
      protocol: channel === "text" ? "openai-embeddings" : "memory-features-v1", baseUrl: "", modelName: "", revision: "1", apiKey: "" }])) as FeatureSettings["connections"],
    faceMatchThreshold: 0.5, faceMatchMargin: 0.1,
  };
  if (!existsSync(path)) return defaults;
  const saved = JSON.parse(readFileSync(path, "utf8"));
  if (saved.version !== 1 || !saved.connections) invalid("特征服务配置文件格式无效");
  for (const channel of featureChannels) {
    const value = saved.connections[channel];
    if (value) defaults.connections[channel] = { enabled: value.enabled, protocol: value.protocol, baseUrl: value.baseUrl,
      modelName: value.modelName, revision: value.revision, apiKey: value.apiKey || "" };
    validate(channel, defaults.connections[channel]);
  }
  defaults.faceMatchThreshold = saved.faceMatchThreshold;
  defaults.faceMatchMargin = saved.faceMatchMargin;
  validatePolicy(defaults.faceMatchThreshold, defaults.faceMatchMargin);
  return defaults;
}

export function publicFeatureSettings(settings: FeatureSettings): FeatureModelConfiguration {
  return { connections: Object.fromEntries(featureChannels.map((channel) => {
    const { apiKey, ...connection } = settings.connections[channel];
    return [channel, { ...connection, hasApiKey: !!apiKey }];
  })) as FeatureModelConfiguration["connections"], faceMatchThreshold: settings.faceMatchThreshold, faceMatchMargin: settings.faceMatchMargin };
}

export function featureConnectionUpdate(settings: FeatureSettings, channel: FeatureChannel, input: FeatureConnectionUpdate): FeatureSettings {
  const previous = settings.connections[channel];
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const connection: StoredFeatureConnection = { enabled: input.enabled, protocol: input.protocol, baseUrl,
    modelName: input.modelName.trim(), revision: input.revision.trim(),
    apiKey: input.clearApiKey ? "" : input.apiKey?.trim() || (previous.baseUrl === baseUrl ? previous.apiKey : "") };
  validate(channel, connection);
  return { ...settings, connections: { ...settings.connections, [channel]: connection } };
}

export function validatePolicy(threshold: number, margin: number) {
  if ([threshold, margin].some((n) => !Number.isFinite(n) || n < 0 || n > 1)) invalid("人物匹配阈值须在 0 到 1 之间");
}

export function saveFeatureSettings(dataDir: string, settings: FeatureSettings) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "feature-models.json"), temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify({ version: 1, ...settings }, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
