export type OffsetRange = { start: number; end: number };
export type SourceLine = OffsetRange & { text: string; number: number; next: number };
export type AttributeValue = { key: string; value: string; start: number; end: number };
export type AttributeBlock = OffsetRange & { id?: AttributeValue; classes: string[]; values: AttributeValue[] };
export type AttributeRead = { block?: AttributeBlock; next: number };
export type SpanSyntax = OffsetRange & { contentStart: number; contentEnd: number; attribute: AttributeBlock };
export type MathSyntax = OffsetRange & { contentStart: number; contentEnd: number; display: boolean; standalone?: boolean };
type BacktickRun = OffsetRange & { length: number; escaped?: boolean };

/** Parses Pandoc attributes once, retaining source positions and duplicate keys for ambiguity checks. */
export function readAttributeBlock(text: string, start: number, limit = text.length): AttributeRead {
  const block: AttributeBlock = { start, end: start, classes: [], values: [] };
  let index = start + 1;
  while (index < limit) {
    while (index < limit && /\s/.test(text[index])) index++;
    if (index >= limit) return { next: limit };
    if (text[index] === "}") {
      block.end = index + 1;
      return { block, next: block.end };
    }
    const tokenStart = index;
    if (text[index] === "#" || text[index] === ".") {
      const marker = text[index++];
      const valueStart = index;
      while (index < limit && !/[\s{}="']/.test(text[index])) index++;
      if (index === valueStart) return { next: Math.max(index, start + 1) };
      const value = text.slice(valueStart, index);
      if (marker === "#") {
        if (block.id) return { next: index };
        block.id = { key: "id", value, start: valueStart, end: index };
      } else block.classes.push(value);
    } else if (text[index] === "-" && /[\s}]/.test(text[index + 1] ?? "")) {
      block.classes.push("unnumbered");
      index++;
    } else {
      const keyStart = index;
      while (index < limit && /[\p{L}\p{N}_:-]/u.test(text[index])) index++;
      const key = text.slice(keyStart, index);
      while (index < limit && /[ \t]/.test(text[index])) index++;
      if (!key || text[index] !== "=") return { next: Math.max(index, start + 1) };
      index++;
      while (index < limit && /[ \t]/.test(text[index])) index++;
      const valueStart = index;
      let value: string;
      if (text[index] === '"' || text[index] === "'") {
        const quote = text[index++];
        const contentStart = index;
        // Quoted footer values may contain complete nested spans and escaped quotes.
        while (index < limit && text[index] !== quote) {
          if (text[index] === "\\" && index + 1 < limit) index += 2;
          else index++;
        }
        if (index >= limit) return { next: limit };
        value = text.slice(contentStart, index).replace(/\\(["'\\])/g, "$1");
        index++;
      } else {
        while (index < limit && !/[\s{}]/.test(text[index])) {
          if (text[index] === "\\" && index + 1 < limit) index += 2;
          else index++;
        }
        if (index === valueStart) return { next: Math.max(index, start + 1) };
        value = text.slice(valueStart, index);
      }
      block.values.push({ key, value, start: valueStart, end: index });
    }
    if (index === tokenStart || (index < limit && !/[\s}]/.test(text[index]))) return { next: index };
  }
  // An unfinished quoted attribute is consumed once rather than rescanned at each nested opener.
  return { next: limit };
}

/** Reads an attribute list supplied either by a Span or a brace-delimited Div. */
export function parseAttributeList(attributes: string): AttributeBlock | undefined {
  const source = attributes.trim();
  const wrapped = source.startsWith("{") ? source : `{${source}}`;
  const result = readAttributeBlock(wrapped, 0);
  return result.block?.end === wrapped.length ? result.block : undefined;
}

/** Returns one exact, unambiguous attribute value without matching keys inside quoted values. */
export function getAttributeValue(attributes: string, key: string): string | undefined {
  const values = parseAttributeList(attributes)?.values.filter((value) => value.key === key);
  return values?.length === 1 ? values[0].value : undefined;
}

/** Splits all supported newline forms without losing UTF-16 offsets or a leading BOM. */
export function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\r" && text[index] !== "\n") continue;
    const next = index + (text[index] === "\r" && text[index + 1] === "\n" ? 2 : 1);
    lines.push({ text: text.slice(start, index), number: lines.length, start, end: index, next });
    start = next;
    index = next - 1;
  }
  lines.push({ text: text.slice(start), number: lines.length, start, end: text.length, next: text.length });
  return lines;
}

/** Masks syntax without moving offsets; range merging prevents nested literals from duplicating text. */
export function maskSourceRanges(text: string, ranges: OffsetRange[]): string {
  const sorted = [...ranges].sort(compareRanges);
  const parts: string[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, range.start);
    if (range.end <= start) continue;
    parts.push(text.slice(cursor, start), text.slice(start, range.end).replace(/[^\r\n]/g, " "));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Orders source ranges for masking and cursor lookup. */
function compareRanges(left: OffsetRange, right: OffsetRange): number {
  return left.start - right.start || right.end - left.end;
}

/** Builds escape parity in one pass, avoiding quadratic scans through consecutive backslashes. */
function escapeFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length);
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    flags[index] = Number(escaped);
    escaped = text[index] === "\\" ? !escaped : false;
  }
  return flags;
}

