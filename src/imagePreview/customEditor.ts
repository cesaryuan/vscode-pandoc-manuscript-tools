/*
 * Read-only custom editor for SVG/EMF/WMF files.
 *
 * EMF/WMF use this editor by default, while SVG is exposed as an optional
 * "Reopen With" preview so source text remains the default SVG editor.
 */

import * as path from "path";
import * as vscode from "vscode";
import { OPEN_SVG_SOURCE_TEXT_COMMAND } from "../constants";
import { VisiblePreviewFileWatcher } from "./fileRefreshWatcher";
import { convertEmfToSvg, convertWmfToSvg, WEBVIEW_METAFILE_MAX_HEIGHT, WEBVIEW_METAFILE_MAX_WIDTH } from "./libemf2svgRuntime";
import { buildPanelHtml, buildDiffHighlightIcon, buildPreviewActionButton, buildPreviewHtml, buildSourceTextIcon, buildSynchronizedZoomIcon, createInlineSvgPreviewSource, renderWebviewPreviewSource, type WebviewPreviewSource } from "./sidePreview";
import { buildSvgDiffHighlightScript, TOGGLE_SVG_DIFF_HIGHLIGHT_COMMAND } from "./svgDiffHighlight";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);
const TOGGLE_SVG_ZOOM_SYNC_COMMAND = "pandocManuscriptTools.toggleSvgZoomSync";

type SvgDiffPair = { original: vscode.Uri; modified: vscode.Uri };
type SvgViewState = { scale: number; scrollX: number; scrollY: number };

