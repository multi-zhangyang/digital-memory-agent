import { createHash } from "node:crypto";
import sharp from "sharp";
import exifr from "exifr";
import type { FeatureChannel } from "@memory/contracts";
import { featureChannels, type FeatureSettings, type StoredFeatureConnection } from "../feature-config.js";
import { UserFacingError } from "../errors.js";
import { validateImageRegion, PHOTO_MAX_BYTES, PHOTO_MAX_PIXELS } from "../memory/photo-source.js";
import type { FeatureInfo, ImageFeatures, FeatureProcessor, TextFeatures } from "./feature-provider.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = () => new UserFacingError(503, "FEATURE_SERVICE_FAILED", "特征服务未完成请求，请检查连接、模型和接口协议");
const dimension = (value: number) => Number.isInteger(value) && value > 0 && value <= 8192;
function vector(value: unknown, size?: number): number[] {
  if (!Array.isArray(value) || !dimension(value.length) || (size !== undefined && value.length !== size) ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw failure();
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm < 1e-8) throw failure();
  return value.map((n) => n / norm);
}

/** Provider configuration owns models. Business code consumes only capabilities and vectors. */
export class HttpFeatureProcessor implements FeatureProcessor {
  private readonly controller = new AbortController();
  private manifest?: Promise<FeatureInfo>;
  private revisions: Partial<Record<FeatureChannel, string>> = {};
  constructor(private readonly settings: FeatureSettings) {}

