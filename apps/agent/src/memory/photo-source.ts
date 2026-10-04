import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Asset, ImageRegion, ImageView } from "@memory/contracts";
import { UserFacingError } from "../errors.js";

export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 40_000_000;
export const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const photoHash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export interface PreparedPhoto {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export function validateImageRegion(region: ImageRegion) {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.x >= 1 || region.y >= 1 ||
    region.width <= 0 || region.height <= 0 || region.x + region.width > 1 + 1e-9 || region.y + region.height > 1 + 1e-9)
    throw new UserFacingError(400, "INVALID_IMAGE_REGION", "局部区域须使用整张正向原图的 0–1 坐标，宽高大于零且不能超出原图");
}

// Decode locally; providers receive only a bounded, oriented raster without EXIF/GPS.
export async function preparePhoto(assetsDir: string, asset: Asset, region?: ImageRegion): Promise<PreparedPhoto & { view: ImageView }> {
  if (region) validateImageRegion(region);
  if (asset.kind !== "image" || !PHOTO_MIME_TYPES.has(asset.mimeType) || asset.size > PHOTO_MAX_BYTES)
    throw new UserFacingError(400, "INVALID_PHOTO", "请选择不超过 20 MB 的 JPEG、PNG 或静态 WebP 图片");
  let buffer: Buffer;
  try {
    const file = await open(join(assetsDir, asset.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== asset.size || stat.size > PHOTO_MAX_BYTES)
        throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件大小已改变，请重新导入");
      buffer = await file.readFile();
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError(410, "SOURCE_MISSING", "图片原件已不可用，请重新导入");
  }
  if (buffer.length !== asset.size || photoHash(buffer) !== asset.sha256)
    throw new UserFacingError(409, "SOURCE_CHANGED", "图片原件校验不一致，请重新导入");
  try {
    const options = { limitInputPixels: PHOTO_MAX_PIXELS, failOn: "warning" as const };
    const metadata = await sharp(buffer, options).metadata();
    const formats: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (formats[metadata.format || ""] !== asset.mimeType || (metadata.pages || 1) > 1)
      throw new Error("Unsupported image");
    const rotated = [5, 6, 7, 8].includes(metadata.orientation || 1);
    const sourceWidth = (rotated ? metadata.height : metadata.width)!;
    const sourceHeight = (rotated ? metadata.width : metadata.height)!;
    const left = region ? Math.floor(region.x * sourceWidth) : 0;
    const top = region ? Math.floor(region.y * sourceHeight) : 0;
    const pixels = { left, top,
      width: region ? Math.min(sourceWidth, Math.ceil((region.x + region.width) * sourceWidth)) - left : sourceWidth,
      height: region ? Math.min(sourceHeight, Math.ceil((region.y + region.height) * sourceHeight)) - top : sourceHeight };
    // Extract before resizing: zooming an already downsampled preview loses small text and details.
    let pipeline = sharp(buffer, options).rotate();
    if (region) pipeline = pipeline.extract(pixels);
    const { data, info } = await pipeline
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    const sha256 = photoHash(data);
    const view: ImageView = { sourceWidth, sourceHeight, pixels, width: info.width, height: info.height, sha256,
      ...(region ? { region: { x: left / sourceWidth, y: top / sourceHeight, width: pixels.width / sourceWidth, height: pixels.height / sourceHeight } } : {}) };
    return { data, width: info.width, height: info.height, sha256, view };
  } catch {
    throw new UserFacingError(400, "INVALID_PHOTO", "图片无法解码、格式不匹配或超过 4,000 万像素；不支持动画图片");
  }
}
