import { createJimp } from "@jimp/core";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import * as resize from "@jimp/plugin-resize";

type OutputChannelLike = { appendLine(message: string): void };
type ParsedDataUri = { mimeType: string; parameters: string[]; payload: string };

const MAX_DATA_URI_RASTER_DIMENSION = 150;
const DATA_URI_RASTER_OUTPUT_MIME_TYPE = "image/png";

const SUPPORTED_DATA_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

const RESIZABLE_DATA_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
]);

const DataUriRasterJimp = createJimp({
  plugins: [resize.methods],
  formats: [png, jpeg],
});

/**
 * Returns the MIME type for a data URI, if it has one.
 *
 * @param value Candidate data URI.
 */
export function getDataUriMimeType(value: string): string | undefined {
  return parseDataUri(value)?.mimeType;
}

/**
 * Normalizes supported image data URIs so VS Code hover Markdown can embed them.
 *
 * Raw SVG data URIs may contain spaces, parentheses, or angle brackets that are
 * valid in source text but fragile inside Markdown image destinations. Converting
 * them to base64 keeps the hover rendering path stable.
 *
 * @param value Candidate data URI.
 */
export function normalizeSupportedImageDataUri(value: string): string | undefined {
  const parsed = parseDataUri(value);
  if (!parsed || !SUPPORTED_DATA_IMAGE_MIME_TYPES.has(parsed.mimeType)) {
    return undefined;
  }

  return buildBase64DataUri(parsed.mimeType, decodeDataUriPayload(parsed));
}

/**
 * Prepares a supported image data URI for hover display.
 *
 * Large embedded PNG/JPEG images can exceed what VS Code hover Markdown will
 * render reliably. This shrinks those raster formats to a compact preview while
 * preserving SVG and other unsupported raster formats as normalized data URIs.
 *
 * @param value Candidate data URI.
 * @param output Output channel for resize diagnostics.
 */
export async function prepareImageDataUriForHover(value: string, output: OutputChannelLike): Promise<string | undefined> {
  const parsed = parseDataUri(value);
  if (!parsed || !SUPPORTED_DATA_IMAGE_MIME_TYPES.has(parsed.mimeType)) {
    return undefined;
  }

  const bytes = decodeDataUriPayload(parsed);
  if (!RESIZABLE_DATA_IMAGE_MIME_TYPES.has(parsed.mimeType)) {
    return buildBase64DataUri(parsed.mimeType, bytes);
  }

  try {
    const resized = await resizeDataUriRasterImage(bytes, parsed.mimeType);
    return buildBase64DataUri(resized.mimeType, resized.bytes);
  } catch (error) {
    output.appendLine(`Image data URI preview kept original raster after resize failed: ${formatError(error)}`);
    return buildBase64DataUri(parsed.mimeType, bytes);
  }
}

/**
 * Parses the structural parts of a data URI.
 *
 * @param value Candidate data URI.
 */
function parseDataUri(value: string): ParsedDataUri | undefined {
  const match = value.match(/^data:([^;,]+)((?:;[^,]*)*),(.*)$/is);
  if (!match) {
    return undefined;
  }

  return {
    mimeType: match[1].toLowerCase(),
    parameters: match[2].toLowerCase().split(";").filter(Boolean),
    payload: match[3],
  };
}

/**
 * Decodes a parsed data URI payload into bytes.
 *
 * @param parsed Parsed data URI.
 */
function decodeDataUriPayload(parsed: ParsedDataUri): Buffer {
  if (parsed.parameters.includes("base64")) {
    return Buffer.from(parsed.payload.replace(/\s+/g, ""), "base64");
  }

  return decodeDataUriTextPayload(parsed.payload);
}

/**
 * Builds a canonical base64 data URI.
 *
 * @param mimeType Data URI MIME type.
 * @param bytes Payload bytes.
 */
function buildBase64DataUri(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/**
 * Resizes one embedded PNG/JPEG data URI image if it exceeds the hover bound.
 *
 * @param imageBytes Source image bytes.
 */
async function resizeDataUriRasterImage(imageBytes: Buffer, mimeType: string) {
  const decoderBytes = mimeType === "image/png" ? trimPngTrailingBytes(imageBytes) : imageBytes;
  const image = await DataUriRasterJimp.fromBuffer(decoderBytes);
  const dimensions = fitWithinBounds(image.width, image.height, MAX_DATA_URI_RASTER_DIMENSION);
  if (!dimensions) {
    return { bytes: decoderBytes, mimeType };
  }

  // Jimp v1's resize plugin uses short option names (`w`/`h`).
  image.resize({ w: dimensions.width, h: dimensions.height });
  return {
    bytes: await image.getBuffer(DATA_URI_RASTER_OUTPUT_MIME_TYPE),
    mimeType: DATA_URI_RASTER_OUTPUT_MIME_TYPE,
  };
}

/**
 * Removes bytes after the PNG IEND chunk before handing data URIs to pngjs.
 *
 * Some embedded PNG data URLs render in browsers despite trailing bytes, but
 * pngjs rejects them with "unrecognised content at end of stream". Trimming only
 * after a structurally found IEND keeps this bug fix narrow.
 *
 * @param imageBytes Source PNG bytes.
 */
function trimPngTrailingBytes(imageBytes: Buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (imageBytes.length < pngSignature.length || !imageBytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return imageBytes;
  }

  let offset = pngSignature.length;
  while (offset + 12 <= imageBytes.length) {
    const length = imageBytes.readUInt32BE(offset);
    const chunkTypeStart = offset + 4;
    const chunkDataStart = chunkTypeStart + 4;
    const nextOffset = chunkDataStart + length + 4;
    if (nextOffset > imageBytes.length) {
      return imageBytes;
    }

    if (imageBytes.toString("ascii", chunkTypeStart, chunkDataStart) === "IEND") {
      return imageBytes.subarray(0, nextOffset);
    }

    offset = nextOffset;
  }

  return imageBytes;
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
 * Decodes the text payload of a non-base64 data URI.
 *
 * This special case is needed for hand-written SVG data URLs, where authors
 * often use URL-encoded XML instead of base64.
 *
 * @param payload Data URI payload after the comma.
 */
function decodeDataUriTextPayload(payload: string): Buffer {
  try {
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch (_error) {
    return Buffer.from(payload, "utf8");
  }
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
