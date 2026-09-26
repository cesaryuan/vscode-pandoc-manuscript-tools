import * as vscode from "vscode";
import { parsePandocDocument, type HeadingEntry, type InlineMathEntry, type MathBlockEntry } from "../parser";

/** Block categories emitted when a user clicks the Papper HTML preview. */
export type HtmlPreviewClickBlockType = "paragraph" | "heading" | "math" | "image" | "table" | "caption";

/** Message sent from the WebView after a rendered block is clicked. */
export type HtmlPreviewClickMessage = {
  type?: string;
  blockType?: HtmlPreviewClickBlockType;
  label?: string;
  text?: string;
  caption?: string;
  alt?: string;
  tex?: string;
  display?: boolean;
  blockId?: string;
};

/** Describes one rendered block that can be associated with Markdown source. */
export type HtmlPreviewBlockDescriptor = HtmlPreviewClickMessage & {
  blockId: string;
};

/** Source range returned for a rendered preview block. */
export type HtmlPreviewBlockMapping = {
  blockId: string;
  startLine: number;
  endLine: number;
};

/** Message sent by the WebView when its rendered block list is ready to map. */
export type HtmlPreviewBlocksMessage = {
  type: "previewBlocks";
  blocks: HtmlPreviewBlockDescriptor[];
};

type SourceTarget = {
  range: vscode.Range;
  reason: string;
};

type SourceBlock = {
  kind: "paragraph" | "image" | "table" | "caption";
  startLine: number;
  endLine: number;
  text: string;
  normalized: string;
};

/** Navigates from a clicked rendered preview block to the source Markdown. */
export class HtmlPreviewClickNavigation {
  private previewMappings?: { uri: string; version: number; mappings: Map<string, HtmlPreviewBlockMapping> };

  /** Creates a click navigator with the shared extension output channel. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Opens the preview source and reveals the best matching Markdown range. */
  async handlePreviewClick(previewUri: vscode.Uri | undefined, message: HtmlPreviewClickMessage) {
    if (message.type !== "previewBlockClick" || !previewUri) {
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(previewUri);
    } catch (error) {
      this.output.appendLine(`[HTML][click] source document could not be opened: ${String(error)}`);
      return;
    }

    const target = this.resolvePreviewSourceTarget(document, message);
    if (!target) {
      this.output.appendLine(`[HTML][click] no source match type=${message.blockType || "unknown"} label=${message.label || "none"}`);
      return;
    }

    const currentEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: currentEditor?.viewColumn || vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    editor.selection = new vscode.Selection(target.range.start, target.range.end);
    editor.revealRange(target.range, vscode.TextEditorRevealType.AtTop);
    this.output.appendLine(`[HTML][click] preview -> editor type=${message.blockType || "unknown"} line=${target.range.start.line + 1} reason=${target.reason}`);
  }

  /** Resolves a rendered preview block to a Markdown range for clicks and scroll mapping. */
  resolvePreviewSourceTarget(document: vscode.TextDocument, message: HtmlPreviewClickMessage): SourceTarget | undefined {
    const cached = message.blockId && this.previewMappings
      && this.previewMappings.uri === document.uri.toString()
      && this.previewMappings.version === document.version
      ? this.previewMappings.mappings.get(message.blockId)
      : undefined;
    if (cached) {
      return { range: sourceRange(document, cached.startLine, cached.endLine), reason: "mapped-block" };
    }
    return findPreviewSourceTarget(document, message);
  }

  /** Maps rendered preview blocks in source order using one parser pass per update. */
  mapPreviewBlocks(document: vscode.TextDocument, blocks: HtmlPreviewBlockDescriptor[]): HtmlPreviewBlockMapping[] {
    const parsed = parsePandocDocument(document.getText(), document.uri.toString());
    const sourceBlocks = collectSourceBlocks(document.getText());
    const mappings: HtmlPreviewBlockMapping[] = [];
    let previousSourceLine = -1;
    for (const block of blocks) {
      const target = findPreviewSourceTarget(document, block, { parsed, sourceBlocks, minimumLine: previousSourceLine });
      if (!target) {
        continue;
      }
      const startLine = target.range.start.line;
      const endLine = target.range.end.line;
      mappings.push({ blockId: block.blockId, startLine, endLine });
      previousSourceLine = Math.max(previousSourceLine, startLine);
    }
    this.previewMappings = {
      uri: document.uri.toString(),
      version: document.version,
      mappings: new Map(mappings.map((mapping) => [mapping.blockId, mapping])),
    };
    return mappings;
  }
}

type PreviewMatchContext = {
  parsed: ReturnType<typeof parsePandocDocument>;
  sourceBlocks: SourceBlock[];
  minimumLine?: number;
};

