"use strict";

const vscode = require("vscode");
const { EXTENSION_NAME } = require("./constants");
const { getConfiguration } = require("./configuration");
const {
  parsePandocDocument,
  findMathBlockAtPosition,
  findInlineMathAtPosition,
  findTokenAtPosition,
  containsPosition,
} = require("./parser");
const {
  toRange,
  toLocation,
  toLocationLink,
  toPlainPosition,
  toSymbolKind,
  isMarkdownDocument,
} = require("./vscodeUtils");

class PandocDefinitionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides go-to-definition for Pandoc cross references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.LocationLink[] | undefined}
   */
  provideDefinition(document, position) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    return this.index.getDefinitions(document, token.entry.label).map((definition) => toLocationLink(definition, token.entry));
  }
}

class PandocReferenceProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides find-all-references for Pandoc labels and references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @param {{includeDeclaration: boolean}} options Reference options.
   * @returns {vscode.Location[] | undefined}
   */
  provideReferences(document, position, options) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    const locations = this.index.getReferences(document, token.entry.label).map(toLocation);
    if (options.includeDeclaration) {
      locations.unshift(...this.index.getDefinitions(document, token.entry.label).map(toLocation));
    }
    return locations;
  }
}

class PandocHoverProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
   * @param {GoogleParagraphTranslator} paragraphTranslator Paragraph translation service.
   */
  constructor(index, mathRenderer, paragraphTranslator) {
    this.index = index;
    this.mathRenderer = mathRenderer;
    this.paragraphTranslator = paragraphTranslator;
  }

  /**
   * Provides label, reference, math, and optional paragraph hover information.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {Promise<vscode.Hover | undefined>}
   */
  async provideHover(document, position) {
    const parsed = this.index.getParsedDocument(document);
    const plainPosition = toPlainPosition(position);
    const token = findTokenAtPosition(parsed, plainPosition);
    if (token) {
      const labeledMathBlock = findMathBlockForEquationLabelHover(parsed, token, plainPosition);
      if (labeledMathBlock) {
        // Pandoc-crossref puts equation labels on the closing delimiter, so the
        // token hover must opt into the formula preview before the generic label
        // hover short-circuits it.
        return new vscode.Hover(await buildMathHover(labeledMathBlock, this.index, document, this.mathRenderer), toRange(token.entry.fullRange));
      }
      return new vscode.Hover(buildLabelHover(token.entry, this.index, document, token.type), toRange(token.entry.fullRange));
    }

    const mathBlock = findMathBlockAtPosition(parsed, plainPosition);
    if (mathBlock) {
      // Math-block hovers should shade the whole display equation; label hovers
      // are handled above so `{#eq:...}` still keeps its tighter range.
      return new vscode.Hover(await buildMathHover(mathBlock, this.index, document, this.mathRenderer), toRange(mathBlock.range));
    }

    const paragraphHover = findParagraphHover(document, parsed, position);
    if (paragraphHover) {
      const paragraphMarkdown = await buildParagraphHover(paragraphHover, this.mathRenderer, this.paragraphTranslator);
      if (paragraphMarkdown) {
        return new vscode.Hover(paragraphMarkdown, paragraphHover.range);
      }
    }

    const inlineMath = findInlineMathAtPosition(parsed, plainPosition);
    if (inlineMath) {
      return new vscode.Hover(await buildInlineMathHover(inlineMath, this.mathRenderer), toRange(inlineMath.fullRange));
    }

    return undefined;
  }
}

/**
 * Finds the display equation associated with an equation-definition label hover.
 *
 * Only labels parsed from math delimiters should use the formula preview here;
 * cross-reference hovers such as `@eq:linear` still need the generic label
 * summary instead of rendering the target equation inline.
 *
 * @param {import("./parser").ParsedPandocDocument} parsed Parsed document.
 * @param {{type: string, entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry}} token Token under the cursor.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {import("./parser").MathBlockEntry | undefined}
 */
function findMathBlockForEquationLabelHover(parsed, token, position) {
  if (token.type !== "label" || token.entry.prefix !== "eq" || token.entry.source !== "math") {
    return undefined;
  }

  const mathBlock = findMathBlockAtPosition(parsed, position);
  if (!mathBlock || mathBlock.label !== token.entry.label) {
    return undefined;
  }

  return mathBlock;
}

/**
 * Finds the current Markdown paragraph when a paragraph hover feature applies.
 *
 * Paragraph hovers can be triggered by inline-math preview or translation, so
 * English paragraphs without formulas can still show translation when enabled.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {import("./parser").ParsedPandocDocument} parsed Parsed document.
 * @param {vscode.Position} position Hover position.
 * @returns {ParagraphHover | undefined}
 */
