import * as vscode from "vscode";
import { EXTENSION_NAME } from "./constants";
import { getConfiguration } from "./configuration";
import { parsePandocDocument, findMathBlockAtPosition, findInlineMathAtPosition, findTokenAtPosition, containsPosition } from "./parser";
import { toRange, toLocation, toLocationLink, toPlainPosition, toSymbolKind, isPandocDocument, supportsPandocTextFeatures } from "./vscodeUtils";
import type { PandocWorkspaceIndex } from "./workspaceIndex";
import type { MathJaxRenderer } from "./mathJaxRenderer";
import type { ParagraphTranslator, TranslationEngine } from "./paragraphTranslator";
import type { ImagePreviewRenderer } from "./imagePreview";
import type { HeadingEntry, InlineMathEntry, LabelEntry, MathBlockEntry, PandocTokenAtPosition, ParsedPandocDocument, PlainPosition, PlainRange, ReferenceEntry } from "./parser";

const MAX_TRANSLATABLE_CJK_RATIO = 0.3;

type ParagraphHover = { range: vscode.Range; text: string; translationText: string; startOffset: number; inlineMath: InlineMathEntry[]; showMathPreview: boolean; showTranslation: boolean };
type RenderedTranslation = { markdown: string; engine: TranslationEngine };
type MarkdownPipeTable = { rows: { cells: string[] }[]; separatorIndex: number; captionLines: string[] };
type TranslatedPipeTableHtml = { rows: string[][]; caption: string };
type SimpleMarkdownList = { items: { prefix: string; text: string }[] };


export class PandocDefinitionProvider {
  declare index: PandocWorkspaceIndex;
  /**
   * @param index Workspace index.
   */
  constructor(index: PandocWorkspaceIndex) {
    this.index = index;
  }

  /**
   * Provides go-to-definition for Pandoc cross references.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   */
  provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    return this.index.getDefinitions(document, token.entry.label).map((definition) => toLocationLink(definition, token.entry));
  }
}

export class PandocReferenceProvider {
  declare index: PandocWorkspaceIndex;
  /**
   * @param index Workspace index.
   */
  constructor(index: PandocWorkspaceIndex) {
    this.index = index;
  }

