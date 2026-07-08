/*
 * Editor-side image preview panel.
 *
 * This implements the VS Code-style "open preview to the side" action for
 * SVG/EMF/WMF files. It creates a WebviewPanel beside the active editor and
 * renders through ImagePreviewRenderer while adding Webview-specific handling
 * for SVG href rewriting and EMF/WMF conversion.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WEBVIEW_METAFILE_MAX_HEIGHT } from "./libemf2svgRuntime";
import { resolveLocalPath, isDataUri, isRemoteUrl } from "./pathResolver";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);

type Replacement = { start: number; end: number; value: string };
type DocumentLike = { uri: vscode.Uri };

export type WebviewPreviewSource = (
  | { kind: "uri"; src: string }
  | { kind: "blob"; mimeType: string; base64: string }
  | { kind: "inlineSvg"; svg: string; width: number; height: number }
) & { localResourceRoots?: import("vscode").Uri[] };

type PreviewHtmlOptions = {
  toolbarActions?: string;
};

export class ImagePreviewSidePanel {
  declare imagePreviewRenderer: import("./index").ImagePreviewRenderer;
  declare output: import("vscode").OutputChannel;
  declare panels: Map<string, import("vscode").WebviewPanel>;
  /**
   * Creates a side-preview command handler.
   *
   * @param imagePreviewRenderer Shared preview renderer.
   * @param output Output channel.
   */
  constructor(imagePreviewRenderer: import("./index").ImagePreviewRenderer, output: vscode.OutputChannel) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
    this.panels = new Map();
  }

  /**
   * Opens or refreshes a side preview panel for an SVG/EMF/WMF file.
   *
   * @param uri Optional resource URI supplied by VS Code menus.
   */
  async open(uri: vscode.Uri | undefined) {
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
   * @param document Saved text document.
   */
  async refreshIfOpen(document: vscode.TextDocument) {
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
   * @param uri Optional command resource URI.
   */
  resolveImageUri(uri: vscode.Uri | undefined) {
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
   * @param imageUri Image file URI.
   */
  getOrCreatePanel(imageUri: vscode.Uri) {
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
   * @param panel Preview panel.
   * @param imageUri Image file URI.
   * @param extension Lowercase image extension.
   */
  async renderPanel(panel: vscode.WebviewPanel, imageUri: vscode.Uri, extension: string) {
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
      panel.webview.html = buildPreviewHtml(imageUri.fsPath, previewSource);
    } catch (error) {
      this.output.appendLine(`Image side preview failed for ${imageUri.fsPath}: ${formatError(error)}`);
      panel.webview.html = buildPanelHtml(`<p class="muted">Preview failed for ${escapeHtml(label)}.</p>`);
    }
  }
}

/**
 * Builds the full image-preview panel HTML.
 *
 * @param imagePath Absolute image path.
 * @param previewSource Rendered image source.
 * @param options Optional toolbar actions for custom editor workflows.
 */
export function buildPreviewHtml(imagePath: string, previewSource: WebviewPreviewSource, options: PreviewHtmlOptions = {}): string {
  const label = path.basename(imagePath);
  const previewMarkup = previewSourceToPreviewMarkup(previewSource, label);
  const toolbarActions = options.toolbarActions ? `${options.toolbarActions}${buildToolbarSeparator()}` : "";
  return buildPanelHtml(`
    <header>
      <div class="toolbar" role="toolbar">
        ${toolbarActions}
        ${buildToolbarButton("out", "Zoom out", buildZoomOutIcon())}
        ${buildToolbarButton("in", "Zoom in", buildZoomInIcon())}
        ${buildToolbarButton("actual", "Actual size", buildActualSizeIcon())}
        ${buildToolbarButton("fit", "Fit to window", buildFitIcon())}
        <span class="zoomValue" data-zoom-value>100%</span>
      </div>
    </header>
    <main class="viewport" data-preview-viewport>
      <div class="stage" data-preview-stage>
        ${previewMarkup}
      </div>
    </main>
  `, getPreviewScript());
}

/**
 * Builds a command button that matches the zoom toolbar style.
 *
 * @param command Webview command identifier.
 * @param label Accessible label and tooltip.
 * @param icon Inline SVG icon.
 */
export function buildPreviewActionButton(command: string, label: string, icon: string): string {
  return `<button type="button" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}" data-preview-command="${escapeAttribute(command)}">${icon}</button>`;
}

/**
 * Builds a thin separator between toolbar action groups.
 *
 */
function buildToolbarSeparator(): string {
  return "<span class=\"toolbarSeparator\" aria-hidden=\"true\"></span>";
}

/**
 * Builds one icon-only toolbar button.
 *
 * @param action Zoom action identifier.
 * @param label Accessible label and tooltip.
 * @param icon Inline SVG icon.
 */
function buildToolbarButton(action: string, label: string, icon: string) {
  return `<button type="button" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}" data-zoom-action="${escapeAttribute(action)}">${icon}</button>`;
}

/**
 * Builds a zoom-out icon.
 *
 */
function buildZoomOutIcon() {
  return buildIconSvg(`
    <circle cx="9.5" cy="9.5" r="5.25"></circle>
    <path d="M6.75 9.5h5.5"></path>
    <path d="m13.4 13.4 5.1 5.1"></path>
  `);
}

/**
 * Builds a zoom-in icon.
 *
 */
function buildZoomInIcon() {
  return buildIconSvg(`
    <circle cx="9.5" cy="9.5" r="5.25"></circle>
    <path d="M9.5 6.75v5.5"></path>
    <path d="M6.75 9.5h5.5"></path>
    <path d="m13.4 13.4 5.1 5.1"></path>
  `);
}

/**
 * Builds an actual-size icon.
 *
 */
function buildActualSizeIcon() {
  return buildIconSvg(`
    <path d="M5 5h14v14H5z"></path>
    <path d="M8.5 8.75v6.5"></path>
    <circle cx="12" cy="10.6" r="0.85" fill="currentColor" stroke="none"></circle>
    <circle cx="12" cy="13.4" r="0.85" fill="currentColor" stroke="none"></circle>
    <path d="M15.5 8.75v6.5"></path>
  `);
}

/**
 * Builds a fit-to-window icon.
 *
 */
function buildFitIcon() {
  return buildIconSvg(`
    <path d="M5 9V5h4"></path>
    <path d="M19 9V5h-4"></path>
    <path d="M5 15v4h4"></path>
    <path d="M19 15v4h-4"></path>
    <path d="m9 9-4-4"></path>
    <path d="m15 9 4-4"></path>
    <path d="m9 15-4 4"></path>
    <path d="m15 15 4 4"></path>
  `);
}

/**
 * Builds a source-text icon for the SVG preview fallback action.
 *
 */
export function buildSourceTextIcon() {
  return buildIconSvg(`
    <path d="M8 5h6.5l3.5 3.5V19H8z"></path>
    <path d="M14.5 5v3.5H18"></path>
    <path d="m5.5 10.5-2.75 2.5 2.75 2.5"></path>
    <path d="M3 13h3.5"></path>
  `);
}

/**
 * Wraps icon paths in a common SVG shell.
 *
 * @param body SVG child markup.
 */
function buildIconSvg(body: string) {
  return `<svg class="toolbarIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Creates the Webview-specific image source for preview panels.
 *
 * SVG files are rewritten before preview so nested local `<image href>` values
 * can be converted to Webview URIs. EMF/WMF converter output is decoded here so
 * SVG data URIs can be inserted as inline SVG instead of Blob-backed images.
 *
 * @param webview Target webview.
 * @param imagePreviewRenderer Shared preview renderer.
 * @param documentUri Document URI used for path resolution.
 * @param imagePath Absolute image path.
 * @param extension Lowercase image extension.
 */
export async function renderWebviewPreviewSource(webview: vscode.Webview, imagePreviewRenderer: import("./index").ImagePreviewRenderer, documentUri: vscode.Uri, imagePath: string, extension: string): Promise<WebviewPreviewSource | undefined> {
  if (extension === ".svg") {
    return renderSvgInlinePreviewSource(webview, documentUri, imagePath);
  }

  const documentLike = { uri: documentUri };
  const dataUri = await imagePreviewRenderer.renderToDataUri(documentLike, imagePath, extension, {
    metafile: { maxHeight: WEBVIEW_METAFILE_MAX_HEIGHT },
  });
  return dataUri ? dataUriToWebviewPreviewSource(dataUri) : undefined;
}

/**
 * Rewrites a local SVG file into inline SVG for Webview preview.
 *
 * This is needed because SVG loaded as `<img src="blob:...">` cannot reliably
 * load nested local images, even after the hrefs are rewritten to Webview URIs.
 *
 * @param webview Target webview.
 * @param documentUri SVG document URI.
 * @param imagePath Absolute SVG path.
 */
async function renderSvgInlinePreviewSource(webview: vscode.Webview, documentUri: vscode.Uri, imagePath: string): Promise<WebviewPreviewSource> {
  const svg = await fs.readFile(imagePath, "utf8");
  const documentLike = { uri: documentUri };
  const rewritten = rewriteSvgImageReferencesToWebviewUris(webview, documentLike, svg, path.dirname(imagePath));
  return {
    ...createInlineSvgPreviewSource(rewritten.svg),
    localResourceRoots: rewritten.localResourceRoots,
  };
}

/**
 * Replaces local SVG image hrefs with Webview-safe resource URIs.
 *
 * @param webview Target webview.
 * @param document Document-like object for path resolution.
 * @param svg Raw SVG text.
 * @param baseDirectory Directory used for relative nested images.
 */
function rewriteSvgImageReferencesToWebviewUris(webview: vscode.Webview, document: DocumentLike, svg: string, baseDirectory: string) {
  const replacements = [];
  const localResourceRootPaths = new Set<string>();
  const hrefPattern = /\b((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const rawHref = match[3];
    const decodedHref = decodeSvgHrefForLocalResolution(rawHref);
    const resolved = resolveSvgHrefToWebviewUri(webview, document, decodedHref, baseDirectory);
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
 * Decodes percent-encoded SVG href values before local file resolution.
 *
 * This guards the side-preview rewrite path against nested image filenames like
 * `my%20image.png`. Invalid percent-encoding is left untouched so malformed SVG
 * input does not introduce a new preview failure.
 *
 * @param rawHref Raw SVG href.
 */
function decodeSvgHrefForLocalResolution(rawHref: string) {
  try {
    return decodeURIComponent(rawHref);
  } catch (_error) {
    return rawHref;
  }
}

/**
 * Resolves one SVG href into a Webview URI while preserving query or hash.
 *
 * @param webview Target webview.
 * @param document Document-like object for path resolution.
 * @param rawHref Raw SVG href.
 * @param baseDirectory Directory used for relative nested images.
 */
function resolveSvgHrefToWebviewUri(webview: vscode.Webview, document: DocumentLike, rawHref: string, baseDirectory: string) {
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
 * @param value Raw SVG href.
 */
function getQueryAndHashSuffix(value: string) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? "" : value.slice(suffixIndex);
}

/**
 * Converts rendered data URI output into the best Webview preview source.
 *
 * SVG data URIs, including EMF and WMF converter output, are decoded and shown
 * inline. Raster data URI output remains on the Blob image path.
 *
 * @param dataUri Rendered image data URI.
 */
function dataUriToWebviewPreviewSource(dataUri: string): WebviewPreviewSource | undefined {
  const match = dataUri.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1].toLowerCase();
  if (mimeType === "image/svg+xml") {
    const svg = Buffer.from(match[2], "base64").toString("utf8");
    return createInlineSvgPreviewSource(svg);
  }

  return {
    kind: "blob",
    mimeType,
    base64: match[2],
  };
}

/**
 * Creates an inline SVG preview source from rendered SVG text.
 *
 * @param svg Raw SVG text.
 */
export function createInlineSvgPreviewSource(svg: string): WebviewPreviewSource {
  const dimensions = getSvgNaturalDimensions(svg);
  return {
    kind: "inlineSvg",
    svg: sanitizeInlineSvgForWebview(svg),
    width: dimensions.width,
    height: dimensions.height,
  };
}

/**
 * Builds the preview element for one rendered image source.
 *
 * @param previewSource Rendered image source.
 * @param label Accessible preview label.
 */
function previewSourceToPreviewMarkup(previewSource: WebviewPreviewSource, label: string) {
  if (previewSource.kind === "inlineSvg") {
    return [
      `<div data-preview-image data-preview-frame="true" data-preview-kind="inline-svg" class="svgPreview" role="img" aria-label="${escapeAttribute(label)}"`,
      ` data-natural-width="${escapeAttribute(String(previewSource.width))}"`,
      ` data-natural-height="${escapeAttribute(String(previewSource.height))}">`,
      previewSource.svg,
      "</div>",
    ].join("");
  }

  const imageAttributes = previewSourceToImageAttributes(previewSource);
  return `<img data-preview-image data-preview-frame="true" ${imageAttributes} alt="${escapeAttribute(label)}">`;
}

/**
 * Builds safe img attributes for URI and Blob preview sources.
 *
 * @param previewSource Rendered image source.
 */
function previewSourceToImageAttributes(previewSource: Extract<WebviewPreviewSource, {kind: "uri" | "blob"}>): string {
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
 * Removes active SVG content before injecting the SVG inline.
 *
 * This guard is needed because inline SVG lives in the Webview DOM; scripts or
 * event attributes that were inert through `<img>` would otherwise become DOM.
 *
 * @param svg Raw SVG text.
 */
function sanitizeInlineSvgForWebview(svg: string) {
  return svg
    .replace(/^\s*<\?xml\b[^?]*\?>/i, "")
    .replace(/^\s*<!doctype\b[^>]*>/i, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
}

/**
 * Reads natural SVG dimensions from width/height or viewBox.
 *
 * @param svg Raw SVG text.
 */
function getSvgNaturalDimensions(svg: string) {
  const openTag = svg.match(/<svg\b[^>]*>/i);
  if (!openTag) {
    return { width: 300, height: 150 };
  }

  const width = parseSvgLength(readAttribute(openTag[0], "width"));
  const height = parseSvgLength(readAttribute(openTag[0], "height"));
  if (width && height) {
    return { width, height };
  }

  const viewBox = readAttribute(openTag[0], "viewBox");
  const viewBoxParts = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number) : [];
  if (viewBoxParts.length === 4 && viewBoxParts.every(Number.isFinite) && viewBoxParts[2] > 0 && viewBoxParts[3] > 0) {
    return {
      width: viewBoxParts[2],
      height: viewBoxParts[3],
    };
  }

  return { width: width || 300, height: height || 150 };
}

/**
 * Reads one quoted XML attribute from a tag.
 *
 * @param tag XML start tag.
 * @param name Attribute name.
 */
function readAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : undefined;
}

/**
 * Parses simple SVG length values in px/user units.
 *
 * @param value Raw length value.
 */
function parseSvgLength(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Applies non-overlapping string replacements from right to left.
 *
 * @param value Source string.
 * @param replacements Replacements.
 */
function applyReplacements(value: string, replacements: Replacement[]): string {
  let result = value;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

/**
 * Creates Webview options that allow direct SVG file loading from safe roots.
 *
 * @param imageUri Image URI.
 * @param additionalRoots Additional local resource roots.
 */
function createWebviewOptions(imageUri: vscode.Uri, additionalRoots: vscode.Uri[] | undefined = []) {
  return {
    enableScripts: true,
    localResourceRoots: getLocalResourceRoots(imageUri, additionalRoots),
  };
}

/**
 * Returns local roots used by asWebviewUri for SVG preview files.
 *
 * @param imageUri Image URI.
 * @param additionalRoots Additional local resource roots.
 */
function getLocalResourceRoots(imageUri: vscode.Uri, additionalRoots: vscode.Uri[]) {
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
 * @param body Body HTML.
 * @param script Optional inline script.
 */
export function buildPanelHtml(body: string, script = ""): string {
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
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      margin-bottom: 12px;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      padding: 3px 5px;
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, transparent);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid transparent;
      color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
      background: transparent;
      border-radius: 4px;
      font: inherit;
      line-height: 1;
      cursor: pointer;
      transition: background-color 80ms linear, color 80ms linear, border-color 80ms linear;
    }
    button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
    }
    button:active {
      background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.22));
    }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .toolbarIcon {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .toolbarSeparator {
      width: 1px;
      height: 16px;
      margin: 0 2px;
      background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      opacity: 0.9;
    }
    .zoomValue {
      min-width: 40px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      text-align: left;
      padding-left: 8px;
      font-variant-numeric: tabular-nums;
    }
    main {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      background: var(--vscode-editor-background);
    }
    main.canPan {
      cursor: grab;
    }
    main.isPanning {
      cursor: grabbing;
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
    img,
    .svgPreview {
      display: block;
      flex: 0 0 auto;
      max-width: none;
      max-height: none;
      user-select: none;
    }
    img {
      -webkit-user-drag: none;
    }
    .svgPreview svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    [data-preview-frame="true"] {
      /* Checkerboard makes transparent SVG/EMF/WMF regions visible without changing the image data. */
      background-color: var(--vscode-editor-background);
      background-image:
        linear-gradient(45deg, rgba(127, 127, 127, 0.22) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(127, 127, 127, 0.22) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.22) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.22) 75%);
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      background-size: 16px 16px;
      box-shadow:
        0 16px 42px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.26)),
        0 4px 14px rgba(0, 0, 0, 0.18);
    }
  </style>
</head>
<body>${body}${script}</body>
</html>`;
}

/**
 * Builds the image zoom script used by preview webviews.
 *
 */
function getPreviewScript() {
  return `<script>
(() => {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const viewport = document.querySelector("[data-preview-viewport]");
  const stage = document.querySelector("[data-preview-stage]");
  const preview = document.querySelector("[data-preview-image]");
  const zoomValue = document.querySelector("[data-zoom-value]");
  if (!viewport || !stage || !preview || !zoomValue) {
    return;
  }

  // Large source images need a lower floor than VS Code's default-like 10%.
  const minScale = 0.01;
  const maxScale = 8;
  const zoomStep = 1.2;
  let naturalWidth = 1;
  let naturalHeight = 1;
  let scale = 1;
  let fitMode = false;
  let blobUrl = "";
  let pendingFitFrame = 0;
  let isPanning = false;
  let panPointerId = 0;
  let panStartX = 0;
  let panStartY = 0;
  let panStartScrollLeft = 0;
  let panStartScrollTop = 0;

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
    if (!(preview instanceof HTMLImageElement)) {
      return;
    }

    const mimeType = preview.getAttribute("data-blob-mime");
    const base64 = preview.getAttribute("data-blob-base64");
    if (!mimeType || !base64) {
      return;
    }

    blobUrl = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: mimeType }));
    preview.src = blobUrl;
    preview.removeAttribute("data-blob-base64");
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

  /** Returns whether the rendered image currently overflows the viewport. */
  function canPanViewport() {
    return viewport.scrollWidth > viewport.clientWidth + 1 || viewport.scrollHeight > viewport.clientHeight + 1;
  }

  /** Updates the pan cursor state after zoom or viewport size changes. */
  function updatePanState() {
    viewport.classList.toggle("canPan", canPanViewport());
  }

  /** Applies the current scale to the preview image and stage. */
  function render() {
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    preview.style.width = naturalWidth + "px";
    preview.style.height = naturalHeight + "px";
    // VS Code Webviews run on Chromium; zoom keeps layout, SVG filters, and
    // frame shadows scaling together instead of resizing only the viewport.
    preview.style.zoom = String(scale);

    stage.style.width = Math.max(viewport.clientWidth, width + 32) + "px";
    stage.style.height = Math.max(viewport.clientHeight, height + 32) + "px";
    zoomValue.textContent = Math.round(scale * 100) + "%";
    updatePanState();
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

  /** Defers the initial 1:1-or-fit choice until viewport dimensions are stable. */
  function scheduleInitialScale() {
    if (pendingFitFrame) {
      cancelAnimationFrame(pendingFitFrame);
    }
    pendingFitFrame = requestAnimationFrame(() => {
      const fitScale = getFitScale();
      pendingFitFrame = 0;
      setScale(fitScale < 1 ? fitScale : 1, fitScale < 1);
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

  /** Starts drag-to-pan when the preview is larger than the visible viewport. */
  function startPan(event) {
    if (event.button !== 0 || !canPanViewport()) {
      return;
    }

    event.preventDefault();
    isPanning = true;
    panPointerId = event.pointerId;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panStartScrollLeft = viewport.scrollLeft;
    panStartScrollTop = viewport.scrollTop;
    viewport.classList.add("isPanning");
    viewport.setPointerCapture(event.pointerId);
  }

  /** Moves the scroll viewport while the pointer is dragging the preview. */
  function movePan(event) {
    if (!isPanning || event.pointerId !== panPointerId) {
      return;
    }

    event.preventDefault();
    viewport.scrollLeft = panStartScrollLeft - (event.clientX - panStartX);
    viewport.scrollTop = panStartScrollTop - (event.clientY - panStartY);
  }

  /** Ends drag-to-pan and restores the normal cursor state. */
  function endPan(event) {
    if (!isPanning || event.pointerId !== panPointerId) {
      return;
    }

    isPanning = false;
    viewport.classList.remove("isPanning");
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }

  /** Sets natural image dimensions after the image has loaded. */
  function refreshNaturalSize() {
    if (preview instanceof HTMLImageElement) {
      naturalWidth = preview.naturalWidth || 1;
      naturalHeight = preview.naturalHeight || 1;
    } else {
      naturalWidth = Number(preview.getAttribute("data-natural-width")) || 1;
      naturalHeight = Number(preview.getAttribute("data-natural-height")) || 1;
    }
    scheduleInitialScale();
  }

  document.addEventListener("click", (event) => {
    const commandButton = event.target.closest("[data-preview-command]");
    if (commandButton) {
      if (vscode) {
        vscode.postMessage({ command: commandButton.getAttribute("data-preview-command") });
      }
      return;
    }

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
  viewport.addEventListener("pointerdown", startPan);
  viewport.addEventListener("pointermove", movePan);
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  preview.addEventListener("dragstart", (event) => event.preventDefault());

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
  if (!(preview instanceof HTMLImageElement)) {
    refreshNaturalSize();
  } else if (preview.complete) {
    refreshNaturalSize();
  } else {
    preview.addEventListener("load", refreshNaturalSize, { once: true });
  }
})();
</script>`;
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
 * Escapes text for HTML attributes.
 *
 * @param value Raw text.
 */
function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * Formats an unknown error for diagnostics.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
