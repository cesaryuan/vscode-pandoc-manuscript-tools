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
      : await renderWmfPreviewDataUri(bytes);

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
 * Converts WMF bytes to a PNG data URI through the existing fallback renderer.
 *
 * @param {Buffer} bytes WMF file bytes.
 * @returns {Promise<string | undefined>}
 */
async function renderWmfPreviewDataUri(bytes) {
  installNodeCanvasRuntime();
  return convertWmfToDataUrl(toArrayBuffer(bytes), DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, { dpiScale: DEFAULT_DPI_SCALE });
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
