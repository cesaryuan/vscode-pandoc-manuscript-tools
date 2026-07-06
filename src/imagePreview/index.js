"use strict";

const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const { findImageTokenAtPosition } = require("./imageTokenParser");
const { resolveLocalPath } = require("./pathResolver");
const { renderSvgPreviewDataUri } = require("./svgPreview");
const { renderMetafilePreviewDataUri } = require("./emfPreview");

class ImagePreviewRenderer {
  /**
   * Creates a renderer for SVG, EMF, and WMF hover previews.
   *
   * @param {{appendLine(message: string): void}} output Output channel.
   */
  constructor(output) {
    this.output = output;
    this.cache = new Map();
  }

  /**
   * Builds a hover for a supported local image under the cursor.
   *
   * @param {vscode.TextDocument} document Text document.
   * @param {vscode.Position} position Hover position.
   * @returns {Promise<vscode.Hover | undefined>}
   */
  async provideHover(document, position) {
    const token = findImageTokenAtPosition(document, position);
    if (!token) {
      return undefined;
    }

    const imagePath = resolveLocalPath(document, token.target);
    if (!imagePath) {
      return undefined;
    }

    const dataUri = await this.renderToDataUri(document, imagePath, token.extension);
    if (!dataUri) {
      return new vscode.Hover(buildImagePreviewUnavailableHover(token.target), token.range);
    }

    return new vscode.Hover(buildImagePreviewHover(token.target, dataUri), token.range);
  }

  /**
   * Renders one image to a data URI, using an in-memory cache per path.
   *
   * @param {vscode.TextDocument} document Text document.
   * @param {string} imagePath Absolute image path.
   * @param {string} extension Lowercase image extension.
   * @returns {Promise<string | undefined>}
   */
  async renderToDataUri(document, imagePath, extension) {
    let cacheKey;
    try {
      cacheKey = await this.createCacheKey(imagePath, extension);
    } catch (error) {
      this.output.appendLine(`Image preview could not read ${imagePath}: ${formatError(error)}`);
      return undefined;
    }

    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, this.renderToDataUriUncached(document, imagePath, extension));
    }
    return this.cache.get(cacheKey);
  }

  /**
   * Creates a cache key that changes when the outer image file changes.
   *
   * @param {string} imagePath Absolute image path.
   * @param {string} extension Lowercase image extension.
   * @returns {Promise<string>}
   */
  async createCacheKey(imagePath, extension) {
    const stats = await fs.stat(imagePath);
    return `${extension}:${imagePath}:${stats.size}:${stats.mtimeMs}`;
  }

  /**
   * Renders one image without reading the preview cache.
   *
   * @param {vscode.TextDocument} document Text document.
   * @param {string} imagePath Absolute image path.
   * @param {string} extension Lowercase image extension.
   * @returns {Promise<string | undefined>}
   */
  async renderToDataUriUncached(document, imagePath, extension) {
    if (extension === ".svg") {
      return renderSvgPreviewDataUri(document, imagePath, this.output);
    }
    if (extension === ".emf" || extension === ".wmf") {
      return renderMetafilePreviewDataUri(imagePath, extension, this.output);
    }
    return undefined;
  }

  /**
   * Clears preview data held by the renderer.
   */
  dispose() {
    this.cache.clear();
  }
}

/**
 * Builds the Markdown body for a successful image preview.
 *
 * @param {string} target Original image target.
 * @param {string} dataUri Preview image data URI.
 * @returns {vscode.MarkdownString}
 */
function buildImagePreviewHover(target, dataUri) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${path.basename(target)}\`\n\n`);
  markdown.appendMarkdown(`![Rendered image preview](${dataUri})`);
  return markdown;
}

/**
 * Builds the Markdown body shown when preview rendering fails.
 *
 * @param {string} target Original image target.
 * @returns {vscode.MarkdownString}
 */
function buildImagePreviewUnavailableHover(target) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${path.basename(target)}\`\n\n`);
  markdown.appendMarkdown("$(warning) Preview could not render. See the Pandoc Manuscript Tools output for details.");
  return markdown;
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param {unknown} error Error-like value.
 * @returns {string}
 */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  ImagePreviewRenderer,
};