export class MetafilePreviewCustomEditorProvider implements vscode.Disposable {
  declare imagePreviewRenderer;
  declare output: import("vscode").OutputChannel;
  private readonly diffPairs = new Map<string, SvgDiffPair>();
  private readonly svgPanels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly svgDiffPanels = new Map<vscode.WebviewPanel, SvgDiffPair>();
  private pendingDiffPreview: SvgDiffPair | undefined;
  private readonly highlightedPairs = new Set<string>();
  private readonly synchronizedZoomPairs = new Map<string, SvgViewState>();
  private readonly tabListener: vscode.Disposable;
  /**
   * Creates a read-only custom editor provider for SVG/EMF/WMF previews.
   *
   * @param imagePreviewRenderer Shared preview renderer.
   * @param output Output channel.
   */
  constructor(imagePreviewRenderer: import("./index").ImagePreviewRenderer, output: vscode.OutputChannel) {
    this.imagePreviewRenderer = imagePreviewRenderer;
    this.output = output;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        this.rememberDiffTab(tab);
      }
    }
    this.tabListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of [...event.opened, ...event.changed]) {
        this.rememberDiffTab(tab);
      }
    });
  }

  /** Releases the diff tab listener when the extension deactivates. */
  dispose(): void {
    this.tabListener.dispose();
    this.svgPanels.clear();
    this.svgDiffPanels.clear();
    this.diffPairs.clear();
    this.highlightedPairs.clear();
    this.synchronizedZoomPairs.clear();
  }

  /** Remembers the exact two URIs before VS Code reopens a text diff as previews. */
  rememberDiffTab(tab: vscode.Tab | undefined): void {
    if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
      return;
    }
    const pair = { original: tab.input.original, modified: tab.input.modified };
    if (path.extname(pair.modified.path).toLowerCase() !== ".svg") {
      return;
    }
    this.diffPairs.set(pair.original.toString(), pair);
    this.diffPairs.set(pair.modified.toString(), pair);
  }

  /** Tracks a diff while the preview command reopens its two revisions. */
  beginSvgDiffPreview(tab: vscode.Tab | undefined): void {
    this.rememberDiffTab(tab);
    this.pendingDiffPreview = tab?.input instanceof vscode.TabInputTextDiff
      ? this.diffPairs.get(tab.input.modified.toString()) : undefined;
  }

  /** Stops attributing newly opened standalone tabs to the preceding diff. */
  endSvgDiffPreview(): void {
    this.pendingDiffPreview = undefined;
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

    if (extension === ".svg") {
      const key = document.uri.toString();
      const panels = this.svgPanels.get(key) || new Set<vscode.WebviewPanel>();
      panels.add(webviewPanel);
      this.svgPanels.set(key, panels);
      const pair = this.findSvgDiffPair(document.uri);
      const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const activeDiff = activeInput instanceof vscode.TabInputTextDiff
        && pair && activeInput.original.toString() === pair.original.toString()
        && activeInput.modified.toString() === pair.modified.toString();
      if (pair && (activeDiff || this.pendingDiffPreview && svgDiffPairKey(this.pendingDiffPreview) === svgDiffPairKey(pair))) {
        this.svgDiffPanels.set(webviewPanel, pair);
      }
      if (pair) {
        this.linkSvgDiffPanels(pair);
      }
    }

    const messageListener = webviewPanel.webview.onDidReceiveMessage(async (message: { command?: string; type?: string; scale?: number; scrollX?: number; scrollY?: number }) => {
      if (message.command === OPEN_SVG_SOURCE_TEXT_COMMAND) {
        await vscode.commands.executeCommand(OPEN_SVG_SOURCE_TEXT_COMMAND, document.uri);
      } else if (message.command === TOGGLE_SVG_DIFF_HIGHLIGHT_COMMAND && this.svgDiffPanels.has(webviewPanel)) {
        await this.toggleSvgDiffHighlight(document.uri);
      } else if (message.command === TOGGLE_SVG_ZOOM_SYNC_COMMAND && this.svgDiffPanels.has(webviewPanel)) {
        await this.toggleSvgZoomSync(document.uri, message.scale, message.scrollX, message.scrollY);
      } else if (message.type === "svgZoomChanged" && this.svgDiffPanels.has(webviewPanel)) {
        await this.relaySvgZoom(document.uri, webviewPanel, message.scale, message.scrollX, message.scrollY);
      } else if (message.type === "svgScrollChanged" && this.svgDiffPanels.has(webviewPanel)) {
        await this.relaySvgScroll(document.uri, webviewPanel, message.scrollX, message.scrollY);
      } else if (message.type === "svgZoomReady" && this.svgDiffPanels.has(webviewPanel)) {
        await this.restoreSvgZoomSync(document.uri, webviewPanel);
      } else if (message.type === "svgDiffToolbarReady" && extension === ".svg") {
        await webviewPanel.webview.postMessage({ type: "svgDiffToolbar", visible: this.svgDiffPanels.has(webviewPanel) });
      }
    });
    const watcher = new VisiblePreviewFileWatcher(
      webviewPanel,
      document.uri,
      () => this.renderCustomEditorPanel(webviewPanel, document, imagePath, extension, label),
      this.output,
    );
    webviewPanel.onDidDispose(() => {
      messageListener.dispose();
      watcher.dispose();
      const diffPair = this.svgDiffPanels.get(webviewPanel);
      this.svgDiffPanels.delete(webviewPanel);
      const panels = this.svgPanels.get(document.uri.toString());
      panels?.delete(webviewPanel);
      if (panels?.size === 0) {
        this.svgPanels.delete(document.uri.toString());
      }
      if (diffPair && ![...this.svgDiffPanels.values()].some((linked) => svgDiffPairKey(linked) === svgDiffPairKey(diffPair))) {
        this.synchronizedZoomPairs.delete(svgDiffPairKey(diffPair));
        this.highlightedPairs.delete(svgDiffPairKey(diffPair));
      }
    });

    await this.renderCustomEditorPanel(webviewPanel, document, imagePath, extension, label);
  }

  /**
   * Renders the current custom editor content into its WebviewPanel.
   *
   * This method is shared by the initial load and visible-only auto-refresh so
   * external edits use the same SVG/EMF/WMF rendering path as a newly opened tab.
   *
   * @param webviewPanel Preview webview panel.
   * @param document Custom editor document.
   * @param imagePath Display path or local file path.
   * @param extension Lowercase image extension.
   * @param label File name shown in status text.
   */
  private async renderCustomEditorPanel(webviewPanel: vscode.WebviewPanel, document: vscode.CustomDocument, imagePath: string, extension: string, label: string) {
    if (extension === ".svg" && this.svgDiffPanels.has(webviewPanel)) {
      this.clearSvgDiffHighlight(document.uri);
    }
    webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Rendering ${escapeHtml(label)}...</p>`);

    try {
      const previewSource = await renderCustomEditorPreviewSource(webviewPanel.webview, this.imagePreviewRenderer, document.uri, imagePath, extension, this.output);
      if (!previewSource) {
        webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview could not render ${escapeHtml(label)}. See the Papper Tools output for details.</p>`);
        return;
      }
      if (previewSource.localResourceRoots) {
        webviewPanel.webview.options = {
          enableScripts: true,
          localResourceRoots: previewSource.localResourceRoots,
        };
      }

      webviewPanel.webview.html = buildPreviewHtml(imagePath, previewSource, {
        toolbarActions: extension === ".svg"
          ? buildPreviewActionButton(OPEN_SVG_SOURCE_TEXT_COMMAND, "Source Text", buildSourceTextIcon())
          : "",
        diffToolbarActions: extension === ".svg"
          ? buildPreviewActionButton(TOGGLE_SVG_DIFF_HIGHLIGHT_COMMAND, "Highlight changed areas", buildDiffHighlightIcon())
            + buildPreviewActionButton(TOGGLE_SVG_ZOOM_SYNC_COMMAND, "Synchronize zoom and scroll", buildSynchronizedZoomIcon())
          : "",
        showDiffToolbarActions: this.svgDiffPanels.has(webviewPanel),
        additionalScript: extension === ".svg" ? buildSvgDiffHighlightScript() : "",
        synchronizedView: this.svgDiffPanels.has(webviewPanel) ? this.getSynchronizedView(document.uri) : undefined,
      });
    } catch (error) {
      this.output.appendLine(`Image custom editor preview failed for ${imagePath}: ${formatError(error)}`);
      webviewPanel.webview.html = buildPanelHtml(`<p class="muted">Preview failed for ${escapeHtml(label)}.</p>`);
    }
  }

  /** Finds the current SVG diff pair using the public text-diff tab input. */
  private findSvgDiffPair(uri: vscode.Uri): SvgDiffPair | undefined {
    this.rememberDiffTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    const known = this.diffPairs.get(uri.toString());
    if (known) {
      return known;
    }

    // Direct "Reopen With" can bypass our command. Pair one file URI with one
    // virtual revision of that file only when there is exactly one candidate.
    const resourcePath = process.platform === "win32" ? path.normalize(uri.fsPath).toLowerCase() : path.normalize(uri.fsPath);
    const peers = [...this.svgPanels.keys()].filter((key) => {
      if (key === uri.toString()) {
        return false;
      }
      const peer = vscode.Uri.parse(key);
      if ((peer.scheme === "file") === (uri.scheme === "file")) {
        return false;
      }
      const peerPath = path.normalize(peer.fsPath);
      return (process.platform === "win32" ? peerPath.toLowerCase() : peerPath) === resourcePath;
    });
    return peers.length === 1 ? { original: vscode.Uri.parse(peers[0]), modified: uri } : undefined;
  }

  /** Reveals diff controls after both unique revision panels are available. */
  private linkSvgDiffPanels(pair: SvgDiffPair): void {
    const originals = [...this.svgPanels.get(pair.original.toString()) || []];
    const modified = [...this.svgPanels.get(pair.modified.toString()) || []];
    if (originals.length !== 1 || modified.length !== 1 || originals[0] === modified[0]) {
      return;
    }
    for (const [panel, uri] of [[originals[0], pair.original], [modified[0], pair.modified]] as const) {
      if (this.svgDiffPanels.has(panel)) {
        continue;
      }
      this.svgDiffPanels.set(panel, pair);
      void panel.webview.postMessage({ type: "svgDiffToolbar", visible: true });
      void this.restoreSvgZoomSync(uri, panel);
    }
  }

  /** Toggles comparison boxes on both sides of one SVG diff preview. */
  private async toggleSvgDiffHighlight(uri: vscode.Uri): Promise<void> {
    const pair = this.findSvgDiffPair(uri);
    if (!pair) {
      await vscode.window.showInformationMessage("Open this SVG in a diff editor to highlight changed areas.");
      return;
    }
    const pairKey = [pair.original.toString(), pair.modified.toString()].sort().join("\n");
    const enabled = !this.highlightedPairs.has(pairKey);
    if (enabled) {
      try {
        const [originalBytes, modifiedBytes] = await Promise.all([
          vscode.workspace.fs.readFile(pair.original),
          vscode.workspace.fs.readFile(pair.modified),
        ]);
        // A newly added/deleted SVG can have an empty diff side. Use an empty
        // SVG root so the visible side can still be marked as one addition.
        const originalSvg = Buffer.from(originalBytes).toString("utf8") || "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        const modifiedSvg = Buffer.from(modifiedBytes).toString("utf8") || "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        this.highlightedPairs.add(pairKey);
        await Promise.all([
          this.postSvgDiffHighlight(pair.original, originalSvg, modifiedSvg, true),
          this.postSvgDiffHighlight(pair.modified, modifiedSvg, originalSvg, true),
        ]);
      } catch (error) {
        this.output.appendLine(`SVG diff highlight failed: ${formatError(error)}`);
        await vscode.window.showWarningMessage("Could not read both SVG revisions for highlighting. See Papper Tools output.");
      }
      return;
    }
    this.highlightedPairs.delete(pairKey);
    await Promise.all([
      this.postSvgDiffHighlight(pair.original, "", "", false),
      this.postSvgDiffHighlight(pair.modified, "", "", false),
    ]);
  }

  /** Returns the current shared scale when this SVG belongs to a linked diff. */
  private getSynchronizedView(uri: vscode.Uri): SvgViewState | undefined {
    const pair = this.findSvgDiffPair(uri);
    return pair ? this.synchronizedZoomPairs.get(svgDiffPairKey(pair)) : undefined;
  }

  /** Enables or disables shared zoom and scroll for both panes of one SVG diff. */
  private async toggleSvgZoomSync(uri: vscode.Uri, scale: number | undefined, scrollX: number | undefined, scrollY: number | undefined): Promise<void> {
    const pair = this.findSvgDiffPair(uri);
    if (!pair) {
      await vscode.window.showInformationMessage("Open this SVG in a diff editor to synchronize zoom.");
      return;
    }
    const key = svgDiffPairKey(pair);
    const enabled = !this.synchronizedZoomPairs.has(key);
    let view: SvgViewState | undefined;
    if (enabled) {
      view = normalizeSvgView(scale, scrollX, scrollY);
      if (!view) {
        return;
      }
      this.synchronizedZoomPairs.set(key, view);
    } else {
      this.synchronizedZoomPairs.delete(key);
    }
    await this.postSvgZoomSync(pair, enabled, view);
  }

  /** Relays a local zoom and position change without feeding it back. */
  private async relaySvgZoom(uri: vscode.Uri, origin: vscode.WebviewPanel, scale: number | undefined, scrollX: number | undefined, scrollY: number | undefined): Promise<void> {
    const view = normalizeSvgView(scale, scrollX, scrollY);
    if (!view) {
      return;
    }
    const pair = this.findSvgDiffPair(uri);
    if (!pair || !this.synchronizedZoomPairs.has(svgDiffPairKey(pair))) {
      return;
    }
    this.synchronizedZoomPairs.set(svgDiffPairKey(pair), view);
    await this.postSvgZoomSync(pair, true, view, origin);
  }

  /** Relays a user scroll on either axis while retaining the shared scale. */
  private async relaySvgScroll(uri: vscode.Uri, origin: vscode.WebviewPanel, scrollX: number | undefined, scrollY: number | undefined): Promise<void> {
    if (typeof scrollX !== "number" || !Number.isFinite(scrollX)
      || typeof scrollY !== "number" || !Number.isFinite(scrollY)) {
      return;
    }
    const pair = this.findSvgDiffPair(uri);
    const key = pair && svgDiffPairKey(pair);
    const current = key && this.synchronizedZoomPairs.get(key);
    if (!pair || !key || !current) {
      return;
    }
    const view = { ...current, scrollX: Math.min(1, Math.max(0, scrollX)), scrollY: Math.min(1, Math.max(0, scrollY)) };
    this.synchronizedZoomPairs.set(key, view);
    await this.postSvgScrollSync(pair, view, origin);
  }

  /** Restores the shared scale after a late pane load or preview refresh. */
  private async restoreSvgZoomSync(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    const view = this.getSynchronizedView(uri);
    if (view) {
      await panel.webview.postMessage({ type: "svgZoomSync", enabled: true, ...view });
    }
  }

  /** Updates both revision previews and any duplicate pane for the same URI. */
  private async postSvgZoomSync(pair: SvgDiffPair, enabled: boolean, view: SvgViewState | undefined, origin?: vscode.WebviewPanel): Promise<void> {
    const panels = [
      ...this.svgPanels.get(pair.original.toString()) || [],
      ...this.svgPanels.get(pair.modified.toString()) || [],
    ];
    await Promise.all(panels.filter((panel) => panel !== origin && this.svgDiffPanels.has(panel)).map((panel) =>
      panel.webview.postMessage({ type: "svgZoomSync", enabled, ...view })));
  }

  /** Sends one user scroll to every other preview of this diff pair. */
  private async postSvgScrollSync(pair: SvgDiffPair, view: SvgViewState, origin: vscode.WebviewPanel): Promise<void> {
    const panels = [
      ...this.svgPanels.get(pair.original.toString()) || [],
      ...this.svgPanels.get(pair.modified.toString()) || [],
    ];
    await Promise.all(panels.filter((panel) => panel !== origin && this.svgDiffPanels.has(panel)).map((panel) =>
      panel.webview.postMessage({ type: "svgScrollSync", scrollX: view.scrollX, scrollY: view.scrollY })));
  }

  /** Sends current and counterpart SVG source to every preview of one revision. */
  private async postSvgDiffHighlight(uri: vscode.Uri, currentSvg: string, otherSvg: string, enabled: boolean): Promise<void> {
    await Promise.all([...this.svgPanels.get(uri.toString()) || []].filter((panel) => this.svgDiffPanels.has(panel)).map((panel) =>
      panel.webview.postMessage({ type: "svgDiffHighlight", enabled, currentSvg, otherSvg })));
  }

  /** Clears both overlays before a file refresh replaces either preview DOM. */
  private clearSvgDiffHighlight(uri: vscode.Uri): void {
    const pair = this.findSvgDiffPair(uri);
    if (!pair) {
      return;
    }
    const pairKey = [pair.original.toString(), pair.modified.toString()].sort().join("\n");
    if (!this.highlightedPairs.delete(pairKey)) {
      return;
    }
    void this.postSvgDiffHighlight(pair.original, "", "", false);
    void this.postSvgDiffHighlight(pair.modified, "", "", false);
  }
}

/** Identifies one ordered SVG revision pair regardless of which pane sent a message. */
function svgDiffPairKey(pair: SvgDiffPair): string {
  return [pair.original.toString(), pair.modified.toString()].sort().join("\n");
}

/** Accepts finite zoom and scroll values from a preview webview. */
function normalizeSvgView(scale: number | undefined, scrollX: number | undefined, scrollY: number | undefined): SvgViewState | undefined {
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0
    || typeof scrollX !== "number" || !Number.isFinite(scrollX)
    || typeof scrollY !== "number" || !Number.isFinite(scrollY)) {
    return undefined;
  }
  return {
    scale: Math.min(100, Math.max(0.01, scale)),
    scrollX: Math.min(1, Math.max(0, scrollX)),
    scrollY: Math.min(1, Math.max(0, scrollY)),
  };
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
    const conversionOptions = {
      maxWidth: WEBVIEW_METAFILE_MAX_WIDTH,
      maxHeight: WEBVIEW_METAFILE_MAX_HEIGHT,
    };
    const svg = extension === ".emf"
      ? await convertEmfToSvg(bytes, output, conversionOptions)
      : await convertWmfToSvg(bytes, output, conversionOptions);
    return svg ? createInlineSvgPreviewSource(svg) : undefined;
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
