import type { PlainPosition, PlainRange } from "../parser";

export type CommentSyntax = { lineComments: string[]; blockComments: [string, string][] };
export type CommentTextDocument = { lineCount: number; lineAt(line: number): { text: string } };
export type CommentParagraph = { text: string; range: PlainRange };
type CommentSpan = { start: number; end: number; bodyStart: number; bodyEnd: number; open: string; close?: string };

/** Extracts comment paragraphs from a bounded window without parsing strings or requesting a language server. */
export class CommentParagraphScanner {
  private readonly firstLine: number;
  private readonly lastLine: number;
  private readonly lines: string[] = [];
  private readonly offsets: number[] = [];
  private readonly text: string;
  private readonly hoverOffset: number;

  /** Reads only the hovered line and at most scanLines lines on either side. */
  constructor(
    private readonly document: CommentTextDocument,
    private readonly position: PlainPosition,
    private readonly syntax: CommentSyntax,
    scanLines = 30,
  ) {
    this.firstLine = Math.max(0, position.line - scanLines);
    this.lastLine = Math.min(document.lineCount - 1, position.line + scanLines);
    let offset = 0;
    for (let line = this.firstLine; line <= this.lastLine; line++) {
      const text = document.lineAt(line).text;
      this.offsets.push(offset);
      this.lines.push(text);
      offset += text.length + 1;
    }
    this.text = this.lines.join("\n");
    this.hoverOffset = this.offsets[position.line - this.firstLine] + position.character;
  }

  /** Finds the hovered comment and expands only its current paragraph. */
  find(): CommentParagraph | undefined {
    const spans = this.scanSpans();
    const index = spans.findIndex((span) => this.hoverOffset >= span.start && this.hoverOffset < span.end);
    if (index === -1) {
      return undefined;
    }
    return spans[index].close ? this.blockParagraph(spans[index]) : this.lineParagraph(spans, index);
  }

  /** Scans configured delimiters literally; comment-shaped text inside strings is intentionally eligible. */
  private scanSpans(): CommentSpan[] {
    const delimiters = [
      ...this.syntax.lineComments.filter(Boolean).map((open) => ({ open, close: undefined as string | undefined })),
      ...this.syntax.blockComments.filter(([open, close]) => open && close).map(([open, close]) => ({ open, close })),
    ];
    const spans: CommentSpan[] = [];
    let cursor = 0;
    while (cursor < this.text.length) {
      let next: { start: number; open: string; close?: string } | undefined;
      for (const delimiter of delimiters) {
        const start = this.text.indexOf(delimiter.open, cursor);
        // Lua --[[ and PowerShell <# must win over shorter line-comment prefixes.
        if (start !== -1 && (!next || start < next.start || (start === next.start && delimiter.open.length > next.open.length))) {
          next = { start, ...delimiter };
        }
      }
      if (!next) {
        break;
      }
      const bodyStart = next.start + next.open.length;
      const boundary = this.text.indexOf(next.close || "\n", bodyStart);
      const bodyEnd = boundary === -1 ? this.text.length : boundary;
      const end = bodyEnd + (boundary !== -1 && next.close ? next.close.length : 0);
      spans.push({ ...next, bodyStart, bodyEnd, end });
      cursor = end + (next.close ? 0 : 1);
    }
    return spans;
  }

  /** Joins adjacent standalone line comments, stopping at empty comments or code lines. */
  private lineParagraph(spans: CommentSpan[], index: number): CommentParagraph | undefined {
    let first = index;
    let last = index;
    const hovered = spans[index];
    if (!this.lineBody(hovered)) {
      return undefined;
    }
    if (this.isStandalone(hovered)) {
      while (first > 0 && this.areAdjacentLines(spans[first - 1], spans[first])) {
        first--;
      }
      while (last + 1 < spans.length && this.areAdjacentLines(spans[last], spans[last + 1])) {
        last++;
      }
    }
    // A window boundary must not silently truncate a long continuous paragraph.
    if ((this.firstLine > 0 && this.localLine(spans[first].start) === 0)
      || (this.lastLine + 1 < this.document.lineCount && this.localLine(spans[last].end) === this.lines.length - 1)) {
      return undefined;
    }
    return {
      text: spans.slice(first, last + 1).map((span) => this.lineBody(span)).join("\n"),
      range: { start: this.toPosition(spans[first].start), end: this.toPosition(spans[last].end) },
    };
  }