function findParagraphHover(document, parsed, position) {
  if (isParagraphBoundaryLine(document, position.line)) {
    return undefined;
  }

  const range = findParagraphRange(document, position.line);
  const paragraphText = document.getText(range);
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const inlineMath = parsed.inlineMath.filter((entry) => entry.fullOffset >= startOffset && entry.fullEndOffset <= endOffset);
  const showMathPreview = shouldShowInlineMathParagraphPreview(paragraphText, inlineMath);
  const showTranslation = shouldTranslateParagraphHover(paragraphText);

  if (!showMathPreview && !showTranslation) {
    return undefined;
  }

  return {
    range,
    text: paragraphText,
    startOffset,
    inlineMath,
    showMathPreview,
    showTranslation,
  };
}

/**
 * Checks whether the paragraph should show the rendered inline-math preview.
 *
 * @param {string} paragraphText Raw paragraph text.
 * @param {import("./parser").InlineMathEntry[]} inlineMath Inline math spans inside the paragraph.
 * @returns {boolean}
 */
function shouldShowInlineMathParagraphPreview(paragraphText, inlineMath) {
  return getConfiguration().get("enableInlineMathParagraphHover", false)
    && inlineMath.length > 0
    && !isParagraphTooLongForHover(paragraphText);
}

/**
 * Checks the user-configured paragraph preview length limit.
 *
 * Long paragraphs can make VS Code hovers noisy and expensive because each
 * inline formula may need MathJax rendering, so they opt out before rendering.
 *
 * @param {string} paragraphText Raw paragraph text.
 * @returns {boolean}
 */
function isParagraphTooLongForHover(paragraphText) {
  const maxCharacters = getConfiguration().get("inlineMathParagraphHoverMaxCharacters", 1000);
  return Number.isFinite(maxCharacters) && paragraphText.length > maxCharacters;
}

/**
 * Checks whether the paragraph should request a translation hover.
 *
 * @param {string} paragraphText Raw paragraph text.
 * @returns {boolean}
 */
function shouldTranslateParagraphHover(paragraphText) {
  if (!getConfiguration().get("enableParagraphHoverTranslation", false)) {
    return false;
  }

  const maxCharacters = getConfiguration().get("paragraphHoverTranslationMaxCharacters", 800);
  if (Number.isFinite(maxCharacters) && paragraphText.length > maxCharacters) {
    return false;
  }

  return isLikelyEnglishParagraph(paragraphText);
}

/**
 * Finds a Markdown paragraph around one line.
 *
 * Paragraph hovers intentionally stop at standalone HTML comments because
 * manuscript revision notes are not prose and should not be sent to previews.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {number} lineNumber Zero-based line number inside the paragraph.
 * @returns {vscode.Range}
 */
function findParagraphRange(document, lineNumber) {
  let startLine = lineNumber;
  while (startLine > 0 && !isParagraphBoundaryLine(document, startLine - 1)) {
    startLine -= 1;
  }

  let endLine = lineNumber;
  while (endLine + 1 < document.lineCount && !isParagraphBoundaryLine(document, endLine + 1)) {
    endLine += 1;
  }

  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}

/**
 * Checks whether a line should split paragraph hover ranges.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {number} lineNumber Zero-based line number.
 * @returns {boolean}
 */
function isParagraphBoundaryLine(document, lineNumber) {
  return document.lineAt(lineNumber).text.trim().length === 0
    || isStandaloneHtmlCommentLine(document, lineNumber);
}

/**
 * Checks whether a line belongs to a standalone HTML comment block.
 *
 * Standalone comments often hold review notes such as `<!-- Revision... -->`.
 * Treating them as boundaries keeps hidden editorial text out of paragraph
 * translation and inline-math preview hovers.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {number} lineNumber Zero-based line number.
 * @returns {boolean}
 */
function isStandaloneHtmlCommentLine(document, lineNumber) {
  for (let currentLine = lineNumber; currentLine >= 0; currentLine -= 1) {
    const trimmed = document.lineAt(currentLine).text.trim();
    if (trimmed.length === 0) {
      return false;
    }

    const commentEnd = trimmed.lastIndexOf("-->");
    if (commentEnd !== -1 && currentLine !== lineNumber) {
      return false;
    }

    const commentStart = trimmed.lastIndexOf("<!--");
    if (commentStart === -1) {
      continue;
    }

    const hasProseBeforeComment = trimmed.slice(0, commentStart).trim().length > 0;
    const sameLineCommentEnd = trimmed.indexOf("-->", commentStart + 4);
    const hasProseAfterComment = sameLineCommentEnd !== -1
      && trimmed.slice(sameLineCommentEnd + 3).trim().length > 0;
    return !hasProseBeforeComment && !hasProseAfterComment;
  }

  return false;
}

class PandocDocumentSymbolProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides a Pandoc-aware outline that is not confused by `$$ {#eq:...}`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {vscode.DocumentSymbol[]}
   */
  provideDocumentSymbols(document) {
    const parsed = this.index.getParsedDocument(document);
    const headingSymbols = buildHeadingTree(parsed.headings);
    if (getConfiguration().get("includeLabelSymbols", true)) {
      addLabelSymbols(parsed.labels, headingSymbols);
    }
    return headingSymbols;
  }
}

class PandocCompletionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides label completions after `@`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.CompletionItem[] | undefined}
   */
  provideCompletionItems(document, position) {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = linePrefix.match(/@([A-Za-z0-9_:.~-]*)$/);
    if (!match) {
      return undefined;
    }

    const replacementStart = position.translate(0, -match[1].length);
    const replacementRange = new vscode.Range(replacementStart, position);
    const seen = new Set();

    return this.index.getAllLabels(document)
      .filter((entry) => !seen.has(entry.label) && seen.add(entry.label))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((entry) => {
        const item = new vscode.CompletionItem(entry.label, vscode.CompletionItemKind.Reference);
        item.insertText = entry.label;
        item.detail = entry.kind;
        item.documentation = entry.preview;
        item.range = replacementRange;
        return item;
      });
  }
}

/**
 * Builds a hover body for a label or cross-reference token.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Label or reference entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.TextDocument} document Markdown document whose references should be counted.
 * @param {string} tokenType Parsed token type, for example `label` or `reference`.
 * @returns {vscode.MarkdownString}
 */
function buildLabelHover(entry, index, document, tokenType) {
  const definitions = index.getDefinitions(document, entry.label);
  const references = index.getReferences(document, entry.label);
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${entry.kind}** \`${entry.label}\`\n\n`);
  markdown.appendMarkdown(`Definitions: **${definitions.length}**  \n`);
  markdown.appendMarkdown(`References: **${references.length}**`);

  if (definitions.length === 0) {
    markdown.appendMarkdown("\n\n$(warning) No definition found for this Pandoc cross reference.");
  } else if (definitions.length > 1) {
    markdown.appendMarkdown("\n\n$(warning) Duplicate definitions were found for this label.");
  } else if (!isDefinitionHover(tokenType)) {
    markdown.appendMarkdown(`\n\nDefined at \`${definitions[0].preview}\``);
  }

  return markdown;
}

/**
 * Returns whether a hover is on a label definition itself.
 *
 * Definitions are already at their own location, so repeating the current line
 * as "Defined at" makes the hover noisy without adding navigation value.
 *
 * @param {string} tokenType Parsed token type.
 * @returns {boolean}
 */
function isDefinitionHover(tokenType) {
  return tokenType === "label";
}

/**
 * Builds a hover body for display math blocks with a rendered SVG preview.
 *
 * @param {import("./parser").MathBlockEntry} mathBlock Math block entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.TextDocument} document Markdown document whose references should be counted.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<vscode.MarkdownString>}
 */
async function buildMathHover(mathBlock, index, document, mathRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  const label = mathBlock.label || "unlabeled equation";
  const referenceCount = mathBlock.label ? index.getReferences(document, mathBlock.label).length : 0;

  markdown.appendMarkdown(`**Equation** \`${label}\``);
  if (mathBlock.label) {
    markdown.appendMarkdown(`  \nReferences: **${referenceCount}**`);
  }

  if (mathBlock.tex) {
    const renderedSvg = await mathRenderer.renderToDataUri(mathBlock.tex, true);
    if (renderedSvg) {
      markdown.appendMarkdown(`\n\n![Rendered equation preview](${renderedSvg})\n\n`);
    } else {
      appendMathJaxUnavailableMessage(markdown);
      // Only show raw TeX when rendering fails; successful previews should not
      // repeat LaTeX text underneath the formula image.
      markdown.appendCodeblock(mathBlock.tex, "tex");
    }
  }

  return markdown;
}

/**
 * Builds a hover body for inline TeX math spans.
 *
 * @param {import("./parser").InlineMathEntry} inlineMath Inline math entry.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<vscode.MarkdownString>}
 */
async function buildInlineMathHover(inlineMath, mathRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown("**Inline math**");

  const renderedSvg = await mathRenderer.renderToDataUri(inlineMath.tex, false);
  if (renderedSvg) {
    markdown.appendMarkdown(`\n\n![Rendered inline equation preview](${renderedSvg})\n\n`);
  } else {
    appendMathJaxUnavailableMessage(markdown);
    // Keep failed inline hovers diagnosable without showing source below a
    // successful rendered preview.
    markdown.appendCodeblock(inlineMath.tex, "tex");
  }

  return markdown;
}

