import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { parse, parseDocument } from "yaml";
import { SourceModuleFixture } from "./helpers/sourceModule";

const { getStyleSuggestions, getStyleHoverEntries, mergeStyleExample } = new SourceModuleFixture({ vscode: {} })
  .load<typeof import("../src/styleConfiguration")>("src/styleConfiguration.ts");

/** Requests production completions at the cursor marker in a user-written YAML fragment. */
function suggestions(markedText: string) {
  const offset = markedText.indexOf("<cursor>");
  assert.ok(offset >= 0);
  return getStyleSuggestions(markedText.replace("<cursor>", ""), offset);
}

/** Applies the selected production completion so assertions inspect the resulting configuration. */
function acceptCompletion(markedText: string, label: string): string {
  const text = markedText.replace("<cursor>", "");
  const item = suggestions(markedText).find((entry) => entry.label === label);
  assert.ok(item, `Missing completion ${label}`);
  return text.slice(0, item.start) + item.insertText + text.slice(item.end);
}

/** Checks nested maps and dedents without leaking settings across unrelated domains. */
function completesNestedDomains(): void {
  assert.deepEqual(parse(acceptCompletion("reply:\n  pandocMetadata:\n    link-cit<cursor>\n", "link-citations")), {
    reply: { pandocMetadata: { "link-citations": null } },
  });
  assert.deepEqual(parse(acceptCompletion("reply:\n  tableAutofit: content\nmathtypeSvgBack<cursor>\n", "mathtypeSvgBackend")), {
    reply: { tableAutofit: "content" }, mathtypeSvgBackend: null,
  });
  assert.equal(suggestions("pandocMetadata:\n  mathtype<cursor>").length, 0);
  assert.equal(suggestions("unrelated:\n  docx<cursor>").length, 0);
}

/** Exercises arbitrary quoted style names, Chinese styles and flow-map editing. */
function completesNamedAndInlineStyles(): void {
  const accepted = acceptCompletion('reply:\n  docxStyle:\n    "My custom: style":\n      paragraphSpacing: { be<cursor>: 6pt, after: 0pt }\n', "before");
  assert.equal(parse(accepted).reply.docxStyle["My custom: style"].paragraphSpacing.before, "6pt");
  const chinese = acceptCompletion("docxStyle:\n  正文文本:\n    fontFamily: { west<cursor>: Times New Roman, chinese: 宋体 }\n", "western");
  assert.equal(parse(chinese).docxStyle.正文文本.fontFamily.western, "Times New Roman");
  assert.ok(suggestions("docxStyle: { Body Text: { fo<cursor> } }").some((item) => item.label === "fontSize"));
}

/** Verifies replacement of partial values, quoted values and text to the right of the caret. */
function acceptsValidScalarCompletions(): void {
  assert.equal(parse(acceptCompletion("mathtype:<cursor>\n", "true")).mathtype, true);
  assert.equal(parse(acceptCompletion("reply:\n  mathtype-conversion-method: r<cursor>ust\n", "rust")).reply["mathtype-conversion-method"], "rust");
  assert.equal(parse(acceptCompletion('docxStyle: { Body Text: { alignment: "cen<cursor>ter" } }', "center")).docxStyle["Body Text"].alignment, "center");
  assert.equal(parse(acceptCompletion("docxStyle:\n  Revision Char:\n    fontColor: <cursor>\n", '"#FF0000"')).docxStyle["Revision Char"].fontColor, "#FF0000");
}

/** Keeps comments, block scalar text and sequences free from misleading configuration keys. */
function ignoresNonConfigurationContent(): void {
  assert.deepEqual(suggestions("# mathtype<cursor>"), []);
  assert.deepEqual(suggestions("mathtype: false # t<cursor>"), []);
  assert.deepEqual(suggestions("pandocMetadata:\n  subfigureTemplate: |\n    docx<cursor>\n    literal text\n"), []);
  assert.deepEqual(suggestions("pandocMetadata:\n  custom:\n    - docx<cursor>"), []);
}

