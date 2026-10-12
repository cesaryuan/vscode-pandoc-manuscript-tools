/** Finds authored attribute blocks, including unfinished input, without interpreting literal Markdown. */
import { collectMarkdownCodeSpanRanges } from "../parser";
import { getYamlHeader } from "../manuscriptStyle/document";

export type AttributeToken = { key: string; start: number; keyEnd: number; end: number;
  value?: string; valueStart?: number; valueEnd?: number; quote?: string; quotePrefix?: string; closed?: boolean };
export type AttributeGroup = { context: "table" | "emptySpan"; start: number; end: number; tokens: AttributeToken[]; outerQuote?: string };
type Range = { start: number; end: number };

/** Preserves absolute offsets while hiding frontmatter, code, comments, raw HTML and math. */
function sourceWithoutLiterals(text: string): string {
  const ranges: Range[] = [];
  const header = getYamlHeader(text, true);
  if (header) ranges.push({ start: 0, end: header.bodyStart });
  let fence = "";
  let displayMath = false;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const start = match.index;
    if (start < (header?.bodyStart ?? 0)) continue;
    const line = match[0];
    const delimiter = /^\s*(?:>\s*)?(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      ranges.push({ start, end: start + line.length });
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = "";
    } else if (delimiter) {
      fence = delimiter[1];
      ranges.push({ start, end: start + line.length });
    } else if (displayMath || /^\s*(?:\$\$|\\\[)/.test(line)) {
      ranges.push({ start, end: start + line.length });
      if (/^\s*\$\$/.test(line)) displayMath = (line.match(/(?<!\\)\$\$/g)?.length ?? 0) % 2 === 1 ? !displayMath : displayMath;
      else if (/^\s*\\\[/.test(line)) displayMath = !/\\\]/.test(line);
      else if (/\\\]/.test(line)) displayMath = false;
    } else if (/^(?: {4}|\t)/.test(line)) ranges.push({ start, end: start + line.length });
  }
  let source = maskRanges(text, ranges);
  const inline = [...collectMarkdownCodeSpanRanges(source)];
  for (const match of source.matchAll(/<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|(?<!\\)\$(?!\$)(?:\\.|[^$\r\n])+(?<!\\)\$/gi)) {
    inline.push({ start: match.index, end: match.index + match[0].length });
  }
  source = maskRanges(source, inline);
  return source;
}

/** Masks overlapping literal ranges in one pass without changing line boundaries. */
function maskRanges(text: string, ranges: Range[]): string {
  const sorted = ranges.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let offset = 0;
  for (const range of sorted) {
    if (range.end <= offset) continue;
    const start = Math.max(offset, range.start);
    parts.push(text.slice(offset, start), text.slice(start, range.end).replace(/[^\r\n]/g, " "));
    offset = range.end;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}

/** Distinguishes escaped delimiters from source markup, including doubled backslashes. */
function escaped(text: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && text[--offset] === "\\") count += 1;
  return count % 2 === 1;
}

/** Recognizes syntax contexts only; attribute names and directive types come from Papper. */
function contextAt(text: string, offset: number): AttributeGroup["context"] | undefined {
  const before = text.slice(Math.max(0, offset - 2), offset);
  if (before === "[]" && !escaped(text, offset - 2) && text[offset - 3] !== "!") return "emptySpan";
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  if (/^ {0,3}(?:>\s*)*(?::\s|Table\s*:)/i.test(prefix)
    && !/\{/.test(prefix)) return "table";
  return undefined;
}

/** Reads one attribute block with quoted braces, escaped quotes and incomplete keys/values. */
function readGroup(text: string, start: number, context: AttributeGroup["context"], limit: number, outerQuote?: string): AttributeGroup {
  const tokens: AttributeToken[] = [];
  let offset = start + 1;
  while (offset < limit && text[offset] !== "}") {
    if (/\s/.test(text[offset])) {
      if (/^\r?\n[ \t]*\r?\n/.test(text.slice(offset, offset + 100))) break;
      offset += 1;
      continue;
    }
    const tokenStart = offset;
    while (offset < limit && !/[\s={}]/.test(text[offset])) offset += 1;
    if (offset === tokenStart) { offset += 1; continue; }
    const token: AttributeToken = { key: text.slice(tokenStart, offset), start: tokenStart, keyEnd: offset, end: offset };
    while (offset < limit && /[ \t]/.test(text[offset])) offset += 1;
    if (text[offset] === "=") {
      offset += 1;
      while (offset < limit && /[ \t]/.test(text[offset])) offset += 1;
      // Story Markdown can escape the same quote used by its enclosing attribute.
      const quotePrefix = outerQuote && text[offset] === "\\" && text[offset + 1] === outerQuote ? "\\" : "";
      if (quotePrefix) offset += 1;
      const quote = text[offset] === '"' || text[offset] === "'" ? text[offset++] : undefined;
      token.quote = quote;
      token.quotePrefix = quotePrefix;
      token.valueStart = offset;
      const closing = quotePrefix + (quote ?? "");
      while (offset < limit && (quote ? !text.startsWith(closing, offset) || escaped(text, offset) : !/[\s{}]/.test(text[offset]))) {
        // An unfinished quote must not turn a later body paragraph into an attribute value.
        if (quote && /^\r?\n[ \t]*\r?\n/.test(text.slice(offset, offset + 100))) break;
        offset += 1;
      }
      token.valueEnd = offset;
      token.value = text.slice(token.valueStart, offset).replace(/\\(["'\\])/g, "$1");
      token.closed = !!quote && text.startsWith(closing, offset) && !escaped(text, offset);
      if (token.closed) offset += closing.length;
      token.end = offset;
    }
    tokens.push(token);
    if (token.quote && !token.closed) break;
  }
  return { context, start, end: offset, tokens, outerQuote };
}

/** Scans nested empty spans in quoted Markdown stories without confusing their outer attributes. */
function scanGroups(text: string, start: number, limit: number, depth = 0, outerQuote?: string): AttributeGroup[] {
  const groups: AttributeGroup[] = [];
  for (let offset = start; offset < limit; offset += 1) {
    if (text[offset] !== "{" || escaped(text, offset)) continue;
    const context = contextAt(text, offset);
    if (!context) continue;
    const group = readGroup(text, offset, context, limit, outerQuote);
    groups.push(group);
    if (depth < 4) {
      for (const token of group.tokens) {
        if (token.quote && token.valueStart !== undefined && token.valueEnd !== undefined) {
          groups.push(...scanGroups(text, token.valueStart, token.valueEnd, depth + 1, token.quote));
        }
      }
    }
    offset = group.end;
  }
  return groups;
}

/** Returns absolute source ranges for supported contexts, including a missing closing brace. */
export function getAttributeGroups(text: string): AttributeGroup[] {
  const source = sourceWithoutLiterals(text);
  return scanGroups(source, 0, source.length);
}
