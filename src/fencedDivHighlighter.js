"use strict";

const vscode = require("vscode");
const { getConfiguration } = require("./configuration");
const { isMarkdownDocument } = require("./vscodeUtils");

const DECORATION_COLORS = [
  {
    backgroundColor: "rgba(86, 156, 214, 0.10)",
    borderColor: "rgba(86, 156, 214, 0.80)",
  },
  {
    backgroundColor: "rgba(78, 201, 176, 0.10)",
    borderColor: "rgba(78, 201, 176, 0.80)",
  },
  {
    backgroundColor: "rgba(220, 220, 170, 0.11)",
    borderColor: "rgba(220, 220, 170, 0.85)",
  },
  {
    backgroundColor: "rgba(197, 134, 192, 0.10)",
    borderColor: "rgba(197, 134, 192, 0.85)",
  },
];

class FencedDivHighlighter {
  /**
   * Creates editor decorations for Pandoc fenced div blocks.
   *
   * @param {import("./workspaceIndex").PandocWorkspaceIndex} index Workspace index.
   * @param {vscode.OutputChannel} output Output channel for useful diagnostics.
   */
  constructor(index, output) {
    this.index = index;
    this.output = output;
    this.decorationTypes = DECORATION_COLORS.map(createFencedDivDecorationType);
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
    if (!getConfiguration().get("highlightFencedDivs", true)) {
      this.clearEditor(editor);
      return;
    }

    if (!isMarkdownDocument(editor.document)) {
      this.clearEditor(editor);
      return;
    }

    try {
      this.applyDecorations(editor);
    } catch (error) {
      this.output.appendLine(`Failed to highlight Pandoc fenced divs: ${String(error)}`);
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
  }

  /**
   * Applies nested fenced div decorations to one editor.
   *
   * @param {vscode.TextEditor} editor Markdown editor.
   */
  applyDecorations(editor) {
    const parsed = this.index.getParsedDocument(editor.document);
    const groupedRanges = this.decorationTypes.map(() => []);

    for (const fencedDiv of parsed.fencedDivs) {
      const decorationIndex = fencedDiv.depth % this.decorationTypes.length;
      groupedRanges[decorationIndex].push(toWholeLineRange(editor.document, fencedDiv));
    }

    for (let index = 0; index < this.decorationTypes.length; index += 1) {
      editor.setDecorations(this.decorationTypes[index], groupedRanges[index]);
    }
  }

  /**
   * Clears fenced div decorations from one editor.
   *
   * @param {vscode.TextEditor} editor Text editor.
   */
  clearEditor(editor) {
    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }
  }
}

/**
 * Creates a whole-line decoration style for one nesting level.
 *
 * @param {{backgroundColor: string, borderColor: string}} colors Decoration colors.
 * @returns {vscode.TextEditorDecorationType}
 */
function createFencedDivDecorationType(colors) {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: colors.backgroundColor,
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    borderColor: colors.borderColor,
    overviewRulerColor: colors.borderColor,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
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

module.exports = {
  FencedDivHighlighter,
};
