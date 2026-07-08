/*
 * Read-only custom editor for SVG/EMF/WMF files.
 *
 * EMF/WMF use this editor by default, while SVG is exposed as an optional
 * "Reopen With" preview so source text remains the default SVG editor.
 */

import * as path from "path";
import * as vscode from "vscode";
import { buildPanelHtml, buildPreviewHtml, renderWebviewPreviewSource } from "./sidePreview";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);

export class MetafilePreviewCustomEditorProvider {
  declare imagePreviewRenderer;
  declare output: import("vscode").OutputChannel;
  /**
   * Creates a read-only custom editor provider for SVG/EMF/WMF previews.
   *
   * @param imagePreviewRenderer Shared preview renderer.
   * @param output Output channel.
   */
  constructor(imagePreviewRenderer: import("./index").ImagePreviewRenderer, output: vscode.OutputChannel) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
  }

  /**
   * Opens the image as a lightweight custom document.
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
   * Resolves the custom editor webview for one SVG/EMF/WMF document.
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

    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      webviewPanel.webview.html = buildPanelHtml("<p class=\"muted\">This custom editor only supports SVG, EMF, and WMF files.</p>");
      return;
    }

    try {
      const previewSource = await renderWebviewPreviewSource(webviewPanel.webview, this.imagePreviewRenderer, document.uri, imagePath, extension);
      if (!previewSource) {
        webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Pandoc Manuscript Tools output for details.</p>`);
        return;
      }

      webviewPanel.webview.html = buildPreviewHtml(imagePath, previewSource);
    } catch (error) {
      this.output.appendLine(`Image custom editor preview failed for ${imagePath}: ${formatError(error)}`);
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
