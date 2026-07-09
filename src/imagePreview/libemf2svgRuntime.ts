import * as fs from "fs";
import * as path from "path";
const createEmf2SvgModule = require("../../assets/libemf2svg/emf2svg.js");

const DEFAULT_MAX_WIDTH = 600;
const HOVER_METAFILE_MAX_HEIGHT = 150;
// Webview previews have more room than hovers, so they request taller SVGs
// directly from the wasm converter instead of resizing Webview DOM nodes.
export const WEBVIEW_METAFILE_MAX_HEIGHT = 450;
const POINTER_SIZE = 4;
const WASM_EMFPLUS_ENABLED = 1; // Some Visio exported EMF files contain EMF+ data
const WASM_SVG_DELIMITER_ENABLED = 1;

type LibEmf2SvgModule = {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  setValue(pointer: number, value: number, type: "*" | "i32"): void;
  getValue(pointer: number, type: "*" | "i32"): number;
  _emf2svg_wasm_convert(inputPtr: number, inputLength: number, emfplus: number, svgDelimiter: number, maxWidth: number, maxHeight: number, outputPtrSlot: number, outputLenSlot: number): number;
  _wmf2svg_wasm_convert(inputPtr: number, inputLength: number, svgDelimiter: number, maxWidth: number, maxHeight: number, outputPtrSlot: number, outputLenSlot: number): number;
};
type OutputChannelLike = { appendLine(message: string): void };
type EmscriptenFactoryOptions = { locateFile(fileName: string): string; print(message: string): void; printErr(message: string): void };
type MetafileConversionOptions = {
  maxHeight?: number;
  maxWidth?: number;
};

let modulePromise: Promise<LibEmf2SvgModule> | undefined;

/**
 * Converts one EMF byte buffer to SVG text through the bundled libemf2svg WASM module.
 *
 * @param bytes EMF file bytes.
 * @param output Output channel.
 * @param options Optional wasm conversion size limits.
 */
export async function convertEmfToSvg(bytes: Buffer | Uint8Array, output: OutputChannelLike, options: MetafileConversionOptions = {}) {
  return convertMetafileToSvg(bytes, "EMF", output, options);
}

/**
 * Converts one WMF byte buffer to SVG text through the bundled libemf2svg WASM module.
 *
 * WMF support was added after the first libemf2svg integration. Keeping this
 * separate wrapper makes the format-specific wasm export explicit while sharing
 * the same memory ownership path as EMF conversion.
 *
 * @param bytes WMF file bytes.
 * @param output Output channel.
 * @param options Optional wasm conversion size limits.
 */
export async function convertWmfToSvg(bytes: Buffer | Uint8Array, output: OutputChannelLike, options: MetafileConversionOptions = {}) {
  return convertMetafileToSvg(bytes, "WMF", output, options);
}

/**
 * Converts one metafile byte buffer to SVG text with the format-specific wasm export.
 *
 * @param bytes Metafile bytes.
 * @param format Metafile format.
 * @param output Output channel.
 * @param options Optional wasm conversion size limits.
 */
async function convertMetafileToSvg(bytes: Buffer | Uint8Array, format: "EMF" | "WMF", output: OutputChannelLike, options: MetafileConversionOptions) {
  const module = await loadLibemf2svgModule(output);
  const inputPtr = module._malloc(bytes.byteLength);
  const outputPtrSlot = module._malloc(POINTER_SIZE);
  const outputLenSlot = module._malloc(POINTER_SIZE);
  let svgPtr = 0;

  try {
    module.HEAPU8.set(bytes, inputPtr);
    module.setValue(outputPtrSlot, 0, "*");
    module.setValue(outputLenSlot, 0, "i32");

    const ok = callMetafileConverter(module, format, inputPtr, bytes.byteLength, outputPtrSlot, outputLenSlot, options);

    svgPtr = module.getValue(outputPtrSlot, "*");
    const svgLength = module.getValue(outputLenSlot, "i32");
    if (!ok || !svgPtr || svgLength <= 0) {
      output.appendLine(`libemf2svg returned no SVG output for ${format} image preview.`);
      return undefined;
    }

    return addMissingSvgViewBox(Buffer.from(module.HEAPU8.subarray(svgPtr, svgPtr + svgLength)).toString("utf8"), format, output);
  } finally {
    if (svgPtr) {
      module._free(svgPtr);
    }
    module._free(outputLenSlot);
    module._free(outputPtrSlot);
    module._free(inputPtr);
  }
}

