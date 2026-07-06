"use strict";

const fs = require("fs/promises");
const { convertWmfToDataUrl } = require("emf-converter");
const { convertEmfToSvg } = require("./libemf2svgRuntime");
const { installNodeCanvasRuntime } = require("./nodeCanvasRuntime");

const DEFAULT_MAX_WIDTH = 900;
const DEFAULT_MAX_HEIGHT = 700;
const DEFAULT_DPI_SCALE = 2;

/**
 * Converts an EMF/WMF file into a hover image data URI.
 *
 * EMF files use the bundled libemf2svg WASM renderer so the hover can show the
 * generated SVG directly. WMF files still use `emf-converter` because
 * libemf2svg only targets Enhanced Metafile input.
 *
 * @param {string} imagePath Absolute image path.
 * @param {".emf" | ".wmf"} extension Image extension.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderMetafilePreviewDataUri(imagePath, extension, output) {
  try {
    const bytes = await fs.readFile(imagePath);
    const dataUri = extension === ".emf"
      ? await renderEmfPreviewDataUri(bytes, output)
      : await renderWmfPreviewDataUri(bytes, output);

    if (!dataUri) {
      output.appendLine(`EMF/WMF image preview returned no image for ${imagePath}.`);
      return undefined;
    }
    return dataUri;
  } catch (error) {
    output.appendLine(`EMF/WMF image preview failed for ${imagePath}: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Converts EMF bytes to an SVG data URI through libemf2svg WASM.
 *
 * @param {Buffer} bytes EMF file bytes.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderEmfPreviewDataUri(bytes, output) {
  const svg = await convertEmfToSvg(bytes, output);
  if (!svg) {
    return undefined;
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Converts WMF bytes to an SVG data URI through the existing raster renderer.
 *
 * `emf-converter` currently exposes WMF output only as PNG. Wrapping that PNG in
 * SVG keeps WMF previews on the inline-SVG display path without losing the
 * working WMF parser.
 *
 * @param {Buffer} bytes WMF file bytes.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderWmfPreviewDataUri(bytes, output) {
  installNodeCanvasRuntime();
  const pngDataUri = await convertWmfToDataUrl(toArrayBuffer(bytes), DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, { dpiScale: DEFAULT_DPI_SCALE });
  if (!pngDataUri) {
    return undefined;
  }

  const dimensions = readPngDataUriDimensions(pngDataUri);
  if (!dimensions) {
    output.appendLine("WMF image preview used default SVG dimensions because PNG output dimensions could not be read.");
  }
  return rasterDataUriToSvgDataUri(pngDataUri, dimensions || { width: DEFAULT_MAX_WIDTH, height: DEFAULT_MAX_HEIGHT });
}

/**
 * Wraps a raster preview data URI in SVG markup for inline preview surfaces.
 *
 * @param {string} dataUri Raster image data URI.
 * @param {{width: number, height: number}} dimensions Raster dimensions.
 * @returns {string}
 */
function rasterDataUriToSvgDataUri(dataUri, dimensions) {
  const width = Math.max(1, Math.round(dimensions.width));
  const height = Math.max(1, Math.round(dimensions.height));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<image href="${escapeXmlAttribute(dataUri)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Reads dimensions from a PNG data URI header.
 *
 * @param {string} dataUri PNG data URI.
 * @returns {{width: number, height: number} | undefined}
 */
function readPngDataUriDimensions(dataUri) {
  const match = dataUri.match(/^data:image\/png;base64,(.*)$/s);
  if (!match) {
    return undefined;
  }

  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return undefined;
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/**
 * Escapes text for XML attribute values.
 *
 * @param {string} value Raw attribute value.
 * @returns {string}
 */
function escapeXmlAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Copies a Node Buffer into a standalone ArrayBuffer for emf-converter.
 *
 * @param {Buffer} buffer Node buffer.
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
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
  renderMetafilePreviewDataUri,
};
