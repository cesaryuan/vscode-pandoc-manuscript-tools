import type * as vscode from "vscode";

export type ParagraphDiffSide = "original" | "modified";
export type ParagraphSentenceDiffKind = "equal" | "added" | "removed";
export type ParagraphWordDiffKind = ParagraphSentenceDiffKind;

export type ParagraphSentenceDiff = {
  text: string;
  kind: ParagraphSentenceDiffKind;
};

export type ParagraphWordDiff = {
  text: string;
  kind: ParagraphWordDiffKind;
};

export type ProposedTextEditorLineRange = {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
};

export type ProposedTextEditorChange = {
  readonly original: ProposedTextEditorLineRange;
  readonly modified: ProposedTextEditorLineRange;
  readonly kind: number;
};

export type ProposedTextEditorDiffInformation = {
  readonly documentVersion: number;
  readonly original: vscode.Uri | undefined;
  readonly modified: vscode.Uri;
  readonly changes: readonly ProposedTextEditorChange[];
  readonly isStale: boolean;
};

export type TextEditorWithDiffInformation = vscode.TextEditor & {
  readonly diffInformation?: readonly ProposedTextEditorDiffInformation[];
};

type TextDiffInput = {
  readonly original: vscode.Uri;
  readonly modified: vscode.Uri;
};

type ParagraphDiffResolutionOptions = {
  document: vscode.TextDocument;
  paragraphRange: vscode.Range;
  hoverPosition: vscode.Position;
  diffInput: TextDiffInput;
  visibleTextEditors: readonly vscode.TextEditor[];
  openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
  findParagraphRange: (document: vscode.TextDocument, lineNumber: number) => vscode.Range;
  cancellationToken: vscode.CancellationToken;
};

export type ParagraphDiffResolution = {
  side: ParagraphDiffSide;
  originalText: string;
  modifiedText: string;
};

export type ParagraphSentenceDiffResult = {
  original: ParagraphSentenceDiff[];
  modified: ParagraphSentenceDiff[];
};

export type ParagraphWordDiffResult = {
  original: ParagraphWordDiff[];
  modified: ParagraphWordDiff[];
};

/**
 * Resolves the paragraph pair from VS Code's already-computed diff hunks.
 *
 * `TextEditor.diffInformation` is currently a proposed API. The caller passes
 * ordinary editors and this function reads the field only when the running VS
 * Code build exposes it, so older or unsupported hosts can fall back safely.
 *
 * @param options Current hover, diff tab, editor, and document services.
 */
export async function resolveParagraphDiff(options: ParagraphDiffResolutionOptions): Promise<ParagraphDiffResolution | undefined> {
  const side = getParagraphDiffSide(options.document.uri, options.diffInput);
  if (!side || options.cancellationToken.isCancellationRequested) {
    return undefined;
  }

  const diffInformation = findDiffInformation(options.visibleTextEditors, options.diffInput);
  if (!diffInformation || diffInformation.isStale) {
    return undefined;
  }

  const paragraphLines = toOneBasedLineRange(options.paragraphRange);
  const changes = findIntersectingDiffChanges(diffInformation.changes, side, paragraphLines);
  if (changes.length === 0) {
    return undefined;
  }

  const currentText = options.document.getText(options.paragraphRange);
  const primaryChange = findClosestDiffChange(changes, side, options.hoverPosition.line + 1);
  const counterpartSide = side === "original" ? "modified" : "original";
  const counterpartLines = primaryChange[counterpartSide];

  if (isEmptyLineRange(counterpartLines)) {
    return side === "original"
      ? { side, originalText: currentText, modifiedText: "" }
      : { side, originalText: "", modifiedText: currentText };
  }

  const counterpartUri = side === "original" ? options.diffInput.modified : options.diffInput.original;
  const counterpartDocument = await options.openTextDocument(counterpartUri);
  if (options.cancellationToken.isCancellationRequested || counterpartDocument.lineCount === 0) {
    return undefined;
  }

  const counterpartAnchor = mapLineWithinChange(
    options.hoverPosition.line + 1,
    primaryChange[side],
    counterpartLines,
  );
  const counterpartLine = findNearestContentLine(counterpartDocument, counterpartAnchor - 1, counterpartLines);
  if (counterpartLine === undefined) {
    return undefined;
  }

  const counterpartRange = options.findParagraphRange(counterpartDocument, counterpartLine);
  const counterpartText = counterpartDocument.getText(counterpartRange);
  return side === "original"
    ? { side, originalText: currentText, modifiedText: counterpartText }
    : { side, originalText: counterpartText, modifiedText: currentText };
}

