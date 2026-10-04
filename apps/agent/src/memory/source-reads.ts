import type { ChatPart, EvidenceRead, SourceRef } from "@memory/contracts";

/** Only completed original reads can support a new observation. */
export function sourceFromRead(part: ChatPart): SourceRef | undefined {
  if (part.type !== "tool" || part.state !== "complete") return;
  if (part.name === "read_evidence") {
    const read = part.output as (EvidenceRead & { imageDelivered?: boolean }) | undefined;
    const page = read?.source;
    if (!page || read.verification !== "asset-hash" || (page.view && !read.imageDelivered)) return;
    const original = read.hit.sources.find((source) => source.type === "asset" && source.assetId === page.assetId && source.sha256 === page.sha256);
    if (!original || original.type !== "asset") return;
    const { type: _type, ...source } = original;
    return { ...source, start: page.start, end: page.end, ...(page.text !== undefined ? { quote: page.text } : {}) };
  }
  if (part.name === "read_asset_text") {
    const read = part.output as { assetId: string; name: string; sha256: string; verification?: string; offset: number; text: string } | undefined;
    if (read?.verification !== "asset-hash" || typeof read.text !== "string") return;
    return { assetId: read.assetId, name: read.name, sha256: read.sha256, start: read.offset,
      end: read.offset + Buffer.byteLength(read.text), quote: read.text };
  }
}