/**
 * Adds a root viewBox to converted SVGs that only declare width and height.
 *
 * This fixes converted EMF/WMF previews whose contents did not scale as a
 * single image in webviews because the generated SVG had viewport dimensions
 * but no coordinate-system viewBox.
 *
 * @param svg Converted SVG text.
 * @param format Metafile format used for logging.
 * @param output Output channel.
 */
function addMissingSvgViewBox(svg: string, format: "EMF" | "WMF", output: OutputChannelLike): string {
  const openTag = svg.match(/<svg\b[^>]*>/i);
  if (!openTag || /\bviewBox\s*=/i.test(openTag[0])) {
    return svg;
  }

  const width = parseSvgLength(readSvgAttribute(openTag[0], "width"));
  const height = parseSvgLength(readSvgAttribute(openTag[0], "height"));
  if (!width || !height) {
    output.appendLine(`libemf2svg ${format} output has no viewBox and no usable width/height for preview scaling.`);
    return svg;
  }

  const replacement = openTag[0].replace(/>$/, ` viewBox="0 0 ${formatSvgNumber(width)} ${formatSvgNumber(height)}">`);
  return `${svg.slice(0, openTag.index)}${replacement}${svg.slice((openTag.index || 0) + openTag[0].length)}`;
}

/**
 * Reads one quoted attribute from an SVG start tag.
 *
 * @param tag SVG start tag.
 * @param name Attribute name.
 */
function readSvgAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : undefined;
}

/**
 * Parses simple SVG lengths that libemf2svg emits in user units or px.
 *
 * @param value Raw SVG length.
 */
function parseSvgLength(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Formats viewBox numbers without unnecessary trailing zeroes.
 *
 * @param value Numeric SVG coordinate.
 */
function formatSvgNumber(value: number) {
  return Number(value.toFixed(4)).toString();
}

/**
 * Calls the correct libemf2svg wasm export for the input metafile format.
 *
 * @param module Loaded Emscripten module.
 * @param format Metafile format.
 * @param inputPtr Pointer to input bytes in wasm memory.
 * @param inputLength Input byte length.
 * @param outputPtrSlot Pointer slot receiving the SVG buffer pointer.
 * @param outputLenSlot Pointer slot receiving the SVG byte length.
 * @param options Optional wasm conversion size limits.
 * @returns Native success flag.
 */
function callMetafileConverter(module: LibEmf2SvgModule, format: "EMF" | "WMF", inputPtr: number, inputLength: number, outputPtrSlot: number, outputLenSlot: number, options: MetafileConversionOptions) {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? HOVER_METAFILE_MAX_HEIGHT;

  if (format === "WMF") {
    return module._wmf2svg_wasm_convert(
      inputPtr,
      inputLength,
      WASM_SVG_DELIMITER_ENABLED,
      maxWidth,
      maxHeight,
      outputPtrSlot,
      outputLenSlot,
    );
  }

  return module._emf2svg_wasm_convert(
    inputPtr,
    inputLength,
    WASM_EMFPLUS_ENABLED,
    WASM_SVG_DELIMITER_ENABLED,
    maxWidth,
    maxHeight,
    outputPtrSlot,
    outputLenSlot,
  );
}

/**
 * Loads the Emscripten module once and points it at the packaged WASM file.
 *
 * @param output Output channel.
 */
function loadLibemf2svgModule(output: OutputChannelLike): Promise<LibEmf2SvgModule> {
  if (!modulePromise) {
    const wasmPath = resolveBundledWasmPath();
    output.appendLine(`Loading libemf2svg WASM from ${wasmPath}.`);
    modulePromise = createEmf2SvgModule({
      locateFile(fileName: string) {
        return fileName === "emf2svg.wasm" ? wasmPath : fileName;
      },
      print(message: string) {
        output.appendLine(`libemf2svg: ${message}`);
      },
      printErr(message: string) {
        output.appendLine(`libemf2svg error: ${message}`);
      },
    });
  }
  return modulePromise;
}

/**
 * Resolves the WASM asset in both bundled extension runs and direct source runs.
 *
 */
function resolveBundledWasmPath() {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "libemf2svg", "emf2svg.wasm"),
    path.resolve(__dirname, "..", "..", "assets", "libemf2svg", "emf2svg.wasm"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Bundled libemf2svg WASM file is missing. Checked: ${candidates.join("; ")}`);
}
