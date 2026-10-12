/** Finds authored attribute blocks, including unfinished input, without interpreting literal Markdown. */
import { MarkdownSyntax, maskSourceRanges } from "../markdownSyntax";

export type AttributeToken = { key: string; start: number; keyEnd: number; end: number;
  value?: string; valueStart?: number; valueEnd?: number; quote?: string; quotePrefix?: string; closed?: boolean };
export type AttributeGroup = { context: "table" | "emptySpan"; start: number; end: number; tokens: AttributeToken[]; outerQuote?: string };
/** Shares literal context with highlights and references while retaining unfinished attributes for completion. */
function sourceWithoutLiterals(text: string): string {
  const syntax = new MarkdownSyntax(text);
  return maskSourceRanges(text, [...syntax.literalRanges, ...syntax.math]);
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
