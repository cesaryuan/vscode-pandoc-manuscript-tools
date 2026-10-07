import assert from "node:assert/strict";
import test from "node:test";
import { findInlineMathAtPosition, findMathBlockAtPosition, parsePandocDocument } from "../src/parser";

/** Reproduces the reported formula and verifies hover targets include both delimiters. */
function previewsSingleLineDisplayMath(): void {
  const tex = String.raw`\mathbf{h}_{v_i}^T=\mathbf{h}_{v_i}^{pos_T}\oplus \mathbf{h}_{v_i}^{bc_T}\oplus \mathbf{h}_{v_i}^{heat}`;
  const text = `$$${tex}$$`;
  const parsed = parsePandocDocument(text, "formula.md");

  assert.equal(parsed.mathBlocks.length, 1);
  for (let character = 0; character < text.length; character += 1) {
    const target = findMathBlockAtPosition(parsed, { line: 0, character });
    assert.equal(target?.tex, tex);
    assert.equal(target?.display, true);
    assert.equal(findInlineMathAtPosition(parsed, { line: 0, character }), undefined);
  }
}

/** Verifies equation-label hovers resolve to the associated single-line formula. */
function previewsLabeledSingleLineDisplayMath(): void {
  const text = "  $$ x = 1 $$ {#eq:first} and $$ y = 2 $$ {#eq:second}";
  const parsed = parsePandocDocument(text);

  assert.equal(parsed.mathBlocks.length, 2);
  for (const [label, tex] of [["eq:first", "x = 1"], ["eq:second", "y = 2"]]) {
    const position = { line: 0, character: text.indexOf(label) };
    const target = findMathBlockAtPosition(parsed, position);
    assert.equal(target?.label, label);
    assert.equal(target?.tex, tex);
    assert.deepEqual(target?.selectionRange, parsed.labelMap.get(label)?.[0].range);
  }
  assert.equal(findMathBlockAtPosition(parsed, { line: 0, character: text.indexOf("and") }), undefined);
}

/** Verifies surrounding inline math remains available without scanning inside display math. */
function separatesDisplayAndInlineHoverTargets(): void {
  const text = String.raw`Before $a$ then $$\text{$literal$} + \(b\)$$ after $c$`;
  const parsed = parsePandocDocument(text);

  assert.equal(parsed.mathBlocks.length, 1);
  assert.equal(parsed.mathBlocks[0].tex, String.raw`\text{$literal$} + \(b\)`);
  assert.deepEqual(parsed.inlineMath.map((entry) => entry.tex), ["a", "c"]);
  assert.equal(findMathBlockAtPosition(parsed, { line: 0, character: 0 }), undefined);
  assert.equal(findInlineMathAtPosition(parsed, { line: 0, character: text.indexOf("$c$") + 1 })?.tex, "c");
}

/** Verifies literal code, escaped delimiters, and incomplete pairs cannot create display previews. */
function ignoresLiteralAndIncompleteDisplayMath(): void {
  const documents = [
    "`$$x$$`",
    "``$$x$$``",
    "```ruby\n$$x$$\n```",
    "---\nformula: $$x$$\n---",
    String.raw`\$$x\$$`,
    "$$x",
  ];
  for (const text of documents) {
    assert.equal(parsePandocDocument(text).mathBlocks.length, 0, text);
  }
}

/** Verifies single-line formulas do not disrupt existing multiline math or subsequent headings. */
function preservesMultilineDisplayMath(): void {
  const text = "$$a$$\n$$\nx + y\n$$ {#eq:sum}\n\\[\nz\n\\]\n# Results";
  const parsed = parsePandocDocument(text);

  assert.deepEqual(parsed.mathBlocks.map((entry) => [entry.tex, entry.label, entry.line, entry.endLine]), [
    ["a", undefined, 0, 0],
    ["x + y", "eq:sum", 1, 3],
    ["z", undefined, 4, 6],
  ]);
  assert.equal(findMathBlockAtPosition(parsed, { line: 2, character: 2 })?.tex, "x + y");
  assert.deepEqual(parsed.headings.map((entry) => entry.title), ["Results"]);
}

test("previews same-line double-dollar formulas at every formula position", previewsSingleLineDisplayMath);
test("associates same-line display formulas with their own equation labels", previewsLabeledSingleLineDisplayMath);
test("keeps display and inline formula hover targets separate", separatesDisplayAndInlineHoverTargets);
test("ignores literal and incomplete same-line display formulas", ignoresLiteralAndIncompleteDisplayMath);
test("preserves multiline display formulas and following headings", preservesMultilineDisplayMath);
