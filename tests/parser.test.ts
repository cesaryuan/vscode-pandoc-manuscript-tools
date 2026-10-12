import assert from "node:assert/strict";
import test from "node:test";
import { containsPosition, findInlineMathAtPosition, findTokenAtPosition, parsePandocDocument } from "../src/parser";

/** Literal examples must not affect diagnostics, navigation, math hovers or syntax highlights. */
function excludesLiteralContexts(): void {
  const source = [
    "`@fig:code {#fig:fake} [fake]{.mark} $x$`",
    "",
    "    @fig:indented {#fig:fake} [fake]{.mark} $x$",
    "<!-- @fig:comment {#fig:fake}", "", "# Hidden", "::: {.hidden}", "$x$ [fake]{.mark} -->",
    String.raw`\@fig:escaped`,
    '<a title="@fig:tag > {#fig:fake}">link</a>',
    '<pre>@fig:raw [fake]{.mark} $x$</pre>',
    "[link](https://example.com/@fig:path_(part))",
    "[definition]: https://example.com/@fig:url",
    '$@fig:math [fake]{.mark}$',
    `[]{t="sectionBreak" footer='Section []{t="pageNum"} @fig:attribute {#fig:fake}'}`,
    'Visible [@fig:real]{.mark} and ![image](image.png){#fig:real}',
    "::: {.visible}", "body", ":::",
  ].join("\n");
  const parsed = parsePandocDocument(source);
  assert.deepEqual(parsed.references.map((entry) => entry.label), ["fig:real"]);
  assert.deepEqual(parsed.labels.map((entry) => entry.label), ["fig:real"]);
  assert.deepEqual(parsed.spans.map((entry) => entry.text), ["", "@fig:real"]);
  assert.deepEqual(parsed.inlineMath.map((entry) => entry.tex), ["@fig:math [fake]{.mark}"]);
  assert.equal(parsed.headings.length, 0);
  assert.equal(parsed.fencedDivs.length, 1);
  assert.equal(parsed.fencedDivs[0].attributes, "{.visible}");
}

/** Both YAML closers and BOM must preserve subsequent heading IDs and original coordinates. */
function preservesFrontmatterAndHeadingAttributes(): void {
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const closer of ["---", "..."]) {
      const text = ["\uFEFF---", "title: '@fig:hidden'", closer, '# Methods {#sec:methods .unnumbered title="A } B"}', "See @sec:methods."].join(newline);
      const parsed = parsePandocDocument(text);
      assert.deepEqual(parsed.headings.map(({ title, label, line }) => ({ title, label, line })), [{ title: "Methods", label: "sec:methods", line: 3 }]);
      assert.deepEqual(parsed.references.map((entry) => entry.label), ["sec:methods"]);
      assert.equal(text.slice(parsed.labels[0].offset, parsed.labels[0].endOffset), "sec:methods");
      assert.equal(parsed.labels[0].line, 3);
    }
  }
}

/** Soft breaks preserve nested span ranges while code and math exclude inner Markdown syntax. */
function preservesMultilineInlineSyntax(): void {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const outer = `[first [inner]{.nested}${newline}second]{custom-style="Revision Char"}`;
    const formula = `$a +${newline}b$`;
    const text = `😀 ${outer}${newline}${formula}${newline}\`start${newline}$hidden$ [fake]{.mark} @fig:fake${newline}end\`${newline}@fig:visible`;
    const parsed = parsePandocDocument(text);
    assert.equal(parsed.spans.length, 2);
    const span = parsed.spans[0];
    assert.equal(text.slice(span.offset, span.endOffset), outer);
    assert.deepEqual(span.range, { start: { line: 0, character: 3 }, end: { line: 1, character: 'second]{custom-style="Revision Char"}'.length } });
    assert.equal(parsed.spans[1].text, "inner");
    assert.equal(parsed.inlineMath.length, 1);
    assert.equal(text.slice(parsed.inlineMath[0].fullOffset, parsed.inlineMath[0].fullEndOffset), formula);
    assert.equal(findInlineMathAtPosition(parsed, { line: 3, character: 0 })?.tex, `a +${newline}b`);
    assert.deepEqual(parsed.references.map((entry) => entry.label), ["fig:visible"]);
  }
}

/** Dollar delimiter rules keep currency literal and preserve TeX containing Markdown-looking text. */
function respectsMathBoundaries(): void {
  const parsed = parsePandocDocument('Cost $5 and $10; $ x$; $x $; $x$2. Then $a$ and $$[fake]{.mark} @eq:hidden$$ {#eq:real}');
  assert.deepEqual(parsed.inlineMath.map((entry) => entry.tex), ["a"]);
  assert.deepEqual(parsed.mathBlocks.map(({ tex, label }) => ({ tex, label })), [{ tex: "[fake]{.mark} @eq:hidden", label: "eq:real" }]);
  assert.equal(parsed.spans.length, 0);
  assert.equal(parsed.references.length, 0);
  const block = parsePandocDocument("$$\n```\n<!-- TeX content -->\n$$ {#eq:opaque}\n# Visible");
  assert.equal(block.mathBlocks[0].tex, "```\n<!-- TeX content -->");
  assert.equal(block.mathBlocks[0].label, "eq:opaque");
  assert.equal(block.headings[0].title, "Visible");
}

