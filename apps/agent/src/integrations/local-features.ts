import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectRoot } from "../config.js";
import { UserFacingError } from "../harness/runtime.js";

import { encoderFingerprint, type FeatureInfo, type ImageFeatures, type FeatureProcessor, type TextFeatures } from "./feature-provider.js";
// Compatibility exports for existing integrations and evaluation scripts.
export { encoderFingerprint, type FeatureInfo, type ImageFeatures, type TextFeatures } from "./feature-provider.js";
export type LocalFeatures = FeatureProcessor;
export interface LocalProcessorConfig { python: string; modelsDir: string }

/** Fixed protocol, no arbitrary commands, file paths or credentials from the Agent. */
export class LocalMemoryProcessor implements FeatureProcessor {
  private process?: ChildProcessWithoutNullStreams;
  private infoPromise?: Promise<FeatureInfo>;
  private output = "";
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private closed = false;
  constructor(private readonly config: LocalProcessorConfig) {}

  private failure(code = "LOCAL_PROCESSOR_FAILED") {
    return new UserFacingError(503, code, "本地特征处理器不可用，请检查模型安装和处理状态");
  }
  private start() {
    if (this.closed) throw this.failure();
    if (this.process) return this.process;
    if (!existsSync(this.config.python) || !existsSync(resolve(this.config.modelsDir, "manifest.json")))
      throw this.failure("LOCAL_MODELS_NOT_CONFIGURED");
    const script = resolve(projectRoot, "services/memory-worker/worker.py");
    const child = spawn(this.config.python, ["-u", script, "--models", this.config.modelsDir], {
      cwd: dirname(script), stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONUTF8: "1",
        OMP_NUM_THREADS: "2", TOKENIZERS_PARALLELISM: "false", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1", HF_HOME: resolve(this.config.modelsDir, ".cache") },
    });
    this.process = child;
    this.output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.process !== child) return;
      this.output += chunk;
      if (Buffer.byteLength(this.output) > 2 * 1024 * 1024) { this.stop(); return; }
      for (let end; (end = this.output.indexOf("\n")) >= 0;) {
        const line = this.output.slice(0, end);
        this.output = this.output.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.id === null && response.error) { this.stop(); return; }
          const pending = this.pending.get(response.id);
          if (!pending) { this.stop(); return; }
          this.pending.delete(response.id);
          pending.cleanup();
          if (response.error) pending.reject(this.failure()); else pending.resolve(response.result);
        } catch { this.stop(); return; }
      }
    });
    // Native runtime diagnostics can contain asset paths or contents. Never forward them to logs.
    child.stderr.resume();
    child.stdin.on("error", () => { if (this.process === child) this.stop(); });
    child.on("error", () => { if (this.process === child) this.stop(); });
    child.on("exit", () => { if (this.process === child) this.stop(); });
    return child;
  }
  private stop() {
    const child = this.process;
    this.process = undefined;
    this.infoPromise = undefined;
    this.output = "";
    child?.kill("SIGKILL");
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(this.failure()); }
    this.pending.clear();
  }
  private request<T>(input: object, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.pending.size >= 16) return Promise.reject(this.failure("LOCAL_PROCESSOR_BUSY"));
    const child = this.start();
    const id = randomUUID();
    return new Promise<T>((resolveResult, reject) => {
      const abort = () => this.stop();
      const timeout = setTimeout(abort, 60000);
      timeout.unref();
      this.pending.set(id, { resolve: (value) => resolveResult(value as T), reject,
        cleanup: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.write(JSON.stringify({ ...input, id }) + "\n");
    });
  }
  info(signal?: AbortSignal): Promise<FeatureInfo> {
    this.infoPromise ||= this.request<FeatureInfo>({ action: "info" }, signal).then((info) => {
      if (info.protocol !== 1 || !/^[a-f0-9]{64}$/.test(info.fingerprint) || info.network !== false ||
        !["cpu", "cuda"].includes(info.device) || ["text", "image", "face"].some((channel) => {
          const encoder = info.encoders?.[channel as "text" | "image" | "face"];
          return !encoder || typeof encoder.id !== "string" || !Number.isInteger(encoder.dimensions) ||
            encoder.dimensions < 1 || encoder.dimensions > 8192 ||
            (encoder.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(encoder.fingerprint));
        }) || (info.sharedQueryEmbedding && (info.encoders.text!.dimensions !== info.encoders.image!.dimensions ||
          encoderFingerprint(info, "text") !== encoderFingerprint(info, "image")))) throw this.failure();
      return info;
    }).catch((error) => { this.infoPromise = undefined; throw error; });
    return this.infoPromise;
  }
  async embed(texts: string[], role: "query" | "passage", encoder: "text" | "image_text" = "text", signal?: AbortSignal) {
    const info = await this.info(signal);
    const result = await this.request<TextFeatures>({ action: "embed", texts, role, encoder }, signal);
    const dimensions = info.encoders[encoder === "text" ? "text" : "image"]!.dimensions;
    if (result.fingerprint !== info.fingerprint || !Array.isArray(result.vectors) || result.vectors.length !== texts.length ||
      result.vectors.some((v) => !this.validVector(v, dimensions)) || result.truncated?.length !== texts.length ||
      result.tokens?.length !== texts.length) throw this.failure();
    return result;
  }
  async image(data: Buffer, sha256: string, signal?: AbortSignal) {
    if (data.length > 20 * 1024 * 1024) throw new UserFacingError(413, "IMAGE_TOO_LARGE", "本地图片处理限 20 MB");
    const info = await this.info(signal);
    const result = await this.request<ImageFeatures>({ action: "image", data: data.toString("base64"), sha256 }, signal);
    if (result.fingerprint !== info.fingerprint || !result.vector || !this.validVector(result.vector, info.encoders.image!.dimensions) ||
      (result.faceFingerprint !== undefined && result.faceFingerprint !== encoderFingerprint(info, "face")) ||
      result.coordinateSpace !== "exif-oriented" || !Array.isArray(result.faces) || result.faces.length > 256 ||
      result.faces.some((face) => !face.region || !Object.values(face.region).every(Number.isFinite) ||
        face.region.x < 0 || face.region.y < 0 || face.region.width <= 0 || face.region.height <= 0 ||
        face.region.x + face.region.width > 1.000001 || face.region.y + face.region.height > 1.000001 ||
        !["usable", "small"].includes(face.quality) || (face.vector !== null && !this.validVector(face.vector, info.encoders.face!.dimensions))))
      throw this.failure();
    if (result.facePolicy && [result.facePolicy.matchThreshold, result.facePolicy.matchMargin].some((n) => !Number.isFinite(n) || n < 0 || n > 1))
      throw this.failure();
    return result;
  }
  private validVector(vector: number[], dimensions: number) {
    return Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite) && vector.some((n) => Math.abs(n) > 1e-8);
  }
  async close() { this.closed = true; this.stop(); }
}
