import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { findImageTokenAtPosition } from "./imageTokenParser";
import { getDataUriMimeType, prepareImageDataUriForHover } from "./dataUri";
import { resolveLocalPath } from "./pathResolver";
import { pruneInlineRasterImagesToDataUriLimit, renderSvgPreviewDataUri } from "./svgPreview";
import { renderMetafilePreviewDataUri, type MetafilePreviewOptions } from "./emfPreview";

type PreviewDocument = { uri: vscode.Uri };
type ImagePreviewRenderOptions = {
  metafile?: MetafilePreviewOptions;
  nestedRasterMaxDimension?: number;
};

// VS Code 1.135.0 truncates MarkdownString.value only when its length exceeds
// 100,000 JavaScript characters. Keep the complete Markdown text strictly below
// that boundary so an image destination can never be cut in the middle.
const VSCODE_MARKDOWN_VALUE_LIMIT = 100_000;

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

    if (token.dataUri) {
      const dataUri = await this.prepareEmbeddedHoverDataUri(token.dataUri, token.target);
      if (!dataUri) {
        return new vscode.Hover(buildImagePreviewUnavailableHover(token.target), token.range);
      }
      return new vscode.Hover(createImagePreviewHoverMarkdown(token.target, dataUri), token.range);
    }

    const imagePath = resolveLocalPath(document, token.target);
    if (!imagePath) {
      return undefined;
    }

    const dataUri = await this.renderHoverToDataUri(document, imagePath, token.extension, token.target);
    if (!dataUri) {
      return new vscode.Hover(buildImagePreviewUnavailableHover(token.target), token.range);
    }

    return new vscode.Hover(createImagePreviewHoverMarkdown(token.target, dataUri), token.range);
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
      return renderSvgPreviewDataUri(document, imagePath, this.output, {
        maxNestedRasterDimension: options.nestedRasterMaxDimension,
      });
    }
    if (extension === ".emf" || extension === ".wmf") {
      return renderMetafilePreviewDataUri(imagePath, extension, this.output, {
        ...options.metafile,
        nestedRasterMaxDimension: options.nestedRasterMaxDimension ?? options.metafile?.nestedRasterMaxDimension,
      });
    }
    return undefined;
  }

  /**
   * Clears preview data held by the renderer.
   */
  dispose() {
    this.cache.clear();
  }

  /**
   * Renders a hover preview while progressively shrinking embedded raster images.
   *
   * VS Code truncates MarkdownString values above 100,000 characters. Re-rendering
   * at smaller inline-image dimensions keeps the preview as a self-contained data
   * URI while ensuring the complete Markdown image destination remains intact.
   *
   * @param document Preview document.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param target Original image target used in the hover header.
   */
  private async renderHoverToDataUri(document: PreviewDocument, imagePath: string, extension: string, target: string): Promise<string | undefined> {
    let previousLength: number | undefined;
    let smallestDataUri: string | undefined;
    for (const maxDimension of HOVER_NESTED_RASTER_DIMENSIONS) {
      const dataUri = await this.renderToDataUri(document, imagePath, extension, { nestedRasterMaxDimension: maxDimension });
      if (!dataUri) {
        return undefined;
      }
      smallestDataUri = dataUri;

      const markdownLength = createImagePreviewMarkdownLength(target, dataUri);
      if (markdownLength < VSCODE_MARKDOWN_VALUE_LIMIT) {
        if (maxDimension !== HOVER_NESTED_RASTER_DIMENSIONS[0]) {
          this.output.appendLine(`Image hover preview reduced inline raster images to ${maxDimension}px; final Markdown length is ${markdownLength}.`);
        }
        return dataUri;
      }

      if (markdownLength !== previousLength) {
        this.output.appendLine(`Image hover preview Markdown length is ${markdownLength} at inline raster limit ${maxDimension}px; trying a smaller inline image size.`);
      }
      previousLength = markdownLength;
    }

    const prunedDataUri = smallestDataUri ? this.pruneInlineRasterImagesForHover(target, smallestDataUri) : undefined;
    if (prunedDataUri) {
      return prunedDataUri;
    }

    this.output.appendLine(`Image hover preview remains at or above VS Code's ${VSCODE_MARKDOWN_VALUE_LIMIT}-character Markdown limit after the smallest inline raster compression.`);
    return undefined;
  }

  /**
   * Prepares an embedded image data URI with the same progressive compression policy.
   *
   * @param sourceDataUri Original embedded image data URI.
   * @param target Original image target used in the hover header.
   */
  private async prepareEmbeddedHoverDataUri(sourceDataUri: string, target: string): Promise<string | undefined> {
    let previousLength: number | undefined;
    let smallestDataUri: string | undefined;
    for (const maxDimension of HOVER_NESTED_RASTER_DIMENSIONS) {
      const dataUri = await prepareImageDataUriForHover(sourceDataUri, this.output, {
        maxNestedRasterDimension: maxDimension,
      });
      if (!dataUri) {
        return undefined;
      }
      smallestDataUri = dataUri;

      const markdownLength = createImagePreviewMarkdownLength(target, dataUri);
      if (markdownLength < VSCODE_MARKDOWN_VALUE_LIMIT) {
        if (maxDimension !== HOVER_NESTED_RASTER_DIMENSIONS[0]) {
          this.output.appendLine(`Embedded image hover reduced inline raster images to ${maxDimension}px; final Markdown length is ${markdownLength}.`);
        }
        return dataUri;
      }

      if (markdownLength !== previousLength) {
        this.output.appendLine(`Embedded image hover Markdown length is ${markdownLength} at inline raster limit ${maxDimension}px; trying a smaller inline image size.`);
      }
      previousLength = markdownLength;
    }

    const prunedDataUri = smallestDataUri ? this.pruneInlineRasterImagesForHover(target, smallestDataUri) : undefined;
    if (prunedDataUri) {
      return prunedDataUri;
    }

    this.output.appendLine(`Embedded image hover remains at or above VS Code's ${VSCODE_MARKDOWN_VALUE_LIMIT}-character Markdown limit after the smallest inline raster compression.`);
    return undefined;
  }

  /**
   * Uses a zero-raster fallback only if 1px inline images still exceed the limit.
   *
   * @param target Original image target used in the hover header.
   * @param dataUri Smallest data URI produced by progressive raster compression.
   */
  private pruneInlineRasterImagesForHover(target: string, dataUri: string): string | undefined {
    const markdownOverhead = createImagePreviewMarkdownLength(target, "");
    const maximumDataUriLength = VSCODE_MARKDOWN_VALUE_LIMIT - markdownOverhead - 1;
    const pruned = pruneInlineRasterImagesToDataUriLimit(dataUri, maximumDataUriLength);
    if (!pruned || !isWithinVscodeMarkdownLimit(createImagePreviewMarkdownLength(target, pruned.dataUri))) {
      return undefined;
    }

    this.output.appendLine(`Image hover preview removed ${pruned.removedImageCount} inline raster image node(s) after 1px compression so the final Markdown length stays below ${VSCODE_MARKDOWN_VALUE_LIMIT}.`);
    return pruned.dataUri;
  }
}

