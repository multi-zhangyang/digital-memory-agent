import type { MemorySpace } from "./memory.js";

export type AssetKind = "image" | "video" | "text" | "file";

/** Coordinates on the complete, EXIF-oriented original, before any resize. */
export interface ImageRegion { x: number; y: number; width: number; height: number }
export interface ImageView {
  sourceWidth: number;
  sourceHeight: number;
  region?: ImageRegion;
  pixels: { left: number; top: number; width: number; height: number };
  width: number;
  height: number;
  sha256: string;
}

export interface VideoInfo {
  duration: number;
  videoDuration?: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface VideoFrame {
  timestamp: number;
  requestedTimestamp: number;
  duration: number;
  hasAudio: boolean;
}

export interface Asset {
  id: string;
  name: string;
  mimeType: string;
  kind: AssetKind;
  size: number;
  sha256: string;
  createdAt: string;
  memorySpace?: MemorySpace;
}

export interface SourceRef {
  assetId: string;
  name: string;
  sha256: string;
  start: number;
  end: number;
  quote?: string;
  view?: ImageView;
  video?: VideoFrame;
  visual?: {
    width: number;
    height: number;
    previewSha256: string;
    region?: ImageRegion;
    transcript?: string;
  };
}
