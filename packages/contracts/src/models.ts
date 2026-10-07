export type ProviderId = string;

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface ConnectionSettings {
  enabled: boolean;
  baseUrl: string;
  modelName: string;
  protocol: ModelProtocol;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
  supportsImages?: boolean;
}

export interface ConnectionUpdate extends ConnectionSettings {
  apiKey?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  supportsImages: boolean;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
}

export interface ProviderStatus extends ConnectionSettings {
  id: ProviderId;
  name: string;
  configured: boolean;
  missing: string[];
  hasApiKey: boolean;
}

export interface ModelConfiguration {
  models: ModelInfo[];
  providers: ProviderStatus[];
}

export type FeatureChannel = "text" | "image" | "face";
export type FeatureProtocol = "openai-embeddings" | "memory-features-v1";
export interface FeatureConnectionSettings {
  enabled: boolean;
  protocol: FeatureProtocol;
  baseUrl: string;
  modelName: string;
  revision: string;
}
export interface FeatureConnectionUpdate extends FeatureConnectionSettings {
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface FeatureConnectionStatus extends FeatureConnectionSettings {
  hasApiKey: boolean;
}
export interface FeatureModelConfiguration {
  connections: Record<FeatureChannel, FeatureConnectionStatus>;
  faceMatchThreshold: number;
  faceMatchMargin: number;
}
