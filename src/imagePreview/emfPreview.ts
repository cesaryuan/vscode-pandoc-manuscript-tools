import * as fs from "fs/promises";

type OutputChannelLike = { appendLine(message: string): void };
import { convertEmfToSvg, convertWmfToSvg } from "./libemf2svgRuntime";

/**
 * Converts an EMF/WMF file into a hover image data URI.
 *
 * EMF and WMF files use the bundled libemf2svg WASM renderer so the hover can
 * show generated SVG directly.
 *
 * @param {string} imagePath Absolute image path.
 * @param {".emf" | ".wmf"} extension Image extension.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
export async function renderMetafilePreviewDataUri(imagePath: string, extension: ".emf" | ".wmf", output: OutputChannelLike): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(imagePath);
    const dataUri = await renderSvgMetafilePreviewDataUri(bytes, extension, output);

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
 * Converts metafile bytes to an SVG data URI through libemf2svg WASM.
 *
 * @param {Buffer} bytes Metafile bytes.
 * @param {".emf" | ".wmf"} extension Image extension.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function renderSvgMetafilePreviewDataUri(bytes: Buffer, extension: ".emf" | ".wmf", output: OutputChannelLike): Promise<string | undefined> {
  const svg = extension === ".emf"
    ? await convertEmfToSvg(bytes, output)
    : await convertWmfToSvg(bytes, output);
  if (!svg) {
    return undefined;
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param {unknown} error Error-like value.
 * @returns {string}
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

