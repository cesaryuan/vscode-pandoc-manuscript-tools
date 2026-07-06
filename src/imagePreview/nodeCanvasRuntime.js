"use strict";

let installed = false;

/**
 * Installs the minimal browser-like Canvas globals needed by `emf-converter`.
 *
 * VS Code extension host runs in Node, so `document.createElement("canvas")`
 * and `ImageData` do not exist. This bridge is deliberately installed only
 * when EMF/WMF hover rendering is requested.
 */
function installNodeCanvasRuntime() {
  if (installed) {
    return;
  }

  const canvas = require("@napi-rs/canvas");
  if (typeof globalThis.document === "undefined") {
    globalThis.document = createCanvasDocument(canvas);
  }
  if (typeof globalThis.HTMLCanvasElement === "undefined") {
    globalThis.HTMLCanvasElement = canvas.Canvas;
  }
  if (typeof globalThis.ImageData === "undefined") {
    globalThis.ImageData = canvas.ImageData;
  }
  if (typeof globalThis.createImageBitmap === "undefined") {
    globalThis.createImageBitmap = createImageBitmapShim(canvas);
  }

  installed = true;
}

/**
 * Creates the tiny `document` shim used by `emf-converter`.
 *
 * @param {typeof import("@napi-rs/canvas")} canvas Node canvas module.
 * @returns {{createElement(tagName: string): import("@napi-rs/canvas").Canvas}}
 */
function createCanvasDocument(canvas) {
  return {
    createElement(tagName) {
      if (String(tagName).toLowerCase() !== "canvas") {
        throw new Error(`Unsupported synthetic element for image preview: ${tagName}`);
      }
      return canvas.createCanvas(1, 1);
    },
  };
}

/**
 * Creates a `createImageBitmap` shim for embedded bitmap records.
 *
 * @param {typeof import("@napi-rs/canvas")} canvas Node canvas module.
 * @returns {(blob: Blob) => Promise<import("@napi-rs/canvas").Image>}
 */
function createImageBitmapShim(canvas) {
  return async (blob) => {
    const bytes = Buffer.from(await blob.arrayBuffer());
    const image = await canvas.loadImage(bytes);
    image.close = () => {};
    return image;
  };
}

module.exports = {
  installNodeCanvasRuntime,
};