  /**
   * Provides find-all-references for Pandoc labels and references.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   * @param options Reference options.
   */
  provideReferences(document: vscode.TextDocument, position: vscode.Position, options: { includeDeclaration: boolean }) {
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

export class PandocHoverProvider {
  declare index: PandocWorkspaceIndex;
  declare mathRenderer: MathJaxRenderer;
  declare paragraphTranslator: ParagraphTranslator;
  declare output: import("vscode").OutputChannel;
  /**
   * @param index Workspace index.
   * @param mathRenderer MathJax SVG renderer.
   * @param paragraphTranslator Paragraph translation service.
   * @param output Output channel for hover diagnostics.
   */
  constructor(index: PandocWorkspaceIndex, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator, output: vscode.OutputChannel) {
    this.index = index;
    this.mathRenderer = mathRenderer;
    this.paragraphTranslator = paragraphTranslator;
    this.output = output;
  }

  /**
   * Provides label, reference, math, and optional paragraph hover information.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   */
  async provideHover(document: vscode.TextDocument, position: vscode.Position) {
    try {
      return await this.provideHoverUnchecked(document, position);
    } catch (error) {
      this.output.appendLine(`Hover provider failed at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}: ${formatError(error)}`);
      return undefined;
    }
  }

  /**
   * Provides hover information after the public wrapper has installed logging.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   */
  async provideHoverUnchecked(document: vscode.TextDocument, position: vscode.Position) {
    const parsed = this.index.getParsedDocument(document);
    const plainPosition = toPlainPosition(position);
    if (supportsPandocTextFeatures(document)) {
      const token = getTokenAtDocumentPosition(this.index, document, position);
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
    }

    const mathBlock = findMathBlockAtPosition(parsed, plainPosition);
    if (mathBlock) {
      return new vscode.Hover(await buildMathHover(mathBlock, this.index, document, this.mathRenderer), toRange(mathBlock.range));
    }

    const inlineMath = findInlineMathAtPosition(parsed, plainPosition);
    if (inlineMath) {
      return new vscode.Hover(await buildInlineMathHover(inlineMath, this.mathRenderer), toRange(inlineMath.fullRange));
    }

    return undefined;
  }
}

export class ImagePreviewHoverProvider {
  declare imagePreviewRenderer: ImagePreviewRenderer;
  declare output: import("vscode").OutputChannel;
  /**
   * Creates a hover provider for standalone image previews.
   *
   * Registering this separately lets VS Code show image previews alongside the
   * paragraph translation hover instead of forcing one branch to short-circuit.
   *
   * @param imagePreviewRenderer SVG/EMF/WMF image preview renderer.
   * @param output Output channel for hover diagnostics.
   */
  constructor(imagePreviewRenderer: ImagePreviewRenderer, output: vscode.OutputChannel) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
  }

  /**
   * Provides image hovers without allowing image-preview failures to hide other hovers.
   *
   * The image preview path is newer and touches local files plus optional EMF
   * rasterization, so it is isolated from the older math and translation hovers.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   */
  async provideImageHover(document: vscode.TextDocument, position: vscode.Position) {
    try {
      return await this.imagePreviewRenderer.provideHover(document, position);
    } catch (error) {
      this.output.appendLine(`Image hover preview failed at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}: ${formatError(error)}`);
      return undefined;
    }
  }

  /**
   * Provides image hovers through VS Code's HoverProvider API.
   *
   * @param document Text document.
   * @param position Hover position.
   */
  async provideHover(document: vscode.TextDocument, position: vscode.Position) {
    return this.provideImageHover(document, position);
  }
}

/**
 * Formats an unknown hover error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

/**
 * Finds the display equation associated with an equation-definition label hover.
 *
 * Only labels parsed from math delimiters should use the formula preview here;
 * cross-reference hovers such as `@eq:linear` still need the generic label
 * summary instead of rendering the target equation inline.
 *
 * @param parsed Parsed document.
 * @param token Token under the cursor.
 * @param position Cursor position.
 */
function findMathBlockForEquationLabelHover(parsed: ParsedPandocDocument, token: PandocTokenAtPosition, position: PlainPosition): MathBlockEntry | undefined {
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
 * @param document Markdown document.
 * @param parsed Parsed document.
 * @param position Hover position.
 */
function findParagraphHover(document: vscode.TextDocument, parsed: import("./parser").ParsedPandocDocument, position: vscode.Position) {
  if (isBlankParagraphLine(document, position.line)) {
    return undefined;
  }

  const commentRange = findStandaloneHtmlCommentBlockRange(document, position.line);
  const range = commentRange || findParagraphRange(document, position.line);
  const paragraphText = document.getText(range);
  const translationText = commentRange ? extractStandaloneHtmlCommentText(paragraphText) : paragraphText;
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const inlineMath = parsed.inlineMath.filter((entry) => entry.fullOffset >= startOffset && entry.fullEndOffset <= endOffset);
  const showMathPreview = shouldShowInlineMathParagraphPreview(paragraphText, inlineMath);
  const showTranslation = shouldTranslateParagraphHover(translationText);

  if (!showMathPreview && !showTranslation) {
    return undefined;
  }

  return {
    range,
    text: paragraphText,
    translationText,
    startOffset,
    inlineMath,
    showMathPreview,
    showTranslation,
  };
}

/**
 * Checks whether the paragraph should show the rendered inline-math preview.
 *
 * @param paragraphText Raw paragraph text.
 * @param inlineMath Inline math spans inside the paragraph.
 */
function shouldShowInlineMathParagraphPreview(paragraphText: string, inlineMath: import("./parser").InlineMathEntry[]) {
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
 * @param paragraphText Raw paragraph text.
 */
function isParagraphTooLongForHover(paragraphText: string) {
  const maxCharacters = getConfiguration().get("inlineMathParagraphHoverMaxCharacters", 1000);
  return Number.isFinite(maxCharacters) && paragraphText.length > maxCharacters;
}

/**
 * Checks whether the paragraph should request a translation hover.
 *
 * @param paragraphText Raw paragraph text.
 */
function shouldTranslateParagraphHover(paragraphText: string) {
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
 * @param document Markdown document.
 * @param lineNumber Zero-based line number inside the paragraph.
 */
function findParagraphRange(document: vscode.TextDocument, lineNumber: number) {
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
 * @param document Markdown document.
 * @param lineNumber Zero-based line number.
 */
function isParagraphBoundaryLine(document: vscode.TextDocument, lineNumber: number) {
  return isBlankParagraphLine(document, lineNumber)
    || isStandaloneHtmlCommentLine(document, lineNumber);
}

/**
 * Checks whether a line is blank enough to split paragraph hover ranges.
 *
 * @param document Markdown document.
 * @param lineNumber Zero-based line number.
 */
function isBlankParagraphLine(document: vscode.TextDocument, lineNumber: number) {
  return document.lineAt(lineNumber).text.trim().length === 0;
}

/**
 * Checks whether a line belongs to a standalone HTML comment block.
 *
 * Standalone comments often hold review notes such as `<!-- Revision... -->`.
 * Treating them as boundaries keeps hidden editorial text out of paragraph
 * translation and inline-math preview hovers, while comment hovers can still
 * translate the comment block itself.
 *
 * @param document Markdown document.
 * @param lineNumber Zero-based line number.
 */
function isStandaloneHtmlCommentLine(document: vscode.TextDocument, lineNumber: number) {
  return findStandaloneHtmlCommentBlockRange(document, lineNumber) !== undefined;
}

/**
 * Finds the complete standalone HTML comment block around one line.
 *
 * This special case lets review-note comments be translated when hovered
 * directly, without letting hidden comment text merge into nearby prose.
 *
 * @param document Markdown document.
 * @param lineNumber Zero-based line number.
 */
function findStandaloneHtmlCommentBlockRange(document: vscode.TextDocument, lineNumber: number) {
  const startLine = findStandaloneHtmlCommentStartLine(document, lineNumber);
  if (startLine === undefined) {
    return undefined;
  }

  const endLine = findStandaloneHtmlCommentEndLine(document, startLine);
  if (endLine === undefined || lineNumber > endLine) {
    return undefined;
  }

  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}

/**
 * Finds the opening line for a standalone HTML comment block.
 *
 * @param document Markdown document.
 * @param lineNumber Zero-based line number inside the comment.
 */
function findStandaloneHtmlCommentStartLine(document: vscode.TextDocument, lineNumber: number) {
  for (let currentLine = lineNumber; currentLine >= 0; currentLine -= 1) {
    const trimmed = document.lineAt(currentLine).text.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const commentEnd = trimmed.lastIndexOf("-->");
    if (commentEnd !== -1 && currentLine !== lineNumber) {
      return undefined;
    }

    const commentStart = trimmed.lastIndexOf("<!--");
    if (commentStart === -1) {
      continue;
    }

    const hasProseBeforeComment = trimmed.slice(0, commentStart).trim().length > 0;
    const sameLineCommentEnd = trimmed.indexOf("-->", commentStart + 4);
    const hasProseAfterComment = sameLineCommentEnd !== -1
      && trimmed.slice(sameLineCommentEnd + 3).trim().length > 0;
    if (hasProseBeforeComment || hasProseAfterComment) {
      return undefined;
    }

    return currentLine;
  }

  return undefined;
}

/**
 * Finds the closing line for a standalone HTML comment block.
 *
 * @param document Markdown document.
 * @param startLine Zero-based comment opening line.
 */
function findStandaloneHtmlCommentEndLine(document: vscode.TextDocument, startLine: number) {
  for (let currentLine = startLine; currentLine < document.lineCount; currentLine += 1) {
    const trimmed = document.lineAt(currentLine).text.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const commentEnd = trimmed.indexOf("-->");
    if (commentEnd === -1) {
      continue;
    }

    const hasProseAfterComment = trimmed.slice(commentEnd + 3).trim().length > 0;
    return hasProseAfterComment ? undefined : currentLine;
  }

  return undefined;
}

/**
 * Removes standalone HTML comment markers before sending text to translation.
 *
 * Translation endpoints and VS Code Markdown hovers can treat `<!-- ... -->`
 * as hidden HTML, so comment paragraphs need the visible review text only.
 *
 * @param text Raw standalone HTML comment block.
 */
function extractStandaloneHtmlCommentText(text: string) {
  return text
    .replace(/^\s*<!--[ \t]?/, "")
    .replace(/[ \t]?-->\s*$/, "")
    .trim();
}

export class PandocDocumentSymbolProvider {
  declare index: PandocWorkspaceIndex;
  /**
   * @param index Workspace index.
   */
  constructor(index: PandocWorkspaceIndex) {
    this.index = index;
  }

  /**
   * Provides a Pandoc-aware outline that is not confused by `$$ {#eq:...}`.
   *
   * @param document Markdown document.
   */
  provideDocumentSymbols(document: vscode.TextDocument) {
    const parsed = this.index.getParsedDocument(document);
    const headingSymbols = buildHeadingTree(parsed.headings);
    if (getConfiguration().get("includeLabelSymbols", true)) {
      addLabelSymbols(parsed.labels, headingSymbols);
    }
    return headingSymbols;
  }
}

export class PandocCompletionProvider {
  declare index: PandocWorkspaceIndex;
  /**
   * @param index Workspace index.
   */
  constructor(index: PandocWorkspaceIndex) {
    this.index = index;
  }

  /**
   * Provides label completions after `@`.
   *
   * @param document Markdown document.
   * @param position Cursor position.
   */
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = linePrefix.match(/@([A-Za-z0-9_:.~-]*)$/);
    if (!match) {
      return undefined;
    }

    const replacementStart = position.translate(0, -match[1].length);
    const replacementRange = new vscode.Range(replacementStart, position);
    const seen = new Set<string>();

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
 * @param entry Label or reference entry.
 * @param index Workspace index.
 * @param document Markdown document whose references should be counted.
 * @param tokenType Parsed token type, for example `label` or `reference`.
 */
function buildLabelHover(entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry, index: PandocWorkspaceIndex, document: vscode.TextDocument, tokenType: string) {
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
 * @param tokenType Parsed token type.
 */
function isDefinitionHover(tokenType: string) {
  return tokenType === "label";
}

/**
 * Returns a MathJax SVG foreground color for the current VS Code theme.
 *
 * Data-URI SVG images cannot reliably inherit the hover foreground. Dark
 * themes therefore need an explicit light color; light themes keep MathJax's
 * default black glyphs.
 *
 */
function getMathPreviewForegroundColor() {
  const themeKind = vscode.window.activeColorTheme.kind;
  if (themeKind === vscode.ColorThemeKind.HighContrast) {
    return "#ffffff";
  }
  if (themeKind === vscode.ColorThemeKind.Dark) {
    return "#f2f2f2";
  }
  return undefined;
}

/**
 * Builds a hover body for display math blocks with a rendered SVG preview.
 *
 * @param mathBlock Math block entry.
 * @param index Workspace index.
 * @param document Markdown document whose references should be counted.
 * @param mathRenderer MathJax SVG renderer.
 */
async function buildMathHover(mathBlock: import("./parser").MathBlockEntry, index: PandocWorkspaceIndex, document: vscode.TextDocument, mathRenderer: MathJaxRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  const label = mathBlock.label || "unlabeled equation";
  const referenceCount = mathBlock.label ? index.getReferences(document, mathBlock.label).length : 0;

  markdown.appendMarkdown(`**Equation** \`${label}\``);
  if (mathBlock.label) {
    markdown.appendMarkdown(`  \nReferences: **${referenceCount}**`);
  }

  if (mathBlock.tex) {
    const renderedSvg = await mathRenderer.renderToDataUri(mathBlock.tex, true, getMathPreviewForegroundColor());
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
 * @param inlineMath Inline math entry.
 * @param mathRenderer MathJax SVG renderer.
 */
async function buildInlineMathHover(inlineMath: import("./parser").InlineMathEntry, mathRenderer: MathJaxRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown("**Inline math**");

  const renderedSvg = await mathRenderer.renderToDataUri(inlineMath.tex, false, getMathPreviewForegroundColor());
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
 * @param paragraph Paragraph hover data.
 * @param mathRenderer MathJax SVG renderer.
 * @param paragraphTranslator Paragraph translation service.
 */
async function buildParagraphHover(paragraph: ParagraphHover, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator) {
  const markdown = new vscode.MarkdownString(undefined, true);
  let hasContent = false;

  const translation = await buildParagraphTranslation(paragraph, mathRenderer, paragraphTranslator);
  if (translation && translation.markdown) {
    markdown.appendMarkdown(`**Chinese translation** (${formatTranslationEngineName(translation.engine)})\n\n`);
    markdown.appendMarkdown(translation.markdown);
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
 * The full paragraph, including TeX, is sent to the translation engine because
 * the user wants translation to see the same text that appears in the editor;
 * surviving inline TeX is rendered before showing the hover.
 *
 * @param paragraph Paragraph hover data.
 * @param mathRenderer MathJax SVG renderer.
 * @param paragraphTranslator Paragraph translation service.
 */
async function buildParagraphTranslation(paragraph: ParagraphHover, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator) {
  if (!paragraph.showTranslation) {
    return undefined;
  }

  const sourceText = paragraph.translationText || paragraph.text;
  const translatedTable = await buildPipeTableTranslation(sourceText, mathRenderer, paragraphTranslator);
  if (translatedTable !== undefined) {
    return translatedTable; 
  }

  const translatedList = await buildMarkdownListTranslation(sourceText, mathRenderer, paragraphTranslator);
  if (translatedList !== undefined) {
    return translatedList;
  }

  const translatedText = await paragraphTranslator.translateText(normalizeMarkdownLineBreaks(sourceText).trim());
  if (translatedText === undefined) {
    return undefined;
  }
  return {
    markdown: await renderInlineMathTextMarkdown(translatedText.text, mathRenderer),
    engine: translatedText.engine,
  };
}

/**
 * Builds a translated Markdown list while preserving one preview line per item.
 *
 * Normal paragraph translation intentionally folds prose, but list hovers need
 * their source line boundaries kept so VS Code does not show every item inline.
 *
 * @param text Raw paragraph text.
 * @param mathRenderer MathJax SVG renderer.
 * @param paragraphTranslator Paragraph translation service.
 * @returns Undefined means "not a simple list"; empty markdown means translation failed.
 */
async function buildMarkdownListTranslation(text: string, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator) {
  const list = parseSimpleMarkdownList(text);
  if (!list) {
    return undefined;
  }

  const translatedLines = [];
  let translationEngine;
  for (const item of list.items) {
    const translatedText = await paragraphTranslator.translateText(normalizeMarkdownLineBreaks(item.text).trim());
    if (translatedText === undefined) {
      return createRenderedTranslation("", translationEngine || await paragraphTranslator.ensurePreferredEngine());
    }

    translationEngine = translatedText.engine;
    translatedLines.push(`${item.prefix}${await renderInlineMathTextMarkdown(translatedText.text, mathRenderer)}`);
  }

  return createRenderedTranslation(translatedLines.join("\n").trim(), translationEngine);
}

/**
 * Builds a translated Markdown table while preserving the pipe-table syntax.
 *
 * Normal paragraph translation collapses line breaks and escapes `|`, which
 * intentionally makes prose literal but prevents VS Code from rendering tables.
 *
 * @param text Raw paragraph text.
 * @param mathRenderer MathJax SVG renderer.
 * @param paragraphTranslator Paragraph translation service.
 * @returns Undefined means "not a table"; empty markdown means table translation failed.
 */
async function buildPipeTableTranslation(text: string, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator) {
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
    return createRenderedTranslation("", await paragraphTranslator.ensurePreferredEngine());
  }

  const translatedTable = parseTranslatedPipeTableHtml(translatedHtml.text, table);
  if (!translatedTable) {
    return createRenderedTranslation("", translatedHtml.engine);
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

  return createRenderedTranslation(translatedRows.join("\n").trim(), translatedHtml.engine);
}

/**
 * Tries translating raw Markdown directly and accepts it only if still a table.
 *
 * `translateHtml` usually leaves Markdown punctuation alone, but Markdown is
 * not a protected format there; the shape check prevents a broken hover table.
 *
 * @param text Raw Markdown table text.
 * @param sourceTable Source table shape.
 * @param mathRenderer MathJax SVG renderer.
 * @param paragraphTranslator Paragraph translation service.
 */
async function buildDirectMarkdownPipeTableTranslation(text: string, sourceTable: MarkdownPipeTable, mathRenderer: MathJaxRenderer, paragraphTranslator: ParagraphTranslator) {
  const translatedMarkdown = await paragraphTranslator.translateText(text);
  if (translatedMarkdown === undefined) {
    return undefined;
  }

  const translatedTable = parseMarkdownPipeTable(translatedMarkdown.text);
  if (!translatedTable || !hasMatchingPipeTableShape(translatedTable, sourceTable)) {
    return undefined;
  }

  return createRenderedTranslation(await renderParsedPipeTableMarkdown(translatedTable, sourceTable, mathRenderer), translatedMarkdown.engine);
}

/**
 * Creates a rendered translation object when an engine is known.
 *
 * Failed structured translations keep an empty markdown string so callers can
 * stop fallback attempts without showing a partial table or list preview.
 *
 * @param markdown Rendered hover Markdown.
 * @param engine Translation engine.
 */
function createRenderedTranslation(markdown: string, engine: "google" | "microsoft" | undefined) {
  return engine ? { markdown, engine } : undefined;
}

/**
 * Formats the engine label shown in paragraph translation hovers.
 *
 * @param engine Translation engine id.
 */
function formatTranslationEngineName(engine: "google" | "microsoft") {
  return engine === "microsoft" ? "Microsoft Translator" : "Google Translate";
}

/**
 * Checks that direct Markdown translation preserved row and column boundaries.
 *
 * @param translatedTable Translated table.
 * @param sourceTable Source table.
 */
function hasMatchingPipeTableShape(translatedTable: MarkdownPipeTable, sourceTable: MarkdownPipeTable): boolean {
  if (translatedTable.separatorIndex !== sourceTable.separatorIndex || translatedTable.rows.length !== sourceTable.rows.length) {
    return false;
  }

  return translatedTable.rows.every((row, rowIndex) => row.cells.length === sourceTable.rows[rowIndex].cells.length);
}

/**
 * Rebuilds a parsed Markdown table after translating and escaping its cells.
 *
 * @param translatedTable Translated table.
 * @param sourceTable Source table for stable alignment delimiters.
 * @param mathRenderer MathJax SVG renderer.
 */
async function renderParsedPipeTableMarkdown(translatedTable: MarkdownPipeTable, sourceTable: MarkdownPipeTable, mathRenderer: MathJaxRenderer): Promise<string> {
  const translatedRows = [];
  for (let rowIndex = 0; rowIndex < translatedTable.rows.length; rowIndex += 1) {
    if (rowIndex === translatedTable.separatorIndex) {
      translatedRows.push(formatPipeTableRow(sourceTable.rows[sourceTable.separatorIndex].cells));
      continue;
    }

    const translatedCells = await renderMarkdownTableCells(translatedTable.rows[rowIndex].cells, mathRenderer);
    translatedRows.push(formatPipeTableRow(translatedCells));
  }

  const captionText = normalizeMarkdownLineBreaks(translatedTable.captionLines.map((line) => line.replace(/^:\s*/, "")).join("\n")).trim();
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
 * @param table Parsed pipe table.
 */
function formatPipeTableTranslationHtml(table: MarkdownPipeTable): string {
  const htmlRows = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    if (rowIndex === table.separatorIndex) {
      continue;
    }

    const cells = table.rows[rowIndex].cells
      .map((cell) => `<td>${escapeHtmlText(normalizeMarkdownLineBreaks(cell).trim())}</td>`)
      .join("");
    htmlRows.push(`<tr>${cells}</tr>`);
  }

  const captionText = normalizeMarkdownLineBreaks(table.captionLines.map((line) => line.replace(/^:\s*/, "")).join("\n")).trim();
  const captionHtml = captionText ? `<caption>${escapeHtmlText(captionText)}</caption>` : "";
  return `<table>${captionHtml}${htmlRows.join("\n")}</table>`;
}

/**
 * Parses the translated protected HTML table back into row and caption text.
 *
 * @param html Translated HTML fragment returned by Google.
 * @param table Source table shape.
 */
function parseTranslatedPipeTableHtml(html: string, table: MarkdownPipeTable): TranslatedPipeTableHtml | undefined {
  const expectedRows = table.rows.filter((_row, rowIndex) => rowIndex !== table.separatorIndex);
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length !== expectedRows.length) {
    return undefined;
  }

  const rows: string[][] = [];
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
 * @param cells Translated cell texts.
 * @param mathRenderer MathJax SVG renderer.
 */
async function renderMarkdownTableCells(cells: string[], mathRenderer: MathJaxRenderer): Promise<string[]> {
  const renderedCells: string[] = [];
  for (const cell of cells) {
    renderedCells.push(escapeMarkdownTableCellPipes(await renderInlineMathTextMarkdown(cell, mathRenderer)));
  }
  return renderedCells;
}

/**
 * Escapes table-cell pipes after Markdown rendering choices are preserved.
 *
 * @param value Markdown table cell content.
 */
function escapeMarkdownTableCellPipes(value: string) {
  return value.replace(/(^|[^\\])\|/g, "$1\\|");
}

/**
 * Parses a simple Markdown pipe table from one paragraph hover range.
 *
 * This branch intentionally handles only pipe tables with a header delimiter;
 * other table syntaxes should keep using the ordinary literal paragraph hover.
 *
 * @param text Raw paragraph text.
 */
function parseMarkdownPipeTable(text: string): MarkdownPipeTable | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const separatorIndex = lines.findIndex(isPipeTableSeparatorLine);
  if (separatorIndex !== 1) {
    return undefined;
  }

  const rows: { cells: string[] }[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length && isPipeTableRowLine(lines[lineIndex])) {
    const cells = splitMarkdownPipeTableRow(lines[lineIndex]).map((cell) => cell.trim());
    if (cells.length < 1) {
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
 * Parses a paragraph that is entirely made of simple one-line Markdown items.
 *
 * Nested item markers are allowed, but continuation lines are skipped so the
 * translator never flattens structure it cannot reconstruct safely in preview.
 *
 * @param text Raw paragraph text.
 */
function parseSimpleMarkdownList(text: string): SimpleMarkdownList | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return undefined;
  }

  const items: { prefix: string; text: string }[] = [];
  for (const line of lines) {
    const item = parseSimpleMarkdownListItem(line);
    if (!item) {
      return undefined;
    }
    items.push(item);
  }

  if (!items.some((item) => item.prefix.search(/\S/) === 0)) {
    return undefined;
  }

  return { items };
}

/**
 * Parses one bullet or ordered-list item, keeping its original indentation.
 *
 * @param line Markdown line without trailing whitespace.
 */
function parseSimpleMarkdownListItem(line: string) {
  const unorderedMatch = line.match(/^([ \t]*[-+*]\s+)(.+)$/);
  if (unorderedMatch) {
    return { prefix: unorderedMatch[1], text: unorderedMatch[2].trim() };
  }

  const orderedMatch = line.match(/^([ \t]*\d{1,9}[.)]\s+)(.+)$/);
  if (orderedMatch) {
    return { prefix: orderedMatch[1], text: orderedMatch[2].trim() };
  }

  return undefined;
}

/**
 * Checks whether a line can be parsed as a Markdown pipe-table row.
 *
 * @param line Trimmed Markdown line.
 */
function isPipeTableRowLine(line: string) {
  const cells = splitMarkdownPipeTableRow(line);
  // Single-column pipe tables such as `|---|` need outer fences; otherwise a
  // lone pipe in prose would be too easy to misclassify as a table row.
  return cells.length >= 2 || (hasOuterPipeTableFences(line) && cells.length === 1);
}

/**
 * Checks whether a line is the required Markdown table delimiter row.
 *
 * @param line Trimmed Markdown line.
 */
function isPipeTableSeparatorLine(line: string) {
  if (!isPipeTableRowLine(line)) {
    return false;
  }

  return splitMarkdownPipeTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Splits a pipe-table row without treating escaped pipes as cell separators.
 *
 * @param line Trimmed Markdown table row.
 */
function splitMarkdownPipeTableRow(line: string) {
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
 * @param row Trimmed Markdown table row.
 */
function stripOuterPipe(row: string) {
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
 * Checks whether a row has unescaped leading and trailing table pipes.
 *
 * @param line Trimmed Markdown table row.
 */
function hasOuterPipeTableFences(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith("|")
    && trimmed.endsWith("|")
    && !isEscapedMarkdownCharacter(trimmed, trimmed.length - 1);
}

/**
 * Checks whether a Markdown character is escaped by an odd number of slashes.
 *
 * @param value Markdown source.
 * @param index Character index to inspect.
 */
function isEscapedMarkdownCharacter(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Formats already-escaped cells as one Markdown pipe-table row.
 *
 * @param cells Escaped table cells.
 */
function formatPipeTableRow(cells: string[]) {
  return `| ${cells.map((cell) => cell.trim()).join(" | ")} |`;
}

/**
 * Escapes table text before embedding it in protected translation HTML.
 *
 * @param value Raw table cell or caption text.
 */
function escapeHtmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Normalizes translated text recovered from protected table HTML.
 *
 * @param value HTML text content from a translated cell or caption.
 */
function normalizeTranslatedTableHtmlText(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks whether prose looks like an English paragraph.
 *
 * @param text Raw paragraph text.
 */
function isLikelyEnglishParagraph(text: string) {
  const latinLetters = text.match(/[A-Za-z]/g) || [];
  const cjkCharacters = text.match(/[\u3400-\u9FFF]/g) || [];
  const wordMatches = text.match(/[A-Za-z]{2,}/g) || [];
  const languageCharacterCount = latinLetters.length + cjkCharacters.length;
  // Allow English-heavy manuscript paragraphs that include brief Chinese notes.
  const cjkRatio = languageCharacterCount === 0 ? 0 : cjkCharacters.length / languageCharacterCount;

  return latinLetters.length >= 20
    && wordMatches.length >= 4
    && cjkRatio < MAX_TRANSLATABLE_CJK_RATIO;
}

/**
 * Renders inline math spans inside one paragraph as hover-friendly SVG images.
 *
 * Failed formulas fall back to inline TeX so one bad span does not hide the
 * rest of the paragraph preview.
 *
 * @param paragraph Paragraph hover data.
 * @param mathRenderer MathJax SVG renderer.
 */
async function renderInlineMathParagraphMarkdown(paragraph: ParagraphHover, mathRenderer: MathJaxRenderer) {
  return renderInlineMathTextMarkdown(paragraph.text, mathRenderer, paragraph.inlineMath, paragraph.startOffset);
}

/**
 * Renders inline math spans inside arbitrary hover text.
 *
 * The non-math chunks remain Markdown so the hover acts like a Markdown preview
 * with VS Code's missing inline-math rendering filled in by MathJax images.
 *
 * @param text Hover text.
 * @param mathRenderer MathJax SVG renderer.
 * @param inlineMath Inline math entries, if already known.
 * @param startOffset Offset used by precomputed inline math entries.
 */
async function renderInlineMathTextMarkdown(text: string, mathRenderer: MathJaxRenderer, inlineMath: import("./parser").InlineMathEntry[] | undefined = undefined, startOffset: number | undefined = 0) {
  const mathEntries = inlineMath || parsePandocDocument(text).inlineMath;
  const parts = [];
  let cursor = 0;

  for (const inlineMathEntry of mathEntries) {
    const formulaStart = inlineMathEntry.fullOffset - startOffset;
    const formulaEnd = inlineMathEntry.fullEndOffset - startOffset;
    if (formulaStart < cursor || formulaEnd > text.length) {
      continue;
    }

    parts.push(normalizeMarkdownLineBreaks(text.slice(cursor, formulaStart)));
    const renderedSvg = await mathRenderer.renderToDataUri(inlineMathEntry.tex, false, getMathPreviewForegroundColor());
    if (renderedSvg) {
      parts.push(`![Rendered inline equation preview](${renderedSvg})`);
    } else {
      parts.push(`\`${escapeMarkdownCodeSpan(inlineMathEntry.tex)}\``);
    }
    cursor = formulaEnd;
  }

  parts.push(normalizeMarkdownLineBreaks(text.slice(cursor)));
  return parts.join("").trim();
}

/**
 * Normalizes line endings without escaping Markdown syntax.
 *
 * @param value Markdown text.
 */
function normalizeMarkdownLineBreaks(value: string) {
  return value.replace(/\r\n/g, "\n");
}

/**
 * Escapes rare backticks in TeX fallback code spans.
 *
 * @param value TeX source.
 */
function escapeMarkdownCodeSpan(value: string) {
  return value.replace(/`/g, "\\`");
}

/**
 * Adds the MathJax fallback message shown when a hover preview cannot render.
 *
 * @param markdown Hover markdown being built.
 */
function appendMathJaxUnavailableMessage(markdown: vscode.MarkdownString) {
  markdown.appendMarkdown("\n\n$(warning) MathJax preview could not render. See the Pandoc Manuscript Tools output for the TeX source and error details.\n\n");
}


function buildHeadingTree(headings: HeadingEntry[]): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  const stack: Array<{ level: number; symbol: vscode.DocumentSymbol }> = [];

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
 * @param heading Parsed heading.
 */
function formatHeadingSymbolName(heading: import("./parser").HeadingEntry) {
  return `${"#".repeat(heading.level)} ${heading.title}`;
}

/**
 * Adds figure, table, and equation labels below their nearest heading symbol.
 *
 * @param labels Parsed label definitions.
 * @param headingSymbols Heading symbols.
 */
function addLabelSymbols(labels: import("./parser").LabelEntry[], headingSymbols: vscode.DocumentSymbol[]) {
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
 * @param label Parsed label definition.
 */
function createLabelSymbol(label: import("./parser").LabelEntry) {
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
 * @param symbols Heading symbols.
 */
function flattenDocumentSymbols(symbols: vscode.DocumentSymbol[]) {
  const flattened: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    flattened.push(symbol, ...flattenDocumentSymbols(symbol.children));
  }
  return flattened;
}

/**
 * Finds the innermost heading symbol preceding a line.
 *
 * @param symbols Flat candidate heading symbols.
 * @param line Target line.
 */
function findNearestHeadingSymbol(symbols: vscode.DocumentSymbol[], line: number) {
  let nearest: vscode.DocumentSymbol | undefined;
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
 * @param labels Candidate labels.
 * @param child Child label.
 */
function findNearestContainerLabel(labels: import("./parser").LabelEntry[], child: import("./parser").LabelEntry) {
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
 * @param left Left range.
 * @param right Right range.
 */
function isRangeStartAfter(left: import("./parser").PlainRange, right: import("./parser").PlainRange) {
  if (left.start.line !== right.start.line) {
    return left.start.line > right.start.line;
  }
  return left.start.character > right.start.character;
}

/**
 * Updates diagnostics for all open Markdown documents.
 *
 * @param index Workspace index.
 * @param diagnostics Diagnostic collection.
 */
export function updateDiagnosticsForOpenDocuments(index: PandocWorkspaceIndex, diagnostics: vscode.DiagnosticCollection): void {
  for (const document of vscode.workspace.textDocuments) {
    if (isPandocDocument(document)) {
      updateDiagnostics(document, index, diagnostics);
    }
  }
}

/**
 * Updates diagnostics for one Markdown document.
 *
 * @param document Markdown document.
 * @param index Workspace index.
 * @param diagnostics Diagnostic collection.
 */
export function updateDiagnostics(document: vscode.TextDocument, index: PandocWorkspaceIndex, diagnostics: vscode.DiagnosticCollection): void {
  if (!getConfiguration().get("enableDiagnostics", true)) {
    diagnostics.delete(document.uri);
    return;
  }

  const parsed = index.getParsedDocument(document);
  const definitionMap = index.getDefinitionMap(document);
  const documentDiagnostics: vscode.Diagnostic[] = [];

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
 * @param index Workspace index.
 * @param document Markdown document.
 * @param position Cursor position.
 */
function getTokenAtDocumentPosition(index: PandocWorkspaceIndex, document: vscode.TextDocument, position: vscode.Position): PandocTokenAtPosition | undefined {
  const parsed = index.getParsedDocument(document);
  return findTokenAtPosition(parsed, toPlainPosition(position));
}









