import assert from "node:assert/strict";
import test from "node:test";
import { CommentParagraphScanner, isTranslatableCommentText, type CommentSyntax, type CommentTextDocument } from "../src/commentTranslation/commentParagraph";

const slashComments: CommentSyntax = { lineComments: ["//"], blockComments: [["/*", "*/"]] };

/** Adapts editor-like line access without loading the VS Code runtime. */
function documentFrom(text: string): CommentTextDocument {
  const lines = text.split(/\r?\n/);
  return { lineCount: lines.length, lineAt: (line) => ({ text: lines[line] }) };
}

/** Selects the entire adjacent comment paragraph and keeps empty comments as paragraph boundaries. */
function joinsLineCommentsByParagraph(): void {
  const document = documentFrom("const key = 1;\n// Build the cache key.\n// Reuse the normalized path.\n//\n// Stop after three attempts.\nreturn key;");
  const paragraph = new CommentParagraphScanner(document, { line: 2, character: 8 }, slashComments).find();
  assert.equal(paragraph?.text, "Build the cache key.\nReuse the normalized path.");
  assert.deepEqual(paragraph?.range, { start: { line: 1, character: 0 }, end: { line: 2, character: 29 } });
  assert.equal(new CommentParagraphScanner(document, { line: 4, character: 7 }, slashComments).find()?.text, "Stop after three attempts.");
  assert.equal(new CommentParagraphScanner(document, { line: 3, character: 1 }, slashComments).find(), undefined);
}

/** A trailing comment triggers only on its comment range and never collects adjacent standalone comments. */
function isolatesTrailingComments(): void {
  const line = "return value; // Reuse the cached result";
  const document = documentFrom(`${line}\n// Explain the next operation`);
  assert.equal(new CommentParagraphScanner(document, { line: 0, character: 4 }, slashComments).find(), undefined);
  const paragraph = new CommentParagraphScanner(document, { line: 0, character: 20 }, slashComments).find();
  assert.equal(paragraph?.text, "Reuse the cached result");
  assert.equal(paragraph?.range.start.character, line.indexOf("//"));
  assert.equal(paragraph?.range.end.line, 0);
}

/** Removes documentation decoration and translates only the hovered block paragraph. */
function separatesBlockParagraphs(): void {
  const document = documentFrom("/**\n * Build the cache key.\n * Reuse the normalized path.\n *\n * Stop after three attempts.\n */\nconst next = true;");
  assert.equal(new CommentParagraphScanner(document, { line: 2, character: 10 }, slashComments).find()?.text,
    "Build the cache key.\nReuse the normalized path.");
  assert.equal(new CommentParagraphScanner(document, { line: 4, character: 10 }, slashComments).find()?.text, "Stop after three attempts.");
  assert.equal(new CommentParagraphScanner(document, { line: 0, character: 1 }, slashComments).find()?.text,
    "Build the cache key.\nReuse the normalized path.");
  assert.equal(new CommentParagraphScanner(document, { line: 5, character: 2 }, slashComments).find()?.text, "Stop after three attempts.");
  assert.equal(new CommentParagraphScanner(document, { line: 3, character: 1 }, slashComments).find(), undefined);
  assert.equal(new CommentParagraphScanner(document, { line: 6, character: 8 }, slashComments).find(), undefined);
}

/** Stops at each inline block's closing delimiter rather than combining unrelated text on the same line. */
function separatesInlineBlocks(): void {
  const source = "/* First explanation */ const x = 1; /* Second explanation */";
  const document = documentFrom(source);
  assert.equal(new CommentParagraphScanner(document, { line: 0, character: 5 }, slashComments).find()?.text, "First explanation");
  assert.equal(new CommentParagraphScanner(document, { line: 0, character: source.indexOf("Second") }, slashComments).find()?.text, "Second explanation");
}

/** String-shaped comments and ordinary Python triple-quoted text are deliberately eligible. */
function allowsStringContent(): void {
  const document = documentFrom('const note = "// Explain the cached result";');
  assert.equal(new CommentParagraphScanner(document, { line: 0, character: 25 }, slashComments).find()?.text,
    'Explain the cached result";');
  const python: CommentSyntax = { lineComments: ["#"], blockComments: [['"""', '"""'], ["'''", "'''"]] };
  const string = documentFrom('message = """\nExplain the first operation.\n\nExplain the second operation.\n"""');
  assert.equal(new CommentParagraphScanner(string, { line: 1, character: 5 }, python).find()?.text, "Explain the first operation.");
  assert.equal(new CommentParagraphScanner(string, { line: 3, character: 5 }, python).find()?.text, "Explain the second operation.");
}

