import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import type * as vscode from "vscode";
import { build } from "esbuild";
import type { HtmlPreviewClickNavigation, HtmlPreviewBlockDescriptor } from "../src/papperMarkdownPreview/clickNavigation";

/** Supplies the editor range API while exercising the real source-navigation code. */
class SourceRange {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };

  /** Records the complete source-line selection returned by navigation. */
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

/** Loads production navigation with only the unavailable VS Code host API substituted. */
async function createNavigation(text: string): Promise<{ navigator: HtmlPreviewClickNavigation; document: vscode.TextDocument }> {
  const bundle = await build({
    entryPoints: [path.join(__dirname, "../src/papperMarkdownPreview/clickNavigation.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false,
  });
  const module = { exports: {} as { HtmlPreviewClickNavigation: typeof HtmlPreviewClickNavigation } };
  const load = new Function("require", "module", "exports", bundle.outputFiles[0].text);
  // The host range constructor is the only runtime dependency used by mapping.
  load(() => ({ Range: SourceRange }), module, module.exports);
  const lines = text.split(/\r?\n/);
  const document = {
    uri: { toString: () => "file:/preview.md" }, version: 1, lineCount: lines.length,
    /** Returns the editor buffer independently of the rendered preview text. */
    getText: () => text,
    /** Supplies each line's actual length for a complete paragraph selection. */
    lineAt: (line: number) => ({ text: lines[line] }),
  } as unknown as vscode.TextDocument;
  return { navigator: new module.exports.HtmlPreviewClickNavigation({} as vscode.OutputChannel), document };
}

/** Reproduces prose disappearing from click navigation after a same-line Pandoc equation. */
async function locatesParagraphsAfterSingleLineEquations(): Promise<void> {
  const text = "$$k_i=1$$ {#eq:degree}\n\nThe reconstructed response remains accurate.\nIts error is small.\n\n$$R=2$$\n\nA later paragraph remains clickable.";
  const { navigator, document } = await createNavigation(text);
  const first = navigator.resolvePreviewSourceTarget(document, {
    blockType: "paragraph", text: "The reconstructed response remains accurate. Its error is small.",
  });
  assert.equal(first?.range.start.line, 2);
  assert.equal(first?.range.end.line, 3);
  const later = navigator.resolvePreviewSourceTarget(document, {
    blockType: "paragraph", text: "A later paragraph remains clickable.",
  });
  assert.equal(later?.range.start.line, 7);
}

/** Verifies ordered mappings keep repeated paragraphs separate across single/multi-line equations. */
async function mapsParagraphsAcrossMixedEquations(): Promise<void> {
  const text = [
    "$$x=1$$", "", "Repeated response paragraph.", "",
    "$$", "not prose", "$$ {#eq:response}", "", "Repeated response paragraph.", "",
    "\\[", "not prose either", "\\]", "", "Final response paragraph.",
  ].join("\n");
  const { navigator, document } = await createNavigation(text);
  const blocks: HtmlPreviewBlockDescriptor[] = [
    { blockId: "first", blockType: "paragraph", text: "Repeated response paragraph." },
    { blockId: "second", blockType: "paragraph", text: "Repeated response paragraph." },
    { blockId: "last", blockType: "paragraph", text: "Final response paragraph." },
  ];
  const mappings = navigator.mapPreviewBlocks(document, blocks);
  assert.deepEqual(mappings.map(({ startLine, endLine }) => [startLine, endLine]), [[2, 2], [8, 8], [14, 14]]);
  assert.equal(navigator.resolvePreviewSourceTarget(document, blocks[1])?.range.start.line, 8);
  assert.equal(navigator.resolvePreviewSourceTarget(document, { blockType: "paragraph", text: "not prose" }), undefined);
  assert.equal(navigator.resolvePreviewSourceTarget(document, { blockType: "paragraph", text: "not prose either" }), undefined);
}

test("click navigation finds complete paragraphs after same-line display math", locatesParagraphsAfterSingleLineEquations);
test("ordered navigation maps repeated paragraphs across mixed display math", mapsParagraphsAcrossMixedEquations);

/** Reproduces escaped bibliography brackets being mistaken for an unclosed display equation. */
async function locatesEscapedReferencesAndFollowingProse(): Promise<void> {
  const { navigator, document } = await createNavigation("\\[1\\] Reference entry.\n\nA paragraph after the references.");
  assert.equal(navigator.resolvePreviewSourceTarget(document, { blockType: "paragraph", text: "[1] Reference entry." })?.range.start.line, 0);
  assert.equal(navigator.resolvePreviewSourceTarget(document, { blockType: "paragraph", text: "A paragraph after the references." })?.range.start.line, 2);
}

/** Verifies tight/fancy lists and escaped numbered headings retain their independent source locations. */
async function locatesListProseWithoutRenderedMarkers(): Promise<void> {
  const { navigator, document } = await createNavigation([
    "1) First response at $t$.", "2) Second response at $i$.", "",
    "(1) Third response.", "(2) Fourth response.", "", "1\\. Response heading", "",
    "A. Response feature network", "B. Response graph network",
  ].join("\n"));
  const texts = ["First response at .", "Second response at .", "Third response.", "Fourth response.", "1. Response heading", "Response feature network", "Response graph network"];
  const blocks: HtmlPreviewBlockDescriptor[] = texts.map((text, index) => ({ blockId: String(index), blockType: "paragraph", text }));
  assert.deepEqual(navigator.mapPreviewBlocks(document, blocks).map(({ startLine }) => startLine), [0, 1, 3, 4, 6, 8, 9]);
}

test("escaped references and following prose remain clickable", locatesEscapedReferencesAndFollowingProse);
test("list prose and escaped numbered headings map to their own source lines", locatesListProseWithoutRenderedMarkers);

/** Verifies quoted TOC paragraphs and visible reference URLs survive Markdown-to-HTML conversion. */
async function locatesQuotedLinksAndAutolinks(): Promise<void> {
  const text = "> [Methods [2](#methods)](#methods)\n>\n> [Results [3](#results)](#results)\n\n[78] Research reference <https://doi.org/10.1000/example> (2025).";
  const { navigator, document } = await createNavigation(text);
  const blocks: HtmlPreviewBlockDescriptor[] = [
    { blockId: "methods", blockType: "paragraph", text: "Methods [2](#methods)" },
    { blockId: "results", blockType: "paragraph", text: "Results [3](#results)" },
    { blockId: "reference", blockType: "paragraph", text: "[78] Research reference https://doi.org/10.1000/example (2025)." },
  ];
  assert.deepEqual(navigator.mapPreviewBlocks(document, blocks).map(({ startLine }) => startLine), [0, 2, 4]);
}

test("quoted nested links and reference autolinks retain source locations", locatesQuotedLinksAndAutolinks);
