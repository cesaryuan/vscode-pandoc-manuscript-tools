/*
 * Read-only custom editor for EMF/WMF files.
 *
 * VS Code's default text editor cannot display these binary metafiles, so this
 * provider makes opening an EMF/WMF file show the same rendered preview used by
 * hover and side-preview panels.
 */

import * as path from "path";
import * as vscode from "vscode";
import { buildPanelHtml, buildPreviewHtml, renderWebviewPreviewSource } from "./sidePreview";

const SUPPORTED_METAFILE_EXTENSIONS = new Set([".emf", ".wmf"]);

export class MetafilePreviewCustomEditorProvider {
  declare imagePreviewRenderer;
  declare output: import("vscode").OutputChannel;
  /**
   * Creates a read-only custom editor provider for EMF/WMF previews.
   *
   * @param imagePreviewRenderer Shared preview renderer.
   * @param output Output channel.
   */
  constructor(imagePreviewRenderer: import("./index").ImagePreviewRenderer, output: vscode.OutputChannel) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
  }

  /**
   * Opens the binary metafile as a lightweight custom document.
   *
   * @param uri Resource URI.
   */
  async openCustomDocument(uri: vscode.Uri) {
    return {
      uri,
      dispose() {},
    };
  }

  /**
   * Resolves the custom editor webview for one EMF/WMF document.
   *
   * @param document Custom document.
   * @param webviewPanel Preview webview panel.
   */
  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel) {
    const imagePath = document.uri.fsPath;
    const extension = path.extname(imagePath).toLowerCase();
    const label = path.basename(imagePath);

    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Rendering ${escapeHtml(label)}...</p>`);

    if (!SUPPORTED_METAFILE_EXTENSIONS.has(extension)) {
      webviewPanel.webview.html = buildPanelHtml("<p class=\"muted\">This custom editor only supports EMF and WMF files.</p>");
      return;
    }

    try {
      const previewSource = await renderWebviewPreviewSource(webviewPanel.webview, this.imagePreviewRenderer, document.uri, imagePath, extension);
      if (!previewSource) {
        webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Pandoc Manuscript Tools output for details.</p>`);
        return;
      }

      webviewPanel.webview.html = buildPreviewHtml(imagePath, extension, previewSource);
    } catch (error) {
      this.output.appendLine(`Metafile custom editor preview failed for ${imagePath}: ${formatError(error)}`);
      webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview failed for ${escapeHtml(label)}.</p>`);
    }
  }
}

/**
 * Escapes text for HTML body content.
 *
 * @param value Raw text.
 */
function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Formats an unknown error for diagnostics.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


