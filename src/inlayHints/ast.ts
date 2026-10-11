export type PandocNode = { t?: string; c?: unknown };

/** Returns an identifier from a Pandoc Attr triple without reading class/attribute values. */
export function getAttributeId(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string" && value[0] ? value[0] : undefined;
}

/**
 * Visits Pandoc nodes under the document blocks while carrying a surrounding span label.
 *
 * @param value Current AST value.
 * @param parentLabel Label inherited from a surrounding span.
 * @param visit Callback for each Pandoc node.
 */
export function walkAst(value: unknown, parentLabel: string | undefined, visit: (node: PandocNode, parentLabel?: string) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      walkAst(child, parentLabel, visit);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const node = record as PandocNode;
  const nextLabel = node.t === "Span" ? getAttributeId(asArray(node.c)?.[0]) || parentLabel : parentLabel;
  if (typeof node.t === "string") {
    visit(node, parentLabel);
  }
  walkAst(node.c, nextLabel, visit);
}

/**
 * Flattens caption inline content without including links, attributes, or target URLs.
 *
 * @param value Pandoc metadata, inline, or caption block value.
 */
export function flattenAstText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(flattenAstText).join("");
  }

  const node = asRecord(value);
  if (!node || typeof node.t !== "string") {
    return "";
  }

  if (node.t === "Str" || node.t === "MetaString") {
    return typeof node.c === "string" ? node.c : "";
  }
  if (node.t === "Space" || node.t === "SoftBreak" || node.t === "LineBreak") {
    return " ";
  }
  if (node.t === "Code" || node.t === "RawInline") {
    const content = asArray(node.c);
    return typeof content?.[1] === "string" ? content[1] : "";
  }
  if (node.t === "Link" || node.t === "Image" || node.t === "Span") {
    return flattenAstText(asArray(node.c)?.[1]);
  }
  if (node.t === "Cite") {
    return flattenAstText(asArray(node.c)?.[1]);
  }
  if (node.t === "Math") {
    return typeof asArray(node.c)?.[1] === "string" ? String(asArray(node.c)?.[1]) : "";
  }
  if (node.t === "Quoted") {
    const content = asArray(node.c);
    const single = asRecord(content?.[0])?.t === "SingleQuote";
    return `${single ? "‘" : "“"}${flattenAstText(content?.[1])}${single ? "’" : "”"}`;
  }
  return flattenAstText(node.c);
}

/**
 * Normalizes whitespace to compare caption title prefixes across Pandoc output.
 *
 * @param value Caption or title text.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
}

/**
 * Narrows an arbitrary value to a record.
 *
 * @param value Candidate JSON value.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Narrows an arbitrary value to an array.
 *
 * @param value Candidate JSON value.
 */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