/**
 * Builds a hover body for paragraph-level math preview and/or translation.
 *
 * @param {ParagraphHover} paragraph Paragraph hover data.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @param {GoogleParagraphTranslator} paragraphTranslator Paragraph translation service.
 * @returns {Promise<vscode.MarkdownString | undefined>}
 */
async function buildParagraphHover(paragraph, mathRenderer, paragraphTranslator) {
  const markdown = new vscode.MarkdownString(undefined, true);
  let hasContent = false;

  const translation = await buildParagraphTranslation(paragraph, mathRenderer, paragraphTranslator);
  if (translation) {
    markdown.appendMarkdown("**Chinese translation**\n\n");
    markdown.appendMarkdown(translation);
    hasContent = true;
  }

  if (paragraph.showMathPreview) {
    if (hasContent) {
      markdown.appendMarkdown("\n\n---\n\n");
    }
    markdown.appendMarkdown("**Paragraph math preview**\n\n");
    markdown.appendMarkdown(await renderInlineMathParagraphMarkdown(paragraph, mathRenderer));
    hasContent = true;
  }

  return hasContent ? markdown : undefined;
}

/**
 * Builds the optional translated paragraph preview.
 *
 * The full paragraph, including any TeX, is sent to Google Translate because
 * the user wants translation to see the same text that appears in the editor;
 * any inline TeX that survives translation is rendered before showing the hover.
 *
 * @param {ParagraphHover} paragraph Paragraph hover data.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @param {GoogleParagraphTranslator} paragraphTranslator Paragraph translation service.
 * @returns {Promise<string | undefined>}
 */
async function buildParagraphTranslation(paragraph, mathRenderer, paragraphTranslator) {
  if (!paragraph.showTranslation) {
    return undefined;
  }

  const translatedTable = await buildPipeTableTranslation(paragraph.text, mathRenderer, paragraphTranslator);
  if (translatedTable !== undefined) {
    return translatedTable;
  }

  const translatedText = await paragraphTranslator.translateText(normalizeParagraphText(paragraph.text));
  if (translatedText === undefined) {
    return undefined;
  }
  return renderInlineMathTextMarkdown(translatedText, mathRenderer);
}

/**
 * Builds a translated Markdown table while preserving the pipe-table syntax.
 *
 * Normal paragraph translation collapses line breaks and escapes `|`, which
 * intentionally makes prose literal but prevents VS Code from rendering tables.
 *
 * @param {string} text Raw paragraph text.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @param {GoogleParagraphTranslator} paragraphTranslator Paragraph translation service.
 * @returns {Promise<string | undefined>} Undefined means "not a table"; empty string means table translation failed.
 */
async function buildPipeTableTranslation(text, mathRenderer, paragraphTranslator) {
  const table = parseMarkdownPipeTable(text);
  if (!table) {
    return undefined;
  }

  const translatedMarkdown = await buildDirectMarkdownPipeTableTranslation(text, table, mathRenderer, paragraphTranslator);
  if (translatedMarkdown !== undefined) {
    return translatedMarkdown;
  }

  const translatedHtml = await paragraphTranslator.translateText(formatPipeTableTranslationHtml(table));
  if (translatedHtml === undefined) {
    return "";
  }

  const translatedTable = parseTranslatedPipeTableHtml(translatedHtml, table);
  if (!translatedTable) {
    return "";
  }

  const translatedRows = [];
  let htmlRowIndex = 0;
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex];
    if (rowIndex === table.separatorIndex) {
      translatedRows.push(formatPipeTableRow(row.cells));
      continue;
    }

    const translatedCells = await renderMarkdownTableCells(translatedTable.rows[htmlRowIndex], mathRenderer);
    translatedRows.push(formatPipeTableRow(translatedCells));
    htmlRowIndex += 1;
  }

  if (translatedTable.caption) {
    translatedRows.push("", await renderInlineMathTextMarkdown(translatedTable.caption, mathRenderer));
  }

  return translatedRows.join("\n").trim();
}

/**
 * Tries translating raw Markdown directly and accepts it only if still a table.
 *
 * `translateHtml` usually leaves Markdown punctuation alone, but Markdown is
 * not a protected format there; the shape check prevents a broken hover table.
 *
 * @param {string} text Raw Markdown table text.
 * @param {{rows: {cells: string[]}[], separatorIndex: number, captionLines: string[]}} sourceTable Source table shape.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @param {GoogleParagraphTranslator} paragraphTranslator Paragraph translation service.
 * @returns {Promise<string | undefined>}
 */