  /** Checks whether two comment spans belong to the same standalone paragraph. */
  private areAdjacentLines(left: CommentSpan, right: CommentSpan): boolean {
    return !left.close && !right.close && left.open === right.open
      && this.localLine(left.start) + 1 === this.localLine(right.start)
      && this.isStandalone(left) && this.isStandalone(right)
      && Boolean(this.lineBody(left)) && Boolean(this.lineBody(right));
  }

  /** Distinguishes standalone comments from trailing comments, which must not collect nearby code. */
  private isStandalone(span: CommentSpan): boolean {
    return !this.text.slice(this.offsets[this.localLine(span.start)], span.start).trim();
  }

  /** Removes line markers, including repeated slashes used by documentation comments. */
  private lineBody(span: CommentSpan): string {
    return this.text.slice(span.bodyStart, span.bodyEnd).replace(/^[/#;!%]+(?=\s|$)/, "").trim();
  }

  /** Splits a block comment or Python triple-quoted text into paragraphs around blank content lines. */
  private blockParagraph(span: CommentSpan): CommentParagraph | undefined {
    const firstBodyLine = this.localLine(span.bodyStart);
    const lastBodyLine = this.localLine(span.bodyEnd);
    const bodies: string[] = [];
    for (let line = firstBodyLine; line <= lastBodyLine; line++) {
      const start = Math.max(span.bodyStart, this.offsets[line]);
      const end = Math.min(span.bodyEnd, this.offsets[line] + this.lines[line].length);
      const body = this.text.slice(start, end);
      bodies.push((span.open === "/*" ? body.replace(/^\s*\*(?!\/)[ \t]?/, "") : body).trim());
    }
    let selected = this.position.line - this.firstLine - firstBodyLine;
    if (!bodies[selected]) {
      // Hovering a delimiter-only line uses the adjacent paragraph; internal blank lines remain boundaries.
      if (this.localLine(this.hoverOffset) === this.localLine(span.start)) {
        selected = bodies.findIndex(Boolean);
      } else if (this.localLine(this.hoverOffset) === this.localLine(span.end)) {
        selected = bodies.length - 1;
        while (selected >= 0 && !bodies[selected]) {
          selected--;
        }
      }
    }
    if (selected < 0 || !bodies[selected]) {
      return undefined;
    }
    let first = selected;
    let last = selected;
    while (first > 0 && bodies[first - 1]) {
      first--;
    }
    while (last + 1 < bodies.length && bodies[last + 1]) {
      last++;
    }
    const start = Math.min(this.offsets[firstBodyLine + first], this.hoverOffset);
    const end = Math.max(this.offsets[firstBodyLine + last] + this.lines[firstBodyLine + last].length, this.hoverOffset + 1);
    // Suppress a paragraph cut off by the lower scan limit, but allow an unfinished block at EOF.
    if (lastBodyLine === this.lines.length - 1 && last === bodies.length - 1
      && span.bodyEnd === this.text.length && this.lastLine + 1 < this.document.lineCount) {
      return undefined;
    }
    return {
      text: bodies.slice(first, last + 1).join("\n"),
      range: { start: this.toPosition(Math.max(span.start, start)), end: this.toPosition(Math.min(span.end, end)) },
    };
  }

  /** Converts a window offset to its local line index. */
  private localLine(offset: number): number {
    let line = this.offsets.length - 1;
    while (line > 0 && this.offsets[line] > offset) {
      line--;
    }
    return line;
  }

  /** Maps a window offset back to a document position. */
  private toPosition(offset: number): PlainPosition {
    const line = this.localLine(offset);
    return { line: this.firstLine + line, character: offset - this.offsets[line] };
  }
}

/** Allows short English comments while retaining the existing length cap and tolerance for brief Chinese notes. */
export function isTranslatableCommentText(text: string, maxCharacters: number): boolean {
  const latin = text.match(/[A-Za-z]/g)?.length || 0;
  const cjk = text.match(/[\u3400-\u9FFF]/g)?.length || 0;
  return (!Number.isFinite(maxCharacters) || text.length <= maxCharacters)
    && latin >= 6 && (text.match(/[A-Za-z]{2,}/g)?.length || 0) >= 2
    && cjk / (latin + cjk) < 0.3;
}
