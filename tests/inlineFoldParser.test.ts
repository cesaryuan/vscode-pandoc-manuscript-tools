import assert from "node:assert/strict";
import test from "node:test";
import { isRevisionCharCustomStyle, parsePandocDocument } from "../src/parser";

/** Verifies the target annotation exposes precise content and code-span ranges. */
function verifiesLineExcerptFoldParsing(): void {
  const text = "Before (Line `The experimental procedure consists of four main stages`) after";
  const parsed = parsePandocDocument(text, "test.md");

  assert.equal(parsed.lineExcerptFolds.length, 1);
  const fold = parsed.lineExcerptFolds[0];
  assert.equal(fold.text, "The experimental procedure consists of four main stages");
  assert.equal(text.slice(fold.offset, fold.endOffset), fold.text);
  assert.equal(text.slice(fold.fullOffset, fold.fullEndOffset), "`The experimental procedure consists of four main stages`");
}

/** Verifies ordinary code and parser-ignored Markdown regions do not fold. */
function verifiesLineExcerptFoldBoundaries(): void {
  const ordinaryCode = parsePandocDocument("Ordinary `visible code` remains", "ordinary.md");
  const fencedCode = parsePandocDocument("```markdown\n(Line `inside a fence`)\n```", "fence.md");
  const yaml = parsePandocDocument("---\nnote: \"(Line `inside yaml`)\"\n---\nBody", "yaml.md");

  assert.equal(ordinaryCode.lineExcerptFolds.length, 0);
  assert.equal(fencedCode.lineExcerptFolds.length, 0);
  assert.equal(yaml.lineExcerptFolds.length, 0);
}

/** Verifies matching multi-backtick delimiters preserve inner backticks. */
function verifiesMultiBacktickLineExcerptFold(): void {
  const parsed = parsePandocDocument("(Line ``contains a ` backtick``)", "double.md");

  assert.equal(parsed.lineExcerptFolds.length, 1);
  assert.equal(parsed.lineExcerptFolds[0].text, "contains a ` backtick");
}

/** Verifies Revision Char spans expose an exact foldable attribute range. */
function verifiesRevisionCharAttributeRange(): void {
  const text = "[an emphatic phrase]{custom-style=\"Revision Char\"}";
  const span = parsePandocDocument(text, "revision.md").spans[0];

  assert.equal(text.slice(span.attributeRange.start.character, span.attributeRange.end.character), "{custom-style=\"Revision Char\"}");
  assert.equal(isRevisionCharCustomStyle(span.attributes), true);
}

/** Verifies only an unambiguous exact Revision Char style is foldable. */
function verifiesRevisionCharStyleBoundary(): void {
  assert.equal(isRevisionCharCustomStyle("custom-style=\"Emphatically\""), false);
  assert.equal(isRevisionCharCustomStyle("custom-style=\"Revision Character\""), false);
  assert.equal(isRevisionCharCustomStyle("custom-style=\"revision char\""), false);
  assert.equal(isRevisionCharCustomStyle("custom-style='Revision Char'"), true);
  assert.equal(isRevisionCharCustomStyle("custom-style=\"Revision Char\" custom-style=\"Other\""), false);
}

test("parses quoted Line annotations for inline folding", verifiesLineExcerptFoldParsing);
test("ignores ordinary code spans, fenced code, and YAML", verifiesLineExcerptFoldBoundaries);
test("supports multi-backtick Line annotations", verifiesMultiBacktickLineExcerptFold);
test("parses the Revision Char attribute fold range", verifiesRevisionCharAttributeRange);
test("folds only the exact Revision Char custom style", verifiesRevisionCharStyleBoundary);