/** Suppresses duplicate aliases and conflicting controls while permitting compatible indents. */
function avoidsDuplicateAndConflictingSuggestions(): void {
  assert.ok(!suggestions("docx-show-page-numbers: false\ndocxShow<cursor>").some((item) => item.label === "docxShowPageNumbers"));
  assert.ok(!suggestions("docxSvgToPngWidth: 1600\ndocxSvgToPng<cursor>").some((item) => item.label === "docxSvgToPngScale"));
  const indentation = suggestions("docxStyle:\n  Body Text:\n    firstLineIndentChars: 2\n    indentation:\n      <cursor>");
  assert.ok(indentation.some((item) => item.label === "left"));
  assert.ok(!indentation.some((item) => item.label === "hanging"));
}

/** Preserves overrides, explicit nulls, aliases and notes while filling nested missing fields. */
function mergesWithoutOverwritingUserSettings(): void {
  const original = "# Project notes\r\nmathtype: false # Use native Word\r\ndocx-show-page-numbers: null\r\nmathtypeTypstMathFont:\r\n    font: Custom Math\r\ncustom: &custom { number: 1, values: [a, b] }\r\ncopy: *custom\r\n";
  const example = "mathtype: true\ndocxShowPageNumbers: true\nmathtypeTypstMathFont:\n  font: XITS Math\n  calligraphicFont: New Computer Modern Math\ntableAutofit: none\n# Optional setting stays disabled\n# docxSvgToPngWidth: 1600\n";
  const merged = mergeStyleExample(original, example);
  const config = parse(merged.text);
  assert.equal(config.mathtype, false);
  assert.equal(config["docx-show-page-numbers"], null);
  assert.ok(!("docxShowPageNumbers" in config));
  assert.deepEqual(config.mathtypeTypstMathFont, { font: "Custom Math", calligraphicFont: "New Computer Modern Math" });
  assert.deepEqual(config.copy, config.custom);
  assert.equal(config.tableAutofit, "none");
  assert.ok(!("docxSvgToPngWidth" in config));
  assert.ok(merged.text.includes("Project notes"));
  assert.ok(merged.text.includes("Use native Word"));
  assert.ok(merged.text.includes("Optional setting stays disabled"));
  assert.ok(!/(?<!\r)\n/.test(merged.text));
  assert.equal(merged.addedKeys, 2);
  assert.deepEqual(mergeStyleExample(merged.text, example), { text: merged.text, addedKeys: 0 });
}

/** Ensures the shipped starter remains valid, preserves notes, and is safe to apply repeatedly. */
function mergesTheShippedStarter(): void {
  const example = readFileSync(path.resolve(__dirname, "../assets/style-project.yml"), "utf8");
  const blank = mergeStyleExample("# My notes\n", example);
  assert.ok(blank.text.startsWith("# My notes\n"));
  assert.deepEqual(parse(blank.text), parse(example));
  assert.equal(parseDocument(blank.text).errors.length, 0);
  assert.equal(mergeStyleExample(blank.text, example).text, blank.text);
  const merged = mergeStyleExample("mathtype: false\n", example);
  assert.equal(parse(merged.text).mathtype, false);
  assert.ok(merged.text.includes("# docxPageMargins:"));
  assert.ok(merged.text.includes("# pandocMetadata:"));
  assert.equal(mergeStyleExample(merged.text, example).text, merged.text);
  const closedEmpty = mergeStyleExample("---\n# Retain my notes\n...\n", example);
  assert.equal(parseDocument(closedEmpty.text).errors.length, 0);
  assert.deepEqual(parse(closedEmpty.text), parse(example));
  assert.ok(closedEmpty.text.includes("Retain my notes"));
}

/** Rejects ambiguous or invalid files instead of rewriting them. */
function rejectsInvalidMerges(): void {
  for (const input of ["mathtype: [", "mathtype: true\nmathtype: false\n", "---\na: 1\n---\nb: 2\n", "- item\n", "null\n"]) {
    assert.throws(() => mergeStyleExample(input, "mathtype: true\n"));
  }
  assert.throws(() => mergeStyleExample("{}", "- item\n"));
  const original = 'mathtype: false\nmathtypeTypstMathFont: "Custom Math"\n';
  assert.equal(mergeStyleExample(original, "mathtype: true\nmathtypeTypstMathFont:\n  font: XITS Math\n").text, original);
}

