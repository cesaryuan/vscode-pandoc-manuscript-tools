"use strict";

const vscode = require("vscode");

const PANDOC_LANGUAGE_IDS = new Set(["markdown", "mdx"]);

/**
 * Converts a plain parser range into a VS Code range.
 *
 * @param {import("./parser").PlainRange} range Plain parser range.
 * @returns {vscode.Range}
 */
function toRange(range) {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

/**
 * Converts a parser entry to a VS Code location.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Parsed entry.
 * @returns {vscode.Location}
 */
function toLocation(entry) {
  return new vscode.Location(vscode.Uri.parse(entry.uriText), toRange(entry.range));
}

/**
 * Converts a definition target into a VS Code location link.
 *
 * The origin range must cover the full Pandoc token; otherwise Ctrl-hover
 * falls back to VS Code word ranges and underlines only `sec` or `results`.
 *
 * @param {import("./parser").LabelEntry} target Definition target entry.
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} origin Origin token under the cursor.
 * @returns {vscode.LocationLink}
 */
function toLocationLink(target, origin) {
  return {
    originSelectionRange: toRange(origin.fullRange),
    targetUri: vscode.Uri.parse(target.uriText),
    targetRange: toRange(target.fullRange),
    targetSelectionRange: toRange(target.range),
  };
}

/**
 * Converts a VS Code position into a serializable parser position.
 *
 * @param {vscode.Position} position VS Code position.
 * @returns {{line: number, character: number}}
 */
function toPlainPosition(position) {
  return { line: position.line, character: position.character };
}

/**
 * Returns a VS Code symbol kind for a Pandoc label prefix.
 *
 * @param {string} prefix Pandoc label prefix.
 * @returns {vscode.SymbolKind}
 */
function toSymbolKind(prefix) {
  if (prefix === "eq") {
    return vscode.SymbolKind.Number;
  }
  if (prefix === "fig") {
    return vscode.SymbolKind.Object;
  }
  if (prefix === "tbl") {
    return vscode.SymbolKind.Array;
  }
  return vscode.SymbolKind.String;
}

/**
 * Checks whether a document can participate in editor-only language features.
 *
 * Untitled buffers are useful for hover and index behavior while editing, but
 * build commands still require a saved file and use a stricter helper below.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isEditorBackedDocument(document) {
  return document.uri.scheme === "file" || document.uri.scheme === "untitled";
}

/**
 * Checks whether a document language is in one supported-language set.
 *
 * @param {vscode.TextDocument} document Text document.
 * @param {Set<string>} languageIds Supported VS Code language IDs.
 * @returns {boolean}
 */
function isSupportedLanguageDocument(document, languageIds) {
  return languageIds.has(document.languageId);
}

/**
 * Checks whether a document should get full Pandoc-style features.
 *
 * `.mdx` intentionally reuses the Markdown-oriented index and hover pipeline
 * because the user asked for MDX support and its prose/math structure is close
 * enough to Markdown for the current parser.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isPandocDocument(document) {
  return isEditorBackedDocument(document) && isSupportedLanguageDocument(document, PANDOC_LANGUAGE_IDS);
}

/**
 * Checks whether a document can use Pandoc text-oriented hover branches.
 *
 * `.tex` files are deliberately excluded here: they should gain formula
 * previews without also inheriting paragraph-translation or label-summary
 * behavior that is specific to Markdown/MDX manuscripts.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function supportsPandocTextFeatures(document) {
  return isSupportedLanguageDocument(document, PANDOC_LANGUAGE_IDS);
}

/**
 * Checks whether a Markdown document can be passed to the project build script.
 *
 * Untitled Markdown is useful for language features, but the DOCX build needs
 * a concrete file path so the build script can derive the output filename.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isBuildableMarkdownDocument(document) {
  return document.languageId === "markdown" && document.uri.scheme === "file";
}

module.exports = {
  toRange,
  toLocation,
  toLocationLink,
  toPlainPosition,
  toSymbolKind,
  isPandocDocument,
  supportsPandocTextFeatures,
  isBuildableMarkdownDocument,
};