async function buildDirectMarkdownPipeTableTranslation(text, sourceTable, mathRenderer, paragraphTranslator) {
  const translatedMarkdown = await paragraphTranslator.translateText(text);
  if (translatedMarkdown === undefined) {
    return undefined;
  }

  const translatedTable = parseMarkdownPipeTable(translatedMarkdown);
  if (!translatedTable || !hasMatchingPipeTableShape(translatedTable, sourceTable)) {
    return undefined;
  }

  return renderParsedPipeTableMarkdown(translatedTable, sourceTable, mathRenderer);
}

/**
 * Checks that direct Markdown translation preserved row and column boundaries.
 *
 * @param {{rows: {cells: string[]}[], separatorIndex: number}} translatedTable Translated table.
 * @param {{rows: {cells: string[]}[], separatorIndex: number}} sourceTable Source table.
 * @returns {boolean}
 */
function hasMatchingPipeTableShape(translatedTable, sourceTable) {
  if (translatedTable.separatorIndex !== sourceTable.separatorIndex || translatedTable.rows.length !== sourceTable.rows.length) {
    return false;
  }

  return translatedTable.rows.every((row, rowIndex) => row.cells.length === sourceTable.rows[rowIndex].cells.length);
}

/**
 * Rebuilds a parsed Markdown table after translating and escaping its cells.
 *
 * @param {{rows: {cells: string[]}[], separatorIndex: number, captionLines: string[]}} translatedTable Translated table.
 * @param {{rows: {cells: string[]}[], separatorIndex: number}} sourceTable Source table for stable alignment delimiters.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<string>}
 */
async function renderParsedPipeTableMarkdown(translatedTable, sourceTable, mathRenderer) {
  const translatedRows = [];
  for (let rowIndex = 0; rowIndex < translatedTable.rows.length; rowIndex += 1) {
    if (rowIndex === translatedTable.separatorIndex) {
      translatedRows.push(formatPipeTableRow(sourceTable.rows[sourceTable.separatorIndex].cells));
      continue;
    }

    const translatedCells = await renderMarkdownTableCells(translatedTable.rows[rowIndex].cells, mathRenderer);
    translatedRows.push(formatPipeTableRow(translatedCells));
  }

  const captionText = normalizeParagraphText(translatedTable.captionLines.map((line) => line.replace(/^:\s*/, "")).join("\n"));
  if (captionText) {
    translatedRows.push("", await renderInlineMathTextMarkdown(captionText, mathRenderer));
  }

  return translatedRows.join("\n").trim();
}

/**
 * Formats a pipe table as protected HTML for one full-table translation call.
 *
 * The Google endpoint is `translateHtml`, so these simple tags preserve row and
 * cell boundaries while still letting the model translate with table context.
 *
 * @param {{rows: {cells: string[]}[], separatorIndex: number, captionLines: string[]}} table Parsed pipe table.
 * @returns {string}
 */
function formatPipeTableTranslationHtml(table) {
  const htmlRows = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    if (rowIndex === table.separatorIndex) {
      continue;
    }

    const cells = table.rows[rowIndex].cells
      .map((cell) => `<td>${escapeHtmlText(normalizeParagraphText(cell))}</td>`)
      .join("");
    htmlRows.push(`<tr>${cells}</tr>`);
  }

  const captionText = normalizeParagraphText(table.captionLines.map((line) => line.replace(/^:\s*/, "")).join("\n"));
  const captionHtml = captionText ? `<caption>${escapeHtmlText(captionText)}</caption>` : "";
  return `<table>${captionHtml}${htmlRows.join("\n")}</table>`;
}

/**
 * Parses the translated protected HTML table back into row and caption text.
 *
 * @param {string} html Translated HTML fragment returned by Google.
 * @param {{rows: {cells: string[]}[], separatorIndex: number, captionLines: string[]}} table Source table shape.
 * @returns {{rows: string[][], caption: string} | undefined}
 */
function parseTranslatedPipeTableHtml(html, table) {
  const expectedRows = table.rows.filter((_row, rowIndex) => rowIndex !== table.separatorIndex);
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length !== expectedRows.length) {
    return undefined;
  }

  const rows = [];
  for (let rowIndex = 0; rowIndex < rowMatches.length; rowIndex += 1) {
    const cellMatches = [...rowMatches[rowIndex][1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cellMatches.length !== expectedRows[rowIndex].cells.length) {
      return undefined;
    }

    rows.push(cellMatches.map((match) => normalizeTranslatedTableHtmlText(match[1])));
  }

  const captionMatch = html.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
  return {
    rows,
    caption: captionMatch ? normalizeTranslatedTableHtmlText(captionMatch[1]) : "",
  };
}

/**
 * Renders translated table cells as safe Markdown cell content.
 *
 * @param {string[]} cells Translated cell texts.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<string[]>}
 */
async function renderMarkdownTableCells(cells, mathRenderer) {
  const renderedCells = [];
  for (const cell of cells) {
    renderedCells.push(await renderInlineMathTextMarkdown(cell, mathRenderer));
  }
  return renderedCells;
}

