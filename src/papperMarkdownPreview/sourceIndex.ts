import { parsePandocDocument } from "../parser";

/** A source range independent of the VS Code host, with its matching explanation. */
export type PreviewSourceMatch = { startLine: number; endLine: number; reason: string; normalized?: string };

/** Visible fields needed for source lookup without retaining the rendered DOM. */
export type PreviewSourceQuery = { blockType?: string; label?: string; tex?: string; display?: boolean; text?: string; caption?: string; alt?: string };

/** Maintains ordered duplicate matches under normalized text, label, or formula keys. */
class OrderedSourceTargets {
  private readonly targets = new Map<string, PreviewSourceMatch[]>();

  /** Adds a source occurrence without losing repeated paragraphs or variables. */
  add(key: string, target: PreviewSourceMatch): void {
    const entries = this.targets.get(key);
    if (entries) entries.push(target);
    else this.targets.set(key, [target]);
  }

  /** Orders duplicate buckets once, including formulas collected from different syntax families. */
  finish(): void {
    for (const entries of this.targets.values()) {
      if (entries.length > 1) entries.sort((left, right) => left.startLine - right.startLine);
    }
  }

  /** Finds the first allowed occurrence in a single hash bucket using a binary lower bound. */
  after(key: string, minimumLine: number, predicate?: (target: PreviewSourceMatch) => boolean): PreviewSourceMatch | undefined {
    const entries = this.targets.get(key);
    if (!entries) return undefined;
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].startLine <= minimumLine) low = middle + 1;
      else high = middle;
    }
    if (!predicate) return entries[low];
    for (let index = low; index < entries.length; index++) {
      if (predicate(entries[index])) return entries[index];
    }
    return undefined;
  }
}

/** Parses and normalizes one immutable Markdown version for all preview lookups. */
export class HtmlPreviewSourceIndex {
  private readonly targets = new OrderedSourceTargets();
  private readonly headings: PreviewSourceMatch[] = [];

  /** Builds hash indexes once per version instead of rescanning prose for every HTML block. */
  constructor(text: string) {
    const parsed = parsePandocDocument(text);
    for (const heading of parsed.headings) {
      const target = { startLine: heading.range.start.line, endLine: heading.range.end.line, reason: "heading-text", normalized: normalizeHeadingText(heading.title) };
      this.headings.push(target);
      if (heading.label) this.targets.add(`heading-label:${heading.label}`, { ...target, reason: `label=${heading.label}` });
      this.targets.add(`heading:${target.normalized}`, target);
    }
    for (const entry of [...parsed.mathBlocks, ...parsed.inlineMath]) {
      const target = { startLine: entry.range.start.line, endLine: entry.range.end.line, reason: "formula" };
      const family = entry.display ? "display" : "inline";
      const formula = normalizeFormula(entry.tex);
      const relaxed = normalizeFormula(entry.tex, true);
      for (const key of [family, "all"]) {
        this.targets.add(`math:${key}:${formula}`, target);
        this.targets.add(`relaxed-math:${key}:${relaxed}`, { ...target, reason: "formula-relaxed" });
      }
      if (entry.display && "label" in entry && entry.label) this.targets.add(`math-label:${entry.label}`, { ...target, reason: `label=${entry.label}` });
    }
    for (const entry of parsed.labels) {
      this.targets.add(`label:${entry.label}`, { startLine: entry.line, endLine: entry.line, reason: `label=${entry.label}` });
    }
    const lines = text.split(/\r?\n/);
    // Raw HTML IDs previously caused a fresh getText/split/full-line scan on every miss.
    for (let line = 0; line < lines.length; line++) {
      for (const match of lines[line].matchAll(/\bid\s*=\s*["']((?:sec|fig|tbl|eq):[^"']+)["']/gi)) {
        this.targets.add(`html-id:${match[1]}`, { startLine: line, endLine: line, reason: `html-id=${match[1]}` });
      }
    }
    for (const block of collectSourceBlocks(text, parsed.mathBlocks)) {
      const target = { startLine: block.startLine, endLine: block.endLine, normalized: block.normalized, reason: `${block.kind}-text` };
      for (const kind of [block.kind, "all"]) {
        this.targets.add(`text:${kind}:${block.normalized}`, target);
        // An 80-character bucket keeps the conservative prefix fallback local.
        if (block.normalized.length >= 80) this.targets.add(`prefix:${kind}:${block.normalized.slice(0, 80)}`, { ...target, reason: `${block.kind}-text-prefix` });
      }
      if (block.kind === "image") this.targets.add(`image-alt:${normalizeCaptionText(extractImageAlt(block.text))}`, { ...target, reason: "image-alt" });
      if (block.kind === "caption") this.targets.add(`table-caption:${normalizeCaptionText(block.text)}`, { ...target, reason: "table-caption" });
    }
    this.targets.finish();
  }