/** Divs and spans share real attribute grammar, including quoted braces and escaped image prefixes. */
function validatesAttributeSyntax(): void {
  const text = '::: {custom-style="A } B } C"}\n[valid]{.mark key=value}\n[text]{not valid attributes ???}\n\\![escaped image]{.mark}\n:::';
  const parsed = parsePandocDocument(text);
  assert.equal(parsed.fencedDivs.length, 1);
  assert.equal(parsed.fencedDivs[0].closed, true);
  assert.deepEqual(parsed.spans.map((entry) => entry.text), ["valid", "escaped image"]);
}

/** Incomplete syntax recovers at the next paragraph instead of hiding later highlights or references. */
function recoversAtParagraphBoundaries(): void {
  const text = `[]{footer='unfinished []{t="pageNum"}\n\n[visible]{.mark} @fig:real`;
  const parsed = parsePandocDocument(text);
  assert.deepEqual(parsed.spans.map((entry) => entry.text), ["visible"]);
  assert.deepEqual(parsed.references.map((entry) => entry.label), ["fig:real"]);
  assert.equal(parsePandocDocument("[unfinished\n\ntext]{.mark}").spans.length, 0);
  assert.equal(parsePandocDocument("$a\n\nb$").inlineMath.length, 0);
}

/** Half-open ranges keep the first following character out of token hover/navigation targets. */
function excludesFollowingCharacters(): void {
  const parsed = parsePandocDocument("@fig:one next");
  assert.equal(findTokenAtPosition(parsed, { line: 0, character: 7 })?.type, "reference");
  assert.equal(findTokenAtPosition(parsed, { line: 0, character: 8 }), undefined);
  assert.equal(containsPosition(parsed.references[0].fullRange, { line: 0, character: 8 }), false);
}

/** Long generated lines and partially typed attributes must retain real tokens after recovery. */
function handlesLongLines(): void {
  const source = "`literal @fig:hidden` ".repeat(4000) + "[]{broken ".repeat(4000)
    + "\\".repeat(16000) + ' [visible]{.mark} @fig:real';
  const parsed = parsePandocDocument(source);
  assert.deepEqual(parsed.references.map((entry) => entry.label), ["fig:real"]);
  assert.deepEqual(parsed.spans.map((entry) => entry.text), ["visible"]);
}

test("all editor features exclude code, comments, raw syntax and attribute values", excludesLiteralContexts);
test("frontmatter closers retain heading attributes and source coordinates", preservesFrontmatterAndHeadingAttributes);
test("soft breaks preserve nested spans and formulas without parsing code contents", preservesMultilineInlineSyntax);
test("math respects dollar boundaries and keeps TeX opaque", respectsMathBoundaries);
test("Div and span attributes use the same quote-aware grammar", validatesAttributeSyntax);
test("unfinished inline syntax recovers at paragraph boundaries", recoversAtParagraphBoundaries);
test("navigation and hovers exclude characters after a token", excludesFollowingCharacters);
test("long code and unfinished attribute lines preserve real subsequent tokens", handlesLongLines);

/** Indentation belongs to prose/list continuations unless a real code block starts at a block boundary. */
function preservesIndentedProseAndQuotedFences(): void {
  const source = ["Paragraph", "    @fig:wrapped", "", "- List item", "", "    @fig:list", "",
    "        @fig:list-code", "", "> ```md", "> @fig:quoted-code", "> ```", "@fig:visible", "",
    "> ```md", "> @fig:unfinished-code", "@fig:after-quote", "", "    @fig:code", "    @fig:still-code"].join("\n");
  assert.deepEqual(parsePandocDocument(source).references.map((entry) => entry.label), ["fig:wrapped", "fig:list", "fig:visible", "fig:after-quote"]);
  assert.equal(parsePandocDocument("`$hidden$ \\` @fig:real").inlineMath.length, 0);
}

test("indentation and quoted fences retain visible prose and hide only actual code", preservesIndentedProseAndQuotedFences);

/** Only real Div tags establish subfigure parents; quoted ID-looking strings and literal tags are excluded. */
function preservesHtmlDivContainers(): void {
  const text = ['`<div id="fig:fake">`', '<div title="id=\'fig:fake\' >" id="fig:parent">',
    '<div class="child">', '![Plot](plot.png){#fig:child}', '</div>', '</div>', '@fig:parent'].join("\r\n");
  const parsed = parsePandocDocument(text);
  assert.deepEqual(parsed.labels.map((label) => label.label), ["fig:parent", "fig:child"]);
  const parent = parsed.labels[0];
  assert.equal(text.slice(parent.offset, parent.endOffset), "fig:parent");
  assert.deepEqual(parent.containerRange, { start: { line: 1, character: 0 }, end: { line: 5, character: 6 } });
}

test("raw Div containers ignore literal and quoted tag lookalikes", preservesHtmlDivContainers);
