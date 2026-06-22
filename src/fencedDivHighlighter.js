"use strict";

const vscode = require("vscode");
const { getConfiguration } = require("./configuration");
const { isMarkdownDocument } = require("./vscodeUtils");

const DECORATION_COLORS = [
  {
    backgroundColor: "rgba(86, 156, 214, 0.10)",
    markerColor: "rgba(86, 156, 214, 0.80)",
  },
  {
    backgroundColor: "rgba(78, 201, 176, 0.10)",
    markerColor: "rgba(78, 201, 176, 0.80)",
  },
  {
    backgroundColor: "rgba(220, 220, 170, 0.11)",
    markerColor: "rgba(220, 220, 170, 0.85)",
  },
  {
    backgroundColor: "rgba(197, 134, 192, 0.10)",
    markerColor: "rgba(197, 134, 192, 0.85)",
  },
];
const SPAN_DECORATION_BACKGROUND = "rgba(255, 197, 92, 0.16)";

class FencedDivHighlighter {
  /**
   * Creates editor decorations for Pandoc fenced div blocks and bracketed spans.
   *
   * @param {import("./workspaceIndex").PandocWorkspaceIndex} index Workspace index.
   * @param {vscode.OutputChannel} output Output channel for useful diagnostics.
   */
  constructor(index, output) {
    this.index = index;
    this.output = output;
    this.decorationTypes = DECORATION_COLORS.map(createFencedDivDecorationType);
    this.spanDecorationType = createSpanDecorationType();
  }

  /**
   * Refreshes decorations in visible Markdown editors.
   *
   * @param {vscode.TextDocument=} changedDocument Optional changed document to refresh.
   */
  updateVisibleEditors(changedDocument) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!changedDocument || editor.document === changedDocument) {
        this.updateEditor(editor);
      }
    }
  }

  /**
   * Refreshes decorations in one editor.
   *
   * @param {vscode.TextEditor} editor Text editor.
   */
  updateEditor(editor) {
    const configuration = getConfiguration();
    const highlightFencedDivs = configuration.get("highlightFencedDivs", true);
    const highlightBracketedSpans = configuration.get("highlightBracketedSpans", true);
    if (!highlightFencedDivs && !highlightBracketedSpans) {
      this.clearEditor(editor);
      return;
    }

    if (!isMarkdownDocument(editor.document)) {
      this.clearEditor(editor);
      return;
    }

    try {
      this.applyDecorations(editor, highlightFencedDivs, highlightBracketedSpans);
    } catch (error) {
      this.output.appendLine(`Failed to highlight Pandoc visual syntax: ${String(error)}`);
      this.clearEditor(editor);
    }
  }

  /**
   * Clears decorations from every visible editor.
   */
  clearAllEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditor(editor);
    }
  }

  /**
   * Releases decoration resources.
   */
  dispose() {
    this.clearAllEditors();
    for (const decorationType of this.decorationTypes) {
      decorationType.dispose();
    }
    this.spanDecorationType.dispose();
  }

  /**
   * Applies Pandoc fenced div and bracketed span decorations to one editor.
   *
   * @param {vscode.TextEditor} editor Markdown editor.
   * @param {boolean} highlightFencedDivs Whether fenced div block highlights are enabled.
   * @param {boolean} highlightBracketedSpans Whether bracketed span highlights are enabled.
   */
  applyDecorations(editor, highlightFencedDivs, highlightBracketedSpans) {
    const parsed = this.index.getParsedDocument(editor.document);
    this.applyFencedDivDecorations(editor, parsed.fencedDivs, highlightFencedDivs);
    this.applySpanDecorations(editor, parsed.spans, highlightBracketedSpans);
  }

  /**
   * Applies nested fenced div decorations to one editor.
   *
   * @param {vscode.TextEditor} editor Markdown editor.
   * @param {import("./parser").FencedDivEntry[]} fencedDivs Parsed fenced div blocks.
   * @param {boolean} enabled Whether fenced div block highlights are enabled.
   */
  applyFencedDivDecorations(editor, fencedDivs, enabled) {
    const groupedRanges = this.decorationTypes.map(() => []);

    if (enabled) {
      for (const fencedDiv of fencedDivs) {
        const decorationIndex = fencedDiv.depth % this.decorationTypes.length;
        groupedRanges[decorationIndex].push(toWholeLineRange(editor.document, fencedDiv));
      }
    }

    for (let index = 0; index < this.decorationTypes.length; index += 1) {
      editor.setDecorations(this.decorationTypes[index], groupedRanges[index]);
    }
  }

  /**
   * Applies inline bracketed span decorations to one editor.
   *
   * @param {vscode.TextEditor} editor Markdown editor.
   * @param {import("./parser").SpanEntry[]} spans Parsed bracketed spans.
   * @param {boolean} enabled Whether bracketed span highlights are enabled.
   */
  applySpanDecorations(editor, spans, enabled) {
    const ranges = enabled ? spans.map(toInlineRange) : [];
    editor.setDecorations(this.spanDecorationType, ranges);
  }

  /**
   * Clears Pandoc visual syntax decorations from one editor.
   *
   * @param {vscode.TextEditor} editor Text editor.
   */
  clearEditor(editor) {
    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }
    editor.setDecorations(this.spanDecorationType, []);
  }
}

/**
 * Creates a whole-line decoration style for one nesting level.
 *
 * @param {{backgroundColor: string, markerColor: string}} colors Decoration colors.
 * @returns {vscode.TextEditorDecorationType}
 */
function createFencedDivDecorationType(colors) {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: colors.backgroundColor,
    overviewRulerColor: colors.markerColor,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
}

/**
 * Creates the inline decoration style for Pandoc bracketed spans.
 *
 * @returns {vscode.TextEditorDecorationType}
 */
function createSpanDecorationType() {
  return vscode.window.createTextEditorDecorationType({
    backgroundColor: SPAN_DECORATION_BACKGROUND,
  });
}

/**
 * Converts a fenced div parser range into a whole-line VS Code range.
 *
 * VS Code whole-line decorations still need a concrete range, so using column
 * zero on the start and end lines keeps empty closing fences highlighted too.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {import("./parser").FencedDivEntry} fencedDiv Parsed fenced div.
 * @returns {vscode.Range}
 */
function toWholeLineRange(document, fencedDiv) {
  const startLine = Math.max(0, Math.min(fencedDiv.range.start.line, document.lineCount - 1));
  const endLine = Math.max(startLine, Math.min(fencedDiv.range.end.line, document.lineCount - 1));
  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}

/**
 * Converts a parser range into a VS Code inline range.
 *
 * @param {import("./parser").SpanEntry} entry Parsed bracketed span.
 * @returns {vscode.Range}
 */
function toInlineRange(entry) {
  return new vscode.Range(
    entry.range.start.line,
    entry.range.start.character,
    entry.range.end.line,
    entry.range.end.character,
  );
}

module.exports = {
  FencedDivHighlighter,
};