/**
 * Builds the cache suffix for render options that change generated image data.
 *
 * @param options Optional render settings.
 */
function renderOptionsCacheSuffix(options: ImagePreviewRenderOptions) {
  return [
    `metafileMaxWidth=${options.metafile?.maxWidth ?? "default"}`,
    `metafileMaxHeight=${options.metafile?.maxHeight ?? "default"}`,
    `nestedRasterMaxDimension=${options.nestedRasterMaxDimension ?? "default"}`,
  ].join(",");
}

/**
 * Builds the Markdown body for a successful image preview.
 *
 * @param target Original image target.
 * @param imageSource Preview image data URI.
 */
function createImagePreviewHoverMarkdown(target: string, imageSource: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${formatImageTargetLabel(target)}\`\n\n`);
  markdown.appendMarkdown(`![Rendered image preview](${imageSource})`);
  return markdown;
}

/**
 * Computes the exact MarkdownString value length used by the image hover.
 *
 * @param target Original image target.
 * @param imageSource Preview image data URI.
 */
function createImagePreviewMarkdownLength(target: string, imageSource: string): number {
  return createImagePreviewHoverMarkdown(target, imageSource).value.length;
}

/**
 * Checks a final MarkdownString value against VS Code's pre-parse truncation boundary.
 *
 * @param markdownLength Exact final MarkdownString character length.
 */
function isWithinVscodeMarkdownLimit(markdownLength: number): boolean {
  return markdownLength < VSCODE_MARKDOWN_VALUE_LIMIT;
}

// Try the existing 100px compression first, then progressively smaller bounds.
// The final 1px attempt is the smallest meaningful raster image and provides a
// deterministic failure boundary when SVG paths alone exceed VS Code's limit.
const HOVER_NESTED_RASTER_DIMENSIONS = [100, 80, 64, 48, 32, 24, 16, 12, 8, 4, 2, 1];

/**
 * Builds the Markdown body shown when preview rendering fails.
 *
 * @param target Original image target.
 */
function buildImagePreviewUnavailableHover(target: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Image preview** \`${formatImageTargetLabel(target)}\`\n\n`);
  markdown.appendMarkdown("$(warning) Preview could not render. See the Pandoc Manuscript Tools output for details.");
  return markdown;
}

/**
 * Builds a compact hover label for a file path or embedded data URI.
 *
 * @param target Original image target.
 */
function formatImageTargetLabel(target: string) {
  const mimeType = getDataUriMimeType(target);
  if (mimeType) {
    return `embedded ${mimeType}`;
  }

  return path.basename(target);
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