/**
 * Returns changes whose line range intersects the hovered paragraph.
 *
 * Empty ranges represent the absent side of a pure addition or deletion and
 * therefore never intersect a paragraph on that side.
 *
 * @param changes VS Code diff changes.
 * @param side Side containing the hovered paragraph.
 * @param paragraphLines One-based paragraph line range.
 */
export function findIntersectingDiffChanges(
  changes: readonly ProposedTextEditorChange[],
  side: ParagraphDiffSide,
  paragraphLines: ProposedTextEditorLineRange,
): ProposedTextEditorChange[] {
  return changes.filter((change) => lineRangesIntersect(change[side], paragraphLines));
}

/**
 * Computes sentence-level additions and removals inside one VS Code hunk.
 *
 * Exact sentence matches are retained through a longest-common-subsequence
 * alignment. A rewritten sentence is intentionally represented as an old
 * removed sentence and a new added sentence, matching normal diff semantics.
 *
 * @param originalText Paragraph text from the original side.
 * @param modifiedText Paragraph text from the modified side.
 */
export function diffParagraphSentences(originalText: string, modifiedText: string): ParagraphSentenceDiffResult {
  const originalSentences = splitParagraphSentences(originalText);
  const modifiedSentences = splitParagraphSentences(modifiedText);
  const lengths = buildSentenceLcsLengths(originalSentences, modifiedSentences);
  const original: ParagraphSentenceDiff[] = [];
  const modified: ParagraphSentenceDiff[] = [];
  let originalIndex = 0;
  let modifiedIndex = 0;

  while (originalIndex < originalSentences.length && modifiedIndex < modifiedSentences.length) {
    if (sentencesMatch(originalSentences[originalIndex], modifiedSentences[modifiedIndex])) {
      original.push({ text: originalSentences[originalIndex], kind: "equal" });
      modified.push({ text: modifiedSentences[modifiedIndex], kind: "equal" });
      originalIndex += 1;
      modifiedIndex += 1;
      continue;
    }

    if (lengths[originalIndex + 1][modifiedIndex] >= lengths[originalIndex][modifiedIndex + 1]) {
      original.push({ text: originalSentences[originalIndex], kind: "removed" });
      originalIndex += 1;
    } else {
      modified.push({ text: modifiedSentences[modifiedIndex], kind: "added" });
      modifiedIndex += 1;
    }
  }

  while (originalIndex < originalSentences.length) {
    original.push({ text: originalSentences[originalIndex], kind: "removed" });
    originalIndex += 1;
  }
  while (modifiedIndex < modifiedSentences.length) {
    modified.push({ text: modifiedSentences[modifiedIndex], kind: "added" });
    modifiedIndex += 1;
  }

  return { original, modified };
}

/**
 * Computes word-level additions and removals inside one already-paired paragraph.
 *
 * Whitespace is retained in each token so the translated input keeps readable
 * spacing. Inline math, code spans, URLs, and hyphenated scientific terms are
 * treated as atomic tokens to avoid wrapping their syntax halfway through.
 *
 * @param originalText Paragraph text from the original side.
 * @param modifiedText Paragraph text from the modified side.
 */
