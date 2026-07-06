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
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      "pandocManuscriptTools.imagePreview",
      `Preview ${path.basename(imageUri.fsPath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: false },
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
      const documentLike = { uri: imageUri };
      const dataUri = await this.imagePreviewRenderer.renderToDataUri(documentLike, imageUri.fsPath, extension);
      if (!dataUri) {
        panel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Pandoc Manuscript Tools output for details.</p>`);
        return;
      }
      panel.webview.html = buildPreviewHtml(imageUri.fsPath, extension, dataUri);
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
 * @param {string} dataUri Rendered image data URI.
 * @returns {string}
 */
function buildPreviewHtml(imagePath, extension, dataUri) {
  const label = path.basename(imagePath);
  return buildPanelHtml(`
    <header>
      <div class="title">${escapeHtml(label)}</div>
      <div class="subtitle">${escapeHtml(extension.toUpperCase().slice(1))}</div>
    </header>
    <main>
      <img src="${escapeAttribute(dataUri)}" alt="${escapeAttribute(label)}">
    </main>
    <footer>${escapeHtml(imagePath)}</footer>
  `);
}

/**
 * Builds the complete WebviewPanel HTML document.
 *
 * @param {string} body Body HTML.
 * @returns {string}
 */
function buildPanelHtml(body) {
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
    }
    header {
      margin-bottom: 12px;
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
    main {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: calc(100vh - 120px);
      border: 1px solid var(--vscode-panel-border, transparent);
      background: var(--vscode-editor-background);
    }
    img {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 140px);
      object-fit: contain;
    }
    footer {
      margin-top: 12px;
      font-size: 0.85em;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>${body}</body>
</html>`;
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
};
