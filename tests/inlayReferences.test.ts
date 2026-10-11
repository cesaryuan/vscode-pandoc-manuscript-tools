import assert from "node:assert/strict";
import test from "node:test";
import { prepareReferenceSource, type SourceReference } from "../src/inlayHints/sourceReferences";
import { collectRenderedReferences } from "../src/inlayHints/references";

/** Checks citation cluster/locator boundaries and original UTF-16 positions rather than guessed rendered numbers. */
function marksCompleteReferenceExpressions(): void {
  const text = "😀参见 @fig:one，式 @eq:x。\r\n[see @alpha; -@beta, p. 7]\r\n@alpha [pp. 3–5] 和 @alpha。\r\n[@fig:one; @fig:two]";
  const prepared = prepareReferenceSource(text);
  assert.deepEqual(prepared.references.map(({ sourceText, labels, line, character }) => ({ sourceText, labels, line, character })), [
    { sourceText: "@fig:one", labels: ["fig:one"], line: 0, character: 13 },
    { sourceText: "@eq:x", labels: ["eq:x"], line: 0, character: 21 },
    { sourceText: "[see @alpha; -@beta, p. 7]", labels: ["alpha", "beta"], line: 1, character: 26 },
    { sourceText: "@alpha [pp. 3–5]", labels: ["alpha"], line: 2, character: 16 },
    { sourceText: "@alpha", labels: ["alpha"], line: 2, character: 25 },
    { sourceText: "[@fig:one; @fig:two]", labels: ["fig:one", "fig:two"], line: 3, character: 20 },
  ]);
  assert.equal(prepared.markdown.replace(/<span data-pmt-inlay-reference="[^"]+">|<\/span>/g, ""), text);
}

/** Literal @examples must neither trigger hints nor perturb source-order matching for real references. */
function ignoresLiteralReferenceExamples(): void {
  const text = [
    "\uFEFF---", "title: '@yaml'", "...", "", "````markdown", "@fenced", "```", "@still-fenced", "````", "",
    "    @indented", "<!-- @comment", "@multiline -->", "`@code` and ``@longcode``", "\\@escaped and a@domain.example",
    '<a title="@attribute">link</a>', "[link](https://example.com/@path)", "[url]: https://example.com/@definition",
    "$@inline$", "$$", "@math", "$$", "![caption](plot.png){#fig:plot note=\"@attr\"}", "正文 @fig:real。 @paper",
  ].join("\n");
  assert.deepEqual(prepareReferenceSource(text).references.map(({ sourceText }) => sourceText), ["@fig:real", "@paper"]);
}

/** A styled span or unrelated bracketed prose must not become part of a reference's displayed text. */
function isolatesReferencesInsideStyledSpans(): void {
  const text = '[revised @fig:one]{custom-style="Revision Char"} and @paper [unrelated text]';
  assert.deepEqual(prepareReferenceSource(text).references.map(({ sourceText }) => sourceText), ["@fig:one", "@paper"]);
}

/** Constructs an independently processed AST span with no dependency on citation style or prefix settings. */
function renderedSpan(reference: SourceReference, inlines: unknown[]): unknown {
  return { t: "Span", c: [["", [], [["data-pmt-inlay-reference", reference.marker]]], inlines] };
}

/** Actual AST text can differ at each occurrence and grouped bibliography/crossrefs must remain one hint. */
function readsActualBuiltReferenceText(): void {
  const source = "[@alpha; @beta]\n@alpha\n@alpha\n[@fig:a; @fig:b]\n@eq:x\n@fig:missing";
  const prepared = prepareReferenceSource(source);
  const references = prepared.references;
  const ast = { blocks: [
    renderedSpan(references[0], [{ t: "Cite", c: [[{ citationId: "alpha", citationSuffix: [{ t: "Str", c: "must not leak" }] }], [
      { t: "Superscript", c: [{ t: "Str", c: "[" }, { t: "Link", c: [["", [], []], [{ t: "Str", c: "2–4" }], ["#ref-alpha", ""]] }, { t: "Str", c: "]" }] },
    ]] }]),
    renderedSpan(references[1], [{ t: "Str", c: "Smith" }, { t: "Space" }, { t: "Str", c: "(2024)" }]),
    renderedSpan(references[2], [{ t: "Str", c: "(Smith," }, { t: "Space" }, { t: "Str", c: "2024," }, { t: "Space" }, { t: "Str", c: "p. 7)" }]),
    renderedSpan(references[3], [{ t: "Strong", c: [{ t: "Str", c: "图 " }] }, { t: "Link", c: [["", [], []], [{ t: "Str", c: "3-3 (a–b)" }], ["#fig:a", ""]] }]),
    // linkReferences=false still produces complete plain-text reference output.
    renderedSpan(references[4], [{ t: "Str", c: "式 (2-1)" }]),
    renderedSpan(references[5], [{ t: "Str", c: "@fig:missing" }]),
  ] };
  assert.deepEqual(collectRenderedReferences(ast, references).map(({ displayText, line, character }) => ({ displayText, line, character })), [
    { displayText: "[2–4]", line: 0, character: 15 },
    { displayText: "Smith (2024)", line: 1, character: 6 },
    { displayText: "(Smith, 2024, p. 7)", line: 2, character: 6 },
    { displayText: "图 3-3 (a–b)", line: 3, character: 16 },
    { displayText: "式 (2-1)", line: 4, character: 5 },
  ]);
  assert.deepEqual(collectRenderedReferences(undefined, references), []);
}

test("marks complete reference expressions at original source positions", marksCompleteReferenceExpressions);
test("ignores reference-shaped text in metadata, code, comments, math and URLs", ignoresLiteralReferenceExamples);
test("keeps styled-span content and unrelated brackets outside reference hints", isolatesReferencesInsideStyledSpans);
test("uses actual built citation and cross-reference text per occurrence", readsActualBuiltReferenceText);
