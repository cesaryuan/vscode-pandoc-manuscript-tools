"use strict";

const fs = require("fs/promises");
const path = require("path");
const { createJimp } = require("@jimp/core");
const jpeg = require("@jimp/js-jpeg").default;
const png = require("@jimp/js-png").default;
const resize = require("@jimp/plugin-resize");
const { resolveLocalPath, isDataUri, isRemoteUrl } = require("./pathResolver");

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
 * @param {vscode.TextDocument} document Document containing the SVG reference.
 * @param {string} svgPath Absolute SVG path.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderSvgPreviewDataUri(document, svgPath, output) {
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
 * @param {vscode.TextDocument} document Document containing the outer image.
 * @param {string} svg Raw SVG text.
 * @param {string} baseDirectory Directory used for relative nested images.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string>}
 */
async function inlineSvgImageReferences(document, svg, baseDirectory, output) {
  const replacements = [];
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
 * @param {string} imagePath Absolute image path.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function readImageAsDataUri(imagePath, output) {
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
 * @param {Buffer} imageBytes Source image bytes.
 * @param {string} mimeType Source MIME type.
 * @param {string} imagePath Absolute image path for diagnostics.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<{bytes: Buffer, mimeType: string}>}
 */
async function prepareNestedImageForDataUri(imageBytes, mimeType, imagePath, output) {
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
 * @param {Buffer} imageBytes Source image bytes.
 * @param {string} mimeType Source MIME type.
 * @returns {Promise<{bytes: Buffer, mimeType: string}>}
 */
async function resizeNestedRasterImage(imageBytes, mimeType) {
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
 * @param {number} width Source width.
 * @param {number} height Source height.
 * @param {number} maxDimension Maximum allowed width or height.
 * @returns {{width: number, height: number} | undefined}
 */
function fitWithinBounds(width, height, maxDimension) {
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
 * @param {string} value Source string.
 * @param {{start: number, end: number, value: string}[]} replacements Replacements.
 * @returns {string}
 */
function applyReplacements(value, replacements) {
  let result = value;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
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
  renderSvgPreviewDataUri,
  inlineSvgImageReferences,
};
