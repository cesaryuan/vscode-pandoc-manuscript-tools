"use strict";

const fs = require("fs/promises");
const { convertEmfToDataUrl, convertWmfToDataUrl } = require("emf-converter");
const { installNodeCanvasRuntime } = require("./nodeCanvasRuntime");

const DEFAULT_MAX_WIDTH = 900;
const DEFAULT_MAX_HEIGHT = 700;
const DEFAULT_DPI_SCALE = 2;

/**
 * Converts an EMF/WMF file into a PNG data URI for Markdown hover previews.
 *
 * `emf-converter` remains the renderer; the Node Canvas runtime only supplies
 * the Canvas objects that VS Code extension host lacks.
 *
 * @param {string} imagePath Absolute image path.
 * @param {".emf" | ".wmf"} extension Image extension.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderMetafilePreviewDataUri(imagePath, extension, output) {
  try {
    installNodeCanvasRuntime();
    const bytes = await fs.readFile(imagePath);
    const buffer = toArrayBuffer(bytes);
    const dataUri = extension === ".wmf"
      ? await convertWmfToDataUrl(buffer, DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, { dpiScale: DEFAULT_DPI_SCALE })
      : await convertEmfToDataUrl(buffer, DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, { dpiScale: DEFAULT_DPI_SCALE });

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
 * Copies a Node Buffer into a standalone ArrayBuffer.
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
