import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../../config.js";

/** Shared provider access for sessions and dedicated processors; owns no Agent state. */
export class ModelAccess {
  private pending?: Promise<ModelRuntime>;

  constructor(private readonly config: AppConfig) {}

  get(): Promise<ModelRuntime> {
    return this.pending ??= this.create();
  }

  private async create() {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    for (const provider of this.config.providers) {
      const providerId = "memory-" + provider.id;
      runtime.registerProvider(providerId, {
        api: provider.protocol,
        baseUrl: provider.baseUrl,
        models: [{
          id: provider.model.name,
          name: provider.model.name,
          reasoning: provider.model.reasoning,
          input: provider.model.supportsImages ? ["text", "image"] : ["text"],
          thinkingLevelMap: provider.model.reasoning ? {
            minimal: "minimal", low: "low", medium: "medium",
            high: "high", xhigh: "xhigh", max: "max",
          } : undefined,
          ...(provider.protocol === "openai-completions" ? {
            compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" as const },
          } : {}),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: provider.model.contextWindow,
          maxTokens: provider.model.maxTokens,
        }],
      });
      await runtime.setRuntimeApiKey(providerId, provider.apiKey);
    }
    return runtime;
  }
}