export function diffParagraphWords(originalText: string, modifiedText: string): ParagraphWordDiffResult {
  const originalTokens = tokenizeParagraphWords(originalText);
  const modifiedTokens = tokenizeParagraphWords(modifiedText);
  const lengths = buildWordLcsLengths(originalTokens, modifiedTokens);
  const original: ParagraphWordDiff[] = [];
  const modified: ParagraphWordDiff[] = [];
  let originalIndex = 0;
  let modifiedIndex = 0;

  while (originalIndex < originalTokens.length && modifiedIndex < modifiedTokens.length) {
    if (wordTokensMatch(originalTokens[originalIndex], modifiedTokens[modifiedIndex])) {
      original.push({ text: originalTokens[originalIndex].text, kind: "equal" });
      modified.push({ text: modifiedTokens[modifiedIndex].text, kind: "equal" });
      originalIndex += 1;
      modifiedIndex += 1;
      continue;
    }

    if (lengths[originalIndex + 1][modifiedIndex] >= lengths[originalIndex][modifiedIndex + 1]) {
      original.push({ text: originalTokens[originalIndex].text, kind: "removed" });
      originalIndex += 1;
    } else {
      modified.push({ text: modifiedTokens[modifiedIndex].text, kind: "added" });
      modifiedIndex += 1;
    }
  }

  while (originalIndex < originalTokens.length) {
    original.push({ text: originalTokens[originalIndex].text, kind: "removed" });
    originalIndex += 1;
  }
  while (modifiedIndex < modifiedTokens.length) {
    modified.push({ text: modifiedTokens[modifiedIndex].text, kind: "added" });
    modifiedIndex += 1;
  }

  return { original, modified };
}

/**
 * Builds the HTML sent to the translator for one side of a word diff.
 *
 * Adjacent tokens with the same status share one marker so the translation
 * service cannot relocate dozens of word-level tags independently.
 *
 * @param words Word diff for the hovered side.
 */
export function formatDiffTranslationInput(words: readonly ParagraphWordDiff[]): string {
  const groupedWords: ParagraphWordDiff[] = [];
  for (const word of words) {
    const previous = groupedWords[groupedWords.length - 1];
    if (previous && previous.kind === word.kind) {
      previous.text += word.text;
    } else {
      groupedWords.push({ ...word });
    }
  }

  const body = groupedWords.map((word) => {
    const escapedText = escapeHtmlText(word.text);
    return word.kind === "equal"
      ? escapedText
      : `<span data-pmt-diff="${word.kind}">${escapedText}</span>`;
  }).join("");
  return `<div><p>${body}</p></div>`;
}

/**
 * Splits manuscript prose into sentences while keeping scientific
 * abbreviations such as `Fig.` and `Eq.` attached to their surrounding text.
 *
 * @param text Markdown paragraph text.
 */
export function splitParagraphSentences(text: string): string[] {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return [];
  }

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...segmenter.segment(normalizedText)]
      .map((segment) => segment.segment.trim())
      .filter((sentence) => sentence.length > 0);
  }

  // This fallback is needed only on older extension hosts without Segmenter.
  return normalizedText.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * Splits prose into diffable tokens while retaining leading whitespace.
 *
 * @param text Markdown paragraph text.
 */
export function splitParagraphWords(text: string): string[] {
  return tokenizeParagraphWords(text).map((token) => token.text);
}

/**
 * Finds the VS Code diff record matching the active text diff tab.
 *
 * @param editors Visible editors, including both sides of a diff editor.
 * @param diffInput Original and modified URIs from TabInputTextDiff.
 */
function findDiffInformation(editors: readonly vscode.TextEditor[], diffInput: TextDiffInput): ProposedTextEditorDiffInformation | undefined {
  const originalUri = diffInput.original.toString();
  const modifiedUri = diffInput.modified.toString();

  for (const editor of editors as readonly TextEditorWithDiffInformation[]) {
    const match = editor.diffInformation?.find((diff) =>
      diff.modified.toString() === modifiedUri
      // A newly added file can expose no original URI even though its diff tab
      // still has an original input, so the modified URI is authoritative there.
      && (diff.original === undefined || diff.original.toString() === originalUri),
    );
    if (match) {
      return match;
    }
  }

  return undefined;
}

