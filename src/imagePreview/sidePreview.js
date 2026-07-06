"use strict";

/*
 * Editor-side image preview panel.
 *
 * This implements the VS Code-style "open preview to the side" action for
 * SVG/EMF/WMF files. It creates a WebviewPanel beside the active editor and
 * renders through ImagePreviewRenderer so side previews share the same SVG href
 * inlining and EMF/WMF conversion behavior as hover previews.
 */

const path = require("path");
const vscode = require("vscode");

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
        <button type="button" title="Zoom out" aria-label="Zoom out" data-zoom-action="out">−</button>
        <button type="button" title="Zoom in" aria-label="Zoom in" data-zoom-action="in">+</button>
        <button type="button" title="Actual size" aria-label="Actual size" data-zoom-action="actual">1:1</button>
        <button type="button" title="Fit" aria-label="Fit" data-zoom-action="fit">□</button>
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
 * Creates the Webview-specific image source for preview panels.
 *
 * SVG files can be loaded directly through asWebviewUri. EMF/WMF are converted
 * first, then passed to the Webview script as Blob URL input to avoid using a
 * long data URI as the final image src.
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
    return {
      kind: "uri",
      src: webview.asWebviewUri(vscode.Uri.file(imagePath)).toString(),
    };
  }

  const documentLike = { uri: documentUri };
  const dataUri = await imagePreviewRenderer.renderToDataUri(documentLike, imagePath, extension);
  return dataUri ? dataUriToBlobPreviewSource(dataUri) : undefined;
}

/**
 * Converts a data URI into Blob URL source data for the Webview script.
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
    mimeType: match[1],
    base64: match[2],
  };
}

/**
 * Builds safe img attributes for a preview source.
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
 * Creates Webview options that allow direct SVG file loading from safe roots.
 *
 * @param {vscode.Uri} imageUri Image URI.
 * @returns {vscode.WebviewPanelOptions & vscode.WebviewOptions}
 */
function createWebviewOptions(imageUri) {
  return {
    enableScripts: true,
    localResourceRoots: getLocalResourceRoots(imageUri),
  };
}

/**
 * Returns local roots used by asWebviewUri for SVG preview files.
 *
 * @param {vscode.Uri} imageUri Image URI.
 * @returns {vscode.Uri[]}
 */
function getLocalResourceRoots(imageUri) {
  const roots = [vscode.Uri.file(path.dirname(imageUri.fsPath))];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    roots.push(folder.uri);
  }
  return roots;
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
      gap: 4px;
      flex: 0 0 auto;
    }
    button {
      width: 26px;
      height: 24px;
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
  if (!viewport || !stage || !image || !zoomValue) {
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

  /** Creates a Blob URL for converted EMF/WMF preview data. */
  function applyBlobSource() {
    const mimeType = image.getAttribute("data-blob-mime");
    const base64 = image.getAttribute("data-blob-base64");
    if (!mimeType || !base64) {
      return;
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
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
    return clampScale(Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight, 1));
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
    setScale(getFitScale(), true);
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
      setScale(getFitScale(), true);
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
      setScale(getFitScale(), true);
    } else {
      render();
    }
  });
  window.addEventListener("unload", () => {
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
 * @typedef {{kind: "uri", src: string} | {kind: "blob", mimeType: string, base64: string}} WebviewPreviewSource
 */
