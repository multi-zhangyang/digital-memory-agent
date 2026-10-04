export function toolOutput(value: unknown): unknown {
  const content = (
    value as { content?: Array<{ type: string; text?: string }> }
  )?.content;
  const text =
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n") || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
