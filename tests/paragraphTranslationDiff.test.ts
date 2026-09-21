import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import { diffParagraphSentences, diffParagraphWords, findIntersectingDiffChanges, formatDiffTranslationInput, resolveParagraphDiff, splitParagraphSentences, splitParagraphWords } from "../src/paragraphTranslationDiff";

const snapshotDirectory = join(process.cwd(), "tests");

/** Compares a deterministic diff HTML result with its checked-in snapshot. */
function assertSnapshot(snapshotName: string, value: string): void {
  const expected = readFileSync(join(snapshotDirectory, snapshotName), "utf8").trimEnd();
  assert.equal(formatSnapshotHtml(value), expected);
}

/** Formats inline diff HTML for readable snapshots without changing runtime HTML. */
function formatSnapshotHtml(value: string): string {
  const opening = "<div><p>";
  const closing = "</p></div>";
  assert.equal(value.startsWith(opening), true);
  assert.equal(value.endsWith(closing), true);

  const body = value.slice(opening.length, -closing.length);
  const chunks = body.split(/(<span\b[^>]*>[\s\S]*?<\/span>)/gi).filter(Boolean);
  return [
    "<div>",
    "  <p>",
    ...chunks.map((chunk) => `    ${chunk}`),
    "  </p>",
    "</div>",
  ].join("\n");
}

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

/** Verifies changed words are isolated while surrounding context stays equal. */
function verifiesWordDiffWithinSentence(): void {
  const original = "The field is treated as physical damage.";
  const modified = "The field is used only as a geometry-update input.";
  const result = diffParagraphWords(original, modified);

  assert.deepEqual(result.original.map((token) => token.kind), ["equal", "equal", "equal", "removed", "equal", "removed", "removed", "equal"]);
  assert.deepEqual(result.modified.map((token) => token.kind), ["equal", "equal", "equal", "added", "added", "equal", "added", "added", "added", "equal"]);
  assert.equal(result.original.filter((token) => token.kind === "equal").map((token) => token.text).join(""), "The field is as.");
  assert.equal(result.modified.filter((token) => token.kind === "equal").map((token) => token.text).join(""), "The field is as.");
}

/** Verifies formulas and hyphenated scientific terms stay atomic tokens. */
function verifiesProtectedWordTokens(): void {
  assert.deepEqual(
    splitParagraphWords("The geometry-update input uses $x^2$ and `candidate_field`."),
    ["The", " geometry-update", " input", " uses", " $x^2$", " and", " `candidate_field`", "."],
  );
}

/** Verifies deleting a clause does not mark the surviving modified words. */
function verifiesClauseDeletionKeepsModifiedWordsEqual(): void {
  const original = "This study uses a pixel-aligned normalized scalar field because it satisfies four requirements. It shares pixel coordinates with the original image.";
  const modified = "This study uses a pixel-aligned normalized scalar field. It shares pixel coordinates with the original image.";
  const result = diffParagraphWords(original, modified);

  assert.equal(result.original.some((token) => token.kind === "removed"), true);
  assert.equal(result.modified.some((token) => token.kind !== "equal"), false);
}

/** Verifies the reported formula-heavy paragraph uses one marker for the insertion. */
function snapshotsReportedParagraphMarkerInput(): void {
  const original = String.raw`Each node contains structural, traffic, and management-related attributes. Structural attributes include reliability index $\beta\_i$, structural failure probability $P\_{s,i}$, service age, deterioration-related variables, maintenance condition, and node capacity $C\_i$. Traffic attributes include total node flow, inflow, outflow, local flow, through-flow, and saturation. Local flow represents demand associated with the local bridge-tunnel node, while through-flow represents traffic that passes through the node and can be decomposed into movements between upstream and downstream neighboring nodes when the node fails. Each directed edge contains edge flow $q\_{ij}$, capacity $C\_{ij}$, free-flow travel time $t^0\_{ij}$, current travel time $t\_{ij}$, length, and topological indicators.`;
  const modified = String.raw`Each node contains structural, traffic, and management-related attributes. Structural attributes include reliability index $\beta\_i$, structural failure probability $P\_{s,i}$, service age, deterioration-related variables, maintenance condition, and node capacity $C\_i$. Here, traffic flow denotes the traffic volume carried by a node or directed link during the analysis interval, and node capacity denotes the effective traffic-carrying capacity of a bridge-tunnel node. Traffic attributes include total node flow, inflow, outflow, local flow, through-flow, and saturation. Local flow represents demand associated with the local bridge-tunnel node, while through-flow represents traffic that passes through the node and can be decomposed into movements between upstream and downstream neighboring nodes when the node fails. Each directed edge contains edge flow $q\_{ij}$, capacity $C\_{ij}$, free-flow travel time $t^0\_{ij}$, current travel time $t\_{ij}$, length, and topological indicators.`;
  const result = diffParagraphWords(original, modified);
  assertSnapshot("reported-paragraph-added.html.snap", formatDiffTranslationInput(result.modified));
}

/** Verifies a short middle insertion does not create one marker per word. */
function snapshotsMiddleInsertionMarkerInput(): void {
  const result = diffParagraphWords(
    "The model uses a normalized field for geometry updates.",
    "The model uses a shared image-aligned normalized field for geometry updates.",
  );
  assertSnapshot("middle-insertion.html.snap", formatDiffTranslationInput(result.modified));
}

/** Verifies punctuation, formulas, and code spans remain inside one changed run. */
function snapshotsProtectedInsertionMarkerInput(): void {
  const result = diffParagraphWords(
    "The loss is $L=0$ and the value is stored in `candidate_field`.",
    "The loss is $L=0$ and the calibrated value, computed per bridge-tunnel node, is stored in `candidate_field`.",
  );
  assertSnapshot("protected-insertion.html.snap", formatDiffTranslationInput(result.modified));
}

/** Verifies separated edits produce separate markers while equal context stays unmarked. */
function snapshotsSeparatedChangesMarkerInput(): void {
  const result = diffParagraphWords(
    "The original model uses local flow and reports capacity.",
    "The revised model uses total flow and reports effective capacity.",
  );
  assertSnapshot("separated-changes.html.snap", formatDiffTranslationInput(result.modified));
}

/** Verifies a deletion on the original side receives one removed marker. */
function snapshotsDeletionMarkerInput(): void {
  const result = diffParagraphWords(
    "The model uses a temporary empirical correction before updating geometry.",
    "The model updates geometry.",
  );
  assertSnapshot("deletion.html.snap", formatDiffTranslationInput(result.original));
}

test("marks only a rewritten sentence as removed and added", verifiesSentenceReplacementDiff);
test("keeps Fig. and Eq. inside scientific sentences", verifiesScientificSentenceSegmentation);
test("matches an addition only on the modified side", verifiesDiffLineIntersection);
test("resolves a pure addition without an original diff URI", verifiesPureAdditionResolution);
test("isolates changed words inside a rewritten sentence", verifiesWordDiffWithinSentence);
test("keeps formulas and scientific compounds atomic", verifiesProtectedWordTokens);
test("does not mark surviving words after a clause deletion", verifiesClauseDeletionKeepsModifiedWordsEqual);
test("snapshots the reported paragraph marker input", snapshotsReportedParagraphMarkerInput);
test("snapshots a middle insertion marker input", snapshotsMiddleInsertionMarkerInput);
test("snapshots protected insertion marker input", snapshotsProtectedInsertionMarkerInput);
test("snapshots separated changes marker input", snapshotsSeparatedChangesMarkerInput);
test("snapshots a deletion marker input", snapshotsDeletionMarkerInput);