  /** Resolves a rendered descriptor with hash lookups and ordered duplicate selection. */
  find(message: PreviewSourceQuery, minimumLine = -1): PreviewSourceMatch | undefined {
    const label = message.label?.trim();
    if (label && /^(?:sec|fig|tbl|eq):/.test(label)) {
      for (const category of ["heading-label", "math-label", "label", "html-id"]) {
        const target = this.targets.after(`${category}:${label}`, minimumLine);
        if (target) return target;
      }
    }
    if (message.blockType === "math") {
      const formula = normalizeFormula(message.tex || message.text || "");
      if (!formula) return undefined;
      const family = message.display === true ? "display" : message.display === false ? "inline" : "all";
      return this.targets.after(`math:${family}:${formula}`, minimumLine)
        || this.targets.after(`relaxed-math:${family}:${normalizeFormula(formula, true)}`, minimumLine);
    }
    if (message.blockType === "heading") {
      const normalized = normalizeHeadingText(message.text || "");
      if (!normalized) return undefined;
      // Only unusual generated heading names need a scan of the small heading list.
      return this.targets.after(`heading:${normalized}`, minimumLine)
        || this.headings.find((entry) => entry.startLine > minimumLine && entry.normalized
          && (entry.normalized.includes(normalized) || normalized.includes(entry.normalized)));
    }
    const media = message.blockType === "image" || message.blockType === "caption" || message.blockType === "table";
    const caption = media ? normalizeCaptionText(message.caption || message.text || "") : "";
    if (message.blockType === "image" || message.blockType === "caption") {
      const alt = normalizeCaptionText(message.alt || "");
      const image = (alt && this.targets.after(`image-alt:${alt}`, minimumLine))
        || (caption && this.targets.after(`image-alt:${caption}`, minimumLine));
      if (image) return image;
    }
    if ((message.blockType === "table" || message.blockType === "caption") && caption) {
      const target = this.targets.after(`table-caption:${caption}`, minimumLine);
      if (target) return target;
    }
    const kind = message.blockType === "table" ? "table"
      : message.blockType === "image" || message.blockType === "caption" ? "all" : "paragraph";
    const normalized = normalizeVisibleText(message.text || message.caption || message.alt || "");
    if (!normalized) return undefined;
    return this.targets.after(`text:${kind}:${normalized}`, minimumLine)
      || (normalized.length >= 80 ? this.targets.after(`prefix:${kind}:${normalized.slice(0, 80)}`, minimumLine,
        (entry) => entry.normalized!.startsWith(normalized)) : undefined);
  }
}

type SourceBlock = {
  kind: "paragraph" | "image" | "table" | "caption";
  startLine: number;
  endLine: number;
  text: string;
  normalized: string;
};

