"use strict";

const fs = require("fs");
const path = require("path");
const createEmf2SvgModule = require("../../assets/libemf2svg/emf2svg.js");

const DEFAULT_MAX_WIDTH = 450;
const DEFAULT_MAX_HEIGHT = 150;
const POINTER_SIZE = 4;

let modulePromise;

/**
 * Converts one EMF byte buffer to SVG text through the bundled libemf2svg WASM module.
 *
 * @param {Buffer | Uint8Array} bytes EMF file bytes.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function convertEmfToSvg(bytes, output) {
  return convertMetafileToSvg(bytes, "EMF", output);
}

/**
 * Converts one WMF byte buffer to SVG text through the bundled libemf2svg WASM module.
 *
 * WMF support was added after the first libemf2svg integration. Keeping this
 * separate wrapper makes the format-specific wasm export explicit while sharing
 * the same memory ownership path as EMF conversion.
 *
 * @param {Buffer | Uint8Array} bytes WMF file bytes.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function convertWmfToSvg(bytes, output) {
  return convertMetafileToSvg(bytes, "WMF", output);
}

/**
 * Converts one metafile byte buffer to SVG text with the format-specific wasm export.
 *
 * @param {Buffer | Uint8Array} bytes Metafile bytes.
 * @param {"EMF" | "WMF"} format Metafile format.
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<string | undefined>}
 */
async function convertMetafileToSvg(bytes, format, output) {
  const module = await loadLibemf2svgModule(output);
  const inputPtr = module._malloc(bytes.byteLength);
  const outputPtrSlot = module._malloc(POINTER_SIZE);
  const outputLenSlot = module._malloc(POINTER_SIZE);
  let svgPtr = 0;

  try {
    module.HEAPU8.set(bytes, inputPtr);
    module.setValue(outputPtrSlot, 0, "*");
    module.setValue(outputLenSlot, 0, "i32");

    const ok = callMetafileConverter(module, format, inputPtr, bytes.byteLength, outputPtrSlot, outputLenSlot);

    svgPtr = module.getValue(outputPtrSlot, "*");
    const svgLength = module.getValue(outputLenSlot, "i32");
    if (!ok || !svgPtr || svgLength <= 0) {
      output.appendLine(`libemf2svg returned no SVG output for ${format} image preview.`);
      return undefined;
    }

    return Buffer.from(module.HEAPU8.subarray(svgPtr, svgPtr + svgLength)).toString("utf8");
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
 * Calls the correct libemf2svg wasm export for the input metafile format.
 *
 * @param {any} module Loaded Emscripten module.
 * @param {"EMF" | "WMF"} format Metafile format.
 * @param {number} inputPtr Pointer to input bytes in wasm memory.
 * @param {number} inputLength Input byte length.
 * @param {number} outputPtrSlot Pointer slot receiving the SVG buffer pointer.
 * @param {number} outputLenSlot Pointer slot receiving the SVG byte length.
 * @returns {number} Native success flag.
 */
function callMetafileConverter(module, format, inputPtr, inputLength, outputPtrSlot, outputLenSlot) {
  if (format === "WMF") {
    return module._wmf2svg_wasm_convert(
      inputPtr,
      inputLength,
      1,
      DEFAULT_MAX_WIDTH,
      DEFAULT_MAX_HEIGHT,
      outputPtrSlot,
      outputLenSlot,
    );
  }

  return module._emf2svg_wasm_convert(
    inputPtr,
    inputLength,
    1,
    1,
    DEFAULT_MAX_WIDTH,
    DEFAULT_MAX_HEIGHT,
    outputPtrSlot,
    outputLenSlot,
  );
}

/**
 * Loads the Emscripten module once and points it at the packaged WASM file.
 *
 * @param {{appendLine(message: string): void}} output Output channel.
 * @returns {Promise<any>}
 */
function loadLibemf2svgModule(output) {
  if (!modulePromise) {
    const wasmPath = resolveBundledWasmPath();
    output.appendLine(`Loading libemf2svg WASM from ${wasmPath}.`);
    modulePromise = createEmf2SvgModule({
      locateFile(fileName) {
        return fileName === "emf2svg.wasm" ? wasmPath : fileName;
      },
      print(message) {
        output.appendLine(`libemf2svg: ${message}`);
      },
      printErr(message) {
        output.appendLine(`libemf2svg error: ${message}`);
      },
    });
  }
  return modulePromise;
}

/**
 * Resolves the WASM asset in both bundled extension runs and direct source runs.
 *
 * @returns {string}
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

module.exports = {
  convertEmfToSvg,
  convertWmfToSvg,
};
