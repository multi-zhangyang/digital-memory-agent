import { Type } from "@earendil-works/pi-ai";

// Short references are bound to an inspected version and run, never resolved fuzzily or to "latest".
export const versionedReference = Type.Object({ id: Type.String({ format: "uuid" }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const inspectedReference = (kind: "memory" | "sample") => Type.Object({
  ref: Type.String({ pattern: kind === "memory" ? "^m[1-9][0-9]*$" : "^s[1-9][0-9]*$", description: "Use the exact short ref returned by this task's inspection; it already binds the inspected version." }),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
