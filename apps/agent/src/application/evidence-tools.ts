import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.js";
import type { AppConfig } from "../config.js";
import type { EvidenceService } from "../memory/evidence-service.js";
import { UserFacingError } from "../errors.js";

export function createEvidenceTools(store: Store, config: AppConfig, evidence: EvidenceService, conversationId: string) {
  const current = () => {
    const run = store.work.activeRun(conversationId);
    if (!run) throw new UserFacingError(409, "RUN_REQUIRED", "请从任务工作台读取证据");
    return { run, scope: { allowedAssetIds: run.scope === "selected" ? run.assetIds : undefined, allowObservations: run.useMemory } };
  };
  return [defineTool({ name: "search_evidence", label: "检索素材证据",
    description: "Search original text/images/videos, locally indexed video frames and asset-derived observations, including unconfirmed candidates. Video frame hits retain original source and exact time, independent of caption generation or confirmation. Filter personId only with a confirmed identity; entityId narrows to an unknown/candidate group without claiming identity. Uses available keyword and embedding channels with scope and suppression enforced before ranking. Results carry authority and versions; a match is evidence to inspect, not a confirmed fact or identity. Use read_evidence to verify original sources. Does not promote observations or create training data.",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), kind: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("text"), Type.Literal("video")])),
      assetIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 200 })),
      personId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Confirmed person ID only; use null when no confirmed-person filter is needed. Never invent a placeholder UUID." })),
      entityId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Candidate group ID returned by inspect_source_people, or null for no group filter." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      const { scope } = current();
      const result = await evidence.search({ ...input, personId: input.personId ?? undefined, entityId: input.entityId ?? undefined }, scope, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  }), defineTool({ name: "read_evidence", label: "读取原始证据",
    description: "Read current original evidence and verify its bytes/version. sourceRef (e1, e2...) identifies this exact completed read for propose_memory.sourceRefs; use the relevant reads, including multiple times when a claim spans them. A returned frame: ID reads its fixed video frame directly, using an original SHA-256 version; use asset: and timestamp for other video times. For text follow nextOffset. For images read the full frame first, then set region={x,y,width,height} in 0..1 coordinates on the complete oriented ORIGINAL. For video set timestamp in seconds (default 0); video reports duration and source.video reports actual frame time and requested time. Use a returned observation source's requestedTimestamp to revisit that exact frame. A frame cannot prove unsampled events or audio; inspect multiple relevant timestamps for actions. Crops use original pixels before resizing. source.view records pixels/hash and preview URL, imageDelivered records actual model delivery. Read relevant originals before correcting drafts.",
    parameters: Type.Object({ id: Type.String({ pattern: "^(asset|frame|observation):[0-9a-f-]{36}$" }), version: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Integer({ minimum: 1 })],
      { description: "For asset: use the exact SHA-256 string from task assets.version or search_evidence. Numeric 1 is NOT an asset version. Only observation: IDs use integer versions. Omit when unknown; never invent a version." })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 4, maximum: 8000 })),
      timestamp: Type.Optional(Type.Number({ minimum: 0, maximum: 7200, description: "Video time in seconds from its beginning. Omit for images/text. Use the source's requestedTimestamp to reproduce a video observation frame." })),
      region: Type.Optional(Type.Union([Type.Object({ x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }),
        width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) }, { additionalProperties: false }), Type.Null()])),
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const { run, scope } = current();
      const vision = config.providers.find((provider) => provider.model.id === run.modelId)?.model.supportsImages === true;
      if ((input.region || input.timestamp !== undefined) && !vision) throw new UserFacingError(400, "VISION_UNAVAILABLE", "当前任务模型未启用图片输入，不能读取局部或视频画面像素");
      const { image, ...result } = await evidence.read(input.id, scope, { ...input, image: vision, signal });
      signal?.throwIfAborted();
      const latest = current().run;
      if (latest.id !== run.id || latest.memoryEpoch !== run.memoryEpoch) throw new UserFacingError(409, "RUN_CHANGED", "任务或依据已改变，请重新读取");
      for (const source of result.hit.sources) if (source.type === "asset") store.recordSource(run.id, { ...source, ...(result.source?.text ? { quote: result.source.text } : {}) });
      const sourceRef = result.source && (typeof result.source.text === "string" || image) ? store.work.recordRef(run.id, "source", _id, 1) : undefined;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, sourceRef, imageDelivered: !!image }) }, ...(image ? [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" }] : [])], details: {} };
    },
  })];
}