/** Indexes matching backtick runs in reverse; unmatched openers cannot suppress later valid code. */
function backtickPairs(text: string, escaped: Uint8Array, boundaries: Set<number>): Map<number, BacktickRun> {
  const runs: Array<BacktickRun | undefined> = [];
  for (let index = 0; index < text.length;) {
    if (boundaries.has(index)) runs.push(undefined);
    if (text[index] !== "`") { index++; continue; }
    const start = index;
    while (text[index] === "`") index++;
    runs.push({ start, end: index, length: index - start, escaped: !!escaped[start] });
  }
  const pairs = new Map<number, BacktickRun>();
  const nearest = new Map<number, BacktickRun>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    if (!run) { nearest.clear(); continue; }
    const next = nearest.get(run.length);
    // Backslashes are literal inside code, so even an escaped run can close an existing code span.
    if (next && !run.escaped) pairs.set(run.start, next);
    nearest.set(run.length, run);
  }
  return pairs;
}

/** Collects complete code spans across soft breaks, stopping at paragraph and block boundaries. */
export function collectCodeSpanRanges(text: string): OffsetRange[] {
  const lines = sourceLines(text);
  const boundaries = paragraphBoundaries(lines);
  const pairs = backtickPairs(text, escapeFlags(text), boundaries);
  const ranges: OffsetRange[] = [];
  for (const [start, closing] of [...pairs.entries()].sort(comparePairs)) {
    if (ranges.length && start < ranges[ranges.length - 1].end) continue;
    ranges.push({ start, end: closing.end });
  }
  return ranges;
}

/** Orders precomputed delimiters by source position. */
function comparePairs(left: [number, BacktickRun], right: [number, BacktickRun]): number {
  return left[0] - right[0];
}