/** Finds the source range corresponding to a rendered preview click. */
function findPreviewSourceTarget(document: vscode.TextDocument, message: HtmlPreviewClickMessage, context?: PreviewMatchContext): SourceTarget | undefined {
  const parsed = context?.parsed || parsePandocDocument(document.getText(), document.uri.toString());
  const labeledTarget = findLabeledSourceTarget(document, parsed, message.label);
  if (labeledTarget) {
    return labeledTarget;
  }

  if (message.blockType === "math") {
    return findFormulaSourceTarget(document, parsed.mathBlocks, parsed.inlineMath, message, context?.minimumLine);
  }
  if (message.blockType === "heading") {
    return findHeadingSourceTarget(document, parsed.headings, message.text, context?.minimumLine);
  }
  if (message.blockType === "image" || message.blockType === "caption" || message.blockType === "table") {
    return findMediaOrTableSourceTarget(document, message, context?.sourceBlocks, context?.minimumLine);
  }
  return findParagraphSourceTarget(document, message.text || message.caption || message.alt, context?.sourceBlocks, context?.minimumLine);
}

/** Resolves a stable Pandoc label before attempting fuzzy text matching. */
function findLabeledSourceTarget(document: vscode.TextDocument, parsed: ReturnType<typeof parsePandocDocument>, labelText: string | undefined): SourceTarget | undefined {
  const label = normalizeLabel(labelText);
  if (!label) {
    return undefined;
  }

  const heading = parsed.headings.find((entry) => entry.label === label);
  if (heading) {
    return { range: sourceRange(document, heading.range.start.line, heading.range.end.line), reason: `label=${label}` };
  }

  const mathBlock = parsed.mathBlocks.find((entry) => entry.label === label);
  if (mathBlock) {
    return { range: sourceRange(document, mathBlock.line, mathBlock.endLine), reason: `label=${label}` };
  }

  const labelEntry = parsed.labels.find((entry) => entry.label === label);
  if (labelEntry) {
    return { range: sourceRange(document, labelEntry.line, labelEntry.line), reason: `label=${label}` };
  }

  // HTML figure/table IDs are common in generated output but are not always
  // present in the Markdown parser's label scan. Keep a bounded raw-line
  // fallback for source files that use an explicit HTML id attribute.
  const lines = document.getText().split(/\r?\n/);
  const idPattern = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(label)}["']`, "i");
  const idLine = lines.findIndex((line) => idPattern.test(line));
  return idLine >= 0 ? { range: sourceRange(document, idLine, idLine), reason: `html-id=${label}` } : undefined;
}

/** Matches a clicked formula against labeled, display, and inline source math. */
function findFormulaSourceTarget(document: vscode.TextDocument, mathBlocks: MathBlockEntry[], inlineMath: InlineMathEntry[], message: HtmlPreviewClickMessage, minimumLine = -1): SourceTarget | undefined {
  const formula = normalizeFormula(message.tex || message.text || "");
  if (!formula) {
    return undefined;
  }

  const candidates = (message.display === false ? inlineMath : message.display === true ? mathBlocks : [...mathBlocks, ...inlineMath])
    .filter((entry) => entry.range.start.line > minimumLine);
  const exact = candidates.find((entry) => normalizeFormula(entry.tex) === formula);
  if (exact) {
    return { range: sourceRange(document, exact.range.start.line, exact.range.end.line), reason: "formula" };
  }

  // Pandoc may inject spacing or a display wrapper before the HTML is
  // rendered. Removing only those wrappers preserves TeX semantics while
  // recovering the source location for otherwise equivalent formulas.
  const relaxedFormula = normalizeFormula(formula, true);
  const relaxed = candidates.find((entry) => normalizeFormula(entry.tex, true) === relaxedFormula);
  return relaxed
    ? { range: sourceRange(document, relaxed.range.start.line, relaxed.range.end.line), reason: "formula-relaxed" }
    : undefined;
}

/** Matches a heading by its rendered text when no section label is available. */
function findHeadingSourceTarget(document: vscode.TextDocument, headings: HeadingEntry[], text: string | undefined, minimumLine = -1): SourceTarget | undefined {
  const normalized = normalizeVisibleText(text || "");
  if (!normalized) {
    return undefined;
  }

  const orderedHeadings = headings.filter((entry) => entry.range.start.line > minimumLine);
  const heading = orderedHeadings.find((entry) => normalizeHeadingText(entry.title) === normalizeHeadingText(text || ""))
    || orderedHeadings.find((entry) => normalizeHeadingText(entry.title).includes(normalizeHeadingText(text || "")) || normalizeHeadingText(text || "").includes(normalizeHeadingText(entry.title)));
  return heading
    ? { range: sourceRange(document, heading.range.start.line, heading.range.end.line), reason: "heading-text" }
    : undefined;
}

