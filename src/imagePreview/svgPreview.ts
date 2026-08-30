import type * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { createJimp } from "@jimp/core";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import * as resize from "@jimp/plugin-resize";
import { resolveLocalPath, isDataUri, isRemoteUrl } from "./pathResolver";

type OutputChannelLike = { appendLine(message: string): void };
type Replacement = { start: number; end: number; value: string };
export type SvgPreviewOptions = { maxNestedRasterDimension?: number };

const MAX_NESTED_RASTER_DIMENSION = 100;
const NESTED_RASTER_OUTPUT_MIME_TYPE = "image/png";
const SVG_DATA_URI_PREFIX = "data:image/svg+xml;base64,";

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const RESIZABLE_RASTER_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
]);

const NestedRasterJimp = createJimp({
  plugins: [resize.methods],
  formats: [png, jpeg],
});

/**
 * Creates a hover-safe SVG data URI with local `<image href>` assets inlined.
 *
 * This exists because VS Code hover images cannot reliably resolve local file
 * references inside a data-URI SVG. Inlining keeps SVG previews self-contained.
 *
 * @param document Document containing the SVG reference.
 * @param svgPath Absolute SVG path.
 * @param output Output channel.
 */
export async function renderSvgPreviewDataUri(document: { uri: vscode.Uri }, svgPath: string, output: OutputChannelLike, options: SvgPreviewOptions = {}): Promise<string | undefined> {
  try {
    const svg = await fs.readFile(svgPath, "utf8");
    const inlinedSvg = await inlineSvgImageReferences(document, svg, path.dirname(svgPath), output, options.maxNestedRasterDimension);
    return `data:image/svg+xml;base64,${Buffer.from(inlinedSvg, "utf8").toString("base64")}`;
  } catch (error) {
    output.appendLine(`SVG image preview failed for ${svgPath}: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Replaces local SVG image references with embedded data URIs.
 *
 * @param document Document containing the outer image.
 * @param svg Raw SVG text.
 * @param baseDirectory Directory used for relative nested images.
 * @param output Output channel.
 */
async function inlineSvgImageReferences(document: { uri: vscode.Uri }, svg: string, baseDirectory: string, output: OutputChannelLike, maxNestedRasterDimension: number | undefined): Promise<string> {
  const replacements: Replacement[] = [];
  const hrefPattern = /\b((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const rawHref = match[3];
    if (isDataUri(rawHref) || isRemoteUrl(rawHref)) {
      continue;
    }

    const localPath = resolveLocalPath(document, rawHref, baseDirectory);
    if (!localPath) {
      continue;
    }

    const dataUri = await readImageAsDataUri(localPath, output, maxNestedRasterDimension);
    if (!dataUri) {
      continue;
    }

    replacements.push({
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
      value: `${match[1]}=${match[2]}${dataUri}${match[2]}`,
    });
  }

  return compressSvgEmbeddedRasterDataUris(applyReplacements(svg, replacements), output, maxNestedRasterDimension);
}

/**
 * Reads one nested image as a data URI.
 *
 * @param imagePath Absolute image path.
 * @param output Output channel.
 */
async function readImageAsDataUri(imagePath: string, output: OutputChannelLike, maxNestedRasterDimension: number | undefined) {
  const mimeType = MIME_TYPES.get(path.extname(imagePath).toLowerCase());
  if (!mimeType) {
    output.appendLine(`SVG image preview skipped unsupported nested image type: ${imagePath}`);
    return undefined;
  }

  try {
    const imageBytes = await fs.readFile(imagePath);
    const encodedImage = await prepareNestedImageForDataUri(imageBytes, mimeType, imagePath, output, maxNestedRasterDimension);
    return `data:${encodedImage.mimeType};base64,${encodedImage.bytes.toString("base64")}`;
  } catch (error) {
    output.appendLine(`SVG image preview could not inline ${imagePath}: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Shrinks nested PNG/JPEG images before embedding them into hover SVG data URIs.
 *
 * This special case keeps SVG hovers compact without shipping the previous
 * native canvas runtime. Non-PNG/JPEG raster formats are left unchanged because
 * this lightweight Jimp instance only includes the formats this extension needs.
 *
 * @param imageBytes Source image bytes.
 * @param mimeType Source MIME type.
 * @param imagePath Absolute image path for diagnostics.
 * @param output Output channel.
 */
async function prepareNestedImageForDataUri(imageBytes: Buffer, mimeType: string, imagePath: string, output: OutputChannelLike, maxNestedRasterDimension: number | undefined) {
  if (!RESIZABLE_RASTER_MIME_TYPES.has(mimeType)) {
    return { bytes: imageBytes, mimeType };
  }

  try {
    return await resizeNestedRasterImage(imageBytes, mimeType, maxNestedRasterDimension);
  } catch (error) {
    output.appendLine(`SVG image preview kept original nested image after resize failed for ${imagePath}: ${formatError(error)}`);
    return { bytes: imageBytes, mimeType };
  }
}

/**
 * Resizes one PNG/JPEG image so both dimensions are at most MAX_NESTED_RASTER_DIMENSION.
 *
 * @param imageBytes Source image bytes.
 * @param mimeType Source MIME type.
 */
async function resizeNestedRasterImage(imageBytes: Buffer, mimeType: string, maxNestedRasterDimension: number | undefined) {
  const image = await NestedRasterJimp.fromBuffer(imageBytes);
  const dimensions = fitWithinBounds(image.width, image.height, maxNestedRasterDimension ?? MAX_NESTED_RASTER_DIMENSION);
  if (!dimensions) {
    return { bytes: imageBytes, mimeType };
  }

  // Jimp v1's resize plugin uses short option names (`w`/`h`).
  image.resize({ w: dimensions.width, h: dimensions.height });
  return {
    bytes: await image.getBuffer(NESTED_RASTER_OUTPUT_MIME_TYPE),
    mimeType: NESTED_RASTER_OUTPUT_MIME_TYPE,
  };
}

/**
 * Re-compresses existing embedded PNG/JPEG hrefs, including images emitted by
 * metafile converters, before the outer SVG is base64 encoded.
 *
 * @param svg SVG text containing possible data URI image hrefs.
 * @param output Output channel.
 * @param maxNestedRasterDimension Maximum width or height for raster images.
 */
export async function compressSvgEmbeddedRasterDataUris(svg: string, output: OutputChannelLike, maxNestedRasterDimension: number | undefined = undefined): Promise<string> {
  const replacements: Replacement[] = [];
  const hrefPattern = /\b((?:xlink:)?href)\s*=\s*(["'])(data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+)\2/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const dataUri = match[3];
    const parsed = dataUri.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/i);
    if (!parsed) {
      continue;
    }

    try {
      const encoded = await resizeNestedRasterImage(Buffer.from(parsed[2], "base64"), parsed[1].toLowerCase(), maxNestedRasterDimension);
      const resizedDataUri = `data:${encoded.mimeType};base64,${encoded.bytes.toString("base64")}`;
      replacements.push({
        start: match.index || 0,
        end: (match.index || 0) + match[0].length,
        value: `${match[1]}=${match[2]}${resizedDataUri}${match[2]}`,
      });
    } catch (error) {
      output.appendLine(`SVG image preview kept an existing embedded raster after resize failed: ${formatError(error)}`);
    }
  }

  return applyReplacements(svg, replacements);
}

/**
 * Removes the largest inline raster image nodes only when 1px compression cannot
 * make a self-contained SVG data URI fit within VS Code's Markdown limit.
 *
 * The normal hover path progressively resizes every embedded PNG/JPEG first.
 * This last-resort step handles SVGs with so many `<image>` elements that the
 * repeated XML element syntax itself is too large. It preserves all vector SVG
 * content and never returns an oversized data URI that VS Code would truncate.
 *
 * @param dataUri SVG data URI generated by this extension.
 * @param maxDataUriLength Maximum allowed data URI character length.
 */
export function pruneInlineRasterImagesToDataUriLimit(dataUri: string, maxDataUriLength: number): { dataUri: string; removedImageCount: number } | undefined {
  if (!dataUri.startsWith(SVG_DATA_URI_PREFIX) || dataUri.length <= maxDataUriLength) {
    return dataUri.length <= maxDataUriLength ? { dataUri, removedImageCount: 0 } : undefined;
  }

  const svg = Buffer.from(dataUri.slice(SVG_DATA_URI_PREFIX.length), "base64").toString("utf8");
  const imagePattern = /<image\b[^>]*\b(?:xlink:)?href\s*=\s*(["'])data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+\1[^>]*?(?:\/>|>[\s\S]*?<\/image\s*>)/gi;
  const matches = [...svg.matchAll(imagePattern)]
    .filter((match) => match.index !== undefined)
    .sort((left, right) => right[0].length - left[0].length);
  if (!matches.length) {
    return undefined;
  }

  const removals: Replacement[] = [];
  for (const match of matches) {
    const start = match.index || 0;
    removals.push({ start, end: start + match[0].length, value: "" });
    const candidateSvg = applyReplacements(svg, removals);
    const candidateDataUri = `${SVG_DATA_URI_PREFIX}${Buffer.from(candidateSvg, "utf8").toString("base64")}`;
    if (candidateDataUri.length <= maxDataUriLength) {
      return { dataUri: candidateDataUri, removedImageCount: removals.length };
    }
  }

  return undefined;
}

/**
 * Computes dimensions that fit inside a square bound without upscaling.
 *
 * @param width Source width.
 * @param height Source height.
 * @param maxDimension Maximum allowed width or height.
 */
function fitWithinBounds(width: number, height: number, maxDimension: number) {
  if (!width || !height || width <= maxDimension && height <= maxDimension) {
    return undefined;
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Applies non-overlapping string replacements from right to left.
 *
 * @param value Source string.
 * @param replacements Replacements.
 */
function applyReplacements(value: string, replacements: Replacement[]): string {
  let result = value;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
