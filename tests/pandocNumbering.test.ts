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
test("ignores unnumbered sections and malformed AST values", ignoresUnnumberedAndMalformedAstEntries);