/**
 * Parses a simple Markdown pipe table from one paragraph hover range.
 *
 * This branch intentionally handles only pipe tables with a header delimiter;
 * other table syntaxes should keep using the ordinary literal paragraph hover.
 *
 * @param {string} text Raw paragraph text.
 * @returns {{rows: {cells: string[]}[], separatorIndex: number, captionLines: string[]} | undefined}
 */
function parseMarkdownPipeTable(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const separatorIndex = lines.findIndex(isPipeTableSeparatorLine);
  if (separatorIndex !== 1) {
    return undefined;
  }

  const rows = [];
  let lineIndex = 0;
  while (lineIndex < lines.length && isPipeTableRowLine(lines[lineIndex])) {
    const cells = splitMarkdownPipeTableRow(lines[lineIndex]).map((cell) => cell.trim());
    if (cells.length < 2) {
      return undefined;
    }
    rows.push({ cells });
    lineIndex += 1;
  }

  const expectedCellCount = rows[separatorIndex].cells.length;
  if (rows.length < 2 || rows.some((row) => row.cells.length !== expectedCellCount)) {
    return undefined;
  }

  const captionLines = lines.slice(lineIndex);
  if (captionLines.some((line) => !line.startsWith(":"))) {
    return undefined;
  }

  return { rows, separatorIndex, captionLines };
}

/**
 * Checks whether a line can be parsed as a Markdown pipe-table row.
 *
 * @param {string} line Trimmed Markdown line.
 * @returns {boolean}
 */
function isPipeTableRowLine(line) {
  return line.includes("|") && splitMarkdownPipeTableRow(line).length >= 2;
}

/**
 * Checks whether a line is the required Markdown table delimiter row.
 *
 * @param {string} line Trimmed Markdown line.
 * @returns {boolean}
 */
function isPipeTableSeparatorLine(line) {
  if (!isPipeTableRowLine(line)) {
    return false;
  }

  return splitMarkdownPipeTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Splits a pipe-table row without treating escaped pipes as cell separators.
 *
 * @param {string} line Trimmed Markdown table row.
 * @returns {string[]}
 */
function splitMarkdownPipeTableRow(line) {
  const row = stripOuterPipe(line.trim());
  const cells = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === "|" && !isEscapedMarkdownCharacter(row, index)) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Removes optional leading and trailing pipe-table fences.
 *
 * @param {string} row Trimmed Markdown table row.
 * @returns {string}
 */
function stripOuterPipe(row) {
  let stripped = row;
  if (stripped.startsWith("|")) {
    stripped = stripped.slice(1);
  }
  if (stripped.endsWith("|") && !isEscapedMarkdownCharacter(stripped, stripped.length - 1)) {
    stripped = stripped.slice(0, -1);
  }
  return stripped;
}

/**
 * Checks whether a Markdown character is escaped by an odd number of slashes.
 *
 * @param {string} value Markdown source.
 * @param {number} index Character index to inspect.
 * @returns {boolean}
 */
function isEscapedMarkdownCharacter(value, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Formats already-escaped cells as one Markdown pipe-table row.
 *
 * @param {string[]} cells Escaped table cells.
 * @returns {string}
 */
function formatPipeTableRow(cells) {
  return `| ${cells.map((cell) => cell.trim()).join(" | ")} |`;
}

/**
 * Escapes table text before embedding it in protected translation HTML.
 *
 * @param {string} value Raw table cell or caption text.
 * @returns {string}
 */
function escapeHtmlText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Normalizes translated text recovered from protected table HTML.
 *
 * @param {string} value HTML text content from a translated cell or caption.
 * @returns {string}
 */
function normalizeTranslatedTableHtmlText(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks whether prose looks like an English paragraph.
 *
 * @param {string} text Raw paragraph text.
 * @returns {boolean}
 */
function isLikelyEnglishParagraph(text) {
  const latinLetters = text.match(/[A-Za-z]/g) || [];
  const cjkCharacters = text.match(/[\u3400-\u9FFF]/g) || [];
  const nonAsciiLetters = text.match(/[^\x00-\x7F]/g) || [];
  const wordMatches = text.match(/[A-Za-z]{2,}/g) || [];

  return latinLetters.length >= 20
    && wordMatches.length >= 4
    && cjkCharacters.length === 0
    && latinLetters.length >= nonAsciiLetters.length * 3;
}

/**
 * Normalizes a paragraph before translation.
 *
 * @param {string} value Raw paragraph text.
 * @returns {string}
 */
function normalizeParagraphText(value) {
  return value.replace(/[ \t]*\r?\n[ \t]*/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Renders inline math spans inside one paragraph as hover-friendly SVG images.
 *
 * Failed formulas fall back to inline TeX so one bad span does not hide the
 * rest of the paragraph preview.
 *
 * @param {ParagraphHover} paragraph Paragraph hover data.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<string>}
 */
async function renderInlineMathParagraphMarkdown(paragraph, mathRenderer) {
  return renderInlineMathTextMarkdown(paragraph.text, mathRenderer, paragraph.inlineMath, paragraph.startOffset);
}

/**
 * Renders inline math spans inside arbitrary hover text.
 *
 * Translated text is parsed after Google returns it so preserved TeX delimiters
 * are rendered even when the original paragraph preview is not enabled.
 *
 * @param {string} text Hover text.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @param {import("./parser").InlineMathEntry[]=} inlineMath Inline math entries, if already known.
 * @param {number=} startOffset Offset used by precomputed inline math entries.
 * @returns {Promise<string>}
 */
async function renderInlineMathTextMarkdown(text, mathRenderer, inlineMath, startOffset = 0) {
  const mathEntries = inlineMath || parsePandocDocument(text).inlineMath;
  const parts = [];
  let cursor = 0;

  for (const inlineMathEntry of mathEntries) {
    const formulaStart = inlineMathEntry.fullOffset - startOffset;
    const formulaEnd = inlineMathEntry.fullEndOffset - startOffset;
    if (formulaStart < cursor || formulaEnd > text.length) {
      continue;
    }

    parts.push(escapeMarkdownText(text.slice(cursor, formulaStart)));
    const renderedSvg = await mathRenderer.renderToDataUri(inlineMathEntry.tex, false);
    if (renderedSvg) {
      parts.push(`![Rendered inline equation preview](${renderedSvg})`);
    } else {
      parts.push(`\`${escapeMarkdownCodeSpan(inlineMathEntry.tex)}\``);
    }
    cursor = formulaEnd;
  }

  parts.push(escapeMarkdownText(text.slice(cursor)));
  return parts.join("").trim();
}

/**
 * Escapes paragraph text so the hover previews literal prose plus rendered math.
 *
 * @param {string} value Raw paragraph text chunk.
 * @returns {string}
 */
function escapeMarkdownText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[ \t]*\r?\n[ \t]*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|])/g, "\\$1");
}

