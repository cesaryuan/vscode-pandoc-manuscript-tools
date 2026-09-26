import * as path from "path";
import * as vscode from "vscode";

/** Message shape exchanged by the Papper preview scroll bridge. */
export type HtmlPreviewMessage = {
  type?: string;
  ratio?: number;
  detail?: string;
  sourceLine?: number;
  sourcePosition?: number;
  offsetRatio?: number;
  blockId?: string;
  blockOffsetRatio?: number;
};

/** Keeps editor and Papper preview positions aligned through source block mappings. */
export class HtmlPreviewScrollSync {
  private syncing = false;
  private lastPreviewMessageAt = 0;
  private scrollSyncUntil = 0;
  private suppressEditorSyncUntil = 0;
  private lastSourcePosition = -1;
  private lastSourceOffset = 0;
  private lastTraceAt = 0;

  /** Creates a scroll synchronizer with the extension output channel for diagnostics. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Writes bounded scroll diagnostics so a rapid wheel event cannot flood Output. */
  private trace(message: string, force = false) {
    const now = Date.now();
    if (!force && now - this.lastTraceAt < 500) {
      return;
    }
    this.lastTraceAt = now;
    this.output.appendLine(`[HTML][scroll] ${message}`);
  }

  /** Resets source-to-preview deduplication before a fresh WebView document loads. */
  resetSourcePosition() {
    this.lastSourcePosition = -1;
    this.lastSourceOffset = 0;
  }

  /** Suppresses editor events caused by a programmatic preview click reveal. */
  suppressEditorSync(durationMs = 1500) {
    this.suppressEditorSyncUntil = Date.now() + durationMs;
    this.trace(`editor sync suppressed for ${durationMs} ms`, true);
  }

  /** Sends the editor viewport or cursor position to its matching preview. */
  syncFromEditor(panel: vscode.WebviewPanel | undefined, previewUri: vscode.Uri | undefined, editor: vscode.TextEditor, selectedPosition?: vscode.Position) {
    const hasSelection = selectedPosition !== undefined;
    const visibleRange = editor.visibleRanges[0];
    this.trace(`editor event direction=to-preview line=${(selectedPosition?.line ?? visibleRange?.start.line ?? -1) + 1} selected=${hasSelection} panel=${Boolean(panel)} previewUri=${previewUri?.fsPath || "none"}`);
    if (!panel) {
      this.trace("editor event skipped: preview panel is missing");
      return;
    }
    if (!previewUri) {
      this.trace("editor event skipped: preview document URI is missing");
      return;
    }
    if (!isSameUri(previewUri, editor.document.uri)) {
      this.trace(`editor event skipped: URI mismatch editor=${editor.document.uri.fsPath} preview=${previewUri.fsPath}`);
      return;
    }
    if (Date.now() < this.suppressEditorSyncUntil) {
      this.trace("editor event skipped: preview click reveal suppression active");
      return;
    }
    if (!hasSelection && (this.syncing || Date.now() < this.scrollSyncUntil)) {
      this.trace(`editor event skipped: feedback suppression active syncing=${this.syncing} until=${this.scrollSyncUntil}`);
      return;
    }
    if (!visibleRange) {
      this.trace("editor event skipped: editor has no visible range");
      return;
    }

    const sourcePosition = selectedPosition
      ? getFractionalDocumentLine(editor.document, selectedPosition)
      : getFractionalDocumentLine(editor.document, visibleRange.start);
    const sourceLine = Math.max(0, Math.min(editor.document.lineCount - 1, Math.floor(sourcePosition)));
    const visibleStart = getFractionalDocumentLine(editor.document, visibleRange.start);
    const visibleEnd = getFractionalDocumentLine(editor.document, visibleRange.end);
    const visibleLineCount = Math.max(1, visibleEnd - visibleStart);
    const offsetRatio = selectedPosition
      ? Math.max(-1.5, Math.min(1.5, (sourcePosition - visibleStart) / visibleLineCount))
      : 0;
    const denominator = Math.max(1, editor.document.lineCount - 1);
    const ratio = Math.max(0, Math.min(1, sourcePosition / denominator));
    if (!hasSelection && Math.abs(sourcePosition - this.lastSourcePosition) < 0.15 && Math.abs(offsetRatio - this.lastSourceOffset) < 0.02) {
      return;
    }
    this.lastSourcePosition = sourcePosition;
    this.lastSourceOffset = offsetRatio;
    const message = { type: "sourceScroll", ratio, sourceLine, sourcePosition, offsetRatio };
    this.trace(`editor -> preview send line=${sourceLine + 1} ratio=${ratio.toFixed(3)} offset=${offsetRatio.toFixed(3)} selected=${hasSelection}`, true);
    void panel.webview.postMessage(message).then((delivered) => {
      this.trace(`editor -> preview message ${delivered ? "delivered" : "rejected"}`, true);
    }, (error) => {
      this.trace(`editor -> preview message failed: ${String(error)}`, true);
    });
  }

