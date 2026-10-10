import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { getYamlHeader } from "../src/manuscriptStyle/document";
import { SourceModuleFixture } from "./helpers/sourceModule";

const { getMarkdownHeaderSuggestions, getMarkdownHeaderHoverEntries } = new SourceModuleFixture({ vscode: {} })
  .load<typeof import("../src/markdownYamlHeader")>("src/markdownYamlHeader.ts");

/** Requests completions at a marked cursor in the full Markdown source. */
function suggestions(markedText: string) {
  const offset = markedText.indexOf("<cursor>");
  assert.ok(offset >= 0);
  return getMarkdownHeaderSuggestions(markedText.replace("<cursor>", ""), offset);
}

/** Applies the real completion range and exposes the parsed result for behavior assertions. */
function acceptCompletion(markedText: string, label: string): string {
  const text = markedText.replace("<cursor>", "");
  const suggestion = suggestions(markedText)?.find((item) => item.label === label);
  assert.ok(suggestion, `Missing completion ${label}`);
  return text.slice(0, suggestion.start) + suggestion.insertText + text.slice(suggestion.end);
}

/** Finds help using absolute source coordinates so BOM and CRLF offsets are exercised. */
function hoverAt(markedText: string) {
  const offset = markedText.indexOf("<cursor>");
  assert.ok(offset >= 0);
  const text = markedText.replace("<cursor>", "");
  const entry = getMarkdownHeaderHoverEntries(text).find((item) => item.start <= offset && offset < item.end);
  return { entry, token: entry ? text.slice(entry.start, entry.end) : undefined };
}

/** Checks metadata key edits preserve delimiters, original values and the Markdown body exactly. */
function completesMetadataWithoutChangingBody(): void {
  assert.equal(acceptCompletion("---\n<cursor>\n---\n", "title"), "---\ntitle: \n---\n");
  const source = "\uFEFF---\r\ntitle: Paper\r\nbibli<cursor>ography: refs.bib\r\n...\r\n\r\n# Body\r\nLiteral text\r\n";
  const accepted = acceptCompletion(source, "bibliography");
  const header = getYamlHeader(accepted);
  assert.deepEqual(parse(header.content), { title: "Paper", bibliography: "refs.bib" });
  assert.equal(accepted, source.replace("<cursor>", ""));
  assert.equal(accepted.slice(header.bodyStart), "\r\n# Body\r\nLiteral text\r\n");
  assert.ok(suggestions("---\nnumberSec<cursor>\n---\n")?.some((item) => item.label === "numberSections"));
  assert.deepEqual(suggestions("---\nmathtype<cursor>\n---\n"), []);
}

/** Reuses style configuration rules under both spellings of per-manuscript Papper settings. */
function completesPerManuscriptSettings(): void {
  const source = "---\npapper-settings:\n  reply:\n    docx-style:\n      My Style:\n        paragraphSpacing: { be<cursor>: 6pt, after: 0pt }\n---\n# Body";
  const accepted = acceptCompletion(source, "before");
  assert.equal(parse(getYamlHeader(accepted).content)["papper-settings"].reply["docx-style"]["My Style"].paragraphSpacing.before, "6pt");
  const boolean = acceptCompletion("---\npapperSettings:\n  mathtype: f<cursor>alse\n---\n", "false");
  assert.equal(parse(getYamlHeader(boolean).content).papperSettings.mathtype, false);
  assert.ok(suggestions("---\npapperSettings:\n  pandocMetadata:\n    fig<cursor>\n---\n")?.some((item) => item.label === "figureTitle"));
  assert.deepEqual(suggestions("---\nreply:\n  mathtype<cursor>\n---\n"), []);
}