/**
 * Identifies which side of the active diff owns the hovered document.
 *
 * @param documentUri Hovered document URI.
 * @param diffInput Active text diff input.
 */
function getParagraphDiffSide(documentUri: vscode.Uri, diffInput: TextDiffInput): ParagraphDiffSide | undefined {
  const uriText = documentUri.toString();
  if (uriText === diffInput.original.toString()) {
    return "original";
  }
  if (uriText === diffInput.modified.toString()) {
    return "modified";
  }
  return undefined;
}

/**
 * Converts a zero-based VS Code range into VS Code diff API line numbers.
 *
 * @param range Paragraph range.
 */
function toOneBasedLineRange(range: vscode.Range): ProposedTextEditorLineRange {
  const inclusiveEndLine = range.end.character === 0 && range.end.line > range.start.line
    ? range.end.line - 1
    : range.end.line;
  return {
    startLineNumber: range.start.line + 1,
    endLineNumberExclusive: inclusiveEndLine + 2,
  };
}

/**
 * Checks whether two non-empty half-open line ranges intersect.
 *
 * @param left First line range.
 * @param right Second line range.
 */
function lineRangesIntersect(left: ProposedTextEditorLineRange, right: ProposedTextEditorLineRange): boolean {
  if (isEmptyLineRange(left) || isEmptyLineRange(right)) {
    return false;
  }
  return left.startLineNumber < right.endLineNumberExclusive
    && right.startLineNumber < left.endLineNumberExclusive;
}

/**
 * Returns whether a diff line range represents an absent side.
 *
 * @param range Diff line range.
 */
function isEmptyLineRange(range: ProposedTextEditorLineRange): boolean {
  return range.startLineNumber === range.endLineNumberExclusive;
}

/**
 * Selects the intersecting hunk nearest to the exact hover line.
 *
 * @param changes Changes intersecting the paragraph.
 * @param side Hovered diff side.
 * @param hoverLine One-based hover line.
 */
function findClosestDiffChange(
  changes: readonly ProposedTextEditorChange[],
  side: ParagraphDiffSide,
  hoverLine: number,
): ProposedTextEditorChange {
  return [...changes].sort((left, right) =>
    getLineRangeDistance(left[side], hoverLine) - getLineRangeDistance(right[side], hoverLine),
  )[0];
}

/**
 * Measures the distance between a line and a half-open line range.
 *
 * @param range Diff line range.
 * @param lineNumber One-based line number.
 */
function getLineRangeDistance(range: ProposedTextEditorLineRange, lineNumber: number): number {
  if (lineNumber < range.startLineNumber) {
    return range.startLineNumber - lineNumber;
  }
  if (lineNumber >= range.endLineNumberExclusive) {
    return lineNumber - range.endLineNumberExclusive + 1;
  }
  return 0;
}

/**
 * Maps one line within a hunk to the corresponding side by relative position.
 *
 * @param currentLine One-based line on the hovered side.
 * @param currentRange Hovered-side hunk range.
 * @param counterpartRange Counterpart-side hunk range.
 */
function mapLineWithinChange(
  currentLine: number,
  currentRange: ProposedTextEditorLineRange,
  counterpartRange: ProposedTextEditorLineRange,
): number {
  const currentOffset = Math.max(0, currentLine - currentRange.startLineNumber);
  const counterpartLength = counterpartRange.endLineNumberExclusive - counterpartRange.startLineNumber;
  return counterpartRange.startLineNumber + Math.min(currentOffset, Math.max(0, counterpartLength - 1));
}

/**
 * Finds non-blank counterpart content near the mapped line inside the hunk.
 *
 * @param document Counterpart document.
 * @param anchorLine Zero-based mapped line.
 * @param range One-based counterpart hunk range.
 */
