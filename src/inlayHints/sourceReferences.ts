import { randomUUID } from "node:crypto";
import { collectMarkdownCodeSpanRanges, parsePandocDocument } from "../parser";

export type SourceReference = { marker: string; labels: string[]; sourceText: string; line: number; character: number };
export type PreparedReferenceSource = { markdown: string; references: SourceReference[] };
type OffsetRange = { start: number; end: number };
const CITATION = /(?<![A-Za-z0-9_@])(-?@)((?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+|[\p{L}\p{N}_][\p{L}\p{N}_:.#$%&+?<>~/-]*)/gu;

/** Marks reference expressions only in a temporary build snapshot, retaining original hint positions. */
export function prepareReferenceSource(text: string): PreparedReferenceSource {
  const masked = maskLiteralContent(text);
  const brackets = collectBracketRanges(masked);
  const tokens = [...masked.matchAll(CITATION)].map((match) => {
    // Sentence punctuation is not part of a Pandoc citation identifier.
    const label = match[2].replace(/[.:?!]+$/, "");
    return { start: match.index, end: match.index + match[1].length + label.length, label };
  });
  const lines = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lines.push(index + 1);
  const references: SourceReference[] = [];
  const edits: Array<OffsetRange & { marker: string }> = [];
  const nonce = randomUUID();
  let consumedUntil = -1;

  for (const token of tokens) {
    if (token.start < consumedUntil) continue;
    // Keep a citation cluster intact so citeproc can collapse ranges and retain locators/prefixes.
    const enclosing = brackets.find((range) => range.start < token.start && range.end >= token.end
      && text[range.start - 1] !== "!" && !/^[([{]/.test(text[range.end] ?? ""));
    const start = enclosing?.start ?? token.start;
    let end = enclosing?.end ?? token.end;
    if (!enclosing) {
      const suffixStart = end + (masked.slice(end).match(/^[ \t]*/)?.[0].length ?? 0);
      const suffix = brackets.find((range) => range.start === suffixStart);
      // Author-in-text locators belong to the citation; a following independent citation does not.
      if (suffix && /^\[\s*(?:p{1,2}\.|pages?\b|chap(?:ter)?\.?\b|sec(?:tion)?\.?\b|vol(?:ume)?\.?\b|no\.|\d)/i.test(text.slice(suffix.start, suffix.end))
        && !tokens.some((entry) => entry.start >= suffix.start && entry.start < suffix.end)) end = suffix.end;
    }
    const attributes = text.slice(end).match(/^\{[^}\r\n]*\}/);
    if (attributes) end += attributes[0].length;
    const labels = tokens.filter((entry) => entry.start >= start && entry.end <= end).map((entry) => entry.label);
    const marker = `${nonce}:${references.length}`;
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= end) low = middle;
      else high = middle;
    }
    references.push({ marker, labels, sourceText: text.slice(start, end), line: low, character: end - lines[low] });
    edits.push({ start, end, marker });
    consumedUntil = end;
  }

  let markdown = "";
  let cursor = 0;
  for (const edit of edits) {
    markdown += text.slice(cursor, edit.start) + `<span data-pmt-inlay-reference="${edit.marker}">`
      + text.slice(edit.start, edit.end) + "</span>";
    cursor = edit.end;
  }
  markdown += text.slice(cursor);
  return { markdown, references };
}

/** Masks non-prose regions without shifting offsets or rewriting line endings. */
function maskLiteralContent(text: string): string {
  const characters = text.split("");
  /** Removes an ignored range while keeping original source coordinates. */
  const mask = (start: number, end: number): void => {
    for (let index = start; index < end; index++) if (!/[\r\n]/.test(characters[index])) characters[index] = " ";
  };
  let offset = 0;
  let fence = "";
  let yaml = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(text);
  for (const line of text.split(/(?<=\n)/)) {
    const content = line.replace(/[\r\n]+$/, "");
    const match = content.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (yaml) {
      mask(offset, offset + line.length);
      if (offset > 0 && /^(?:---|\.\.\.)\s*$/.test(content)) yaml = false;
    } else if (fence) {
      mask(offset, offset + line.length);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = "";
    } else if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = match[1];
      mask(offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(content) || /^\s*\[[^\]]+\]:\s*\S/.test(content)) {
      mask(offset, offset + line.length);
    }
    offset += line.length;
  }
  let masked = characters.join("");
  for (const comment of masked.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) mask(comment.index, comment.index + comment[0].length);
  masked = characters.join("");
  for (const code of collectMarkdownCodeSpanRanges(masked)) mask(code.start, code.end);
  masked = characters.join("");
  const parsed = parsePandocDocument(masked);
  const lineOffsets = [0];
  for (let index = 0; index < masked.length; index++) if (masked[index] === "\n") lineOffsets.push(index + 1);
  for (const math of [...parsed.mathBlocks, ...parsed.inlineMath]) {
    const range = "fullRange" in math ? math.fullRange : math.range;
    mask(lineOffsets[range.start.line] + range.start.character, lineOffsets[range.end.line] + range.end.character);
  }
  masked = characters.join("");
  // Attributes, raw tags, URLs, and escaped tokens are literal, even when they contain @ characters.
  for (const literal of masked.matchAll(/<[^>\r\n]*>|\{[^}\r\n]*\}|\]\([^\r\n]*?\)|\\[^\r\n]/g)) {
    // Keep the closing link-text bracket available to the bracket scanner.
    const start = literal.index + (literal[0].startsWith("](") ? 1 : 0);
    mask(start, literal.index + literal[0].length);
  }
  return characters.join("");
}

/** Pairs nested Markdown brackets and returns inner ranges first for citation expressions. */
function collectBracketRanges(text: string): OffsetRange[] {
  const stack: number[] = [];
  const ranges: OffsetRange[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "[") stack.push(index);
    else if (text[index] === "]" && stack.length) ranges.push({ start: stack.pop()!, end: index + 1 });
    else if (text[index] === "\n" && /^\s*\n/.test(text.slice(index + 1))) stack.length = 0;
  }
  return ranges;
}
