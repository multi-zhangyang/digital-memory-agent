import type { AppConfig } from "../../config.js";
import { ModelAccess } from "./model-access.js";
import { UserFacingError } from "../../harness/runtime.js";
import { extractMemories, type ExtractionInput, type ExtractionResult } from "../../memory-extraction.js";
import { extractPhotoMemories, type PhotoExtractionInput, type PhotoExtractionResult } from "../../photo-extraction.js";
import { captureMemories, type CaptureInput, type CaptureResult } from "../../memory-capture-extraction.js";
import { generateDatasetQuestions, type DatasetQuestionInput, type DatasetQuestionResult } from "../../dataset-question-generation.js";
import { reviewDatasetSamples, type DatasetQualityInput } from "../../dataset-quality-review.js";

import type { MemoryProcessors } from "../../memory/processors.js";
export type { MemoryProcessors } from "../../memory/processors.js";

export class PiMemoryProcessors implements MemoryProcessors {
  constructor(private readonly config: AppConfig, private readonly models: ModelAccess) {}

  private provider(modelId: string) {
    const provider = this.config.providers.find((item) => item.model.id === modelId);
    if (!provider) throw new UserFacingError(400, "MODEL_UNAVAILABLE", "所选模型未配置，请检查模型设置");
    return provider;
  }

  hasModel(modelId: string) { return this.config.providers.some((item) => item.model.id === modelId); }

  async extractMemories(input: ExtractionInput, signal: AbortSignal) {
    return extractMemories(await this.models.get(), this.provider(input.modelId), input, signal);
  }

  async extractPhotoMemories(input: PhotoExtractionInput, signal: AbortSignal) {
    return extractPhotoMemories(await this.models.get(), this.provider(input.modelId), input, signal);
  }

  async captureMemories(input: CaptureInput, signal: AbortSignal) {
    return captureMemories(await this.models.get(), this.provider(input.modelId), input, signal);
  }

  async generateDatasetQuestions(input: DatasetQuestionInput, signal: AbortSignal) {
    return generateDatasetQuestions(await this.models.get(), this.provider(input.modelId), input, signal);
  }

  async reviewDatasetSamples(input: DatasetQualityInput, signal: AbortSignal) {
    return reviewDatasetSamples(await this.models.get(), this.provider(input.modelId), input, signal);
  }
}