function findNearestContentLine(
  document: vscode.TextDocument,
  anchorLine: number,
  range: ProposedTextEditorLineRange,
): number | undefined {
  const startLine = Math.max(0, range.startLineNumber - 1);
  const endLine = Math.min(document.lineCount - 1, range.endLineNumberExclusive - 2);
  const clampedAnchor = Math.max(startLine, Math.min(endLine, anchorLine));

  for (let distance = 0; distance <= endLine - startLine; distance += 1) {
    const before = clampedAnchor - distance;
    if (before >= startLine && document.lineAt(before).text.trim()) {
      return before;
    }

    const after = clampedAnchor + distance;
    if (after <= endLine && after !== before && document.lineAt(after).text.trim()) {
      return after;
    }
  }

  return undefined;
}

/**
 * Builds the dynamic-programming table used for sentence LCS alignment.
 *
 * @param original Original sentences.
 * @param modified Modified sentences.
 */
function buildSentenceLcsLengths(original: readonly string[], modified: readonly string[]): number[][] {
  const lengths = Array.from({ length: original.length + 1 }, () => Array(modified.length + 1).fill(0));
  for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let modifiedIndex = modified.length - 1; modifiedIndex >= 0; modifiedIndex -= 1) {
      lengths[originalIndex][modifiedIndex] = sentencesMatch(original[originalIndex], modified[modifiedIndex])
        ? lengths[originalIndex + 1][modifiedIndex + 1] + 1
        : Math.max(lengths[originalIndex + 1][modifiedIndex], lengths[originalIndex][modifiedIndex + 1]);
    }
  }
  return lengths;
}

/**
 * Compares sentences while ignoring editor-only whitespace reflow.
 *
 * @param left First sentence.
 * @param right Second sentence.
 */
function sentencesMatch(left: string, right: string): boolean {
  return normalizeSentenceForComparison(left) === normalizeSentenceForComparison(right);
}

/**
 * Normalizes Markdown line wrapping without hiding wording or case changes.
 *
 * @param sentence Sentence text.
 */
function normalizeSentenceForComparison(sentence: string): string {
  return sentence.replace(/\s+/g, " ").trim();
}

type ParagraphWordToken = {
  text: string;
  value: string;
};

/**
 * Tokenizes words and protected inline constructs for the paragraph diff.
 *
 * @param text Markdown paragraph text.
 */
function tokenizeParagraphWords(text: string): ParagraphWordToken[] {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return [];
  }

  const tokenPattern = /`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|https?:\/\/\S+|[\p{L}\p{M}\p{N}]+(?:['’_-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu;
  const tokens: ParagraphWordToken[] = [];
  let cursor = 0;
  for (const match of normalizedText.matchAll(tokenPattern)) {
    const value = match[0];
    const leadingWhitespace = normalizedText.slice(cursor, match.index);
    tokens.push({ text: `${leadingWhitespace}${value}`, value });
    cursor = match.index + value.length;
  }
  return tokens;
}

/**
 * Builds the dynamic-programming table used for word LCS alignment.
 *
 * @param original Original word tokens.
 * @param modified Modified word tokens.
 */
function buildWordLcsLengths(original: readonly ParagraphWordToken[], modified: readonly ParagraphWordToken[]): number[][] {
  const lengths = Array.from({ length: original.length + 1 }, () => Array(modified.length + 1).fill(0));
  for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let modifiedIndex = modified.length - 1; modifiedIndex >= 0; modifiedIndex -= 1) {
      lengths[originalIndex][modifiedIndex] = wordTokensMatch(original[originalIndex], modified[modifiedIndex])
        ? lengths[originalIndex + 1][modifiedIndex + 1] + 1
        : Math.max(lengths[originalIndex + 1][modifiedIndex], lengths[originalIndex][modifiedIndex + 1]);
    }
  }
  return lengths;
}

/**
 * Compares token values without allowing line wrapping or surrounding spaces
 * to create a false wording change.
 *
 * @param left First token.
 * @param right Second token.
 */
function wordTokensMatch(left: ParagraphWordToken, right: ParagraphWordToken): boolean {
  return left.value === right.value;
}

/**
 * Escapes text before embedding it in translator HTML.
 *
 * @param value Raw token text.
 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
