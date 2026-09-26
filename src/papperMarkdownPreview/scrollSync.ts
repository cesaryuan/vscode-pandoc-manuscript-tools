import * as path from "path";
import * as vscode from "vscode";
import { parsePandocDocument } from "../parser";

/** Message shape exchanged by the Papper preview scroll bridge. */
export type HtmlPreviewMessage = {
  type?: string;
  ratio?: number;
  detail?: string;
  headingId?: string;
  headingKey?: string;
  offsetRatio?: number;
};

type HtmlPreviewSourceHeading = { label?: string; line: number; key: string };

/** Keeps editor and Papper preview positions aligned through nearby headings. */
export class HtmlPreviewScrollSync {
  private syncing = false;
  private lastPreviewMessageAt = 0;
  private scrollSyncUntil = 0;
  private lastSourceRatio = -1;
  private lastSourceAnchorKey = "";
  private lastSourceOffset = 0;
  private sourceHeadings: HtmlPreviewSourceHeading[] = [];
  private sourceHeadingsUri: string | undefined;
  private sourceHeadingsVersion = -1;
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
    this.lastSourceRatio = -1;
    this.lastSourceAnchorKey = "";
    this.lastSourceOffset = 0;
  }

  /** Sends the editor's current viewport or cursor position to its matching preview. */
  syncFromEditor(panel: vscode.WebviewPanel | undefined, previewUri: vscode.Uri | undefined, editor: vscode.TextEditor, selectedPosition?: vscode.Position) {
    const hasSelection = selectedPosition !== undefined;
    this.trace(`editor event direction=to-preview line=${(selectedPosition?.line ?? editor.visibleRanges[0]?.start.line ?? -1) + 1} selected=${hasSelection} panel=${Boolean(panel)} previewUri=${previewUri?.fsPath || "none"}`);
    // A deliberate cursor change must win over feedback suppression from preview scrolling.
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
    if (!hasSelection && (this.syncing || Date.now() < this.scrollSyncUntil)) {
      this.trace(`editor event skipped: feedback suppression active syncing=${this.syncing} until=${this.scrollSyncUntil}`);
      return;
    }

    const visibleRange = editor.visibleRanges[0];
    if (!visibleRange) {
      this.trace("editor event skipped: editor has no visible range");
      return;
    }
    const sourceLine = selectedPosition?.line ?? visibleRange.start.line;
    const sourcePosition = selectedPosition
      ? getFractionalDocumentLine(editor.document, selectedPosition)
      : getFractionalDocumentLine(editor.document, visibleRange.start);
    const denominator = Math.max(1, editor.document.lineCount - 1);
    const ratio = Math.max(0, Math.min(1, sourcePosition / denominator));
    const visibleStart = getFractionalDocumentLine(editor.document, visibleRange.start);
    const visibleEnd = getFractionalDocumentLine(editor.document, visibleRange.end);
    const visibleLineCount = Math.max(1, visibleEnd - visibleStart);
    const headings = this.getSourceHeadings(editor.document);
    const selectionOffsetRatio = !selectedPosition
      ? 0
      : Math.max(0, Math.min(1, (sourcePosition - visibleStart) / visibleLineCount));
    const nearbyHeading = !selectedPosition
      ? undefined
      : findNearestSourceHeading(headings, sourceLine, visibleLineCount);
    const heading = !selectedPosition
      ? findVisibleSourceHeading(headings, editor.document, visibleRange)
      : nearbyHeading
        ? {
          ...nearbyHeading,
          offsetRatio: Math.max(-1.25, Math.min(1.25, selectionOffsetRatio + (nearbyHeading.line - sourcePosition) / visibleLineCount)),
        }
        : undefined;
    const anchorKey = heading ? `${heading.line}|${heading.label || ""}|${heading.key}` : "";
    const offsetRatio = heading?.offsetRatio ?? selectionOffsetRatio;
    if (!hasSelection && Math.abs(ratio - this.lastSourceRatio) < 0.01 && anchorKey === this.lastSourceAnchorKey && Math.abs(offsetRatio - this.lastSourceOffset) < 0.005) {
      return;
    }
    this.lastSourceRatio = ratio;
    this.lastSourceAnchorKey = anchorKey;
    this.lastSourceOffset = offsetRatio;
    const message = {
      type: "sourceScroll",
      ratio,
      headingId: heading?.label,
      headingKey: heading?.key,
      offsetRatio,
    };
    this.trace(`editor -> preview send line=${sourceLine + 1} ratio=${ratio.toFixed(3)} heading=${heading?.label || heading?.key || "none"} offset=${offsetRatio.toFixed(3)} selected=${hasSelection}`, true);
    void panel.webview.postMessage(message).then((delivered) => {
      this.trace(`editor -> preview message ${delivered ? "delivered" : "rejected"}`, true);
    }, (error) => {
      this.trace(`editor -> preview message failed: ${String(error)}`, true);
    });
  }

  /** Reveals the source heading reported by the preview, with a global ratio fallback. */
  handlePreviewScroll(previewUri: vscode.Uri | undefined, message: HtmlPreviewMessage) {
    if (message.type !== "previewScroll" || typeof message.ratio !== "number" || !Number.isFinite(message.ratio) || !previewUri) {
      this.trace(`preview event ignored: invalid message type=${message.type || "none"} ratio=${String(message.ratio)} previewUri=${previewUri?.fsPath || "none"}`, true);
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
    const ratio = Math.max(0, Math.min(1, message.ratio));
    const approximateLine = Math.round(ratio * Math.max(0, editor.document.lineCount - 1));
    const sourceHeadings = this.getSourceHeadings(editor.document);
    const heading = findSourceHeadingForPreviewAnchor(sourceHeadings, message, approximateLine);
    const visibleRange = editor.visibleRanges[0];
    const visibleLineCount = visibleRange
      ? Math.max(1, getFractionalDocumentLine(editor.document, visibleRange.end) - getFractionalDocumentLine(editor.document, visibleRange.start))
      : 30;
    const offsetRatio = typeof message.offsetRatio === "number" && Number.isFinite(message.offsetRatio)
      ? Math.max(-1.5, Math.min(1.5, message.offsetRatio))
      : 0;
    const line = heading
      ? Math.round(heading.line - offsetRatio * visibleLineCount)
      : approximateLine;
    const targetLine = Math.max(0, Math.min(editor.document.lineCount - 1, line));
    if (visibleRange && Math.abs(visibleRange.start.line - targetLine) <= 1) {
      this.trace(`preview -> editor already aligned targetLine=${targetLine + 1}`, true);
      return;
    }
    this.trace(`preview -> editor reveal line=${targetLine + 1} ratio=${ratio.toFixed(3)} heading=${message.headingId || message.headingKey || "none"} offset=${offsetRatio.toFixed(3)}`, true);
    this.syncing = true;
    this.scrollSyncUntil = now + 220;
    editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.AtTop);
    setTimeout(() => {
      this.syncing = false;
    }, 80);
  }

  /** Returns source headings cached for the current document version. */
  private getSourceHeadings(document: vscode.TextDocument) {
    const uri = document.uri.toString();
    if (this.sourceHeadingsUri !== uri || this.sourceHeadingsVersion !== document.version) {
      this.sourceHeadings = parsePandocDocument(document.getText(), uri).headings.map((heading) => ({
        label: heading.label,
        line: heading.line,
        key: normalizeHtmlPreviewHeadingKey(heading.title),
      }));
      this.sourceHeadingsUri = uri;
      this.sourceHeadingsVersion = document.version;
    }
    return this.sourceHeadings;
  }
}

