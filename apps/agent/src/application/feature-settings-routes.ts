import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import type { FeatureChannel, FeatureConnectionUpdate } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import { featureChannels, featureConnectionUpdate, publicFeatureSettings, readFeatureSettings, saveFeatureSettings, validatePolicy, type FeatureSettings } from "../feature-config.js";
import { configuredFeatureProcessor, HttpFeatureProcessor } from "../integrations/http-features.js";
import type { MemoryFeatureService } from "../memory/feature-service.js";
import { UserFacingError } from "../errors.js";

const connectionSchema = {
  params: { type: "object", properties: { channel: { enum: featureChannels } }, required: ["channel"], additionalProperties: false },
  body: { type: "object", additionalProperties: false,
    required: ["enabled", "protocol", "baseUrl", "modelName", "revision"],
    properties: { enabled: { type: "boolean" }, protocol: { enum: ["openai-embeddings", "memory-features-v1"] },
      baseUrl: { type: "string", maxLength: 2048 }, modelName: { type: "string", maxLength: 256 },
      revision: { type: "string", maxLength: 128 }, apiKey: { type: "string", maxLength: 4096 }, clearApiKey: { type: "boolean" } } },
};
type ConnectionRequest = { Params: { channel: FeatureChannel }; Body: FeatureConnectionUpdate };

export function registerFeatureSettingsRoutes(app: FastifyInstance, config: AppConfig, features: MemoryFeatureService) {
  config.featureModels ||= readFeatureSettings(config.dataDir);
  let saving = false;
  async function save(settings: FeatureSettings) {
    if (saving) throw new UserFacingError(409, "CONFIGURATION_BUSY", "正在应用配置，请稍后重试");
    saving = true;
    try {
      saveFeatureSettings(config.dataDir, settings);
      config.featureModels = settings;
      config.localProcessor = undefined;
      await features.reconfigure(configuredFeatureProcessor(settings));
      return publicFeatureSettings(settings);
    } finally { saving = false; }
  }
  app.get("/api/settings/features", async () => ({ ...publicFeatureSettings(config.featureModels!), status: features.status() }));
  app.post<ConnectionRequest>("/api/settings/features/:channel", { schema: connectionSchema }, async (request) =>
    save(featureConnectionUpdate(config.featureModels!, request.params.channel, request.body)));
  app.post<ConnectionRequest>("/api/settings/features/:channel/test", { schema: connectionSchema }, async (request) => {
    const channel = request.params.channel;
    const updated = featureConnectionUpdate(config.featureModels!, channel, { ...request.body, enabled: true });
    const settings: FeatureSettings = { ...updated, connections: { ...updated.connections } };
    for (const capability of featureChannels) settings.connections[capability] = { ...updated.connections[capability], enabled: capability === channel };
    const processor = new HttpFeatureProcessor(settings);
    try {
      const info = await processor.info();
      if (channel === "text") await processor.embed(["connection test"], "passage");
      else {
        const data = await sharp({ create: { width: 256, height: 256, channels: 3, background: "white" } }).jpeg().toBuffer();
        await processor.image(data, createHash("sha256").update(data).digest("hex"));
        if (channel === "image") await processor.embed(["connection test"], "query", "image_text");
      }
      return { ok: true, model: info.encoders[channel] };
    } finally { await processor.close(); }
  });
  app.post<{ Body: { faceMatchThreshold: number; faceMatchMargin: number } }>("/api/settings/features/policy", {
    schema: { body: { type: "object", additionalProperties: false, required: ["faceMatchThreshold", "faceMatchMargin"],
      properties: { faceMatchThreshold: { type: "number", minimum: 0, maximum: 1 }, faceMatchMargin: { type: "number", minimum: 0, maximum: 1 } } } },
  }, async (request) => {
    validatePolicy(request.body.faceMatchThreshold, request.body.faceMatchMargin);
    return save({ ...config.featureModels!, ...request.body });
  });
}
