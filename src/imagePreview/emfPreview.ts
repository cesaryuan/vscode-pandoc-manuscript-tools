import * as fs from "fs/promises";

type OutputChannelLike = { appendLine(message: string): void };
import { convertEmfToSvg, convertWmfToSvg } from "./libemf2svgRuntime";

export type MetafilePreviewOptions = {
  maxWidth?: number;
  maxHeight?: number;
};

/**
 * Converts an EMF/WMF file into a hover image data URI.
 *
 * EMF and WMF files use the bundled libemf2svg WASM renderer so the hover can
 * show generated SVG directly.
 *
 * @param imagePath Absolute image path.
 * @param extension Image extension.
 * @param output Output channel.
 * @param options Optional wasm conversion size limits.
 */
export async function renderMetafilePreviewDataUri(imagePath: string, extension: ".emf" | ".wmf", output: OutputChannelLike, options: MetafilePreviewOptions = {}): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(imagePath);
    const dataUri = await renderSvgMetafilePreviewDataUri(bytes, extension, output, options);

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
 * @param bytes Metafile bytes.
 * @param extension Image extension.
 * @param output Output channel.
 * @param options Optional wasm conversion size limits.
 */
async function renderSvgMetafilePreviewDataUri(bytes: Buffer, extension: ".emf" | ".wmf", output: OutputChannelLike, options: MetafilePreviewOptions): Promise<string | undefined> {
  const svg = extension === ".emf"
    ? await convertEmfToSvg(bytes, output, options)
    : await convertWmfToSvg(bytes, output, options);
  if (!svg) {
    return undefined;
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
