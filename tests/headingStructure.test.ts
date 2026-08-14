import assert from "node:assert/strict";
import test from "node:test";
import { parsePandocDocument } from "../src/parser";
import { buildHeadingFoldingRanges } from "../src/headingStructure";

/** Reproduces the Pandoc math-label case where later headings must remain foldable. */
function verifiesPandocHeadingFoldsSurviveLabeledMath(): void {
  const text = [
    "# Methods {#sec:methods}",
    "Introductory text",
    "## Objective {#sec:objective}",
    "$$",
    "x = 1",
    "$$ {#eq:objective}",
    "### Results {#sec:results}",
    "Result text",
    "## Discussion {#sec:discussion}",
    "Discussion text",
  ].join("\n");
  const parsed = parsePandocDocument(text, "test.md");

  assert.deepEqual(parsed.headings.map((heading) => heading.line), [0, 2, 6, 8]);
  assert.deepEqual(buildHeadingFoldingRanges(parsed.headings, text.split("\n").length), [
    { start: 0, end: 9 },
    { start: 2, end: 7 },
    { start: 6, end: 7 },
    { start: 8, end: 9 },
  ]);
}

/** Ensures an empty heading section does not create an invalid self-fold. */
function skipsEmptyHeadingSections(): void {
  const parsed = parsePandocDocument("# One\n## Two", "empty.md");

  assert.deepEqual(buildHeadingFoldingRanges(parsed.headings, 2), [
    { start: 0, end: 1 },
  ]);
}

test("builds heading folds across Pandoc labeled display math", verifiesPandocHeadingFoldsSurviveLabeledMath);
test("skips empty heading sections", skipsEmptyHeadingSections);
