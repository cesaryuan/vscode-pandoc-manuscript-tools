import type { HeadingEntry, LabelEntry, MathBlockEntry, ParsedPandocDocument } from "./parser";

export type CrossReferenceNumber = {
  kind: "section" | "figure" | "table" | "equation";
  label?: string;
  number: string;
  line: number;
  character: number;
};

type PandocNode = { t?: string; c?: unknown };
type AstNumberTarget = { node: PandocNode; label?: string; number?: string };

/**
 * Maps Pandoc-crossref numbers in a processed AST back to source positions.
 *
 * Pandoc's JSON writer does not preserve Markdown source locations, so labels
 * identify figures, tables, and equations while headings and unlabeled math
 * blocks use their source-order positions from the existing Markdown parser.
 *
 * @param ast Processed Pandoc JSON AST returned by `papper build json`.
 * @param parsed Parsed Markdown document with source ranges.
 */
export function collectPandocCrossReferenceNumbers(ast: unknown, parsed: ParsedPandocDocument): CrossReferenceNumber[] {
  const root = asRecord(ast);
  const blocks = root && Array.isArray(root.blocks) ? root.blocks : [];
  const metadata = asRecord(root?.meta) || {};
  const headers: AstNumberTarget[] = [];
  const figures: AstNumberTarget[] = [];
  const tables: AstNumberTarget[] = [];
  const equations: AstNumberTarget[] = [];

  walkAst(blocks, undefined, (node, parentLabel) => {
    if (node.t === "Header") {
      const content = asArray(node.c);
      headers.push({ node, label: getAttributeId(content?.[1]), number: getHeaderNumber(content?.[2]) });
    } else if (node.t === "Figure") {
      const content = asArray(node.c);
      figures.push({
        node,
        label: getAttributeId(content?.[0]),
        number: getCaptionNumber(content?.[1], metadata.figureTitle),
      });
    } else if (node.t === "Table") {
      const content = asArray(node.c);
      tables.push({
        node,
        label: getAttributeId(content?.[0]),
        number: getCaptionNumber(content?.[1], metadata.tableTitle),
      });
    } else if (node.t === "Math" && isDisplayMath(node.c)) {
      equations.push({ node, label: parentLabel, number: getEquationNumber(node.c) });
    }
  });

  const numbers: CrossReferenceNumber[] = [];
  const usedHeadings = new Set<HeadingEntry>();
  let headingCursor = 0;
  const sectionsAreNumbered = getMetaBoolean(metadata.numberSections);

  for (const target of headers) {
    const heading = takeHeading(parsed.headings, target.label, usedHeadings, headingCursor);
    if (!heading) {
      continue;
    }
    headingCursor = Math.max(headingCursor, parsed.headings.indexOf(heading) + 1);
    if (!sectionsAreNumbered || !target.number || isUnnumberedHeader(target.node)) {
      continue;
    }
    numbers.push({
      kind: "section",
      label: heading.label,
      number: target.number,
      line: heading.range.end.line,
      character: heading.range.end.character,
    });
  }

  appendLabeledBlockNumbers(figures, "fig", "figure", parsed.labels, numbers);
  appendLabeledBlockNumbers(tables, "tbl", "table", parsed.labels, numbers);
  appendEquationNumbers(equations, parsed.mathBlocks, numbers);
  return numbers.sort((left, right) => left.line - right.line || left.character - right.character);
}

/**
 * Visits Pandoc nodes under the document blocks while carrying a surrounding span label.
 *
 * @param value Current AST value.
 * @param parentLabel Label inherited from a surrounding span.
 * @param visit Callback for each Pandoc node.
 */
function walkAst(value: unknown, parentLabel: string | undefined, visit: (node: PandocNode, parentLabel?: string) => void): void {
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
 * Returns the identifier from a Pandoc Attr triple.
 *
 * @param value Pandoc `[identifier, classes, attributes]` tuple.
 */
function getAttributeId(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string" && value[0] ? value[0] : undefined;
}

/**
 * Reads the generated section number at the start of a Header's inline content.
 *
 * @param value Header inline list.
 */
function getHeaderNumber(value: unknown): string | undefined {
  const firstInline = asArray(value)?.[0];
  const node = asRecord(firstInline);
  if (node?.t !== "Str" || typeof node.c !== "string") {
    return undefined;
  }

  const number = node.c.replace(/\.$/, "");
  return /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)$/i.test(number) ? number : undefined;
}

/**
 * Checks whether Pandoc marked a heading as intentionally unnumbered.
 *
 * @param node Header AST node.
 */
function isUnnumberedHeader(node: PandocNode): boolean {
  const attr = asArray(node.c)?.[1];
  const classes = Array.isArray(attr) && Array.isArray(attr[1]) ? attr[1] : [];
  return classes.includes("unnumbered");
}

/**
 * Reads a figure or table number from the processed caption and its Pandoc-crossref title.
 *
 * @param value Caption pair containing a short caption and long caption blocks.
 * @param titleValue Pandoc metadata for `figureTitle` or `tableTitle`.
 */
