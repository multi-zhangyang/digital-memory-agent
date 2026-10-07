export interface FeatureInfo {
  protocol: 1;
  processorVersion: number;
  fingerprint: string;
  device: "cpu" | "cuda" | "remote";
  network: boolean;
  encoders: Partial<Record<"text" | "image" | "face", { id: string; revision: string; dimensions: number; fingerprint?: string }>>;
  sharedQueryEmbedding?: boolean;
}
export interface TextFeatures {
  vectors: number[][];
  truncated: (boolean | null)[];
  tokens: (number | null)[];
  fingerprint: string;
}
export interface ImageFeatures {
  vector: number[] | null;
  faces: { region: { x: number; y: number; width: number; height: number }; detectionScore: number;
    quality: "usable" | "small"; vector: number[] | null }[];
  width: number;
  height: number;
  coordinateSpace: "exif-oriented";
  metadata: { capturedLocal: string | null; offset: string | null; source: "EXIF" | null;
    certainty: "unverified" | "unknown"; hasGps: boolean };
  fingerprint: string;
  faceFingerprint?: string;
  facePolicy?: { matchThreshold: number; matchMargin: number };
}
export interface FeatureProcessor {
  info(signal?: AbortSignal): Promise<FeatureInfo>;
  embed(texts: string[], role: "query" | "passage", encoder?: "text" | "image_text", signal?: AbortSignal): Promise<TextFeatures>;
  image(data: Buffer, sha256: string, signal?: AbortSignal): Promise<ImageFeatures>;
  close(): Promise<void>;
}

export function encoderFingerprint(info: FeatureInfo, channel: "text" | "image" | "face") {
  return info.encoders[channel]?.fingerprint || info.fingerprint;
}
