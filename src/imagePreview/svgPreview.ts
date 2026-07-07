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

const MAX_NESTED_RASTER_DIMENSION = 100;
const NESTED_RASTER_OUTPUT_MIME_TYPE = "image/png";

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
export async function renderSvgPreviewDataUri(document: { uri: vscode.Uri }, svgPath: string, output: OutputChannelLike): Promise<string | undefined> {
  try {
    const svg = await fs.readFile(svgPath, "utf8");
    const inlinedSvg = await inlineSvgImageReferences(document, svg, path.dirname(svgPath), output);
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
async function inlineSvgImageReferences(document: { uri: vscode.Uri }, svg: string, baseDirectory: string, output: OutputChannelLike): Promise<string> {
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

    const dataUri = await readImageAsDataUri(localPath, output);
    if (!dataUri) {
      continue;
    }

    replacements.push({
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
      value: `${match[1]}=${match[2]}${dataUri}${match[2]}`,
    });
  }

  return applyReplacements(svg, replacements);
}

/**
 * Reads one nested image as a data URI.
 *
 * @param imagePath Absolute image path.
 * @param output Output channel.
 */
async function readImageAsDataUri(imagePath: string, output: OutputChannelLike) {
  const mimeType = MIME_TYPES.get(path.extname(imagePath).toLowerCase());
  if (!mimeType) {
    output.appendLine(`SVG image preview skipped unsupported nested image type: ${imagePath}`);
    return undefined;
  }

  try {
    const imageBytes = await fs.readFile(imagePath);
    const encodedImage = await prepareNestedImageForDataUri(imageBytes, mimeType, imagePath, output);
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
async function prepareNestedImageForDataUri(imageBytes: Buffer, mimeType: string, imagePath: string, output: OutputChannelLike) {
  if (!RESIZABLE_RASTER_MIME_TYPES.has(mimeType)) {
    return { bytes: imageBytes, mimeType };
  }

  try {
    return await resizeNestedRasterImage(imageBytes, mimeType);
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
async function resizeNestedRasterImage(imageBytes: Buffer, mimeType: string) {
  const image = await NestedRasterJimp.fromBuffer(imageBytes);
  const dimensions = fitWithinBounds(image.width, image.height, MAX_NESTED_RASTER_DIMENSION);
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