/** Prevents inline delimiters from binding across blank lines, headings or explicit block fences. */
function paragraphBoundaries(lines: SourceLine[]): Set<number> {
  const boundaries = new Set<number>();
  for (const line of lines) {
    if (!line.text.trim() || /^ {0,3}(?:>[ \t]?)*(?:#{1,6}\s|`{3,}|~{3,}|:{3,}|(?:[-*_]\s*){3,}$)/.test(line.text)) {
      boundaries.add(line.start);
      boundaries.add(line.next);
    }
  }
  return boundaries;
}

/** Shares block/inline context for labels, references, math, highlights and style actions. */
export class MarkdownSyntax {
  readonly lines: SourceLine[];
  readonly literalRanges: OffsetRange[] = [];
  readonly attributeRecoveryRanges: OffsetRange[] = [];
  readonly codeRanges: OffsetRange[] = [];
  readonly attributes: AttributeBlock[] = [];
  readonly spans: SpanSyntax[] = [];
  readonly math: MathSyntax[] = [];
  readonly rawTags: OffsetRange[] = [];
  readonly destinations: OffsetRange[] = [];
  readonly divLines: SourceLine[] = [];
  readonly headingLines: SourceLine[] = [];
  private readonly escaped: Uint8Array;
  private readonly pairs: Map<number, BacktickRun>;
  private readonly limits: number[];
  private readonly closers = new Map<string, number[]>();

  /** Precomputes delimiter lookups, then visits each eligible source region once. */
  constructor(readonly text: string) {
    this.lines = sourceLines(text);
    this.escaped = escapeFlags(text);
    const boundaries = paragraphBoundaries(this.lines);
    this.pairs = backtickPairs(text, this.escaped, boundaries);
    this.limits = new Array(this.lines.length);
    let limit = text.length;
    for (let index = this.lines.length - 1; index >= 0; index--) {
      const line = this.lines[index];
      if (boundaries.has(line.next)) limit = line.end;
      this.limits[index] = limit;
      if (boundaries.has(line.start)) limit = line.start;
    }
    this.indexMathClosers();
    this.scan();
  }

  /** Converts an absolute UTF-16 offset into the original document coordinate. */
  position(offset: number): { line: number; character: number } {
    let low = 0;
    let high = this.lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.lines[middle].start <= offset) low = middle;
      else high = middle;
    }
    return { line: low, character: offset - this.lines[low].start };
  }

  /** Builds an end-exclusive range usable directly by VS Code. */
  range(start: number, end: number): { start: { line: number; character: number }; end: { line: number; character: number } } {
    return { start: this.position(start), end: this.position(end) };
  }

  /** Produces reference-searchable prose with all literals and escaped punctuation removed. */
  prose(): string {
    return maskSourceRanges(this.text, [...this.literalRanges, ...this.attributeRecoveryRanges, ...this.attributes, ...this.math]);
  }

  /** Indexes potential math closers once; binary lookup avoids rescanning malformed prefixes. */
  private indexMathClosers(): void {
    for (const key of ["$", "$$", "\\)", "\\]"]) this.closers.set(key, []);
    for (let index = 0; index < this.text.length; index++) {
      if (this.escaped[index]) continue;
      if (this.text[index] === "$") {
        if (this.text[index + 1] === "$") { this.closers.get("$$").push(index++); }
        else this.closers.get("$").push(index);
      } else if (this.text[index] === "\\" && /[)\]]/.test(this.text[index + 1] ?? "")) {
        this.closers.get(this.text.slice(index, index + 2)).push(index++);
      }
    }
  }

  /** Finds a matching closer within the same prose block using a sorted delimiter index. */
  private closingMath(key: string, start: number, limit: number): number | undefined {
    const positions = this.closers.get(key);
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < start) low = middle + 1;
      else high = middle;
    }
    const result = positions[low];
    return result !== undefined && result < limit ? result : undefined;
  }

  /** Scans block syntax before inline syntax so literal content cannot open headings or Divs. */
  private scan(): void {
    const brackets: Array<{ start: number; image: boolean }> = [];
    let lineIndex = 0;
    let fence = "";
    let fenceQuoteDepth = 0;
    let previousBlank = true;
    let indentedCode = false;
    let listIndent: number | undefined;
    let yaml = /^(?:\uFEFF)?---[ \t]*$/.test(this.lines[0].text);
    let previousBracket: { start: number; image: boolean; end: number } | undefined;
    for (let index = 0; index < this.text.length;) {
      while (lineIndex + 1 < this.lines.length && index >= this.lines[lineIndex].next) lineIndex++;
      const line = this.lines[lineIndex];
      if (index === line.start) {
        if (lineIndex && this.limits[lineIndex - 1] <= index) brackets.length = 0;
        const quotePrefix = /^ {0,3}(?:>[ \t]?)+/.exec(line.text)?.[0] ?? "";
        const quoteDepth = [...quotePrefix.matchAll(/>/g)].length;
        const content = line.text.slice(quotePrefix.length);
        const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(content);
        if (yaml) {
          if (lineIndex > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.text)) yaml = false;
          this.literalRanges.push({ start: index, end: line.end });
          previousBlank = true;
          index = line.next;
          continue;
        }
        // Leaving a quote ends its unfinished fence instead of hiding the rest of the document.
        if (fence && quoteDepth < fenceQuoteDepth) fence = "";
        if (fence) {
          if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = "";
          this.literalRanges.push({ start: index, end: line.end });
          previousBlank = true;
          index = line.next;
          continue;
        }
        if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
          fence = fenceMatch[1];
          fenceQuoteDepth = quoteDepth;
          this.literalRanges.push({ start: index, end: line.end });
          previousBlank = true;
          index = line.next;
          continue;
        }
        const indent = content.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
        const list = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
        if (list) listIndent = list[0].replace(/\t/g, "    ").length;
        else if (content.trim() && previousBlank && listIndent !== undefined && indent < listIndent) listIndent = undefined;
        const startsIndentedCode: boolean = !list && indent >= (listIndent ?? 0) + 4 && (previousBlank || indentedCode);
        indentedCode = startsIndentedCode || indentedCode && !content.trim();
        previousBlank = !content.trim() || /^ {0,3}(?:#{1,6}\s|:{3,})/.test(content);
        if (startsIndentedCode || /^ {0,3}\[[^\]]+\]:[ \t]*\S/.test(content)) {
          this.literalRanges.push({ start: index, end: line.end });
          index = line.next;
          continue;
        }
        if (/^\s*(?:\$\$|\\\[)\s*$/.test(line.text)) {
          previousBlank = true;
          index = this.scanDisplayBlock(lineIndex);
          continue;
        }
        if (/^ {0,3}#{1,6}\s/.test(line.text)) this.headingLines.push(line);
        if (/^\s*:{3,}/.test(line.text)) this.divLines.push(line);
      }
      const character = this.text[index];
      if (character === "`" && !this.escaped[index]) {
        const closing = this.pairs.get(index);
        if (closing) {
          const code = { start: index, end: closing.end };
          this.codeRanges.push(code);
          this.literalRanges.push(code);
          index = code.end;
          continue;
        }
        while (this.text[index] === "`") index++;
        continue;
      }
      if (this.text.startsWith("<!--", index) && !this.escaped[index]) {
        const end = this.text.indexOf("-->", index + 4);
        const range = { start: index, end: end < 0 ? this.text.length : end + 3 };
        this.literalRanges.push(range);
        index = range.end;
        continue;
      }
      if (character === "{" && !this.escaped[index]) {
        const read = readAttributeBlock(this.text, index, this.limits[lineIndex]);
        if (read.block) {
          this.attributes.push(read.block);
          if (previousBracket?.end === index && !previousBracket.image) {
            this.spans.push({ start: previousBracket.start, end: read.block.end,
              contentStart: previousBracket.start + 1, contentEnd: index - 1, attribute: read.block });
          }
          index = read.block.end;
          continue;
        }
        // Incomplete values stay literal while typing; consume examined text once to bound recovery cost.
        if (read.next > index + 1) {
          this.attributeRecoveryRanges.push({ start: index, end: read.next });
          index = read.next;
          continue;
        }
      }
      const math = character === "$" || character === "\\" ? this.readInlineMath(index, this.limits[lineIndex]) : undefined;
      if (math) {
        this.math.push(math);
        index = math.end;
        continue;
      }
      if (character === "<" && !this.escaped[index] && /[A-Za-z/!?]/.test(this.text[index + 1] ?? "")) {
        const end = this.tagEnd(index);
        if (end > index) {
          if (this.text[end - 1] === ">") this.rawTags.push({ start: index, end });
          this.literalRanges.push({ start: index, end });
          index = end;
          continue;
        }
      }
      if (character === "(" && this.text[index - 1] === "]" && !this.escaped[index]) {
        const end = this.destinationEnd(index, this.limits[lineIndex]);
        const destination = { start: index, end };
        this.destinations.push(destination);
        this.literalRanges.push(destination);
        index = end;
        continue;
      }
      if (character === "\\" && !this.escaped[index] && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(this.text[index + 1] ?? "")) {
        this.literalRanges.push({ start: index, end: index + 2 });
        index += 2;
        continue;
      }
      if (character === "[" && !this.escaped[index]) brackets.push({ start: index, image: this.text[index - 1] === "!" && !this.escaped[index - 1] });
      else if (character === "]" && !this.escaped[index]) {
        const opening = brackets.pop();
        previousBracket = opening ? { ...opening, end: index + 1 } : undefined;
      }
      index++;
    }
  }

  /** Reads soft-break math while respecting dollar whitespace/digit rules and delimiter escaping. */
  private readInlineMath(start: number, limit: number): MathSyntax | undefined {
    if (this.escaped[start]) return undefined;
    const source = this.text;
    let opener: string;
    let closer: string;
    let display = false;
    if (source[start] === "$") {
      if (source[start - 1] === "$" && !this.escaped[start - 1]) return undefined;
      display = source[start + 1] === "$";
      opener = closer = display ? "$$" : "$";
      if (!display && /\s/.test(source[start + 1] ?? " ")) return undefined;
    } else if (source.startsWith("\\(", start) || source.startsWith("\\[", start)) {
      opener = source.slice(start, start + 2);
      closer = opener === "\\(" ? "\\)" : "\\]";
      display = opener === "\\[";
    } else return undefined;
    const end = this.closingMath(closer, start + opener.length, limit);
    if (end === undefined || !source.slice(start + opener.length, end).trim()) return undefined;
    // A rejected dollar closer ends this attempt; skipping it would bind currency to unrelated later math.
    if (closer === "$" && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? ""))) return undefined;
    return { start, end: end + closer.length, contentStart: start + opener.length, contentEnd: end, display };
  }

  /** Keeps standalone math opaque even when its TeX contains Markdown fences or comments. */
  private scanDisplayBlock(lineIndex: number): number {
    const opening = this.lines[lineIndex];
    const delimiter = opening.text.trim() === "$$" ? "$$" : "\\]";
    let closing: SourceLine;
    for (let index = lineIndex + 1; index < this.lines.length; index++) {
      const line = this.lines[index];
      const trimmed = line.text.trimStart();
      if (!trimmed.startsWith(delimiter)) continue;
      const remainder = trimmed.slice(delimiter.length).trim();
      if (remainder && !parseAttributeList(remainder)) continue;
      closing = line;
      break;
    }
    const contentEnd = closing ? closing.start : this.text.length;
    const end = closing ? closing.start + closing.text.indexOf(delimiter) + delimiter.length : this.text.length;
    this.math.push({ start: opening.start, end, contentStart: opening.next, contentEnd, display: true, standalone: true });
    return end;
  }

  /** Reads raw tags/autolinks with quoted greater-than characters and opaque raw-code elements. */
  private tagEnd(start: number): number {
    let quote = "";
    for (let index = start + 1; index < this.text.length; index++) {
      const character = this.text[index];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") {
        const raw = /^<(pre|code|script|style|textarea)\b/i.exec(this.text.slice(start, index + 1));
        if (raw) {
          const closing = new RegExp(`</${raw[1]}\\s*>`, "gi");
          closing.lastIndex = index + 1;
          const match = closing.exec(this.text);
          return match ? match.index + match[0].length : this.text.length;
        }
        return index + 1;
      } else if (character === "\n" || character === "\r") return index;
    }
    // Consume an unfinished tag once; repeatedly trying each embedded '<' would rescan the same suffix.
    return this.text.length;
  }

  /** Consumes a balanced link destination once so URL tokens cannot enter reference indexes. */
  private destinationEnd(start: number, limit: number): number {
    let depth = 1;
    for (let index = start + 1; index < limit; index++) {
      if (this.escaped[index]) continue;
      if (this.text[index] === "(") depth++;
      else if (this.text[index] === ")" && --depth === 0) return index + 1;
    }
    return limit;
  }
}