  /** Reveals the source line reported by the preview block mapping. */
  handlePreviewScroll(previewUri: vscode.Uri | undefined, message: HtmlPreviewMessage) {
    if (message.type !== "previewScroll" || !previewUri) {
      this.trace(`preview event ignored: invalid message type=${message.type || "none"} previewUri=${previewUri?.fsPath || "none"}`, true);
      return;
    }
    const now = Date.now();
    if (now - this.lastPreviewMessageAt < 60) {
      return;
    }
    this.lastPreviewMessageAt = now;
    const editor = vscode.window.visibleTextEditors.find((candidate) => isSameUri(candidate.document.uri, previewUri));
    if (!editor) {
      this.trace(`preview -> editor skipped: no visible editor for ${previewUri.fsPath}`, true);
      return;
    }
    const ratio = typeof message.ratio === "number" && Number.isFinite(message.ratio)
      ? Math.max(0, Math.min(1, message.ratio))
      : 0;
    const approximateLine = Math.round(ratio * Math.max(0, editor.document.lineCount - 1));
    const visibleRange = editor.visibleRanges[0];
    const visibleLineCount = visibleRange
      ? Math.max(1, getFractionalDocumentLine(editor.document, visibleRange.end) - getFractionalDocumentLine(editor.document, visibleRange.start))
      : 30;
    const sourceLine = typeof message.sourceLine === "number" && Number.isFinite(message.sourceLine)
      ? Math.max(0, Math.min(editor.document.lineCount - 1, Math.round(message.sourceLine)))
      : undefined;
    const blockOffsetRatio = typeof message.blockOffsetRatio === "number" && Number.isFinite(message.blockOffsetRatio)
      ? Math.max(-1.5, Math.min(1.5, message.blockOffsetRatio))
      : 0;
    const line = sourceLine === undefined
      ? approximateLine
      : Math.round(sourceLine - blockOffsetRatio * visibleLineCount);
    const targetLine = Math.max(0, Math.min(editor.document.lineCount - 1, line));
    if (visibleRange && Math.abs(visibleRange.start.line - targetLine) <= 1) {
      this.trace(`preview -> editor already aligned targetLine=${targetLine + 1}`, true);
      return;
    }
    this.trace(`preview -> editor reveal line=${targetLine + 1} ratio=${ratio.toFixed(3)} block=${message.blockId || "none"} offset=${blockOffsetRatio.toFixed(3)}`, true);
    this.syncing = true;
    this.scrollSyncUntil = now + 220;
    editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.AtTop);
    setTimeout(() => {
      this.syncing = false;
    }, 80);
  }
}

/** Converts a source position into a fractional line coordinate for partially visible lines. */
function getFractionalDocumentLine(document: vscode.TextDocument, position: vscode.Position) {
  const lineText = document.lineAt(position.line).text;
  const characterRatio = lineText.length > 0 ? Math.max(0, Math.min(1, position.character / lineText.length)) : 0;
  return position.line + characterRatio;
}

/** Compares file URIs using platform-aware filesystem path rules. */
function isSameUri(left: vscode.Uri, right: vscode.Uri) {
  return left.scheme === right.scheme && isSameFsPath(left.fsPath, right.fsPath);
}

/** Compares filesystem paths with Windows casing rules. */
function isSameFsPath(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}
