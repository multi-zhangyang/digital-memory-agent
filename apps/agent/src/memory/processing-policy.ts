import type { MemorySettings } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import { UserFacingError } from "../errors.js";

/** Model transport is shared, while each business purpose has its own configured choice. */
export function processingModel(config: AppConfig, settings: MemorySettings, purpose: "text" | "photo" | "video" | "dataset" | "dataset-review", fallbackId?: string) {
  const configured = purpose === "video" ? settings.videoModelId || settings.photoModelId : purpose === "photo" ? settings.photoModelId : purpose === "dataset" ? settings.datasetModelId : purpose === "dataset-review" ? settings.datasetReviewModelId : settings.textModelId;
  const supports = (provider: AppConfig["providers"][number]) => !["photo", "video"].includes(purpose) || provider.model.supportsImages;
  const provider = configured ? config.providers.find((item) => item.model.id === configured && supports(item))
    : config.providers.find((item) => item.model.id === fallbackId && supports(item)) || config.providers.find(supports);
  if (!provider) throw new UserFacingError(400, "PROCESSOR_UNAVAILABLE", purpose === "video" ? "请配置支持图片输入的视频处理模型" : purpose === "photo" ? "请配置支持图片输入的照片处理模型" : "请配置可用的处理模型");
  return provider;
}
