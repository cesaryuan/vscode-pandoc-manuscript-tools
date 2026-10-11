import { asArray, asRecord, flattenAstText, normalizeWhitespace, walkAst } from "./ast";
import type { SourceReference } from "./sourceReferences";

export type ReferenceHint = { labels: string[]; displayText: string; line: number; character: number };

/** Reads each marked reference's actual processed text, including citeproc clusters and unlinked crossrefs. */
export function collectRenderedReferences(ast: unknown, references: SourceReference[]): ReferenceHint[] {
  const sources = new Map(references.map((reference) => [reference.marker, reference]));
  const hints: ReferenceHint[] = [];
  walkAst(asRecord(ast)?.blocks, undefined, (node) => {
    if (node.t !== "Span") return;
    const content = asArray(node.c);
    const attributes = asArray(asArray(content?.[0])?.[2]);
    const marker = attributes?.map(asArray).find((attribute) => attribute?.[0] === "data-pmt-inlay-reference")?.[1];
    if (typeof marker !== "string") return;
    const source = sources.get(marker);
    if (!source) return;
    const displayText = normalizeWhitespace(flattenAstText(content?.[1])).trim();
    // Failed/disabled resolution must not echo the authored @token as a misleading hint.
    if (!displayText || displayText === normalizeWhitespace(source.sourceText).trim()
      || source.labels.some((label) => displayText.includes(`@${label}`))) return;
    hints.push({ labels: source.labels, displayText, line: source.line, character: source.character });
    sources.delete(marker);
  });
  return hints.sort((left, right) => left.line - right.line || left.character - right.character);
}
