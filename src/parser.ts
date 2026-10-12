import { MarkdownSyntax, collectCodeSpanRanges, getAttributeValue, parseAttributeList, type AttributeBlock, type SourceLine } from "./markdownSyntax";

export const LABEL_PREFIXES = ["sec", "fig", "tbl", "eq"];
export type ParsedLine = { text: string; number: number; startOffset: number; endOffset: number };
export type PlainPosition = { line: number; character: number };
export type PlainRange = { start: PlainPosition; end: PlainPosition };
export type LabelEntry = { label: string; prefix: string; kind: string; source: string; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; containerRange?: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type ReferenceEntry = { label: string; prefix: string; kind: string; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type HeadingEntry = { title: string; label?: string; level: number; uriText: string; line: number; character: number; range: PlainRange; selectionRange: PlainRange; preview: string };
export type MathBlockEntry = { label?: string; display: true; uriText: string; line: number; endLine: number; range: PlainRange; selectionRange: PlainRange; tex: string };
export type InlineMathEntry = { tex: string; display: false; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type SpanEntry = { uriText: string; attributes: string; line: number; text: string; range: PlainRange; contentRange: PlainRange; attributeRange: PlainRange; offset: number; endOffset: number; preview: string };
export type LineExcerptFoldEntry = { uriText: string; line: number; text: string; range: PlainRange; fullRange: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type CodeSpanRange = { start: number; end: number };
export type FencedDivMarker = { type: "open" | "close"; fenceLength: number; attributeText?: string };
export type FencedDivEntry = { uriText: string; depth: number; attributes: string; closed: boolean; openingFenceLength: number; closingFenceLength?: number; range: PlainRange };
export type ParsedPandocDocument = { uriText: string; textLength: number; labels: LabelEntry[]; references: ReferenceEntry[]; headings: HeadingEntry[]; mathBlocks: MathBlockEntry[]; inlineMath: InlineMathEntry[]; fencedDivs: FencedDivEntry[]; spans: SpanEntry[]; lineExcerptFolds: LineExcerptFoldEntry[]; labelMap: Map<string, LabelEntry[]>; referenceMap: Map<string, ReferenceEntry[]> };
export type PandocTokenAtPosition = { type: "label"; entry: LabelEntry } | { type: "reference"; entry: ReferenceEntry };


const LABEL_SOURCE = /^(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+$/;
const REFERENCE_PATTERN = /(?<![A-Za-z0-9_@])@((?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+)/g;

/** Builds editor entries from shared syntax rather than independently interpreting Markdown context. */
class PandocDocumentBuilder {
  private readonly attributesByEnd = new Map<number, AttributeBlock>();
  private readonly labelsByAttribute = new Map<number, LabelEntry>();
  private readonly previews = new Map<number, string>();
  private readonly parsed: ParsedPandocDocument;

  /** Retains original UTF-16 offsets, URI and shared lexical context for one immutable source version. */
  constructor(private readonly text: string, private readonly uriText: string, private readonly syntax: MarkdownSyntax) {
    this.parsed = { uriText, textLength: text.length, labels: [], references: [], headings: [], mathBlocks: [],
      inlineMath: [], fencedDivs: [], spans: [], lineExcerptFolds: [], labelMap: new Map(), referenceMap: new Map() };
  }

  /** Generates all public collections and keyed indexes in source order. */
  build(): ParsedPandocDocument {
    for (const attribute of this.syntax.attributes) {
      this.attributesByEnd.set(attribute.end, attribute);
      if (attribute.id && LABEL_SOURCE.test(attribute.id.value)) {
        const id = attribute.id;
        const label = this.createLabel(id.value, id.start, id.end, attribute.start, attribute.end, 'markdown');
        this.parsed.labels.push(label);
        this.labelsByAttribute.set(attribute.start, label);
      }
    }
    this.collectHtmlDivs();
    this.collectReferences();
    this.collectHeadings();
    this.collectFencedDivs();
    this.collectMath();
    this.collectSpans();
    this.collectExcerptFolds();
    this.parsed.labels.sort(compareOffsets);
    this.parsed.spans.sort(compareOffsets);
    for (const label of this.parsed.labels) addToIndex(this.parsed.labelMap, label.label, label);
    for (const reference of this.parsed.references) addToIndex(this.parsed.referenceMap, reference.label, reference);
    return this.parsed;
  }

  /** Shares trimmed source previews so many entries on one long line do not repeatedly copy it. */
  private preview(offset: number): string {
    const { line } = this.syntax.position(offset);
    if (!this.previews.has(line)) this.previews.set(line, this.syntax.lines[line].text.trim());
    return this.previews.get(line);
  }

  /** Creates an exact label range independently of its enclosing attributes or raw HTML tag. */
  private createLabel(label: string, start: number, end: number, fullStart: number, fullEnd: number, source: string): LabelEntry {
    const position = this.syntax.position(start);
    return { label, prefix: getLabelPrefix(label), kind: getLabelKind(label), source, uriText: this.uriText,
      line: position.line, character: position.character, range: this.syntax.range(start, end),
      fullRange: this.syntax.range(fullStart, fullEnd), offset: start, endOffset: end, fullOffset: fullStart,
      fullEndOffset: fullEnd, preview: this.preview(start) };
  }

  /** Excludes literal contexts before matching references; attribute values cannot invent document references. */
  private collectReferences(): void {
    const prose = this.syntax.prose();
    for (const match of prose.matchAll(REFERENCE_PATTERN)) {
      const label = match[1].replace(/[.:]+$/, '');
      if (!LABEL_SOURCE.test(label)) continue;
      const start = match.index + 1;
      const end = start + label.length;
      const position = this.syntax.position(start);
      this.parsed.references.push({ label, prefix: getLabelPrefix(label), kind: getLabelKind(label), uriText: this.uriText,
        line: position.line, character: position.character, range: this.syntax.range(start, end),
        fullRange: this.syntax.range(match.index, end), offset: start, endOffset: end, fullOffset: match.index,
        fullEndOffset: end, preview: this.preview(start) });
    }
  }

  /** Uses the parsed trailing attribute ID, keeping classes and key/value pairs out of heading labels. */
  private collectHeadings(): void {
    for (const line of this.syntax.headingLines) {
      const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line.text);
      if (!match) continue;
      const raw = match[2];
      const titleStart = line.start + line.text.indexOf(raw, match[1].length);
      const trimmedEnd = line.start + line.text.trimEnd().length;
      const attribute = this.attributesByEnd.get(trimmedEnd);
      const titleEnd = attribute && attribute.start >= titleStart ? attribute.start : trimmedEnd;
      const title = this.text.slice(titleStart, titleEnd).replace(/[ \t]+#+[ \t]*$/, '').trimEnd();
      const label = attribute?.id?.value;
      this.parsed.headings.push({ title, label: label?.startsWith('sec:') ? label : undefined, level: match[1].length,
        uriText: this.uriText, line: line.number, character: titleStart - line.start,
        range: this.syntax.range(line.start, line.end), selectionRange: this.syntax.range(titleStart, titleStart + title.length),
        preview: this.preview(line.start) });
    }
  }

  /** Builds nested Div ranges only from delimiters visited outside code, comments and math. */
  private collectFencedDivs(): void {
    const stack: Array<{ line: SourceLine; marker: FencedDivMarker; depth: number }> = [];
    for (const line of this.syntax.divLines) {
      const marker = parseFencedDivMarker(line.text);
      if (!marker) continue;
      if (marker.type === 'open') stack.push({ line, marker, depth: stack.length });
      else {
        const opening = stack.pop();
        if (opening) this.addFencedDiv(opening, line, marker.fenceLength);
      }
    }
    const finalLine = this.syntax.lines[this.syntax.lines.length - 1];
    while (stack.length) this.addFencedDiv(stack.pop(), finalLine);
    this.parsed.fencedDivs.sort(compareDivLines);
  }

  /** Bounds unfinished Divs at EOF so editing an opener still produces a finite decoration. */
  private addFencedDiv(opening: { line: SourceLine; marker: FencedDivMarker; depth: number }, closing: SourceLine, closingLength?: number): void {
    this.parsed.fencedDivs.push({ uriText: this.uriText, depth: opening.depth, attributes: opening.marker.attributeText,
      closed: closingLength !== undefined, openingFenceLength: opening.marker.fenceLength, closingFenceLength: closingLength,
      range: this.syntax.range(opening.line.start, closing.end) });
  }

  /** Associates only adjacent equation attributes with math and retains soft-break source ranges. */
  private collectMath(): void {
    const attributesByStart = new Map<number, AttributeBlock>();
    for (const attribute of this.syntax.attributes) attributesByStart.set(attribute.start, attribute);
    for (const math of this.syntax.math) {
      const tex = this.text.slice(math.contentStart, math.contentEnd).trim();
      const position = this.syntax.position(math.start);
      if (!math.display) {
        if (!tex) continue;
        this.parsed.inlineMath.push({ tex, display: false, uriText: this.uriText, line: position.line, character: position.character,
          range: this.syntax.range(math.contentStart, math.contentEnd), fullRange: this.syntax.range(math.start, math.end),
          offset: math.contentStart, endOffset: math.contentEnd, fullOffset: math.start, fullEndOffset: math.end,
          preview: this.preview(math.start) });
        continue;
      }
      let attributeStart = math.end;
      while (/[ \t]/.test(this.text[attributeStart] ?? '')) attributeStart++;
      const attribute = attributesByStart.get(attributeStart);
      const candidate = attribute && this.labelsByAttribute.get(attribute.start);
      const label = candidate?.prefix === 'eq' ? candidate : undefined;
      if (label) label.source = 'math';
      const end = label ? attribute.end : math.end;
      const range = this.syntax.range(math.start, end);
      this.parsed.mathBlocks.push({ label: label?.label, display: true, uriText: this.uriText, line: position.line,
        endLine: range.end.line, range, selectionRange: label?.range ?? (math.standalone
          ? this.syntax.range(this.syntax.lines[position.line].start, this.syntax.lines[position.line].end) : range), tex });
    }
  }

  /** Exposes nested and multiline spans with independent content/attribute ranges for highlighting and folding. */
  private collectSpans(): void {
    for (const span of this.syntax.spans) {
      const position = this.syntax.position(span.start);
      this.parsed.spans.push({ uriText: this.uriText, attributes: this.text.slice(span.attribute.start + 1, span.attribute.end - 1).trim(),
        line: position.line, text: this.text.slice(span.contentStart, span.contentEnd), range: this.syntax.range(span.start, span.end),
        contentRange: this.syntax.range(span.contentStart, span.contentEnd), attributeRange: this.syntax.range(span.attribute.start, span.attribute.end),
        offset: span.start, endOffset: span.end, preview: this.preview(span.start) });
    }
  }

  /** Detects Line excerpts using already-scanned code ranges instead of repeating code delimiter searches. */
  private collectExcerptFolds(): void {
    for (const code of this.syntax.codeRanges) {
      const position = this.syntax.position(code.start);
      const line = this.syntax.lines[position.line];
      let prefixEnd = code.start;
      while (prefixEnd > line.start && /\s/.test(this.text[prefixEnd - 1])) prefixEnd--;
      if (this.text.slice(prefixEnd - 4, prefixEnd) !== 'Line') continue;
      let prefixStart = prefixEnd - 4;
      while (prefixStart > line.start && /\s/.test(this.text[prefixStart - 1])) prefixStart--;
      if (this.text[prefixStart - 1] !== '(') continue;
      let suffix = code.end;
      while (/\s/.test(this.text[suffix] ?? '')) suffix++;
      if (this.text[suffix] !== ')') continue;
      let contentStart = code.start;
      while (this.text[contentStart] === String.fromCharCode(96)) contentStart++;
      const contentEnd = code.end - (contentStart - code.start);
      if (contentEnd <= contentStart) continue;
      this.parsed.lineExcerptFolds.push({ uriText: this.uriText, line: position.line, text: this.text.slice(contentStart, contentEnd),
        range: this.syntax.range(contentStart, contentEnd), fullRange: this.syntax.range(code.start, code.end), offset: contentStart,
        endOffset: contentEnd, fullOffset: code.start, fullEndOffset: code.end, preview: this.preview(code.start) });
    }
  }

  /** Tracks real raw Div tags; tags printed inside code/comments never affect outline parenting. */
  private collectHtmlDivs(): void {
    const stack: Array<LabelEntry | undefined> = [];
    for (const tag of this.syntax.rawTags) {
      const raw = this.text.slice(tag.start, tag.end);
      if (/^<\/div\s*>$/i.test(raw)) {
        const label = stack.pop();
        if (label) label.containerRange = this.syntax.range(label.fullOffset, tag.end);
      } else if (/^<div\b/i.test(raw)) {
        // Consume all quoted attributes in order so an id-looking string inside title is not mistaken for the ID.
        const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
        let label: LabelEntry;
        for (const match of raw.matchAll(attributes)) {
          const value = match[2] ?? match[3] ?? match[4];
          if (match[1].toLowerCase() !== 'id' || !LABEL_SOURCE.test(value)) continue;
          const valueStart = tag.start + match.index + match[0].indexOf('=') + 1;
          const start = valueStart + this.text.slice(valueStart, tag.end).indexOf(value);
          label = this.createLabel(value, start, start + value.length, tag.start, tag.end, 'html-div');
          this.parsed.labels.push(label);
          break;
        }
        stack.push(label);
      }
    }
    while (stack.length) {
      const label = stack.pop();
      if (label) label.containerRange = this.syntax.range(label.fullOffset, this.text.length);
    }
  }
}

/** Parses supported Pandoc syntax into immutable editor entries with exact original source coordinates. */
export function parsePandocDocument(text: string, uriText = ''): ParsedPandocDocument {
  return parsePandocSyntax(new MarkdownSyntax(text), uriText);
}

/** Reuses one scanned source when a feature needs editor entries and additional lexical context. */
export function parsePandocSyntax(syntax: MarkdownSyntax, uriText = ''): ParsedPandocDocument {
  return new PandocDocumentBuilder(syntax.text, uriText, syntax).build();
}

/** Parses a Div opener/closer with the same quote-aware attributes used by spans and headings. */
function parseFencedDivMarker(line: string): FencedDivMarker | undefined {
  const match = /^\s*(:{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const fenceLength = match[1].length;
  if (!match[2].trim()) return { type: 'close', fenceLength };
  const attributeText = match[2].trim().replace(/\s*:{3,}\s*$/, '').trim();
  if (attributeText.startsWith('{')) {
    if (!parseAttributeList(attributeText)) return undefined;
  } else if (!/^[^\s{}:]+$/.test(attributeText)) return undefined;
  return { type: 'open', fenceLength, attributeText };
}

/** Recognizes one exact Revision Char attribute, excluding quoted lookalikes and duplicate overrides. */
export function isRevisionCharCustomStyle(attributes: string): boolean {
  return getAttributeValue(attributes, 'custom-style') === 'Revision Char';
}

/** Shares code-span matching with consumers outside the document builder. */
export function collectMarkdownCodeSpanRanges(text: string): CodeSpanRange[] {
  return collectCodeSpanRanges(text);
}

/** Orders nested entries by their actual source start. */
function compareOffsets(left: { offset: number }, right: { offset: number }): number {
  return left.offset - right.offset;
}

/** Orders completed and unfinished Divs by their opener. */
function compareDivLines(left: FencedDivEntry, right: FencedDivEntry): number {
  return left.range.start.line - right.range.start.line;
}

/** Appends duplicate occurrences without rebuilding maps during editor lookups. */
function addToIndex<T>(map: Map<string, T[]>, key: string, entry: T): void {
  const entries = map.get(key);
  if (entries) entries.push(entry);
  else map.set(key, [entry]);
}

/** Returns the semantic prefix used by cross-reference features. */
function getLabelPrefix(label: string): string {
  return label.split(':', 1)[0];
}

/** Describes the four manuscript label categories for editor UI. */
function getLabelKind(label: string): string {
  return ({ sec: 'Section', fig: 'Figure', tbl: 'Table', eq: 'Equation' } as Record<string, string>)[getLabelPrefix(label)] ?? 'Label';
}

/** Finds a real reference or label at an end-exclusive source position. */
export function findTokenAtPosition(parsed: ParsedPandocDocument, position: PlainPosition): PandocTokenAtPosition | undefined {
  const reference = parsed.references.find((entry) => containsPosition(entry.fullRange, position));
  if (reference) return { type: 'reference', entry: reference };
  const label = parsed.labels.find((entry) => containsPosition(entry.fullRange, position));
  return label ? { type: 'label', entry: label } : undefined;
}

/** Finds a display formula under the cursor without including adjacent prose. */
export function findMathBlockAtPosition(parsed: ParsedPandocDocument, position: PlainPosition): MathBlockEntry | undefined {
  return parsed.mathBlocks.find((entry) => containsPosition(entry.range, position));
}

/** Finds an inline formula under the cursor, including both delimiters. */
export function findInlineMathAtPosition(parsed: ParsedPandocDocument, position: PlainPosition): InlineMathEntry | undefined {
  return parsed.inlineMath.find((entry) => containsPosition(entry.fullRange, position));
}

/** Checks an end-exclusive source range; the first character after a token belongs to the following text. */
export function containsPosition(range: PlainRange, position: PlainPosition): boolean {
  return (position.line > range.start.line || position.line === range.start.line && position.character >= range.start.character)
    && (position.line < range.end.line || position.line === range.end.line && position.character < range.end.character);
}