/** A long block opener takes precedence over the language's shorter line-comment prefix. */
function prioritizesBlockPrefixes(): void {
  const lua: CommentSyntax = { lineComments: ["--"], blockComments: [["--[[", "]]"]] };
  const document = documentFrom("--[[\nExplain the first operation.\nExplain the second operation.\n]]\nlocal value = 1");
  assert.equal(new CommentParagraphScanner(document, { line: 2, character: 5 }, lua).find()?.text,
    "Explain the first operation.\nExplain the second operation.");
}

/** Uses supplied language delimiters without requiring a language-specific parser. */
function usesCustomDelimiters(): void {
  const syntax: CommentSyntax = { lineComments: [";"], blockComments: [["(*", "*)"]] };
  const document = documentFrom("; Cache the result\n; Reuse the result\n\n(* Explain the next step *)");
  assert.equal(new CommentParagraphScanner(document, { line: 1, character: 4 }, syntax).find()?.text,
    "Cache the result\nReuse the result");
  assert.equal(new CommentParagraphScanner(document, { line: 3, character: 8 }, syntax).find()?.text, "Explain the next step");
}

/** Finds nearby comments in a million-line document while rejecting any access outside the local window. */
function boundsDocumentReads(): void {
  const center = 500_000;
  const document: CommentTextDocument = {
    lineCount: 1_000_000,
    lineAt(line) {
      assert.ok(Math.abs(line - center) <= 30, `Accessed distant line ${line}`);
      return { text: line === center ? "// Cache the result" : "const value = 1;" };
    },
  };
  assert.equal(new CommentParagraphScanner(document, { line: center, character: 8 }, slashComments).find()?.text, "Cache the result");
}

/** A scan limit must not send a silently truncated paragraph to translation. */
function rejectsTruncatedParagraphs(): void {
  const document = documentFrom(Array.from({ length: 80 }, () => "// Continue the explanation.").join("\n"));
  assert.equal(new CommentParagraphScanner(document, { line: 40, character: 8 }, slashComments).find(), undefined);
  const block = documentFrom(`/*\n${Array.from({ length: 80 }, () => "Continue the explanation.").join("\n")}\n*/`);
  assert.equal(new CommentParagraphScanner(block, { line: 10, character: 8 }, slashComments).find(), undefined);
  const unfinished = documentFrom("/* Explain the unfinished operation.");
  assert.equal(new CommentParagraphScanner(unfinished, { line: 0, character: 8 }, slashComments).find()?.text,
    "Explain the unfinished operation.");
}

/** Short English comments translate, while Chinese-only, identifier-only and over-limit text do not. */
function filtersTranslationText(): void {
  assert.equal(isTranslatableCommentText("Cache the result", 100), true);
  assert.equal(isTranslatableCommentText("Cache the result（缓存）", 100), true);
  assert.equal(isTranslatableCommentText("这是中文注释", 100), false);
  assert.equal(isTranslatableCommentText("TODO", 100), false);
  assert.equal(isTranslatableCommentText("Cache the result", 5), false);
}

test("joins line comments and splits at empty comments", joinsLineCommentsByParagraph);
test("isolates trailing comments from code and other comments", isolatesTrailingComments);
test("splits block comments and removes documentation decoration", separatesBlockParagraphs);
test("separates multiple inline comment blocks", separatesInlineBlocks);
test("allows comment-shaped strings and Python triple-quoted text", allowsStringContent);
test("prefers Lua block comments over overlapping line prefixes", prioritizesBlockPrefixes);
test("extracts paragraphs using arbitrary supplied delimiters", usesCustomDelimiters);
test("reads only nearby lines in a large document", boundsDocumentReads);
test("suppresses paragraphs cut by the scan limit", rejectsTruncatedParagraphs);
test("accepts short English comments within the translation length limit", filtersTranslationText);