/** Completes first keys, later keys and scalar values inside author-list mappings. */
function completesAuthorLists(): void {
  const first = acceptCompletion("---\nauthors:\n  - na<cursor>me: First Author\n---\n", "name");
  assert.deepEqual(parse(getYamlHeader(first).content).authors, [{ name: "First Author" }]);
  const later = acceptCompletion("---\nauthors:\n  - name: First Author\n    co<cursor>\n  - name: Second Author\n---\n", "corresponding");
  assert.deepEqual(parse(getYamlHeader(later).content).authors, [{ name: "First Author", corresponding: null }, { name: "Second Author" }]);
  const inline = acceptCompletion("---\nauthor: [{ name: First Author, corresponding: tr<cursor>ue }]\n---\n", "true");
  assert.equal(parse(getYamlHeader(inline).content).author[0].corresponding, true);
  const jobTitle = hoverAt("---\nauthors:\n  - name: Author\n    ti<cursor>tle: Professor\n---\n");
  const manuscriptTitle = hoverAt("---\nti<cursor>tle: My Paper\n---\n");
  assert.deepEqual(jobTitle.entry?.path, ["authors", "0", "title"]);
  assert.notEqual(jobTitle.entry?.description, manuscriptTitle.entry?.description);
}

/** Shows equivalent help for header keys and values, including nested styles and shared affiliations. */
function hoversHeaderFields(): void {
  const value = hoverAt("\uFEFF---\r\npapperSettings:\r\n  docxStyle:\r\n    正文文本: { bold: f<cursor>alse }\r\n---\r\n# Body\r\n");
  const key = hoverAt("\uFEFF---\r\npapperSettings:\r\n  docxStyle:\r\n    正文文本: { bo<cursor>ld: false }\r\n---\r\n# Body\r\n");
  assert.equal(value.token, "false");
  assert.equal(key.token, "bold");
  assert.deepEqual(value.entry?.path, ["papperSettings", "docxStyle", "正文文本", "bold"]);
  assert.equal(value.entry?.description, key.entry?.description);
  assert.equal(value.entry?.currentValue, "false");
  const reply = hoverAt("---\nre<cursor>ply: manuscript.md\n---\n");
  assert.equal(reply.entry?.currentValue, "manuscript.md");
  const affiliation = hoverAt("---\naffiliations:\n  a: Example <cursor>University\n---\n");
  assert.deepEqual(affiliation.entry?.path, ["affiliations", "a"]);
}

/** Keeps body prose, fences, comments and header delimiters outside YAML configuration completion. */
function excludesNonHeaderContent(): void {
  for (const source of [
    "# Paper\n\n<cursor>title: Body text\n",
    "```yaml\n---\n<cursor>title: Example\n---\n```\n",
    "---\ntitle: Paper\n---\n<cursor>title: Body text\n",
    "---\ntitle: Paper\n<cursor>---\n",
    "---\ntitle: Paper\n<cursor>...\n",
  ]) {
    assert.equal(suggestions(source), undefined);
    assert.equal(hoverAt(source).entry, undefined);
  }
  for (const source of ["---\n# ti<cursor>tle\n---\n", "---\nunknown:\n  ti<cursor>tle: literal\n---\n"]) {
    assert.deepEqual(suggestions(source), []);
    assert.equal(hoverAt(source).entry, undefined);
  }
  assert.deepEqual(suggestions("---\nabstract: |\n  ti<cursor>tle: literal text\n  More text\n---\n"), []);
}

/** Supports a header still being typed while preserving the strict behavior of edit commands. */
function handlesUnfinishedHeaders(): void {
  const source = "---\npapperSettings:\n  docxStyle:\n    Body Text:\n      bo<cursor>";
  const accepted = acceptCompletion(source, "bold");
  assert.equal(parse(getYamlHeader(accepted, true).content).papperSettings.docxStyle["Body Text"].bold, null);
  assert.throws(() => getYamlHeader(accepted), /结束分隔符/);
  assert.ok(hoverAt("---\npapperSettings:\n  mathtype: f<cursor>alse\n").entry);
  assert.equal(hoverAt("---\ntitle: Pa<cursor>per\nbroken: [\n").entry?.currentValue, "Paper");
}

test("completes manuscript metadata while preserving source offsets and body", completesMetadataWithoutChangingBody);
test("completes local Papper settings and separates manuscript reply paths", completesPerManuscriptSettings);
test("completes and documents author-list mappings", completesAuthorLists);
test("shows help for Markdown header keys, values and nested configuration", hoversHeaderFields);
test("does not offer YAML configuration help outside the leading header", excludesNonHeaderContent);
test("helps while a YAML header is unfinished without weakening edit validation", handlesUnfinishedHeaders);