function getCaptionNumber(value: unknown, titleValue: unknown): string | undefined {
  const caption = asArray(value);
  const blocks = Array.isArray(caption?.[1]) ? caption[1] : Array.isArray(caption?.[0]) ? caption[0] : [];
  const captionText = normalizeWhitespace(flattenAstText(blocks));
  const title = normalizeWhitespace(flattenAstText(titleValue)).trim();
  if (!title || !captionText.toLocaleLowerCase().startsWith(title.toLocaleLowerCase())) {
    return undefined;
  }

  const remainder = captionText.slice(title.length).trimStart();
  return remainder.match(/^((?:\d+(?:\.\d+)*|[ivxlcdm]+)(?:\s*\([a-z0-9]+\))?)/i)?.[1];
}

/**
 * Flattens caption inline content without including links, attributes, or target URLs.
 *
 * @param value Pandoc metadata, inline, or caption block value.
 */
function flattenAstText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(flattenAstText).join("");
  }

  const node = asRecord(value);
  if (!node || typeof node.t !== "string") {
    return "";
  }

  if (node.t === "Str" || node.t === "Math") {
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
  return flattenAstText(node.c);
}

/**
 * Normalizes whitespace to compare caption title prefixes across Pandoc output.
 *
 * @param value Caption or title text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
}

/**
 * Appends source-labeled figure or table numbers.
 *
 * @param targets Figure or table nodes from the AST.
 * @param prefix Expected Pandoc label prefix.
 * @param kind Inlay hint kind.
 * @param labels Parsed source labels.
 * @param numbers Output number collection.
 */
function appendLabeledBlockNumbers(
  targets: AstNumberTarget[],
  prefix: "fig" | "tbl",
  kind: "figure" | "table",
  labels: LabelEntry[],
  numbers: CrossReferenceNumber[],
): void {
  const used = new Set<LabelEntry>();
  for (const target of targets) {
    if (!target.label || !target.number) {
      continue;
    }
    const source = labels.find((entry) => entry.prefix === prefix && entry.label === target.label && !used.has(entry));
    if (!source) {
      continue;
    }
    used.add(source);
    numbers.push({
      kind,
      label: source.label,
      number: target.number,
      line: source.fullRange.end.line,
      character: source.fullRange.end.character,
    });
  }
}

/**
 * Maps displayed math nodes to their source equations and appends actual equation numbers.
 *
 * @param targets Math nodes from the AST.
 * @param mathBlocks Parsed display-math source ranges.
 * @param numbers Output number collection.
 */
function appendEquationNumbers(targets: AstNumberTarget[], mathBlocks: MathBlockEntry[], numbers: CrossReferenceNumber[]): void {
  const used = new Set<MathBlockEntry>();
  let nextMathBlock = 0;

  for (const target of targets) {
    let source = target.label
      ? mathBlocks.find((entry) => entry.label === target.label && !used.has(entry))
      : undefined;
    if (!source) {
      while (nextMathBlock < mathBlocks.length && used.has(mathBlocks[nextMathBlock])) {
        nextMathBlock += 1;
      }
      source = mathBlocks[nextMathBlock];
      nextMathBlock += 1;
    }
    if (!source) {
      continue;
    }
    used.add(source);
    if (!target.number) {
      continue;
    }
    numbers.push({
      kind: "equation",
      label: source.label,
      number: target.number,
      line: source.range.end.line,
      character: source.range.end.character,
    });
  }
}

/**
 * Returns a cross-reference number appended to a processed display-math TeX string.
 *
 * @param value Math node content.
 */
function getEquationNumber(value: unknown): string | undefined {
  const mathContent = asArray(value);
  if (typeof mathContent?.[1] !== "string") {
    return undefined;
  }
  return mathContent[1].match(/\\qquad\{\s*([^{}]+?)\s*\}\s*$/)?.[1];
}

/**
 * Checks whether a Pandoc Math node uses display math.
 *
 * @param value Math node content.
 */
function isDisplayMath(value: unknown): boolean {
  return asRecord(asArray(value)?.[0])?.t === "DisplayMath";
}

/**
 * Selects a source heading by explicit label or, for automatically labeled headings, source order.
 *
 * @param headings Parsed Markdown headings.
 * @param label AST heading identifier.
 * @param used Already matched headings.
 * @param startIndex Source-order fallback index.
 */
function takeHeading(headings: HeadingEntry[], label: string | undefined, used: Set<HeadingEntry>, startIndex: number): HeadingEntry | undefined {
  if (label) {
    const labeledHeading = headings.find((entry) => entry.label === label && !used.has(entry));
    if (labeledHeading) {
      used.add(labeledHeading);
      return labeledHeading;
    }
  }

  for (let index = startIndex; index < headings.length; index += 1) {
    if (!used.has(headings[index])) {
      used.add(headings[index]);
      return headings[index];
    }
  }
  return undefined;
}

/**
 * Reads a metadata boolean while preserving its explicit false value.
 *
 * @param value Pandoc MetaBool node.
 */
function getMetaBoolean(value: unknown): boolean {
  const meta = asRecord(value);
  return meta?.t === "MetaBool" && meta.c === true;
}

/**
 * Narrows an arbitrary value to a record.
 *
 * @param value Candidate JSON value.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Narrows an arbitrary value to an array.
 *
 * @param value Candidate JSON value.
 */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