/**
 * Escapes rare backticks in TeX fallback code spans.
 *
 * @param {string} value TeX source.
 * @returns {string}
 */
function escapeMarkdownCodeSpan(value) {
  return value.replace(/`/g, "\\`");
}

/**
 * Adds the MathJax fallback message shown when a hover preview cannot render.
 *
 * @param {vscode.MarkdownString} markdown Hover markdown being built.
 */
function appendMathJaxUnavailableMessage(markdown) {
  markdown.appendMarkdown("\n\n$(warning) MathJax preview could not render. See the Pandoc Manuscript Tools output for the TeX source and error details.\n\n");
}


function buildHeadingTree(headings) {
  const roots = [];
  const stack = [];

  for (const heading of headings) {
    const symbol = new vscode.DocumentSymbol(
      formatHeadingSymbolName(heading),
      heading.label || "",
      vscode.SymbolKind.String,
      toRange(heading.range),
      toRange(heading.selectionRange),
    );

    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(symbol);
    } else {
      stack[stack.length - 1].symbol.children.push(symbol);
    }

    stack.push({ level: heading.level, symbol });
  }

  return roots;
}

/**
 * Formats a heading for Outline with its Markdown marker preserved.
 *
 * VS Code merges our symbols with the built-in Markdown provider, so keeping the
 * marker here makes the Pandoc-aware outline easy to distinguish from the built-in one.
 *
 * @param {import("./parser").HeadingEntry} heading Parsed heading.
 * @returns {string}
 */
function formatHeadingSymbolName(heading) {
  return `${"#".repeat(heading.level)} ${heading.title}`;
}

/**
 * Adds figure, table, and equation labels below their nearest heading symbol.
 *
 * @param {import("./parser").LabelEntry[]} labels Parsed label definitions.
 * @param {vscode.DocumentSymbol[]} headingSymbols Heading symbols.
 */
function addLabelSymbols(labels, headingSymbols) {
  const nonSectionLabels = labels.filter((entry) => entry.prefix !== "sec");
  const headingCandidates = flattenDocumentSymbols(headingSymbols);
  const labelSymbols = new Map(nonSectionLabels.map((label) => [label, createLabelSymbol(label)]));

  for (const label of nonSectionLabels) {
    const symbol = labelSymbols.get(label);
    const parentLabel = findNearestContainerLabel(nonSectionLabels, label);
    const parent = parentLabel ? labelSymbols.get(parentLabel) : findNearestHeadingSymbol(headingCandidates, label.line);

    if (parent) {
      parent.children.push(symbol);
    } else {
      headingSymbols.push(symbol);
    }
  }
}

