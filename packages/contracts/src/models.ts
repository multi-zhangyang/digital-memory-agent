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
