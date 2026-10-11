import type { HeadingEntry, LabelEntry, MathBlockEntry, ParsedPandocDocument } from "../parser";
import { asArray, asRecord, flattenAstText, getAttributeId, normalizeWhitespace, walkAst, type PandocNode } from "./ast";

export type CrossReferenceNumber = {
  kind: "section" | "figure" | "table" | "equation";
  label?: string;
  number: string;
  displayText?: string;
  line: number;
  character: number;
};

type CaptionNumber = { number: string; displayText: string };
type AstNumberTarget = { node: PandocNode; label?: string; number?: string; displayText?: string };

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
        ...getCaptionNumber(content?.[1], metadata.figureTitle, metadata.chapDelim),
      });
    } else if (node.t === "Table") {
      const content = asArray(node.c);
      tables.push({
        node,
        label: getAttributeId(content?.[0]),
        ...getCaptionNumber(content?.[1], metadata.tableTitle, metadata.chapDelim),
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
 * Reads a figure or table number and its rendered prefix from the processed caption.
 * Preserve the caption's prefix and spacing to fix hints that previously hard-coded `Fig.` and `Table`.
 *
 * @param value Caption pair containing a short caption and long caption blocks.
 * @param titleValue Pandoc metadata for `figureTitle` or `tableTitle`.
 * @param chapterDelimiterValue Configured separator between chapter and item numbers.
 */
function getCaptionNumber(value: unknown, titleValue: unknown, chapterDelimiterValue: unknown): CaptionNumber | undefined {
  const caption = asArray(value);
  const blocks = Array.isArray(caption?.[1]) ? caption[1] : Array.isArray(caption?.[0]) ? caption[0] : [];
  const captionText = normalizeWhitespace(flattenAstText(blocks)).trimStart();
  const title = normalizeWhitespace(flattenAstText(titleValue)).trim();
  // An explicitly empty title produces bare numbers; absent metadata cannot establish a caption prefix.
  if (titleValue === undefined || !captionText.toLocaleLowerCase().startsWith(title.toLocaleLowerCase())) {
    return undefined;
  }

  const remainder = captionText.slice(title.length).trimStart();
  // Chinese defaults use chapDelim="-"; matching only dots truncated 3-1, 3-2 and 3-3 to 3.
  const chapterDelimiter = normalizeWhitespace(flattenAstText(chapterDelimiterValue));
  const escapedDelimiter = chapterDelimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const separator = escapedDelimiter ? `(?:\\.|${escapedDelimiter})` : "\\.";
  const number = remainder.match(new RegExp(`^((?:\\d+(?:${separator}\\d+)*|[ivxlcdm]+)(?:\\s*\\([a-z0-9]+\\))?)`, "i"))?.[1];
  if (!number) {
    return undefined;
  }
  return { number, displayText: captionText.slice(0, captionText.length - remainder.length + number.length) };
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
      displayText: target.displayText,
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

