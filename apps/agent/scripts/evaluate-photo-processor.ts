import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { readConfig, projectRoot } from "../src/config.js";
import { ModelAccess } from "../src/model-access.js";
import { preparePhoto } from "../src/photo-source.js";
import { extractPhotoMemories, PHOTO_EXTRACTOR_VERSION } from "../src/photo-extraction.js";

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const config = readConfig();
const configured = config.providers.find((provider) => provider.model.supportsImages);
if (!configured) throw new Error("Configure an image-capable connection before evaluating");
const modelName = argument("--model") || configured.model.name;
const provider = { ...configured, model: { ...configured.model, name: modelName, id: configured.id + "/" + modelName } };
const models = await new ModelAccess({ ...config, providers: [provider] }).get();
const manifestPath = resolve(projectRoot, argument("--manifest") || "examples/quality/photo-processing.json");
const fixturesDir = resolve(projectRoot, argument("--directory") || ".data/quality-stage16-fixtures");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString()) as { images: { id: string; file: string; bytes: number; sha256: string }[] };
const label = argument("--label") || "current";
if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Invalid evaluation label");
const root = join(projectRoot, ".data/evaluations");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, `photo-processor-${label}-`));
const extractorPath = new URL("../src/photo-extraction.js", import.meta.url);
extractorPath.pathname = extractorPath.pathname.replace(/\.js$/, ".ts");
const report = {
  at: new Date().toISOString(), model: modelName, protocol: provider.protocol, thinkingLevel: "low" as const,
  extractorVersion: PHOTO_EXTRACTOR_VERSION, extractorHash: hash(await readFile(extractorPath)), manifestHash: hash(manifestBytes),
  scope: "Licensed public pixels only; no source titles or reference claims reach the processor. No user database, Agent session or training.",
  modelCalls: 0, completed: false, cases: [] as Record<string, unknown>[],
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const complete = models.completeSimple.bind(models);
let images: { sha256: string; bytes: number }[] = [];
let rawUsage: unknown;
models.completeSimple = async (model, context, options) => {
  const response = await complete(model, context, { ...options, onPayload(payload) {
    const visit = (value: unknown) => {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        const data = Buffer.from(value.split(",")[1], "base64"); images.push({ sha256: hash(data), bytes: data.length });
      } else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
    };
    visit(payload);
  } });
  rawUsage = response.usage;
  return response;
};
for (const fixture of manifest.images) {
  const photo = await preparePhoto(fixturesDir, {
    id: fixture.file, name: "photo.jpg", kind: "image", mimeType: "image/jpeg", size: fixture.bytes,
    sha256: fixture.sha256, createdAt: new Date().toISOString(),
  });
  images = []; rawUsage = undefined;
  const started = performance.now(); report.modelCalls++;
  let outcome: Record<string, unknown>;
  try {
    outcome = { ...await extractPhotoMemories(models, provider, { modelId: provider.model.id, photo, thinkingLevel: "low" }, new AbortController().signal) };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.name : "UnknownError" };
  }
  const item = { id: fixture.id, ...outcome, rawUsage, durationMs: performance.now() - started,
    prepared: { sha256: photo.sha256, width: photo.width, height: photo.height },
    transport: { images, matchesPrepared: images.length === 1 && images[0].sha256 === photo.sha256 }, review: "pending pixel review" };
  report.cases.push(item); await save();
  console.log(JSON.stringify({ id: fixture.id, ...outcome, durationMs: item.durationMs, matchesPrepared: item.transport.matchesPrepared }));
}
report.completed = true; await save();
console.log(JSON.stringify({ report: join(directory, "report.json"), modelCalls: report.modelCalls, completed: report.completed }));
