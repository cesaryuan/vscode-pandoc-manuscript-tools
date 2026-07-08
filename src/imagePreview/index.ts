import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { findImageTokenAtPosition } from "./imageTokenParser";
import { resolveLocalPath } from "./pathResolver";
import { renderSvgPreviewDataUri } from "./svgPreview";
import { renderMetafilePreviewDataUri, type MetafilePreviewOptions } from "./emfPreview";

type PreviewDocument = { uri: vscode.Uri };
type ImagePreviewRenderOptions = {
  metafile?: MetafilePreviewOptions;
};

export class ImagePreviewRenderer {
  declare output: import("vscode").OutputChannel;
  declare cache: Map<string, Promise<string | undefined>>;
  /**
   * Creates a renderer for SVG, EMF, and WMF hover previews.
   *
   * @param output Output channel.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.cache = new Map();
  }

  /**
   * Builds a hover for a supported local image under the cursor.
   *
   * @param document Document URI used to resolve nested assets.
   * @param position Hover position.
   */
  async provideHover(document: vscode.TextDocument, position: vscode.Position) {
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
   * @param document Text document.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings for non-hover preview contexts.
   */
  async renderToDataUri(document: PreviewDocument, imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    let cacheKey;
    try {
      cacheKey = await this.createCacheKey(imagePath, extension, options);
    } catch (error) {
      this.output.appendLine(`Image preview could not read ${imagePath}: ${formatError(error)}`);
      return undefined;
    }

    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, this.renderToDataUriUncached(document, imagePath, extension, options));
    }
    return this.cache.get(cacheKey);
  }

  /**
   * Creates a cache key that changes when the outer image file changes.
   *
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings included in the cache key.
   */
  async createCacheKey(imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    const stats = await fs.stat(imagePath);
    return `${extension}:${imagePath}:${stats.size}:${stats.mtimeMs}:${renderOptionsCacheSuffix(options)}`;
  }

  /**
   * Renders one image without reading the preview cache.
   *
   * @param document Document URI used to resolve nested assets.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings for non-hover preview contexts.
   */
  async renderToDataUriUncached(document: PreviewDocument, imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    if (extension === ".svg") {
      return renderSvgPreviewDataUri(document, imagePath, this.output);
    }
    if (extension === ".emf" || extension === ".wmf") {
      return renderMetafilePreviewDataUri(imagePath, extension, this.output, options.metafile);
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
 * Builds the cache suffix for render options that change generated image data.
 *
 * @param options Optional render settings.
 */
function renderOptionsCacheSuffix(options: ImagePreviewRenderOptions) {
  return `metafileMaxHeight=${options.metafile?.maxHeight ?? "default"}`;
}

/**
 * Builds the Markdown body for a successful image preview.
 *
 * @param target Original image target.
 * @param dataUri Preview image data URI.
 */
function buildImagePreviewHover(target: string, dataUri: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${path.basename(target)}\`\n\n`);
  markdown.appendMarkdown(`![Rendered image preview](${dataUri})`);
  return markdown;
}

/**
 * Builds the Markdown body shown when preview rendering fails.
 *
 * @param target Original image target.
 */
function buildImagePreviewUnavailableHover(target: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${path.basename(target)}\`\n\n`);
  markdown.appendMarkdown("$(warning) Preview could not render. See the Pandoc Manuscript Tools output for details.");
  return markdown;
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


