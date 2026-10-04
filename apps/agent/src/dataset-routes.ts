import type { FastifyInstance } from "fastify";
import type { DatasetAuditJob, DatasetRebuildInput, DatasetSampleSelection, DatasetScope, MemoryDataset } from "@memory/contracts";
import type { DatasetService } from "./memory/dataset-service.js";
import type { SampleChange } from "./memory/dataset-review.js";

const uuid = { type: "string", format: "uuid" };
const ids = { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: uuid };
const params = { type: "object", required: ["id"], properties: { id: uuid }, additionalProperties: false };
const scope = { type: "object", additionalProperties: false, properties: {
  assetIds: ids, memoryIds: ids, personId: uuid, eventId: uuid, category: { enum: ["fact", "event", "relationship", "profile"] },
  from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
} };
export function registerDatasetRoutes(app: FastifyInstance, datasets: DatasetService) {
  app.get("/api/memory-datasets", async () => ({ datasets: datasets.ledger.list() }));
  app.post<{ Body: { requestKey: string; title?: string; format?: MemoryDataset["format"]; scope?: DatasetScope; modelId?: string } }>("/api/memory-datasets", {
    schema: { body: { type: "object", required: ["requestKey"], additionalProperties: false, properties: {
      requestKey: { type: "string", minLength: 1, maxLength: 200 }, title: { type: "string", minLength: 1, maxLength: 120 },
      format: { enum: ["qa", "narrative", "mixed"] }, scope, modelId: { type: "string", minLength: 1, maxLength: 200 },
    } } },
  }, async (request, reply) => reply.code(202).send({ dataset: datasets.submit({ ...request.body, requestKey: "web:" + request.body.requestKey }) }));
  app.post<{ Params: { id: string }; Body: Omit<DatasetRebuildInput, "datasetId"> }>("/api/memory-datasets/:id/rebuild", {
    schema: { params, body: { type: "object", additionalProperties: false, required: ["revision", "requestKey"], properties: {
      revision: { type: "integer", minimum: 1 }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    } } },
  }, async (request, reply) => reply.code(202).send({ dataset: datasets.rebuild({ datasetId: request.params.id, revision: request.body.revision, requestKey: "web-rebuild:" + request.body.requestKey }) }));
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>("/api/memory-datasets/:id", {
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: { after: { type: "integer", minimum: 0 } } } },
  }, async (request) => datasets.result(request.params.id, request.query.after, 20));
  app.post<{ Params: { id: string }; Body: { revision: number; requestKey: string; modelId: string; mode?: DatasetAuditJob["mode"] } }>("/api/memory-datasets/:id/audits", {
    schema: { params, body: { type: "object", required: ["revision", "requestKey", "modelId"], additionalProperties: false, properties: {
      revision: { type: "integer", minimum: 1 }, requestKey: { type: "string", minLength: 1, maxLength: 200 }, modelId: { type: "string", minLength: 1, maxLength: 200 },
      mode: { enum: ["pending", "all"] },
    } } },
  }, async (request, reply) => reply.code(202).send({ audit: datasets.audits.submit({ ...request.body, datasetId: request.params.id, requestKey: "web-audit:" + request.body.requestKey }) }));
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>("/api/dataset-audits/:id", {
    schema: { params, querystring: { type: "object", properties: { after: { type: "integer", minimum: 0 } }, additionalProperties: false } },
  }, async (request) => datasets.audits.result(request.params.id, request.query.after, 8));
  for (const action of ["retry", "cancel"] as const) app.post<{ Params: { id: string } }>(`/api/dataset-audits/:id/${action}`, {
    schema: { params },
  }, async (request) => ({ audit: datasets.audits[action](request.params.id) }));
  app.get<{ Params: { id: string }; Querystring: { after?: string; view?: DatasetSampleSelection["view"]; sampleIds?: string[] } }>("/api/memory-datasets/:id/samples", {
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: { after: uuid, view: { enum: ["all", "review", "ready", "excluded"] },
      sampleIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: uuid } } } },
  }, async (request) => {
    const dataset = datasets.ledger.get(request.params.id);
    const selection = { view: request.query.view || "all", ...(request.query.sampleIds ? { sampleIds: request.query.sampleIds } : {}) } satisfies DatasetSampleSelection;
    const page = datasets.ledger.samples(dataset.id, request.query.after, 21, selection);
    const samples = page.slice(0, 20);
    return { dataset, samples, trainingSamples: datasets.ledger.pairings.trainingSamples(samples), selection,
      matchingSamples: datasets.ledger.sampleCount(dataset.id, selection), nextCursor: page.length > 20 ? page[19].id : null };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>("/api/memory-datasets/:id/invalidations", {
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: { after: { type: "integer", minimum: 0 } } } },
  }, async (request) => {
    datasets.ledger.get(request.params.id);
    return { invalidations: datasets.ledger.invalidations(request.params.id, request.query.after) };
  });
  app.post<{ Params: { id: string }; Body: { samples: (Omit<SampleChange, "action"> & { action?: SampleChange["action"] })[]; reason: string; requestKey?: string } }>("/api/memory-datasets/:id/review", {
    schema: { params, body: { type: "object", required: ["samples", "reason"], additionalProperties: false, properties: {
      samples: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", required: ["id", "version"], additionalProperties: false,
        properties: { id: uuid, version: { type: "integer", minimum: 1 }, action: { enum: ["approve", "revise", "exclude", "defer"] },
          reason: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
          question: { type: "string", minLength: 1, maxLength: 300 }, answer: { type: "string", minLength: 1, maxLength: 24000 },
          evaluationOf: { type: "object", required: ["id", "version"], additionalProperties: false,
            properties: { id: uuid, version: { type: "integer", minimum: 1 } } } } } },
      reason: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    } } },
  }, async (request) => {
    const receipt = await datasets.changeSamples(request.params.id, request.body.samples.map((sample) => ({ ...sample, action: sample.action || "approve" })),
      request.body.reason, { actor: "user", requestKey: request.body.requestKey && "web-review:" + request.body.requestKey });
    return { dataset: datasets.ledger.get(request.params.id), receipt };
  });
  for (const action of ["retry", "cancel"] as const) app.post<{ Params: { id: string } }>(`/api/memory-datasets/:id/${action}`, {
    schema: { params },
  }, async (request) => ({ dataset: datasets[action](request.params.id) }));
  app.get<{ Params: { id: string; kind: "training" | "evaluation" | "review" | "manifest" } }>("/api/memory-datasets/:id/files/:kind", {
    schema: { params: { type: "object", required: ["id", "kind"], additionalProperties: false, properties: { id: uuid, kind: { enum: ["training", "evaluation", "review", "manifest"] } } } },
  }, async (request, reply) => {
    const file = await datasets.download(request.params.id, request.params.kind);
    return reply.type("application/octet-stream").header("Content-Disposition", `attachment; filename="${file.filename}"`)
      .header("Content-Length", file.bytes).send(file.stream);
  });
}