/**
 * Creates a VS Code symbol for one parsed label definition.
 *
 * @param {import("./parser").LabelEntry} label Parsed label definition.
 * @returns {vscode.DocumentSymbol}
 */
function createLabelSymbol(label) {
  return new vscode.DocumentSymbol(
    label.label,
    label.kind,
    toSymbolKind(label.prefix),
    toRange(label.fullRange),
    toRange(label.range),
  );
}

/**
 * Flattens the heading tree before labels are inserted into it.
 *
 * @param {vscode.DocumentSymbol[]} symbols Heading symbols.
 * @returns {vscode.DocumentSymbol[]}
 */
function flattenDocumentSymbols(symbols) {
  const flattened = [];
  for (const symbol of symbols) {
    flattened.push(symbol, ...flattenDocumentSymbols(symbol.children));
  }
  return flattened;
}

/**
 * Finds the innermost heading symbol preceding a line.
 *
 * @param {vscode.DocumentSymbol[]} symbols Flat candidate heading symbols.
 * @param {number} line Target line.
 * @returns {vscode.DocumentSymbol | undefined}
 */
function findNearestHeadingSymbol(symbols, line) {
  let nearest;
  for (const symbol of symbols) {
    const symbolLine = symbol.selectionRange.start.line;
    if (symbolLine <= line) {
      nearest = symbol;
    }
  }
  return nearest;
}

/**
 * Finds the nearest div label that contains another label.
 *
 * This is the subfigure special case: only labels created from HTML div ids act
 * as outline containers, so ordinary image/table labels stay as siblings.
 *
 * @param {import("./parser").LabelEntry[]} labels Candidate labels.
 * @param {import("./parser").LabelEntry} child Child label.
 * @returns {import("./parser").LabelEntry | undefined}
 */
function findNearestContainerLabel(labels, child) {
  let nearest;
  for (const candidate of labels) {
    if (candidate === child || !candidate.containerRange) {
      continue;
    }
    if (!containsPosition(candidate.containerRange, { line: child.line, character: child.character })) {
      continue;
    }
    if (!nearest || isRangeStartAfter(candidate.containerRange, nearest.containerRange)) {
      nearest = candidate;
    }
  }
  return nearest;
}

/**
 * Checks whether one parser range starts after another range.
 *
 * @param {import("./parser").PlainRange} left Left range.
 * @param {import("./parser").PlainRange} right Right range.
 * @returns {boolean}
 */
function isRangeStartAfter(left, right) {
  if (left.start.line !== right.start.line) {
    return left.start.line > right.start.line;
  }
  return left.start.character > right.start.character;
}

/**
 * Updates diagnostics for all open Markdown documents.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnosticsForOpenDocuments(index, diagnostics) {
  for (const document of vscode.workspace.textDocuments) {
    if (isMarkdownDocument(document)) {
      updateDiagnostics(document, index, diagnostics);
    }
  }
}

/**
 * Updates diagnostics for one Markdown document.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnostics(document, index, diagnostics) {
  if (!getConfiguration().get("enableDiagnostics", true)) {
    diagnostics.delete(document.uri);
    return;
  }

  const parsed = index.getParsedDocument(document);
  const definitionMap = index.getDefinitionMap(document);
  const documentDiagnostics = [];

  for (const reference of parsed.references) {
    if (!definitionMap.has(reference.label)) {
      const diagnostic = new vscode.Diagnostic(
        toRange(reference.fullRange),
        `Undefined Pandoc cross reference: ${reference.label}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  for (const label of parsed.labels) {
    const definitions = definitionMap.get(label.label) || [];
    if (definitions.length > 1) {
      const diagnostic = new vscode.Diagnostic(
        toRange(label.fullRange),
        `Duplicate Pandoc label: ${label.label}`,
        vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  diagnostics.set(document.uri, documentDiagnostics);
}

/**
 * Returns the token at a document position.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.TextDocument} document Markdown document.
 * @param {vscode.Position} position Cursor position.
 * @returns {{type: string, entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry} | undefined}
 */
function getTokenAtDocumentPosition(index, document, position) {
  const parsed = index.getParsedDocument(document);
  return findTokenAtPosition(parsed, toPlainPosition(position));
}

module.exports = {
  PandocDefinitionProvider,
  PandocReferenceProvider,
  PandocHoverProvider,
  PandocDocumentSymbolProvider,
  PandocCompletionProvider,
  updateDiagnosticsForOpenDocuments,
  updateDiagnostics,
};

/**
 * @typedef {{range: vscode.Range, text: string, startOffset: number, inlineMath: import("./parser").InlineMathEntry[], showMathPreview: boolean, showTranslation: boolean}} ParagraphHover
 */
