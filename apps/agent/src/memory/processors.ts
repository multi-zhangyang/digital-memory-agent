import type { ExtractionInput, ExtractionResult } from "../memory-extraction.js";
import type { PhotoExtractionInput, PhotoExtractionResult } from "../photo-extraction.js";
import type { CaptureInput, CaptureResult } from "../memory-capture-extraction.js";
import type { DatasetQuestionInput, DatasetQuestionResult } from "../dataset-question-generation.js";
import type { DatasetQualityInput, DatasetQualityResult } from "../dataset-quality-review.js";

/** A dedicated model capability may be unavailable; workers report that explicitly. */
export interface MemoryProcessors {
  extractMemories?(input: ExtractionInput, signal: AbortSignal): Promise<ExtractionResult>;
  extractPhotoMemories?(input: PhotoExtractionInput, signal: AbortSignal): Promise<PhotoExtractionResult>;
  captureMemories?(input: CaptureInput, signal: AbortSignal): Promise<CaptureResult>;
  generateDatasetQuestions?(input: DatasetQuestionInput, signal: AbortSignal): Promise<DatasetQuestionResult>;
  reviewDatasetSamples?(input: DatasetQualityInput, signal: AbortSignal): Promise<DatasetQualityResult>;
  hasModel?(modelId: string): boolean;
}
