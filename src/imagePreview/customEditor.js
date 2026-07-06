"use strict";

/*
 * Read-only custom editor for EMF/WMF files.
 *
 * VS Code's default text editor cannot display these binary metafiles, so this
 * provider makes opening an EMF/WMF file show the same rendered preview used by
 * hover and side-preview panels.
 */

const path = require("path");
const vscode = require("vscode");
const { buildPanelHtml, buildPreviewHtml } = require("./sidePreview");

const SUPPORTED_METAFILE_EXTENSIONS = new Set([".emf", ".wmf"]);

class MetafilePreviewCustomEditorProvider {
  /**
   * Creates a read-only custom editor provider for EMF/WMF previews.
   *
   * @param {import("./index").ImagePreviewRenderer} imagePreviewRenderer Shared preview renderer.
   * @param {{appendLine(message: string): void}} output Output channel.
   */
  constructor(imagePreviewRenderer, output) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
  }

  /**
   * Opens the binary metafile as a lightweight custom document.
   *
   * @param {vscode.Uri} uri Resource URI.
   * @returns {vscode.CustomDocument}
   */
  async openCustomDocument(uri) {
    return {
      uri,
      dispose() {},
    };
  }

  /**
   * Resolves the custom editor webview for one EMF/WMF document.
   *
   * @param {vscode.CustomDocument} document Custom document.
   * @param {vscode.WebviewPanel} webviewPanel Preview webview panel.
   */
  async resolveCustomEditor(document, webviewPanel) {
    const imagePath = document.uri.fsPath;
    const extension = path.extname(imagePath).toLowerCase();
    const label = path.basename(imagePath);

    webviewPanel.webview.options = {
      enableScripts: false,
    };
    webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Rendering ${escapeHtml(label)}...</p>`);

    if (!SUPPORTED_METAFILE_EXTENSIONS.has(extension)) {
      webviewPanel.webview.html = buildPanelHtml("<p class=\"muted\">This custom editor only supports EMF and WMF files.</p>");
      return;
    }

    try {
      const documentLike = { uri: document.uri };
      const dataUri = await this.imagePreviewRenderer.renderToDataUri(documentLike, imagePath, extension);
      if (!dataUri) {
        webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Pandoc Manuscript Tools output for details.</p>`);
        return;
      }

      webviewPanel.webview.html = buildPreviewHtml(imagePath, extension, dataUri);
    } catch (error) {
      this.output.appendLine(`Metafile custom editor preview failed for ${imagePath}: ${formatError(error)}`);
      webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview failed for ${escapeHtml(label)}.</p>`);
    }
  }
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
 * Formats an unknown error for diagnostics.
 *
 * @param {unknown} error Error-like value.
 * @returns {string}
 */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  MetafilePreviewCustomEditorProvider,
};
