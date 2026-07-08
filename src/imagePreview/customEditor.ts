/*
 * Read-only custom editor for SVG/EMF/WMF files.
 *
 * EMF/WMF use this editor by default, while SVG is exposed as an optional
 * "Reopen With" preview so source text remains the default SVG editor.
 */

import * as path from "path";
import * as vscode from "vscode";
import { convertEmfToSvg, convertWmfToSvg } from "./libemf2svgRuntime";
import { buildPanelHtml, buildPreviewHtml, createInlineSvgPreviewSource, renderWebviewPreviewSource, type WebviewPreviewSource } from "./sidePreview";

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
      const previewSource = await renderCustomEditorPreviewSource(webviewPanel.webview, this.imagePreviewRenderer, document.uri, imagePath, extension, this.output);
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
 * Renders a custom-editor image from the exact URI VS Code opened.
 *
 * Diff editors pass virtual URIs for the original side. Reading through
 * `workspace.fs` keeps EMF/WMF previews tied to the correct revision instead
 * of falling back to the working-tree `fsPath`.
 *
 * @param webview Target webview.
 * @param imagePreviewRenderer Shared preview renderer for normal file previews.
 * @param uri Image resource URI.
 * @param imagePath Display path or local file path.
 * @param extension Lowercase image extension.
 * @param output Output channel.
 */
async function renderCustomEditorPreviewSource(
  webview: vscode.Webview,
  imagePreviewRenderer: import("./index").ImagePreviewRenderer,
  uri: vscode.Uri,
  imagePath: string,
  extension: string,
  output: vscode.OutputChannel,
): Promise<WebviewPreviewSource | undefined> {
  if (extension === ".emf" || extension === ".wmf") {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const svg = extension === ".emf"
      ? await convertEmfToSvg(bytes, output)
      : await convertWmfToSvg(bytes, output);
    return svg ? createInlineSvgPreviewSource(svg) : undefined;
  }

  if (extension === ".svg" && uri.scheme !== "file") {
    const svg = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    return createInlineSvgPreviewSource(svg);
  }

  return renderWebviewPreviewSource(webview, imagePreviewRenderer, uri, imagePath, extension);
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
