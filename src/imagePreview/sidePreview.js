"use strict";

/*
 * Editor-side image preview panel.
 *
 * This implements the VS Code-style "open preview to the side" action for
 * SVG/EMF/WMF files. It creates a WebviewPanel beside the active editor and
 * renders through ImagePreviewRenderer while adding Webview-specific handling
 * for SVG href rewriting and EMF/WMF conversion.
 */

const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const { resolveLocalPath, isDataUri, isRemoteUrl } = require("./pathResolver");

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);

class ImagePreviewSidePanel {
  /**
   * Creates a side-preview command handler.
   *
   * @param {import("./index").ImagePreviewRenderer} imagePreviewRenderer Shared preview renderer.
   * @param {{appendLine(message: string): void}} output Output channel.
   */
  constructor(imagePreviewRenderer, output) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
    this.panels = new Map();
  }

  /**
   * Opens or refreshes a side preview panel for an SVG/EMF/WMF file.
   *
   * @param {vscode.Uri=} uri Optional resource URI supplied by VS Code menus.
   */
  async open(uri) {
    const imageUri = this.resolveImageUri(uri);
    if (!imageUri) {
      await vscode.window.showWarningMessage("Open an SVG, EMF, or WMF file before starting image preview.");
      return;
    }

    const extension = path.extname(imageUri.fsPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      await vscode.window.showWarningMessage("Image preview only supports SVG, EMF, and WMF files.");
      return;
    }

    const panel = this.getOrCreatePanel(imageUri);
    panel.reveal(vscode.ViewColumn.Beside);
    await this.renderPanel(panel, imageUri, extension);
  }

  /**
   * Disposes all side-preview panels.
   */
  dispose() {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  /**
   * Refreshes an already-open preview panel after its source file is saved.
   *
   * @param {vscode.TextDocument} document Saved text document.
   */
  async refreshIfOpen(document) {
    if (document.uri.scheme !== "file") {
      return;
    }

    const panel = this.panels.get(document.uri.fsPath);
    if (!panel) {
      return;
    }

    const extension = path.extname(document.uri.fsPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      return;
    }

    await this.renderPanel(panel, document.uri, extension);
  }

  /**
   * Resolves the target image URI from command arguments or the active editor.
   *
   * @param {vscode.Uri=} uri Optional command resource URI.
   * @returns {vscode.Uri | undefined}
   */
  resolveImageUri(uri) {
    if (uri && uri.scheme === "file") {
      return uri;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === "file") {
      return activeEditor.document.uri;
    }

    return undefined;
  }

  /**
   * Gets an existing panel for one file, or creates a new side-preview panel.
   *
   * @param {vscode.Uri} imageUri Image file URI.
   * @returns {vscode.WebviewPanel}
   */
  getOrCreatePanel(imageUri) {
    const key = imageUri.fsPath;
    const existing = this.panels.get(key);
    if (existing) {
      existing.webview.options = createWebviewOptions(imageUri);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      "pandocManuscriptTools.imagePreview",
      `Preview ${path.basename(imageUri.fsPath)}`,
      vscode.ViewColumn.Beside,
      createWebviewOptions(imageUri),
    );
    panel.onDidDispose(() => {
      this.panels.delete(key);
    });
    this.panels.set(key, panel);
    return panel;
  }

  /**
   * Renders one image into a side-preview panel.
   *
   * @param {vscode.WebviewPanel} panel Preview panel.
   * @param {vscode.Uri} imageUri Image file URI.
   * @param {string} extension Lowercase image extension.
   */
  async renderPanel(panel, imageUri, extension) {
    const label = path.basename(imageUri.fsPath);
    panel.title = `Preview ${label}`;
    panel.webview.html = buildPanelHtml(`<p class="muted">Rendering ${escapeHtml(label)}...</p>`);

    try {
      const previewSource = await renderWebviewPreviewSource(panel.webview, this.imagePreviewRenderer, imageUri, imageUri.fsPath, extension);
      if (!previewSource) {
        panel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Pandoc Manuscript Tools output for details.</p>`);
        return;
      }
      if (previewSource.localResourceRoots) {
        panel.webview.options = createWebviewOptions(imageUri, previewSource.localResourceRoots);
      }
      panel.webview.html = buildPreviewHtml(imageUri.fsPath, extension, previewSource);
    } catch (error) {
      this.output.appendLine(`Image side preview failed for ${imageUri.fsPath}: ${formatError(error)}`);
      panel.webview.html = buildPanelHtml(`<p class="muted">Preview failed for ${escapeHtml(label)}.</p>`);
    }
  }
}

/**
 * Builds the full image-preview panel HTML.
 *
 * @param {string} imagePath Absolute image path.
 * @param {string} extension Lowercase image extension.
 * @param {WebviewPreviewSource} previewSource Rendered image source.
 * @returns {string}
 */
function buildPreviewHtml(imagePath, extension, previewSource) {
  const label = path.basename(imagePath);
  const imageAttributes = previewSourceToImageAttributes(previewSource);
  return buildPanelHtml(`
    <header>
      <div class="heading">
        <div class="title">${escapeHtml(label)}</div>
        <div class="subtitle">${escapeHtml(extension.toUpperCase().slice(1))}</div>
      </div>
      <div class="toolbar" role="toolbar">
        ${buildToolbarButton("out", "Zoom out", buildZoomOutIcon())}
        ${buildToolbarButton("in", "Zoom in", buildZoomInIcon())}
        ${buildToolbarButton("actual", "Actual size", buildActualSizeIcon())}
        ${buildToolbarButton("fit", "Fit to window", buildFitIcon())}
        <span class="zoomValue" data-zoom-value>100%</span>
      </div>
    </header>
    <main class="viewport" data-preview-viewport>
      <div class="stage" data-preview-stage>
        <img data-preview-image ${imageAttributes} alt="${escapeAttribute(label)}">
      </div>
    </main>
    <footer>${escapeHtml(imagePath)}</footer>
  `, getPreviewScript());
}

/**
 * Builds one icon-only toolbar button.
 *
 * @param {string} action Zoom action identifier.
 * @param {string} label Accessible label and tooltip.
 * @param {string} icon Inline SVG icon.
 * @returns {string}
 */
function buildToolbarButton(action, label, icon) {
  return `<button type="button" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}" data-zoom-action="${escapeAttribute(action)}">${icon}</button>`;
}

/**
 * Builds a zoom-out icon.
 *
 * @returns {string}
 */
function buildZoomOutIcon() {
  return buildIconSvg(`
    <circle cx="10" cy="10" r="5.5"></circle>
    <path d="M7.5 10h5"></path>
    <path d="m14.5 14.5 4 4"></path>
  `);
}

/**
 * Builds a zoom-in icon.
 *
 * @returns {string}
 */
function buildZoomInIcon() {
  return buildIconSvg(`
    <circle cx="10" cy="10" r="5.5"></circle>
    <path d="M10 7.5v5"></path>
    <path d="M7.5 10h5"></path>
    <path d="m14.5 14.5 4 4"></path>
  `);
}

/**
 * Builds an actual-size icon.
 *
 * @returns {string}
 */
function buildActualSizeIcon() {
  return buildIconSvg(`
    <path d="M6 6h12v12H6z"></path>
    <path d="M9 10h1.5v5"></path>
    <path d="M13.5 10h1.5v5"></path>
  `);
}

/**
 * Builds a fit-to-window icon.
 *
 * @returns {string}
 */
function buildFitIcon() {
  return buildIconSvg(`
    <path d="M4 9V4h5"></path>
    <path d="M20 9V4h-5"></path>
    <path d="M4 15v5h5"></path>
    <path d="M20 15v5h-5"></path>
    <path d="m9 9-4-4"></path>
    <path d="m15 9 4-4"></path>
    <path d="m9 15-4 4"></path>
    <path d="m15 15 4 4"></path>
  `);
}

/**
 * Wraps icon paths in a common SVG shell.
 *
 * @param {string} body SVG child markup.
 * @returns {string}
 */
function buildIconSvg(body) {
  return `<svg class="toolbarIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Creates the Webview-specific image source for preview panels.
 *
 * SVG files are rewritten before preview so nested local `<image href>` values
 * can be converted to Webview URIs. EMF/WMF are converted first, then passed to
 * the Webview script as Blob URL input to avoid using a long data URI as the
 * final image src.
 *
 * @param {vscode.Webview} webview Target webview.
 * @param {import("./index").ImagePreviewRenderer} imagePreviewRenderer Shared preview renderer.
 * @param {vscode.Uri} documentUri Document URI used for path resolution.
 * @param {string} imagePath Absolute image path.
 * @param {string} extension Lowercase image extension.
 * @returns {Promise<WebviewPreviewSource | undefined>}
 */
async function renderWebviewPreviewSource(webview, imagePreviewRenderer, documentUri, imagePath, extension) {
  if (extension === ".svg") {
    return renderSvgBlobPreviewSource(webview, documentUri, imagePath);
  }

  const documentLike = { uri: documentUri };
  const dataUri = await imagePreviewRenderer.renderToDataUri(documentLike, imagePath, extension);
  return dataUri ? dataUriToBlobPreviewSource(dataUri) : undefined;
}

/**
 * Rewrites a local SVG file and sends it through the simple Blob image path.
 *
 * This intentionally keeps side preview on the original Blob `<img>` model so
 * zooming and sizing use one code path for SVG, EMF, and WMF.
 *
 * @param {vscode.Webview} webview Target webview.
 * @param {vscode.Uri} documentUri SVG document URI.
 * @param {string} imagePath Absolute SVG path.
 * @returns {Promise<WebviewPreviewSource>}
 */
async function renderSvgBlobPreviewSource(webview, documentUri, imagePath) {
  const svg = await fs.readFile(imagePath, "utf8");
  const documentLike = { uri: documentUri };
  const rewritten = rewriteSvgImageReferencesToWebviewUris(webview, documentLike, svg, path.dirname(imagePath));
  return {
    ...stringToBlobPreviewSource(rewritten.svg, "image/svg+xml"),
    localResourceRoots: rewritten.localResourceRoots,
  };
}

/**
 * Replaces local SVG image hrefs with Webview-safe resource URIs.
 *
 * @param {vscode.Webview} webview Target webview.
 * @param {{uri: vscode.Uri}} document Document-like object for path resolution.
 * @param {string} svg Raw SVG text.
 * @param {string} baseDirectory Directory used for relative nested images.
 * @returns {{svg: string, localResourceRoots: vscode.Uri[]}}
 */
function rewriteSvgImageReferencesToWebviewUris(webview, document, svg, baseDirectory) {
  const replacements = [];
  const localResourceRootPaths = new Set();
  const hrefPattern = /\b((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const rawHref = match[3];
    const resolved = resolveSvgHrefToWebviewUri(webview, document, rawHref, baseDirectory);
    if (!resolved) {
      continue;
    }

    localResourceRootPaths.add(path.dirname(resolved.localPath));
    replacements.push({
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
      value: `${match[1]}=${match[2]}${resolved.webviewUri}${match[2]}`,
    });
  }

  return {
    svg: applyReplacements(svg, replacements),
    localResourceRoots: Array.from(localResourceRootPaths, (rootPath) => vscode.Uri.file(rootPath)),
  };
}

/**
 * Resolves one SVG href into a Webview URI while preserving query or hash.
 *
 * @param {vscode.Webview} webview Target webview.
 * @param {{uri: vscode.Uri}} document Document-like object for path resolution.
 * @param {string} rawHref Raw SVG href.
 * @param {string} baseDirectory Directory used for relative nested images.
 * @returns {{webviewUri: string, localPath: string} | undefined}
 */
function resolveSvgHrefToWebviewUri(webview, document, rawHref, baseDirectory) {
  if (!rawHref || rawHref.startsWith("#") || isDataUri(rawHref) || isRemoteUrl(rawHref)) {
    return undefined;
  }

  const suffix = getQueryAndHashSuffix(rawHref);
  const localPath = resolveLocalPath(document, rawHref, baseDirectory);
  if (!localPath) {
    return undefined;
  }

  return {
    webviewUri: `${webview.asWebviewUri(vscode.Uri.file(localPath)).toString()}${suffix}`,
    localPath,
  };
}

/**
 * Returns the query or hash suffix from an SVG href.
 *
 * @param {string} value Raw SVG href.
 * @returns {string}
 */
function getQueryAndHashSuffix(value) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? "" : value.slice(suffixIndex);
}

/**
 * Encodes text as Blob source data for the Webview script.
 *
 * The base64 value is only an HTML transport for the Blob payload; it is not a
 * data URI and is never used as the final img src.
 *
 * @param {string} value Text content to place in the Blob.
 * @param {string} mimeType Blob MIME type.
 * @returns {WebviewPreviewSource}
 */
function stringToBlobPreviewSource(value, mimeType) {
  return {
    kind: "blob",
    mimeType,
    base64: Buffer.from(value, "utf8").toString("base64"),
  };
}

/**
 * Converts rendered data URI output into Blob source data for the Webview.
 *
 * The data URI is only used as converter output. The Webview creates a Blob URL
 * from this payload so the final image source stays compact.
 *
 * @param {string} dataUri Rendered image data URI.
 * @returns {WebviewPreviewSource | undefined}
 */
function dataUriToBlobPreviewSource(dataUri) {
  const match = dataUri.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) {
    return undefined;
  }

  return {
    kind: "blob",
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
}

/**
 * Builds safe img attributes for URI and Blob preview sources.
 *
 * @param {WebviewPreviewSource} previewSource Rendered image source.
 * @returns {string}
 */
function previewSourceToImageAttributes(previewSource) {
  if (previewSource.kind === "uri") {
    return `src="${escapeAttribute(previewSource.src)}"`;
  }

  return [
    "src=\"\"",
    `data-blob-mime="${escapeAttribute(previewSource.mimeType)}"`,
    `data-blob-base64="${escapeAttribute(previewSource.base64)}"`,
  ].join(" ");
}

/**
 * Applies non-overlapping string replacements from right to left.
 *
 * @param {string} value Source string.
 * @param {{start: number, end: number, value: string}[]} replacements Replacements.
 * @returns {string}
 */
function applyReplacements(value, replacements) {
  let result = value;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

/**
 * Creates Webview options that allow direct SVG file loading from safe roots.
 *
 * @param {vscode.Uri} imageUri Image URI.
 * @param {vscode.Uri[]=} additionalRoots Additional local resource roots.
 * @returns {vscode.WebviewPanelOptions & vscode.WebviewOptions}
 */
function createWebviewOptions(imageUri, additionalRoots = []) {
  return {
    enableScripts: true,
    localResourceRoots: getLocalResourceRoots(imageUri, additionalRoots),
  };
}

/**
 * Returns local roots used by asWebviewUri for SVG preview files.
 *
 * @param {vscode.Uri} imageUri Image URI.
 * @param {vscode.Uri[]} additionalRoots Additional local resource roots.
 * @returns {vscode.Uri[]}
 */
function getLocalResourceRoots(imageUri, additionalRoots) {
  const rootsByPath = new Map();
  rootsByPath.set(path.dirname(imageUri.fsPath), vscode.Uri.file(path.dirname(imageUri.fsPath)));
  for (const folder of vscode.workspace.workspaceFolders || []) {
    rootsByPath.set(folder.uri.fsPath, folder.uri);
  }
  for (const root of additionalRoots) {
    rootsByPath.set(root.fsPath, root);
  }
  return Array.from(rootsByPath.values());
}

/**
 * Builds the complete WebviewPanel HTML document.
 *
 * @param {string} body Body HTML.
 * @param {string=} script Optional inline script.
 * @returns {string}
 */
function buildPanelHtml(body, script = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      box-sizing: border-box;
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      height: 100vh;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .heading {
      min-width: 0;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .subtitle,
    .muted,
    footer {
      color: var(--vscode-descriptionForeground);
    }
    .subtitle {
      margin-top: 2px;
      font-size: 0.9em;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      flex: 0 0 auto;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-radius: 3px;
      font: inherit;
      line-height: 1;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .toolbarIcon {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .zoomValue {
      min-width: 42px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      text-align: right;
    }
    main {
      height: calc(100vh - 118px);
      overflow: auto;
      border: 1px solid var(--vscode-panel-border, transparent);
      background: var(--vscode-editor-background);
    }
    .stage {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 100%;
      min-height: 100%;
      padding: 16px;
    }
    img {
      display: block;
      flex: 0 0 auto;
      max-width: none;
      max-height: none;
    }
    footer {
      margin-top: 12px;
      font-size: 0.85em;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>${body}${script}</body>
</html>`;
}

/**
 * Builds the image zoom script used by preview webviews.
 *
 * @returns {string}
 */
function getPreviewScript() {
  return `<script>
(() => {
  const viewport = document.querySelector("[data-preview-viewport]");
  const stage = document.querySelector("[data-preview-stage]");
  const image = document.querySelector("[data-preview-image]");
  const zoomValue = document.querySelector("[data-zoom-value]");
  if (!(image instanceof HTMLImageElement) || !viewport || !stage || !zoomValue) {
    return;
  }

  const minScale = 0.1;
  const maxScale = 8;
  const zoomStep = 1.2;
  let naturalWidth = 1;
  let naturalHeight = 1;
  let scale = 1;
  let fitMode = true;
  let blobUrl = "";
  let pendingFitFrame = 0;

  /** Converts base64 converter output into bytes for fallback metafile previews. */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  /** Creates a Blob URL for converted preview data. */
  function applyBlobSource() {
    const mimeType = image.getAttribute("data-blob-mime");
    const base64 = image.getAttribute("data-blob-base64");
    if (!mimeType || !base64) {
      return;
    }

    blobUrl = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: mimeType }));
    image.src = blobUrl;
    image.removeAttribute("data-blob-base64");
  }

  /** Clamps a number to the allowed zoom range. */
  function clampScale(value) {
    return Math.min(maxScale, Math.max(minScale, value));
  }

  /** Computes the scale that fits the image inside the visible viewport. */
  function getFitScale() {
    const availableWidth = Math.max(1, viewport.clientWidth - 32);
    const availableHeight = Math.max(1, viewport.clientHeight - 32);
    return clampScale(Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight));
  }

  /** Applies the current scale to the preview image and stage. */
  function render() {
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    image.style.width = width + "px";
    image.style.height = height + "px";

    stage.style.width = Math.max(viewport.clientWidth, width + 32) + "px";
    stage.style.height = Math.max(viewport.clientHeight, height + 32) + "px";
    zoomValue.textContent = Math.round(scale * 100) + "%";
  }

  /** Defers fit until the Webview has reported stable viewport dimensions. */
  function scheduleFit() {
    if (pendingFitFrame) {
      cancelAnimationFrame(pendingFitFrame);
    }
    pendingFitFrame = requestAnimationFrame(() => {
      pendingFitFrame = 0;
      setScale(getFitScale(), true);
    });
  }

  /** Sets an absolute zoom scale. */
  function setScale(value, nextFitMode) {
    scale = clampScale(value);
    fitMode = nextFitMode;
    render();
  }

  /** Changes the current zoom by a multiplicative factor. */
  function zoomBy(factor) {
    setScale(scale * factor, false);
  }

  /** Sets natural image dimensions after the image has loaded. */
  function refreshNaturalSize() {
    naturalWidth = image.naturalWidth || 1;
    naturalHeight = image.naturalHeight || 1;
    scheduleFit();
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom-action]");
    if (!button) {
      return;
    }
    const action = button.getAttribute("data-zoom-action");
    if (action === "in") {
      zoomBy(zoomStep);
    } else if (action === "out") {
      zoomBy(1 / zoomStep);
    } else if (action === "actual") {
      setScale(1, false);
    } else if (action === "fit") {
      scheduleFit();
    }
  });

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? zoomStep : 1 / zoomStep);
  }, { passive: false });

  window.addEventListener("resize", () => {
    if (fitMode) {
      scheduleFit();
    } else {
      render();
    }
  });
  window.addEventListener("unload", () => {
    if (pendingFitFrame) {
      cancelAnimationFrame(pendingFitFrame);
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  });

  applyBlobSource();
  if (image.complete) {
    refreshNaturalSize();
  } else {
    image.addEventListener("load", refreshNaturalSize, { once: true });
  }
})();
</script>`;
}

/**
 * Escapes text for HTML body content.
 *
 * @param {string} value Raw text.
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escapes text for HTML attributes.
 *
 * @param {string} value Raw text.
 * @returns {string}
 */
function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * Formats an unknown error for diagnostics.
 *
 * @param {unknown} error Error-like value.
 * @returns {string}
 */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  ImagePreviewSidePanel,
  buildPanelHtml,
  buildPreviewHtml,
  renderWebviewPreviewSource,
};

/**
 * @typedef {({kind: "uri", src: string} | {kind: "blob", mimeType: string, base64: string}) & {localResourceRoots?: vscode.Uri[]}} WebviewPreviewSource
 */
