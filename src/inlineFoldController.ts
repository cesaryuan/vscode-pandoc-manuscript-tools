import * as vscode from "vscode";
import { getConfiguration } from "./configuration";
import { isRevisionCharCustomStyle } from "./parser";
import type { LineExcerptFoldEntry, PlainRange, SpanEntry } from "./parser";
import { isPandocDocument, toRange } from "./vscodeUtils";

const INLINE_FOLD_PLACEHOLDER = "…";
type InlineFoldCandidate = { range: PlainRange; fullRange: PlainRange };
type InlineFoldOptions = { foldLineExcerpts: boolean; foldRevisionCharAttributes: boolean };

export class InlineFoldController {
  declare index: import("./workspaceIndex").PandocWorkspaceIndex;
  declare output: import("vscode").OutputChannel;
  declare hiddenDecorationType: import("vscode").TextEditorDecorationType;
  declare placeholderDecorationType: import("vscode").TextEditorDecorationType;

  /**
   * Creates the editor decorations used for Markdown inline folding.
   *
   * @param index Workspace parser cache.
   * @param output Output channel for useful diagnostics.
   */
  constructor(index: import("./workspaceIndex").PandocWorkspaceIndex, output: vscode.OutputChannel) {
    this.index = index;
    this.output = output;
    this.hiddenDecorationType = createHiddenDecorationType();
    this.placeholderDecorationType = createPlaceholderDecorationType();
  }

  /**
   * Refreshes inline folds in visible Markdown editors.
   *
   * @param changedDocument Optional changed document to refresh.
   */
  updateVisibleEditors(changedDocument: vscode.TextDocument | undefined = undefined): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!changedDocument || editor.document === changedDocument) {
        this.updateEditor(editor);
      }
    }
  }

  /**
   * Refreshes inline folds in one editor.
   *
   * @param editor Text editor.
   */
  updateEditor(editor: vscode.TextEditor): void {
    const configuration = getConfiguration();
    const options: InlineFoldOptions = {
      foldLineExcerpts: configuration.get("foldLineExcerptCodeSpans", true),
      foldRevisionCharAttributes: configuration.get("foldRevisionCharSpanAttributes", true),
    };
    if ((!options.foldLineExcerpts && !options.foldRevisionCharAttributes) || !isPandocDocument(editor.document)) {
      this.clearEditor(editor);
      return;
    }

    try {
      const parsed = this.index.getParsedDocument(editor.document);
      this.applyDecorations(editor, parsed.lineExcerptFolds, parsed.spans, options);
    } catch (error) {
      this.output.appendLine(`Failed to fold Markdown inline syntax: ${String(error)}`);
      this.clearEditor(editor);
    }
  }

  /**
   * Applies collapsed content and placeholder decorations to one editor.
   *
   * A fold is temporarily expanded while any cursor or selection touches its
   * full source range so the hidden syntax remains directly editable.
   *
   * @param editor Text editor.
   * @param lineExcerptFolds Parsed line-excerpt folds.
   * @param spans Parsed Pandoc bracketed spans.
   * @param options Enabled inline-fold syntax families.
   */
  applyDecorations(editor: vscode.TextEditor, lineExcerptFolds: LineExcerptFoldEntry[], spans: SpanEntry[], options: InlineFoldOptions): void {
    const foldCandidates = collectFoldCandidates(lineExcerptFolds, spans, options);
    const collapsedFolds = foldCandidates.filter((fold) => !shouldRevealFold(editor, fold));
    const hiddenRanges = collapsedFolds.map((fold) => toRange(fold.range));
    const placeholderRanges = collapsedFolds.map((fold) => {
      const start = toRange(fold.range).start;
      return new vscode.Range(start, start);
    });

    editor.setDecorations(this.hiddenDecorationType, hiddenRanges);
    editor.setDecorations(this.placeholderDecorationType, placeholderRanges);
  }

  /**
   * Clears inline-fold decorations from one editor.
   *
   * @param editor Text editor.
   */
  clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.hiddenDecorationType, []);
    editor.setDecorations(this.placeholderDecorationType, []);
  }

  /**
   * Releases inline-fold decoration resources.
   */
  dispose(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditor(editor);
    }
    this.hiddenDecorationType.dispose();
    this.placeholderDecorationType.dispose();
  }
}

/**
 * Collects enabled inline-fold ranges from parsed Markdown syntax.
 *
 * Revision spans hide the complete `{...}` attribute block, while line
 * excerpts keep their backtick delimiters and hide only the quoted content.
 *
 * @param lineExcerptFolds Parsed line-excerpt folds.
 * @param spans Parsed Pandoc bracketed spans.
 * @param options Enabled inline-fold syntax families.
 */
function collectFoldCandidates(lineExcerptFolds: LineExcerptFoldEntry[], spans: SpanEntry[], options: InlineFoldOptions): InlineFoldCandidate[] {
  const candidates: InlineFoldCandidate[] = [];
  if (options.foldLineExcerpts) {
    candidates.push(...lineExcerptFolds);
  }
  if (options.foldRevisionCharAttributes) {
    for (const span of spans) {
      if (isRevisionCharCustomStyle(span.attributes)) {
        candidates.push({ range: span.attributeRange, fullRange: span.attributeRange });
      }
    }
  }
  return candidates;
}

/**
 * Creates the decoration that collapses a partial-line source range.
 *
 * VS Code folding ranges are line-based, so this narrow CSS-backed decoration
 * is required for the requested inline fold without changing document text.
 */
function createHiddenDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    textDecoration: "none; display: none;",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/**
 * Creates the virtual ellipsis shown in place of collapsed excerpt content.
 */
function createPlaceholderDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      contentText: INLINE_FOLD_PLACEHOLDER,
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/**
 * Checks whether a fold must stay expanded for the current selections.
 *
 * @param editor Text editor containing the selections.
 * @param fold Parsed fold candidate.
 */
function shouldRevealFold(editor: vscode.TextEditor, fold: InlineFoldCandidate): boolean {
  const fullRange = toRange(fold.fullRange);
  return editor.selections.some((selection) => selectionTouchesRange(selection, fullRange));
}

/**
 * Checks whether one cursor or selection touches a range, including boundaries.
 *
 * Boundary checks are intentional: clicking beside the collapsed ellipsis must
 * reveal the code span before the user edits its hidden content.
 *
 * @param selection Editor selection.
 * @param range Candidate fold range.
 */
function selectionTouchesRange(selection: vscode.Selection, range: vscode.Range): boolean {
  return range.contains(selection.active)
    || range.contains(selection.anchor)
    || selection.contains(range.start)
    || selection.contains(range.end);
}
