import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import { diffParagraphSentences, findIntersectingDiffChanges, resolveParagraphDiff, splitParagraphSentences } from "../src/paragraphTranslationDiff";

/** Verifies that a rewritten sentence alone receives removed and added states. */
function verifiesSentenceReplacementDiff(): void {
  const original = "The model creates a candidate field. The field is treated as physical damage. The geometry is updated.";
  const modified = "The model creates a candidate field. The field is used only as a geometry-update input. The geometry is updated.";
  const result = diffParagraphSentences(original, modified);

  assert.deepEqual(result.original.map((sentence) => sentence.kind), ["equal", "removed", "equal"]);
  assert.deepEqual(result.modified.map((sentence) => sentence.kind), ["equal", "added", "equal"]);
}

/** Verifies scientific abbreviations do not create false sentence boundaries. */
function verifiesScientificSentenceSegmentation(): void {
  assert.deepEqual(
    splitParagraphSentences("As shown in Fig. 3, the result improves. Eq. (2) defines the loss."),
    ["As shown in Fig. 3, the result improves.", "Eq. (2) defines the loss."],
  );
}

/** Verifies pure additions intersect only the modified side of a paragraph. */
function verifiesDiffLineIntersection(): void {
  const addition = {
    original: { startLineNumber: 4, endLineNumberExclusive: 4 },
    modified: { startLineNumber: 4, endLineNumberExclusive: 6 },
    kind: 1,
  };
  const paragraph = { startLineNumber: 4, endLineNumberExclusive: 7 };

  assert.deepEqual(findIntersectingDiffChanges([addition], "original", paragraph), []);
  assert.deepEqual(findIntersectingDiffChanges([addition], "modified", paragraph), [addition]);
}

/** Verifies a new-file addition works when VS Code omits the original URI. */
async function verifiesPureAdditionResolution(): Promise<void> {
  const originalUri = { toString: () => "git:/article.md" } as vscode.Uri;
  const modifiedUri = { toString: () => "file:/article.md" } as vscode.Uri;
  const paragraphText = "A newly added scientific sentence.";
  const paragraphRange = {
    start: { line: 3, character: 0 },
    end: { line: 3, character: paragraphText.length },
  } as vscode.Range;
  const document = {
    uri: modifiedUri,
    lineCount: 4,
    getText: () => paragraphText,
  } as unknown as vscode.TextDocument;
  const editor = {
    diffInformation: [{
      documentVersion: 1,
      original: undefined,
      modified: modifiedUri,
      changes: [{
        original: { startLineNumber: 4, endLineNumberExclusive: 4 },
        modified: { startLineNumber: 4, endLineNumberExclusive: 5 },
        kind: 1,
      }],
      isStale: false,
    }],
  } as unknown as vscode.TextEditor;
  const cancellationToken = { isCancellationRequested: false } as vscode.CancellationToken;

  const result = await resolveParagraphDiff({
    document,
    paragraphRange,
    hoverPosition: { line: 3, character: 4 } as vscode.Position,
    diffInput: { original: originalUri, modified: modifiedUri },
    visibleTextEditors: [editor],
    openTextDocument: () => Promise.reject(new Error("Pure additions must not open a counterpart document")),
    findParagraphRange: () => paragraphRange,
    cancellationToken,
  });

  assert.deepEqual(result, {
    side: "modified",
    originalText: "",
    modifiedText: paragraphText,
  });
}

test("marks only a rewritten sentence as removed and added", verifiesSentenceReplacementDiff);
test("keeps Fig. and Eq. inside scientific sentences", verifiesScientificSentenceSegmentation);
test("matches an addition only on the modified side", verifiesDiffLineIntersection);
test("resolves a pure addition without an original diff URI", verifiesPureAdditionResolution);
