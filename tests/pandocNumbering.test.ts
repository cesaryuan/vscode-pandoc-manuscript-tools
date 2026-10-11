import assert from "node:assert/strict";
import test from "node:test";
import { parsePandocDocument } from "../src/parser";
import { collectPandocCrossReferenceNumbers } from "../src/pandocNumbering";

const markdown = [
  "# Introduction {#sec:intro}",
  "",
  "![A figure.](plot.png){#fig:trend}",
  "",
  "| Value |",
  "| --- |",
  "| 1 |",
  "",
  ": Values {#tbl:values}",
  "",
  "$$",
  "x = 1",
  "$$ {#eq:x}",
].join("\n");

const processedAst: unknown = {
  meta: {
    numberSections: { t: "MetaBool", c: true },
    figureTitle: { t: "MetaInlines", c: [{ t: "Str", c: "Figure" }] },
    tableTitle: { t: "MetaInlines", c: [{ t: "Str", c: "Table" }] },
  },
  blocks: [
    { t: "Header", c: [1, ["sec:intro", [], []], [{ t: "Str", c: "1" }, { t: "Space" }, { t: "Str", c: "Introduction" }]] },
    {
      t: "Figure",
      c: [
        ["fig:trend", [], []],
        [null, [{ t: "Plain", c: [{ t: "Str", c: "Figure" }, { t: "Space" }, { t: "Str", c: "1" }, { t: "Space" }, { t: "Str", c: "A figure." }] }]],
        [],
      ],
    },
    {
      t: "Table",
      c: [
        ["tbl:values", [], []],
        [null, [{ t: "Plain", c: [{ t: "Str", c: "Table" }, { t: "Space" }, { t: "Str", c: "1" }, { t: "Space" }, { t: "Str", c: "Values" }] }]],
        [],
        [],
        [],
        [],
      ],
    },
    {
      t: "Para",
      c: [{ t: "Span", c: [["eq:x", [], []], [{ t: "Math", c: [{ t: "DisplayMath" }, "\nx = 1\n\\qquad{(1)}"] }]] }],
    },
  ],
};

/**
 * Confirms that processed section, figure, table, and equation numbers map to their Markdown source lines.
 */
function mapsProcessedNumbersToMarkdownPositions(): void {
  const parsed = parsePandocDocument(markdown, "file:///manuscript.md");
  const numbers = collectPandocCrossReferenceNumbers(processedAst, parsed);

  assert.deepEqual(numbers.map(({ kind, label, number, line }) => ({ kind, label, number, line })), [
    { kind: "section", label: "sec:intro", number: "1", line: 0 },
    { kind: "figure", label: "fig:trend", number: "1", line: 2 },
    { kind: "table", label: "tbl:values", number: "1", line: 8 },
    { kind: "equation", label: "eq:x", number: "(1)", line: 12 },
  ]);
  assert.deepEqual(numbers.filter(({ kind }) => kind === "figure" || kind === "table").map(({ displayText }) => displayText), ["Figure 1", "Table 1"]);
}

/** Prevents hints from replacing localized prefixes or inserting spaces absent from built captions. */
function preservesBuiltCaptionPrefixes(): void {
  const parsed = parsePandocDocument(markdown, "file:///manuscript.md");
  const ast: { meta: unknown; blocks: unknown[] } = {
    meta: {
      figureTitle: { t: "MetaInlines", c: [{ t: "Strong", c: [{ t: "Str", c: "图" }] }] },
      tableTitle: { t: "MetaInlines", c: [{ t: "Str", c: "表" }] },
    },
    blocks: [
      { t: "Figure", c: [["fig:trend", [], []], [null, [{ t: "Plain", c: [
        { t: "Strong", c: [{ t: "Str", c: "图" }] }, { t: "Str", c: "2.3(a)：结果" },
      ] }]], []] },
      { t: "Table", c: [["tbl:values", [], []], [null, [{ t: "Plain", c: [
        { t: "Str", c: "表" }, { t: "Space" }, { t: "Str", c: "IV:" }, { t: "Space" }, { t: "Str", c: "Values" },
      ] }]], [], [], [], []] },
    ],
  };
  assert.deepEqual(collectPandocCrossReferenceNumbers(ast, parsed).map(({ number, displayText }) => ({ number, displayText })), [
    { number: "2.3(a)", displayText: "图2.3(a)" },
    { number: "IV", displayText: "表 IV" },
  ]);
}

/** An explicitly empty caption title must produce a bare number rather than an invented English prefix. */
function preservesEmptyCaptionPrefix(): void {
  const parsed = parsePandocDocument(markdown, "file:///manuscript.md");
  const ast: { meta: unknown; blocks: unknown[] } = {
    meta: { figureTitle: { t: "MetaInlines", c: [] } },
    blocks: [{ t: "Figure", c: [["fig:trend", [], []], [null, [{ t: "Plain", c: [
      { t: "Str", c: "7:" }, { t: "Space" }, { t: "Str", c: "A figure." },
    ] }]], []] }],
  };
  assert.equal(collectPandocCrossReferenceNumbers(ast, parsed)[0]?.displayText, "7");
  assert.deepEqual(collectPandocCrossReferenceNumbers({ ...ast, meta: {} }, parsed), []);
}

/**
 * Confirms that missing or malformed build output does not invent displayed numbers.
 */
function ignoresUnnumberedAndMalformedAstEntries(): void {
  const unnumberedAst = {
    meta: { numberSections: { t: "MetaBool", c: false } },
    blocks: [{ t: "Header", c: [1, ["sec:intro", [], ["unnumbered"]], [{ t: "Str", c: "Introduction" }]] }],
  };
  const parsed = parsePandocDocument("# Introduction {#sec:intro}", "file:///manuscript.md");

  assert.deepEqual(collectPandocCrossReferenceNumbers(unnumberedAst, parsed), []);
  assert.deepEqual(collectPandocCrossReferenceNumbers(undefined, parsed), []);
}

test("maps processed cross-reference numbers to Markdown inlay positions", mapsProcessedNumbersToMarkdownPositions);
test("preserves built caption prefixes and spacing", preservesBuiltCaptionPrefixes);
test("preserves explicitly empty caption prefixes", preservesEmptyCaptionPrefix);
test("ignores unnumbered sections and malformed AST values", ignoresUnnumberedAndMalformedAstEntries);