  private async request(connection: StoredFeatureConnection, body: object, signal?: AbortSignal): Promise<any> {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    try {
      const response = await fetch(connection.baseUrl + (connection.protocol === "openai-embeddings" ? "/embeddings" : ""), {
        method: "POST", redirect: "error", signal: combined,
        headers: { "Content-Type": "application/json", ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw failure(); }
      const reader = response.body.getReader(), parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 8 * 1024 * 1024) throw failure();
          parts.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      signal?.throwIfAborted();
      this.controller.signal.throwIfAborted();
      // Never forward provider error text, authorization headers or private input.
      throw failure();
    }
  }
  private async openai(connection: StoredFeatureConnection, texts: string[], signal?: AbortSignal) {
    const response = await this.request(connection, { model: connection.modelName, input: texts, encoding_format: "float" }, signal);
    if (!Array.isArray(response.data) || response.data.length !== texts.length) throw failure();
    const rows = [...response.data].sort((a, b) => a.index - b.index);
    if (rows.some((row, i) => row.index !== i)) throw failure();
    return rows.map((row) => vector(row.embedding));
  }
  info(signal?: AbortSignal): Promise<FeatureInfo> {
    this.manifest ||= (async () => {
      const encoders: FeatureInfo["encoders"] = {};
      const spaces: Partial<Record<FeatureChannel, string>> = {};
      const enabled = featureChannels.filter((c) => this.settings.connections[c].enabled);
      await Promise.all(enabled.map(async (channel) => {
        const connection = this.settings.connections[channel];
        let dimensions: number, revision = connection.revision, space: string | undefined;
        if (connection.protocol === "openai-embeddings") {
          dimensions = (await this.openai(connection, ["connection test"], signal))[0].length;
        } else {
          const result = await this.request(connection, { protocol: 1, action: "info", capability: channel, model: connection.modelName }, signal);
          if (result.protocol !== 1 || !Array.isArray(result.capabilities) || !result.capabilities.includes(channel) ||
            typeof result.revision !== "string" || !result.revision || result.revision.length > 256 || !dimension(result.dimensions)) throw failure();
          dimensions = result.dimensions;
          this.revisions[channel] = result.revision;
          revision += ":" + result.revision;
          if (typeof result.spaceId === "string" && result.spaceId.length > 0 && result.spaceId.length <= 256) space = result.spaceId;
        }
        const fingerprint = hash({ protocol: connection.protocol, baseUrl: connection.baseUrl, model: connection.modelName, revision,
          dimensions, space: space || channel });
        encoders[channel] = { id: connection.modelName, revision, dimensions, fingerprint };
        spaces[channel] = space;
      }));
      if (!enabled.length) throw failure();
      return { protocol: 1, processorVersion: 1, fingerprint: hash({ encoders: featureChannels.map((c) => encoders[c] || null), facePolicy: [this.settings.faceMatchThreshold, this.settings.faceMatchMargin] }),
        encoders, device: "remote", network: true,
        sharedQueryEmbedding: !!spaces.text && spaces.text === spaces.image && encoders.text?.fingerprint === encoders.image?.fingerprint } satisfies FeatureInfo;
    })().catch((error) => { this.manifest = undefined; throw error; });
    return this.manifest;
  }
  async embed(texts: string[], role: "query" | "passage", encoder: "text" | "image_text" = "text", signal?: AbortSignal): Promise<TextFeatures> {
    if (!Array.isArray(texts) || !texts.length || texts.length > 16 || texts.some((t) => typeof t !== "string" || !t.trim() || t.length > 8192)) throw failure();
    const info = await this.info(signal), channel = encoder === "text" ? "text" : "image";
    const model = info.encoders[channel], connection = this.settings.connections[channel];
    if (!model) throw failure();
    if (connection.protocol === "openai-embeddings") {
      const vectors = await this.openai(connection, texts, signal);
      if (vectors.some((v) => v.length !== model.dimensions)) throw failure();
      // Standard embeddings APIs do not report per-item truncation/tokens; request is bounded,
      // and input-too-long must fail at the provider instead of silently truncating it.
      return { vectors, truncated: texts.map(() => null), tokens: texts.map(() => null), fingerprint: info.fingerprint };
    }
    const result = await this.request(connection, { protocol: 1, action: "embed", capability: channel, model: connection.modelName, texts, role }, signal);
    if (result.revision !== this.revisions[channel] || !Array.isArray(result.vectors) || result.vectors.length !== texts.length || !Array.isArray(result.truncated) ||
      result.truncated.length !== texts.length || result.truncated.some((v: unknown) => typeof v !== "boolean") ||
      !Array.isArray(result.tokens) || result.tokens.length !== texts.length || result.tokens.some((v: number) => !Number.isInteger(v) || v < 0)) throw failure();
    return { vectors: result.vectors.map((v: unknown) => vector(v, model.dimensions)), truncated: result.truncated, tokens: result.tokens, fingerprint: info.fingerprint };
  }
  async image(data: Buffer, sha256: string, signal?: AbortSignal): Promise<ImageFeatures> {
    if (data.length > PHOTO_MAX_BYTES || createHash("sha256").update(data).digest("hex") !== sha256) throw failure();
    const info = await this.info(signal);
    const options = { limitInputPixels: PHOTO_MAX_PIXELS, failOn: "warning" as const };
    const meta = await sharp(data, options).metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format || "") || (meta.pages || 1) > 1) throw failure();
    const exif = await exifr.parse(data, { pick: ["DateTimeOriginal", "OffsetTimeOriginal", "GPSLatitude", "GPSLongitude"], reviveValues: false }).catch(() => undefined);
    const date = typeof exif?.DateTimeOriginal === "string" && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(exif.DateTimeOriginal) ? exif.DateTimeOriginal : null;
    const offset = typeof exif?.OffsetTimeOriginal === "string" && /^[+-]\d{2}:\d{2}$/.test(exif.OffsetTimeOriginal) ? exif.OffsetTimeOriginal : null;
    const prepared = await sharp(data, options).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const image = { data: prepared.data.toString("base64"), mimeType: "image/jpeg",
      sha256: createHash("sha256").update(prepared.data).digest("hex"), width: prepared.info.width, height: prepared.info.height, coordinateSpace: "exif-oriented" };
    const result: ImageFeatures = { vector: null, faces: [], width: prepared.info.width, height: prepared.info.height,
      coordinateSpace: "exif-oriented", fingerprint: info.fingerprint, faceFingerprint: info.encoders.face?.fingerprint,
      facePolicy: { matchThreshold: this.settings.faceMatchThreshold, matchMargin: this.settings.faceMatchMargin },
      metadata: { capturedLocal: date, offset, source: date ? "EXIF" : null, certainty: date ? "unverified" : "unknown", hasGps: exif?.GPSLatitude !== undefined || exif?.GPSLongitude !== undefined } };
    await Promise.all((["image", "face"] as const).filter((c) => info.encoders[c]).map(async (channel) => {
      const connection = this.settings.connections[channel];
      const response = await this.request(connection, { protocol: 1, action: "image", capability: channel, model: connection.modelName, image }, signal);
      if (response.revision !== this.revisions[channel]) throw failure();
      if (channel === "image") result.vector = vector(response.vector, info.encoders.image!.dimensions);
      else {
        if (response.coordinateSpace !== "exif-oriented" || !Array.isArray(response.faces) || response.faces.length > 256) throw failure();
        result.faces = response.faces.map((face: ImageFeatures["faces"][number]) => {
          if (!face?.region) throw failure();
          validateImageRegion(face.region);
          if (!Number.isFinite(face.detectionScore) || face.detectionScore < 0 || face.detectionScore > 1 || !["usable", "small"].includes(face.quality) ||
            (face.quality === "usable" && face.vector === null) || (face.quality === "small" && face.vector !== null)) throw failure();
          return { region: face.region, detectionScore: face.detectionScore, quality: face.quality,
            vector: face.vector === null ? null : vector(face.vector, info.encoders.face!.dimensions) };
        });
      }
    }));
    return result;
  }
  async close() { this.controller.abort(); this.manifest = undefined; }
}

export function configuredFeatureProcessor(settings?: FeatureSettings) {
  return settings && featureChannels.some((c) => settings.connections[c].enabled) ? new HttpFeatureProcessor(settings) : undefined;
}