/** Normalizes Markdown heading text to the plain text exposed by generated HTML. */
function normalizeHtmlPreviewHeadingKey(title: string) {
  return title
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\\(.)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Selects a nearby source heading and records its position within the editor viewport. */
function findVisibleSourceHeading(headings: HtmlPreviewSourceHeading[], document: vscode.TextDocument, visibleRange: vscode.Range) {
  if (headings.length === 0) {
    return undefined;
  }
  const visibleStart = getFractionalDocumentLine(document, visibleRange.start);
  const visibleEnd = getFractionalDocumentLine(document, visibleRange.end);
  const visibleLineCount = Math.max(1, visibleEnd - visibleStart);
  const maximumDistance = Math.max(5, visibleLineCount * 1.25);
  const nearest = findNearestSourceHeading(headings, visibleRange.start.line, maximumDistance);
  if (!nearest) {
    return undefined;
  }
  const offsetRatio = Math.max(-1.25, Math.min(1.25, (nearest.line - visibleStart) / visibleLineCount));
  return { ...nearest, offsetRatio };
}

/** Converts a source position into a fractional line coordinate for partially visible lines. */
function getFractionalDocumentLine(document: vscode.TextDocument, position: vscode.Position) {
  const lineText = document.lineAt(position.line).text;
  const characterRatio = lineText.length > 0 ? Math.max(0, Math.min(1, position.character / lineText.length)) : 0;
  return position.line + characterRatio;
}

/** Finds the closest source heading within a useful viewport distance. */
function findNearestSourceHeading(headings: HtmlPreviewSourceHeading[], line: number, maximumDistance: number) {
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (headings[middle].line < line) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const previous = low > 0 ? headings[low - 1] : undefined;
  const next = low < headings.length ? headings[low] : undefined;
  const nearest = previous && next
    ? Math.abs(previous.line - line) <= Math.abs(next.line - line) ? previous : next
    : previous || next;
  return nearest && Math.abs(nearest.line - line) <= maximumDistance ? nearest : undefined;
}

/** Matches a preview heading to its source heading, using position to disambiguate repeated titles. */
function findSourceHeadingForPreviewAnchor(headings: HtmlPreviewSourceHeading[], message: HtmlPreviewMessage, approximateLine: number) {
  if (headings.length === 0) {
    return undefined;
  }
  const exactIdMatches = message.headingId ? headings.filter((heading) => heading.label === message.headingId) : [];
  const headingKey = message.headingKey ? normalizeHtmlPreviewHeadingKey(message.headingKey) : "";
  const candidates = exactIdMatches.length > 0
    ? exactIdMatches
    : headingKey
      ? headings.filter((heading) => heading.key === headingKey)
      : [];
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((nearest, candidate) => Math.abs(candidate.line - approximateLine) < Math.abs(nearest.line - approximateLine) ? candidate : nearest);
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