/** Builds source blocks while keeping formulas, tables, and images out of prose matching. */
function collectSourceBlocks(text: string, mathBlocks = parsePandocDocument(text).mathBlocks): SourceBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: SourceBlock[] = [];
  // Reuse the parser's complete formula ranges: treating $$...$$ or escaped
  // bibliography brackets (\[1\]) as openers used to hide subsequent prose.
  const standaloneMath = mathBlocks.filter((entry) => entry.line !== entry.endLine
    || (!lines[entry.line].slice(0, entry.range.start.character).trim()
      && /^\s*(?:\{[^}]*\})?\s*$/.test(lines[entry.endLine].slice(entry.range.end.character))));
  let mathIndex = 0;
  let currentKind: SourceBlock["kind"] | undefined;
  let currentStart = -1;
  let currentLines: string[] = [];
  let inYaml = lines[0]?.trim() === "---";
  let inFence = false;
  let fenceMarker = "";

  /** Completes the current block before a syntax boundary starts the next one. */
  const flush = () => {
    if (currentKind && currentStart >= 0 && currentLines.length > 0) {
      const blockText = currentLines.join("\n");
      blocks.push({
        kind: currentKind,
        startLine: currentStart,
        endLine: currentStart + currentLines.length - 1,
        text: blockText,
        normalized: normalizeVisibleText(blockText),
      });
    }
    currentKind = undefined;
    currentStart = -1;
    currentLines = [];
  };

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const trimmed = line.trim();
    if (inYaml) {
      if (lineNumber > 0 && trimmed === "---") {
        inYaml = false;
      }
      continue;
    }

    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      flush();
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence || /^\s*<!--/.test(line)) {
      flush();
      continue;
    }

    while (mathIndex < standaloneMath.length && standaloneMath[mathIndex].endLine < lineNumber) {
      mathIndex += 1;
    }
    if (mathIndex < standaloneMath.length && standaloneMath[mathIndex].line <= lineNumber) {
      flush();
      continue;
    }

    if (!trimmed || /^\s*(?:>\s*)+$/.test(line) || /^\s*#{1,6}\s+/.test(line)) {
      flush();
      continue;
    }

    // Tight lists render each item as a separate clickable block even without
    // blank lines, so do not merge adjacent items into one source paragraph.
    if (/^\s*(?:[-+*]|(?:\d+|[A-Za-z])[.)]|\(\d+\)\.?)\s+/.test(line)) {
      flush();
    }
    const kind: SourceBlock["kind"] = /^\s*!\[[^\]]*\]\(/.test(line)
      ? "image"
      : /^\s*:\s+/.test(line)
        ? "caption"
        : /^\s*\|/.test(line)
          ? "table"
          : "paragraph";
    if (currentKind !== kind || (kind === "image" || kind === "caption")) {
      flush();
      currentKind = kind;
      currentStart = lineNumber;
    }
    currentLines.push(line);
  }
  flush();
  return blocks;
}

/** Extracts Markdown image alternative text for figure fallback matching. */
function extractImageAlt(text: string): string {
  return text.match(/!\[([^\]]*)\]\(/)?.[1] || "";
}

/** Normalizes TeX for matching without changing mathematical tokens. */
function normalizeFormula(value: string, relaxed = false): string {
  let normalized = value
    .replace(/\\(?:tag|label)\s*\{[^}]*\}/gi, "")
    .replace(/\s+/g, "")
    .normalize("NFKC");
  if (relaxed) {
    normalized = normalized
      .replace(/\\(?:left|right)\b/g, "")
      .replace(/\\!/g, "")
      .replace(/\\space\b/g, "");
  }
  return normalized;
}

/** Normalizes rendered and Markdown text for conservative block matching. */
function normalizeVisibleText(value: string): string {
  return value
    .replace(/^(?:\s*>\s*)+/gm, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)(?:\{[^}]*\})?/g, "$1")
    // Word-exported TOCs nest a page-number link inside the section link.
    // Unwrap the outer link first to avoid leaving its destination as prose.
    .replace(/\[([^\[\]]*(?:\[[^\[\]]*\]\([^)]*\)[^\[\]]*)+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[@[^\]]+\]/g, " ")
    .replace(/@(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+/g, " ")
    // Pandoc expands cross-reference tokens into visible labels such as
    // “Figure 14” and “Table 5”; remove those generated labels so source and
    // preview prose remain comparable without weakening block boundaries.
    .replace(/\b(?:figure|fig\.?|table|tbl\.?|equation|eq\.?|section|sec\.?|algorithm|alg\.?)\s*\d+(?:\.\d+)*(?:\s*(?:,|and)\s*\d+(?:\.\d+)*)*/gi, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/(^|[^$])\$(?!\$)[^$\n]+\$(?!\$)/g, "$1 ")
    .replace(/\{#[^}]+\}/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/`+([^`]+)`+/g, "$1")
    // Autolink URLs are visible reference text, unlike raw HTML tags.
    .replace(/<(https?:\/\/[^<>\s]+)>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]/g, " ")
    .replace(/\\([\\`*_{}\[\]().])/g, "$1")
    // Pandoc renders list markers outside the item's text node. Strip them
    // after Markdown escapes so literal headings like "1\\. Results" agree too.
    .replace(/^\s*(?:[-+*]|(?:\d+|[A-Za-z])[.)]|\(\d+\)\.?)\s+/gm, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Removes generated figure/table numbering before caption matching. */
function normalizeCaptionText(value: string): string {
  return normalizeVisibleText(value.replace(/^\s*(?:figure|fig\.?|table|tbl\.?|图|表)\s*\d+(?:\.\d+)*\s*/i, ""));
}

/** Removes generated section numbering before heading text matching. */
function normalizeHeadingText(value: string): string {
  return normalizeVisibleText(value.replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, ""));
}