/** Finds the hover at a marked source position using real parsed YAML token ranges. */
function hoverAt(markedText: string) {
  const offset = markedText.indexOf("<cursor>");
  assert.ok(offset >= 0);
  const text = markedText.replace("<cursor>", "");
  const entry = getStyleHoverEntries(text).find((info) => info.start <= offset && offset < info.end);
  return { entry, token: entry ? text.slice(entry.start, entry.end) : undefined };
}

/** Ensures filled keys and scalar values resolve to the same help with precise token ranges. */
function hoversExistingKeysAndValues(): void {
  const key = hoverAt("reply:\r\n  mathtype-conversion-<cursor>method: rust # backend\r\n");
  const value = hoverAt("reply:\r\n  mathtype-conversion-method: r<cursor>ust # backend\r\n");
  assert.ok(key.entry);
  assert.ok(value.entry);
  assert.equal(key.token, "mathtype-conversion-method");
  assert.equal(value.token, "rust");
  assert.deepEqual(key.entry.path, ["reply", "mathtype-conversion-method"]);
  assert.equal(key.entry.currentValue, "rust");
  assert.equal(key.entry.description, value.entry.description);
  assert.deepEqual(key.entry.values, value.entry.values);
  const nullValue = hoverAt("docxPageMargins: n<cursor>ull\n");
  assert.equal(nullValue.entry?.currentValue, "null");
}

/** Resolves arbitrary named styles and nested flow maps without using a parent field's help. */
function hoversNestedAndCustomStyles(): void {
  const name = hoverAt('reply:\n  docxStyle:\n    "My <cursor>custom: style": { paragraphSpacing: { before: 6pt } }\n');
  assert.ok(name.entry);
  assert.deepEqual(name.entry.path, ["reply", "docxStyle", "My custom: style"]);
  const nested = hoverAt('reply:\n  docxStyle:\n    "My custom: style": { paragraphSpacing: { before: 6<cursor>pt } }\n');
  assert.deepEqual(nested.entry?.path, ["reply", "docxStyle", "My custom: style", "paragraphSpacing", "before"]);
  assert.equal(nested.token, "6pt");
  assert.notEqual(nested.entry?.description, name.entry.description);
  const color = hoverAt("docxStyle: { 正文文本: { fontColor: [255, <cursor>0, 0] } }");
  assert.deepEqual(color.entry?.path, ["docxStyle", "正文文本", "fontColor"]);
  assert.equal(color.entry?.currentValue, "[255, 0, 0]");
}

/** Avoids help on comments, whitespace and similarly named keys in unrelated configuration blocks. */
function confinesHoverToKnownFieldTokens(): void {
  for (const text of [
    "# <cursor>mathtype: true\n",
    "mathtype: true # <cursor>comment\n",
    "mathtype:<cursor> true\n",
    "unrelated:\n  <cursor>mathtype: true\n",
    "pandocMetadata:\n  <cursor>mathtype: true\n",
    "docxStyle:\n  Body Text:\n    <cursor>unknown: true\n",
  ]) assert.equal(hoverAt(text).entry, undefined);
  assert.ok(hoverAt("mathtype: f<cursor>alse\nbroken: [\n").entry);
}

test("completes the correct nested style configuration domain", completesNestedDomains);
test("completes arbitrary style names and inline mappings", completesNamedAndInlineStyles);
test("accepts scalar suggestions as valid YAML without duplicate suffixes", acceptsValidScalarCompletions);
test("does not complete comments, multiline text or sequence items", ignoresNonConfigurationContent);
test("avoids duplicate aliases and incompatible controls", avoidsDuplicateAndConflictingSuggestions);
test("merges missing settings while preserving overrides and comments", mergesWithoutOverwritingUserSettings);
test("merges the shipped starter and is idempotent", mergesTheShippedStarter);
test("rejects invalid style files and preserves existing scalar overrides", rejectsInvalidMerges);
test("shows matching hover help for existing style keys and values", hoversExistingKeysAndValues);
test("shows hover help in arbitrary DOCX styles and nested inline maps", hoversNestedAndCustomStyles);
test("confines style hover help to known YAML field tokens", confinesHoverToKnownFieldTokens);
