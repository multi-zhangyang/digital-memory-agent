import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";
import type { Asset, ImageRegion, ImageView, VideoFrame, VideoInfo } from "@memory/contracts";
import { UserFacingError } from "../errors.js";
import { PHOTO_MAX_PIXELS, photoHash, validateImageRegion, type PreparedPhoto } from "./photo-source.js";

const formats: Record<string, string> = { "video/mp4": "mov", "video/webm": "matroska", "video/ogg": "ogg" };
const environment = { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C" };
const verified = new Map<string, string>();
let available: boolean | undefined;
export const VIDEO_EXTRACTOR_VERSION = 2;
export function videoAvailable() {
  return available ??= ["ffmpeg", "ffprobe"].every((command) => spawnSync(command, ["-version"], { env: environment, timeout: 5000, stdio: "ignore" }).status === 0);
}

async function decode(assetsDir: string, asset: Asset, command: string, args: string[], signal?: AbortSignal) {
  if (asset.kind !== "video" || !formats[asset.mimeType] || asset.size > 1024 ** 3)
    throw new UserFacingError(400, "INVALID_VIDEO", "请选择不超过 1 GB 的 MP4、WebM 或 Ogg 视频");
  if (!videoAvailable()) throw new UserFacingError(503, "VIDEO_UNAVAILABLE", "视频处理需要安装 FFmpeg 和 FFprobe");
  signal?.throwIfAborted();
  const path = join(assetsDir, asset.id);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new UserFacingError(410, "SOURCE_MISSING", "视频原件已不可用");
  });
  try {
    const stat = await file.stat(), stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!stat.isFile() || stat.size !== asset.size) throw new UserFacingError(409, "SOURCE_CHANGED", "视频原件已改变");
    const key = path + ":" + asset.sha256;
    if (verified.get(key) !== stamp) {
      const hash = createHash("sha256");
      for await (const bytes of file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) { signal?.throwIfAborted(); hash.update(bytes); }
      if (hash.digest("hex") !== asset.sha256) throw new UserFacingError(409, "SOURCE_CHANGED", "视频原件校验不一致");
    }
    // Each decoder gets a fresh descriptor at byte zero. Only fd/pipe protocols are enabled.
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let result: { data: Buffer; diagnostic: string };
    try {
      const opened = await input.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        throw new UserFacingError(409, "SOURCE_CHANGED", "视频原件在读取前被替换");
      result = await new Promise((resolve, reject) => {
        const process = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe", input.fd],
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]), killSignal: "SIGKILL" });
        const buffers: Buffer[] = []; let size = 0, diagnostic = "";
        process.stdout!.on("data", (bytes: Buffer) => {
          size += bytes.length;
          if (size > 128 * 1024 * 1024) process.kill("SIGKILL"); else buffers.push(bytes);
        });
        process.stderr!.on("data", (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-32000); });
        process.on("error", reject);
        process.on("close", (code) => code === 0 && size <= 128 * 1024 * 1024 ? resolve({ data: Buffer.concat(buffers), diagnostic })
          : reject(new UserFacingError(400, "INVALID_VIDEO", "视频无法解码，请核对格式或换一份原件")));
      });
    } finally { await input.close(); }
    const after = await file.stat();
    if (stamp !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`)
      throw new UserFacingError(409, "SOURCE_CHANGED", "视频在读取期间发生改变");
    verified.set(key, stamp);
    if (verified.size > 128) verified.delete(verified.keys().next().value!);
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError(400, "VIDEO_DECODE_FAILED", "视频读取未完成，请稍后重试");
  } finally { await file.close(); }
}

export async function inspectVideo(assetsDir: string, asset: Asset, signal?: AbortSignal): Promise<VideoInfo & { frameRate: number }> {
  const { data } = await decode(assetsDir, asset, "ffprobe", ["-v", "error", "-protocol_whitelist", "fd,pipe", "-fd", "3", "-f", formats[asset.mimeType] || "mov",
    "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,duration:stream_side_data=rotation", "-of", "json", "fd:"], signal);
  const value = JSON.parse(data.toString()) as { streams: { codec_type: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; side_data_list?: { rotation?: number }[] }[]; format: { duration?: string } };
  const video = value.streams.find((stream) => stream.codec_type === "video"), duration = Number(value.format.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0 || duration > 7200 || video.width * video.height > PHOTO_MAX_PIXELS)
    throw new UserFacingError(400, "INVALID_VIDEO", "视频须有可读取画面和时长，最长 2 小时，单帧不超过 4,000 万像素");
  const rotated = Math.abs(video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation || 0) % 180 === 90;
  const [numerator, denominator] = (video.avg_frame_rate || "0/1").split("/").map(Number);
  const streamDuration = Number(video.duration);
  return { duration, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    ...(Number.isFinite(streamDuration) && streamDuration > 0 ? { videoDuration: Math.min(duration, streamDuration) } : {}),
    hasAudio: value.streams.some((stream) => stream.codec_type === "audio"), frameRate: denominator ? numerator / denominator : 0 };
}

export function sampleVideo(info: VideoInfo & { frameRate: number }, requestedInterval: number) {
  const duration = info.videoDuration ?? info.duration;
  const interval = Math.max(requestedInterval, duration / 119);
  const last = Math.max(0, duration - (info.frameRate > 0 ? 1 / info.frameRate : 0.1));
  const timestamps: number[] = [];
  for (let time = 0; time < last; time += interval) timestamps.push(Number(time.toFixed(6)));
  if (!timestamps.length || last - timestamps.at(-1)! > 0.01) timestamps.push(Number(last.toFixed(6)));
  return { timestamps, interval };
}

export async function prepareVideoFrame(assetsDir: string, asset: Asset, requestedTimestamp: number,
  options: { region?: ImageRegion; signal?: AbortSignal; info?: VideoInfo } = {}): Promise<PreparedPhoto & { view: ImageView; video: VideoFrame }> {
  if (options.region) validateImageRegion(options.region);
  const info = options.info || await inspectVideo(assetsDir, asset, options.signal);
  if (!Number.isFinite(requestedTimestamp) || requestedTimestamp < 0 || requestedTimestamp >= info.duration)
    throw new UserFacingError(400, "INVALID_VIDEO_TIME", "画面时间须在视频时长范围内");
  const { data: png, diagnostic } = await decode(assetsDir, asset, "ffmpeg", ["-hide_banner", "-loglevel", "info", "-nostdin", "-threads", "2",
    "-protocol_whitelist", "fd,pipe", "-fd", "3", "-copyts", "-start_at_zero", "-ss", String(requestedTimestamp), "-f", formats[asset.mimeType], "-i", "fd:",
    "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf", "showinfo", "-threads", "2", "-f", "image2pipe", "-c:v", "png", "pipe:1"], options.signal);
  const timestamp = Number(diagnostic.match(/\bn:\s*0\s+pts:\s*\S+\s+pts_time:([\d.e+-]+)/)?.[1]);
  if (!png.length || !Number.isFinite(timestamp)) throw new UserFacingError(400, "VIDEO_FRAME_UNAVAILABLE", "此时间点没有可读取画面，请选择前一个时间点");
  const metadata = await sharp(png, { limitInputPixels: PHOTO_MAX_PIXELS }).metadata();
  const sourceWidth = metadata.width!, sourceHeight = metadata.height!, region = options.region;
  const left = region ? Math.floor(region.x * sourceWidth) : 0, top = region ? Math.floor(region.y * sourceHeight) : 0;
  const pixels = { left, top, width: region ? Math.min(sourceWidth, Math.ceil((region.x + region.width) * sourceWidth)) - left : sourceWidth,
    height: region ? Math.min(sourceHeight, Math.ceil((region.y + region.height) * sourceHeight)) - top : sourceHeight };
  let image = sharp(png, { limitInputPixels: PHOTO_MAX_PIXELS });
  if (region) image = image.extract(pixels);
  const { data, info: output } = await image.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  const sha256 = photoHash(data);
  return { data, width: output.width, height: output.height, sha256,
    view: { sourceWidth, sourceHeight, pixels, width: output.width, height: output.height, sha256,
      ...(region ? { region: { x: left / sourceWidth, y: top / sourceHeight, width: pixels.width / sourceWidth, height: pixels.height / sourceHeight } } : {}) },
    video: { timestamp, requestedTimestamp, duration: info.duration, hasAudio: info.hasAudio } };
}
