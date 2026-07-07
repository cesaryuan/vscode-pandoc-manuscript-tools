import * as vscode from "vscode";
import { getConfiguration } from "./configuration";
import { isPandocDocument } from "./vscodeUtils";

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

export class FencedDivHighlighter {
  declare index: import("./workspaceIndex").PandocWorkspaceIndex;
  declare output: import("vscode").OutputChannel;
  declare decorationTypes: import("vscode").TextEditorDecorationType[];
  declare spanDecorationType: import("vscode").TextEditorDecorationType;
  /**
   * Creates editor decorations for Pandoc fenced div blocks and bracketed spans.
   *
   * @param index Workspace index.
   * @param output Output channel for useful diagnostics.
   */
  constructor(index: import("./workspaceIndex").PandocWorkspaceIndex, output: vscode.OutputChannel) {
    this.index = index;
    this.output = output;
    this.decorationTypes = DECORATION_COLORS.map(createFencedDivDecorationType);
    this.spanDecorationType = createSpanDecorationType();
  }

  /**
   * Refreshes decorations in visible Markdown editors.
   *
   * @param changedDocument Optional changed document to refresh.
   */
  updateVisibleEditors(changedDocument: vscode.TextDocument | undefined = undefined) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!changedDocument || editor.document === changedDocument) {
        this.updateEditor(editor);
      }
    }
  }

  /**
   * Refreshes decorations in one editor.
   *
   * @param editor Text editor.
   */
  updateEditor(editor: vscode.TextEditor) {
    const configuration = getConfiguration();
    const highlightFencedDivs = configuration.get("highlightFencedDivs", true);
    const highlightBracketedSpans = configuration.get("highlightBracketedSpans", true);
    if (!highlightFencedDivs && !highlightBracketedSpans) {
      this.clearEditor(editor);
      return;
    }

    if (!isPandocDocument(editor.document)) {
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
   * @param editor Markdown editor.
   * @param highlightFencedDivs Whether fenced div block highlights are enabled.
   * @param highlightBracketedSpans Whether bracketed span highlights are enabled.
   */
  applyDecorations(editor: vscode.TextEditor, highlightFencedDivs: boolean, highlightBracketedSpans: boolean) {
    const parsed = this.index.getParsedDocument(editor.document);
    this.applyFencedDivDecorations(editor, parsed.fencedDivs, highlightFencedDivs);
    this.applySpanDecorations(editor, parsed.spans, highlightBracketedSpans);
  }

  /**
   * Applies nested fenced div decorations to one editor.
   *
   * @param editor Markdown editor.
   * @param fencedDivs Parsed fenced div blocks.
   * @param enabled Whether fenced div block highlights are enabled.
   */
  applyFencedDivDecorations(editor: vscode.TextEditor, fencedDivs: import("./parser").FencedDivEntry[], enabled: boolean) {
    const groupedRanges = this.decorationTypes.map((): vscode.Range[] => []);

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
   * @param editor Markdown editor.
   * @param spans Parsed bracketed spans.
   * @param enabled Whether bracketed span highlights are enabled.
   */
  applySpanDecorations(editor: vscode.TextEditor, spans: import("./parser").SpanEntry[], enabled: boolean) {
    const ranges = enabled ? spans.map(toInlineRange) : [];
    editor.setDecorations(this.spanDecorationType, ranges);
  }

  /**
   * Clears Pandoc visual syntax decorations from one editor.
   *
   * @param editor Text editor.
   */
  clearEditor(editor: vscode.TextEditor) {
    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }
    editor.setDecorations(this.spanDecorationType, []);
  }
}

/**
 * Creates a whole-line decoration style for one nesting level.
 *
 * @param colors Decoration colors.
 */
function createFencedDivDecorationType(colors: { backgroundColor: string; markerColor: string }): vscode.TextEditorDecorationType {
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
 */
function createSpanDecorationType(): vscode.TextEditorDecorationType {
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
 * @param document Markdown document.
 * @param fencedDiv Parsed fenced div.
 */
function toWholeLineRange(document: vscode.TextDocument, fencedDiv: import("./parser").FencedDivEntry): vscode.Range {
  const startLine = Math.max(0, Math.min(fencedDiv.range.start.line, document.lineCount - 1));
  const endLine = Math.max(startLine, Math.min(fencedDiv.range.end.line, document.lineCount - 1));
  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}

/**
 * Converts a parser range into a VS Code inline range.
 *
 * @param entry Parsed bracketed span.
 */
function toInlineRange(entry: import("./parser").SpanEntry): vscode.Range {
  return new vscode.Range(
    entry.range.start.line,
    entry.range.start.character,
    entry.range.end.line,
    entry.range.end.character,
  );
}


