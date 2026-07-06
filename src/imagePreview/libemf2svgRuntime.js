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
  const module = await loadLibemf2svgModule(output);
  const inputPtr = module._malloc(bytes.byteLength);
  const outputPtrSlot = module._malloc(POINTER_SIZE);
  const outputLenSlot = module._malloc(POINTER_SIZE);
  let svgPtr = 0;

  try {
    module.HEAPU8.set(bytes, inputPtr);
    module.setValue(outputPtrSlot, 0, "*");
    module.setValue(outputLenSlot, 0, "i32");

    const ok = module._emf2svg_wasm_convert(
      inputPtr,
      bytes.byteLength,
      1,
      1,
      DEFAULT_MAX_WIDTH,
      DEFAULT_MAX_HEIGHT,
      outputPtrSlot,
      outputLenSlot,
    );

    svgPtr = module.getValue(outputPtrSlot, "*");
    const svgLength = module.getValue(outputLenSlot, "i32");
    if (!ok || !svgPtr || svgLength <= 0) {
      output.appendLine("libemf2svg returned no SVG output for EMF image preview.");
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
};