/** Matches images, figures, tables, and captions by their source text. */
function findMediaOrTableSourceTarget(document: vscode.TextDocument, message: HtmlPreviewClickMessage, sourceBlocks?: SourceBlock[], minimumLine = -1): SourceTarget | undefined {
  const blocks = (sourceBlocks || collectSourceBlocks(document.getText())).filter((block) => block.startLine > minimumLine);
  const caption = normalizeCaptionText(message.caption || message.text || "");
  const alt = normalizeCaptionText(message.alt || "");

  if (message.blockType === "image" || message.blockType === "caption") {
    const image = blocks.find((block) => block.kind === "image" && alt && normalizeCaptionText(extractImageAlt(block.text)) === alt)
      || blocks.find((block) => block.kind === "image" && caption && normalizeCaptionText(extractImageAlt(block.text)) === caption);
    if (image) {
      return { range: sourceRange(document, image.startLine, image.endLine), reason: "image-alt" };
    }
  }

  if (message.blockType === "table" || message.blockType === "caption") {
    const tableCaption = blocks.find((block) => block.kind === "caption" && caption && normalizeCaptionText(block.text) === caption);
    if (tableCaption) {
      return { range: sourceRange(document, tableCaption.startLine, tableCaption.endLine), reason: "table-caption" };
    }
  }

  const text = message.text || message.caption || message.alt;
  return findBestSourceBlockTarget(document, blocks, text, message.blockType === "table" ? "table" : undefined);
}

/** Matches a normal rendered paragraph against Markdown block text. */
function findParagraphSourceTarget(document: vscode.TextDocument, text: string | undefined, sourceBlocks?: SourceBlock[], minimumLine = -1): SourceTarget | undefined {
  return findBestSourceBlockTarget(document, (sourceBlocks || collectSourceBlocks(document.getText())).filter((block) => block.startLine > minimumLine), text, "paragraph");
}

/** Selects the strongest normalized text match among source blocks. */
function findBestSourceBlockTarget(document: vscode.TextDocument, blocks: SourceBlock[], text: string | undefined, preferredKind?: SourceBlock["kind"]): SourceTarget | undefined {
  const normalized = normalizeVisibleText(text || "");
  if (!normalized) {
    return undefined;
  }

  const candidates = blocks.filter((block) => !preferredKind || block.kind === preferredKind);
  const exact = candidates.find((block) => block.normalized === normalized);
  if (exact) {
    return { range: sourceRange(document, exact.startLine, exact.endLine), reason: `${exact.kind}-text` };
  }

  const contained = candidates
    .filter((block) => block.normalized.includes(normalized) || normalized.includes(block.normalized))
    .sort((left, right) => Math.abs(left.normalized.length - normalized.length) - Math.abs(right.normalized.length - normalized.length))[0];
  return contained
    ? { range: sourceRange(document, contained.startLine, contained.endLine), reason: `${contained.kind}-text-contained` }
    : undefined;
}

/** Builds source blocks while keeping formulas, tables, and images out of prose matching. */
function collectSourceBlocks(text: string): SourceBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: SourceBlock[] = [];
  let currentKind: SourceBlock["kind"] | undefined;
  let currentStart = -1;
  let currentLines: string[] = [];
  let inYaml = lines[0]?.trim() === "---";
  let inFence = false;
  let fenceMarker = "";
  let inDisplayMath = false;

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

    if (inDisplayMath) {
      if (/^\s*(?:\$\$|\\\])/.test(line)) {
        inDisplayMath = false;
      }
      continue;
    }
    if (/^\s*(?:\$\$|\\\[)/.test(line)) {
      flush();
      inDisplayMath = true;
      continue;
    }

    if (!trimmed || /^\s*#{1,6}\s+/.test(line)) {
      flush();
      continue;
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

/** Creates a range that covers complete source lines without exceeding document bounds. */
function sourceRange(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const safeStart = Math.max(0, Math.min(document.lineCount - 1, startLine));
  const safeEnd = Math.max(safeStart, Math.min(document.lineCount - 1, endLine));
  return new vscode.Range(safeStart, 0, safeEnd, document.lineAt(safeEnd).text.length);
}

/** Normalizes a Pandoc label while rejecting empty or malformed identifiers. */
function normalizeLabel(label: string | undefined): string | undefined {
  const normalized = label?.trim();
  return normalized && /^(?:sec|fig|tbl|eq):/.test(normalized) ? normalized : undefined;
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
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)(?:\{[^}]*\})?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[@[^\]]+\]/g, " ")
    .replace(/@(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/(^|[^$])\$(?!\$)[^$\n]+\$(?!\$)/g, "$1 ")
    .replace(/\{#[^}]+\}/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]/g, " ")
    .replace(/\\([\\`*_{}\[\]()])/g, "$1")
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

/** Escapes a string before placing it in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
