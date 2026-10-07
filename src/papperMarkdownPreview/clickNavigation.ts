import * as vscode from "vscode";
import { HtmlPreviewSourceIndex } from "./sourceIndex";

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

/** Navigates from a clicked rendered preview block to the source Markdown. */
export class HtmlPreviewClickNavigation {
  private previewMappings?: { uri: string; version: number; mappings: Map<string, HtmlPreviewBlockMapping> };
  private sourceCache?: { uri: string; version: number; index: HtmlPreviewSourceIndex; queries: Map<string, SourceTarget | undefined> };

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
      this.output.appendLine(`[HTML][click] No source match: type=${message.blockType || "unknown"}, block=${message.blockId || "none"}, text=${JSON.stringify((message.text || message.caption || message.alt || message.tex || "").slice(0, 120))}`);
      return;
    }

    const currentEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: currentEditor?.viewColumn || vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    editor.selection = new vscode.Selection(target.range.start, target.range.end);
    editor.revealRange(target.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
    const cache = this.getSourceCache(document);
    // Cache misses too: clicking an unresolvable citation must not parse the
    // same long document again, or repeat a costly fallback on every click.
    const key = JSON.stringify([message.blockType, message.label, message.tex, message.display, message.text, message.caption, message.alt]);
    if (cache.queries.has(key)) return cache.queries.get(key);
    const match = cache.index.find(message);
    const target = match ? { range: sourceRange(document, match.startLine, match.endLine), reason: match.reason } : undefined;
    cache.queries.set(key, target);
    return target;
  }

  /** Reuses one normalized index per document version for mapping and fallback clicks. */
  private getSourceCache(document: vscode.TextDocument) {
    const uri = document.uri.toString();
    if (!this.sourceCache || this.sourceCache.uri !== uri || this.sourceCache.version !== document.version) {
      this.sourceCache = { uri, version: document.version, index: new HtmlPreviewSourceIndex(document.getText()), queries: new Map() };
    }
    return this.sourceCache;
  }

  /** Maps rendered blocks using indexed lookup rather than a full source scan per block. */
  mapPreviewBlocks(document: vscode.TextDocument, blocks: HtmlPreviewBlockDescriptor[]): HtmlPreviewBlockMapping[] {
    const started = performance.now();
    const { index } = this.getSourceCache(document);
    const mappings: HtmlPreviewBlockMapping[] = [];
    let previousSourceLine = -1;
    for (const block of blocks) {
      const target = index.find(block, previousSourceLine);
      if (!target) {
        continue;
      }
      const startLine = target.startLine;
      const endLine = target.endLine;
      mappings.push({ blockId: block.blockId, startLine, endLine });
      // Advance past the complete source block so a later preview node cannot
      // be matched to a line inside an already mapped multi-line block.
      previousSourceLine = Math.max(previousSourceLine, endLine);
    }
    this.previewMappings = {
      uri: document.uri.toString(),
      version: document.version,
      mappings: new Map(mappings.map((mapping) => [mapping.blockId, mapping])),
    };
    const elapsed = performance.now() - started;
    if (elapsed >= 100) this.output.appendLine(`[HTML][mapping] ${mappings.length}/${blocks.length} blocks in ${elapsed.toFixed(1)} ms`);
    return mappings;
  }
}

/** Creates a range that covers complete source lines without exceeding document bounds. */
function sourceRange(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const safeStart = Math.max(0, Math.min(document.lineCount - 1, startLine));
  const safeEnd = Math.max(safeStart, Math.min(document.lineCount - 1, endLine));
  return new vscode.Range(safeStart, 0, safeEnd, document.lineAt(safeEnd).text.length);
}
