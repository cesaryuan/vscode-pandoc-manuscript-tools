/*
 * Directory image-preview Webview.
 *
 * This module owns the Explorer "View Images" command. It scans a selected
 * directory breadth-first through VS Code's workspace filesystem, advancing
 * only after the Webview requests another batch. The Webview keeps stable
 * lightweight card skeletons for discovered metadata, but only loads image
 * bitmaps near the viewport.
 */

import * as path from "path";
import * as vscode from "vscode";
import { IMAGE_DIRECTORY_PREVIEW_VIEW_TYPE } from "../constants";
import { normalizeFolderKeywords, shouldIncludeDirectoryImages, shouldTraverseDirectory, type DirectoryPreviewFolderFilters } from "./folderFilters";
import { isDirectoryPreviewImageFile } from "./imageTypes";
import { initializeDirectoryPreviewWebview } from "./webviewInitialization";
import { buildDirectoryPreviewWebviewSecurityMarkup } from "./webviewSecurity";
import { normalizePreviewRelativePath } from "./relativePath";
const MAX_IMAGES_PER_BATCH = 72;
const MAX_ENTRIES_PER_BATCH = 1_000;
const MAX_DIRECTORY_READS_PER_BATCH = 6;

type DirectoryEntry = readonly [string, vscode.FileType];
type DirectoryWork = {
  uri: vscode.Uri;
  relativePath: string;
  entries?: readonly DirectoryEntry[];
  nextEntryIndex: number;
};
type DirectoryImage = {
  name: string;
  folder: string;
  resourceUri: string;
  src: string;
};
type ScanBatch = {
  images: DirectoryImage[];
  hasMore: boolean;
  skippedDirectories: number;
};
type PreviewEntry = {
  panel: vscode.WebviewPanel;
  session: DirectoryPreviewSession;
};
type WebviewMessage = {
  type?: string;
  resourceUri?: string;
  includedFolderKeywords?: unknown;
  excludedFolderKeywords?: unknown;
};

/** Manages one reusable directory-preview panel for each selected directory. */
export class ImageDirectoryPreview {
  private readonly extensionUri: vscode.Uri;
  private readonly output: vscode.OutputChannel;
  private readonly panels = new Map<string, PreviewEntry>();

  /**
   * Creates the Explorer directory-preview command handler.
   *
   * @param extensionUri Extension installation root that contains the bundled Webview script.
   * @param output Output channel for scan diagnostics.
   */
  constructor(extensionUri: vscode.Uri, output: vscode.OutputChannel) {
    this.extensionUri = extensionUri;
    this.output = output;
  }

  /**
   * Opens a directory preview or reveals its existing tab.
   *
   * @param uri Explorer folder URI supplied by VS Code.
   */
  async open(uri: vscode.Uri | undefined): Promise<void> {
    // Explorer contributes the selected URI, while the command palette can use the workspace root.
    const directoryUri = uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!directoryUri) {
      await vscode.window.showWarningMessage("Select a folder in the Explorer or open a workspace before viewing images.");
      return;
    }
    this.output.appendLine(`Opening Image Directory Preview build 0.5.0 for ${directoryUri.toString()}`);

    try {
      const stat = await vscode.workspace.fs.stat(directoryUri);
      if (!isDirectory(stat.type)) {
        await vscode.window.showWarningMessage("View Images only supports folders.");
        return;
      }
    } catch (error) {
      this.output.appendLine(`Image directory preview could not inspect ${directoryUri.toString()}: ${formatError(error)}`);
      await vscode.window.showWarningMessage("The selected folder could not be opened.");
      return;
    }

    const key = directoryUri.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      IMAGE_DIRECTORY_PREVIEW_VIEW_TYPE,
      `Images: ${getUriBaseName(directoryUri)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [directoryUri, this.extensionUri],
      },
    );
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "image-directory-preview.js"));
    const session = new DirectoryPreviewSession(panel, directoryUri, scriptUri, this.output);
    const entry = { panel, session };
    this.panels.set(key, entry);
    panel.onDidDispose(() => {
      session.dispose();
      this.panels.delete(key);
    });
    session.start();
  }

  /** Disposes all active directory-preview panels. */
  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.session.dispose();
      entry.panel.dispose();
    }
    this.panels.clear();
  }
}

/** Coordinates one panel's Webview messages and demand-driven directory scan. */
class DirectoryPreviewSession {
  private readonly panel: vscode.WebviewPanel;
  private readonly rootUri: vscode.Uri;
  private readonly scriptUri: vscode.Uri;
  private readonly output: vscode.OutputChannel;
  private filters: DirectoryPreviewFolderFilters;
  private scanner: IncrementalImageScanner;
  private readonly disposables: vscode.Disposable[] = [];
  private messageChain: Promise<void> = Promise.resolve();
  private receivedReady = false;
  private disposed = false;

  /**
   * Creates one preview session for a selected folder.
   *
   * @param panel Target WebviewPanel.
   * @param rootUri Directory chosen in the Explorer.
   * @param scriptUri CSP-approved URI of the bundled browser controller.
   * @param output Output channel for recoverable scan errors.
   */
  constructor(panel: vscode.WebviewPanel, rootUri: vscode.Uri, scriptUri: vscode.Uri, output: vscode.OutputChannel) {
    this.panel = panel;
    this.rootUri = rootUri;
    this.scriptUri = scriptUri;
    this.output = output;
    this.filters = readDirectoryPreviewFolderFilters(rootUri);
    this.scanner = new IncrementalImageScanner(rootUri, panel.webview, output, this.filters);
  }

  /** Initializes the Webview and begins listening for demand-driven requests. */
  start(): void {
    this.output.appendLine(`Starting Image Directory Preview build 0.5.0 Webview for ${this.rootUri.toString()}`);
    this.disposables.push(initializeDirectoryPreviewWebview(this.panel.webview, buildDirectoryPreviewHtml(this.panel.webview, this.rootUri, this.scriptUri), (message: WebviewMessage) => {
      this.output.appendLine(`Image directory preview received ${message.type || "an unknown"} message for ${this.rootUri.toString()}`);
      // Messages are serialized so refresh cannot interleave two scanner batches.
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(message))
        .catch((error) => {
          this.output.appendLine(`Image directory preview message failed for ${this.rootUri.toString()}: ${formatError(error)}`);
        });
    }));
    // Webview startup is asynchronous. This diagnostic distinguishes a browser-side startup failure from a slow filesystem scan.
    const readyTimeout = setTimeout(() => {
      if (!this.disposed && !this.receivedReady) {
        this.output.appendLine(`Image directory preview Webview did not send ready for ${this.rootUri.toString()}`);
      }
    }, 2_000);
    this.disposables.push({ dispose: () => clearTimeout(readyTimeout) });
  }

  /** Releases the panel's message listener and invalidates queued scanner work. */
  dispose(): void {
    this.disposed = true;
    this.scanner.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /** Routes a Webview request to scanning, reloading, or opening an image. */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed || !message.type) {
      return;
    }

    if (message.type === "ready") {
      // The first scan is host-driven only after Webview JavaScript confirms it can receive the result.
      this.receivedReady = true;
      await this.postFolderFilters();
      await this.sendNextBatch();
      return;
    }
    if (message.type === "nextPage") {
      await this.sendNextBatch();
      return;
    }
    if (message.type === "rescan") {
      await this.resetScanner();
      return;
    }
    if (message.type === "openImage" && message.resourceUri) {
      await this.openImage(message.resourceUri);
      return;
    }
    if (message.type === "requestImageMetadata" && message.resourceUri) {
      await this.sendImageMetadata(message.resourceUri);
      return;
    }
    if (message.type === "updateFolderFilters") {
      await this.updateFolderFilters(message.includedFolderKeywords, message.excludedFolderKeywords);
      return;
    }
    if (message.type === "copyRelativePath" && message.resourceUri) {
      await this.copyRelativePath(message.resourceUri);
      return;
    }
    if (message.type === "deleteImage" && message.resourceUri) {
      await this.deleteImage(message.resourceUri);
    }
  }

  /** Scans and posts exactly one bounded image batch to the Webview. */
  private async sendNextBatch(): Promise<void> {
    this.output.appendLine(`Image directory preview is scanning the next batch for ${this.rootUri.toString()}`);
    const batch = await this.scanner.nextBatch();
    if (this.disposed) {
      return;
    }
    const delivered = await this.panel.webview.postMessage({
      type: "scanBatch",
      items: batch.images,
      hasMore: batch.hasMore,
      skippedDirectories: batch.skippedDirectories,
    });
    this.output.appendLine(`Image directory preview found ${batch.images.length} image(s); Webview delivery ${delivered ? "succeeded" : "was deferred"}`);
  }

  /** Replaces current scan state and begins again using the active folder filters. */
  private async resetScanner(): Promise<void> {
    this.scanner.dispose();
    this.scanner = new IncrementalImageScanner(this.rootUri, this.panel.webview, this.output, this.filters);
    await this.panel.webview.postMessage({ type: "reset" });
    await this.postFolderFilters();
    await this.sendNextBatch();
  }

  /** Sends the effective folder settings back to the Webview after startup or an update. */
  private async postFolderFilters(): Promise<void> {
    await this.panel.webview.postMessage({
      type: "folderFilters",
      includedFolderKeywords: [...this.filters.includedFolderKeywords],
      excludedFolderKeywords: [...this.filters.excludedFolderKeywords],
    });
  }

  /** Saves validated folder-keyword settings and starts a fresh incremental scan. */
  private async updateFolderFilters(includedKeywords: unknown, excludedKeywords: unknown): Promise<void> {
    this.filters = {
      includedFolderKeywords: normalizeFolderKeywords(includedKeywords),
      excludedFolderKeywords: normalizeFolderKeywords(excludedKeywords),
    };
    try {
      await writeDirectoryPreviewFolderFilters(this.rootUri, this.filters);
    } catch (error) {
      this.output.appendLine(`Image directory preview could not save folder filters for ${this.rootUri.toString()}: ${formatError(error)}`);
      await this.panel.webview.postMessage({ type: "notice", text: "Filters apply to this preview, but could not be saved." });
    }
    await this.resetScanner();
  }

  /** Opens a clicked image only when it is a supported descendant of the selected root. */
  private async openImage(resourceUri: string): Promise<void> {
    const imageUri = this.getAllowedImageUri(resourceUri);
    if (!imageUri) {
      return;
    }
    await vscode.commands.executeCommand("vscode.open", imageUri, { preview: true });
  }

  /** Reads one hovered image's filesystem metadata without adding per-file work to directory scanning. */
  private async sendImageMetadata(resourceUri: string): Promise<void> {
    const imageUri = this.getAllowedImageUri(resourceUri);
    if (!imageUri) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(imageUri);
      if (!isFile(stat.type) || isSymbolicLink(stat.type)) {
        return;
      }
      await this.panel.webview.postMessage({
        type: "imageMetadata",
        resourceUri,
        createdAt: stat.ctime,
        modifiedAt: stat.mtime,
        size: stat.size,
      });
    } catch (error) {
      // Return an empty result so the hover UI stops waiting when an image disappears or a provider omits metadata.
      this.output.appendLine(`Image directory preview could not read hover metadata for ${imageUri.toString()}: ${formatError(error)}`);
      await this.panel.webview.postMessage({ type: "imageMetadata", resourceUri });
    }
  }

  /** Copies a selected image's root-relative path through VS Code's desktop clipboard API. */
  private async copyRelativePath(resourceUri: string): Promise<void> {
    const imageUri = this.getAllowedImageUri(resourceUri);
    if (!imageUri) {
      return;
    }
    const relativePath = getRootRelativePath(this.rootUri, imageUri);
    if (!relativePath) {
      return;
    }
    try {
      await vscode.env.clipboard.writeText(relativePath);
      await this.panel.webview.postMessage({ type: "notice", text: `Copied ${relativePath}` });
    } catch (error) {
      this.output.appendLine(`Image directory preview could not copy ${imageUri.toString()}: ${formatError(error)}`);
      await vscode.window.showErrorMessage("Could not copy the image path.");
    }
  }

  /** Confirms then moves one selected, root-contained image file to the operating-system trash. */
  private async deleteImage(resourceUri: string): Promise<void> {
    const imageUri = this.getAllowedImageUri(resourceUri);
    if (!imageUri) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(imageUri);
      if (!isFile(stat.type) || isSymbolicLink(stat.type)) {
        return;
      }
    } catch (error) {
      this.output.appendLine(`Image directory preview could not inspect deletion target ${imageUri.toString()}: ${formatError(error)}`);
      return;
    }

    const fileName = getUriBaseName(imageUri);
    const confirmation = await vscode.window.showWarningMessage(
      `Move "${fileName}" to the Recycle Bin?`,
      { modal: true },
      "Move to Recycle Bin",
    );
    if (confirmation !== "Move to Recycle Bin") {
      return;
    }

    try {
      await vscode.workspace.fs.delete(imageUri, { recursive: false, useTrash: true });
      this.output.appendLine(`Image directory preview moved ${imageUri.toString()} to the Recycle Bin`);
      await this.panel.webview.postMessage({ type: "imageDeleted", resourceUri: imageUri.toString() });
    } catch (error) {
      this.output.appendLine(`Image directory preview could not delete ${imageUri.toString()}: ${formatError(error)}`);
      await vscode.window.showErrorMessage(`Could not delete ${fileName}.`);
    }
  }

  /** Parses a Webview resource URI and verifies it is a supported image below this preview root. */
  private getAllowedImageUri(resourceUri: string): vscode.Uri | undefined {
    try {
      const imageUri = vscode.Uri.parse(resourceUri);
      return isSupportedImageUri(imageUri) && isDescendantUri(this.rootUri, imageUri) ? imageUri : undefined;
    } catch (_error) {
      return undefined;
    }
  }
}

/** Incrementally discovers image files without traversing the complete tree on initial load. */
class IncrementalImageScanner {
  private readonly rootUri: vscode.Uri;
  private readonly webview: vscode.Webview;
  private readonly output: vscode.OutputChannel;
  private readonly filters: DirectoryPreviewFolderFilters;
  private readonly pendingDirectories: DirectoryWork[];
  private skippedDirectories = 0;
  private disposed = false;

  /**
   * Starts a breadth-first scan queue at the selected directory.
   *
   * @param rootUri Directory to scan recursively.
   * @param webview Webview used to create safe image resource URLs.
   * @param output Output channel for folders that cannot be read.
   * @param filters Include and exclude settings for directory branches and images.
   */
  constructor(rootUri: vscode.Uri, webview: vscode.Webview, output: vscode.OutputChannel, filters: DirectoryPreviewFolderFilters) {
    this.rootUri = rootUri;
    this.webview = webview;
    this.output = output;
    this.filters = filters;
    this.pendingDirectories = [{ uri: rootUri, relativePath: "", nextEntryIndex: 0 }];
  }

  /** Stops future batches; an already-running filesystem read is ignored when it resolves. */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Reads a bounded number of entries and returns only a small image batch.
   *
   * VS Code's workspace filesystem exposes direct-directory listings rather
   * than a streaming iterator. This cursor still limits recursive traversal and
   * limits Webview messages even if one direct directory has many files.
   */
  async nextBatch(): Promise<ScanBatch> {
    const images: DirectoryImage[] = [];
    let inspectedEntries = 0;
    let directoryReads = 0;

    while (
      !this.disposed
      && this.pendingDirectories.length > 0
      && images.length < MAX_IMAGES_PER_BATCH
      && inspectedEntries < MAX_ENTRIES_PER_BATCH
      && directoryReads < MAX_DIRECTORY_READS_PER_BATCH
    ) {
      const work = this.pendingDirectories[0];
      if (!work.entries) {
        const entries = await this.readDirectory(work.uri);
        if (this.disposed) {
          break;
        }
        directoryReads += 1;
        if (!entries) {
          this.pendingDirectories.shift();
          continue;
        }
        work.entries = entries;
      }

      while (
        !this.disposed
        && work.entries
        && work.nextEntryIndex < work.entries.length
        && images.length < MAX_IMAGES_PER_BATCH
        && inspectedEntries < MAX_ENTRIES_PER_BATCH
      ) {
        const [name, fileType] = work.entries[work.nextEntryIndex];
        work.nextEntryIndex += 1;
        inspectedEntries += 1;
        const childUri = vscode.Uri.joinPath(work.uri, name);

        if (isDirectory(fileType)) {
          // Do not follow folder symlinks: they can create cycles or leave the requested tree.
          const relativePath = joinRelativePath(work.relativePath, name);
          if (!isSymbolicLink(fileType) && shouldTraverseDirectory(relativePath, this.filters)) {
            this.pendingDirectories.push({
              uri: childUri,
              relativePath,
              nextEntryIndex: 0,
            });
          }
          continue;
        }
        // Image symlinks can point outside the selected tree, so skip them too.
        if (isFile(fileType) && !isSymbolicLink(fileType) && isSupportedImageUri(childUri) && shouldIncludeDirectoryImages(work.relativePath, this.filters)) {
          images.push({
            name,
            folder: work.relativePath,
            resourceUri: childUri.toString(),
            src: this.webview.asWebviewUri(childUri).toString(),
          });
        }
      }

      if (work.entries && work.nextEntryIndex >= work.entries.length) {
        this.pendingDirectories.shift();
      }
    }

    return {
      images,
      hasMore: !this.disposed && this.pendingDirectories.length > 0,
      skippedDirectories: this.skippedDirectories,
    };
  }

  /** Reads and alphabetizes one direct directory, recovering from inaccessible folders. */
  private async readDirectory(uri: vscode.Uri): Promise<readonly DirectoryEntry[] | undefined> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return [...entries].sort(([leftName], [rightName]) => leftName.localeCompare(rightName, undefined, { numeric: true }));
    } catch (error) {
      this.skippedDirectories += 1;
      this.output.appendLine(`Image directory preview could not read ${uri.toString()}: ${formatError(error)}`);
      return undefined;
    }
  }
}

/** Builds the complete HTML document for the directory-preview Webview. */
function buildDirectoryPreviewHtml(webview: vscode.Webview, rootUri: vscode.Uri, scriptUri: vscode.Uri): string {
  const rootLabel = getUriDisplayPath(rootUri);
  const securityMarkup = buildDirectoryPreviewWebviewSecurityMarkup(webview.cspSource, scriptUri.toString());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Images: ${escapeHtml(getUriBaseName(rootUri))}</title>
  ${securityMarkup}
  <style>
    :root { --thumbnail-size: 180px; --card-gap: 14px; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); overflow: hidden; }
    .page { display: flex; height: 100%; min-width: 0; flex-direction: column; }
    .toolbar { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 8px 14px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); background: var(--vscode-editor-background); }
    .root { min-width: 0; flex: 1 1 auto; overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
    .control { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
    select, input, button { font: inherit; }
    select { max-width: 142px; color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 3px; background: var(--vscode-dropdown-background); padding: 3px 5px; }
    input[type="range"] { width: 110px; accent-color: var(--vscode-focusBorder); }
    button { color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 3px; background: var(--vscode-button-secondaryBackground); cursor: pointer; padding: 4px 8px; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .icon-button { display: inline-grid; width: 28px; height: 28px; place-items: center; padding: 0; font-size: 1.1em; line-height: 1; }
    #status { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: .9em; white-space: nowrap; }
    /* Lazy image measurements can change masonry heights; explicit anchoring handles that change predictably. */
    #scroll { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; overflow-anchor: none; }
    #top-spacer, #bottom-spacer { display: none; }
    #gallery { padding: 16px; }
    #gallery.layout-grid, .folder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(var(--thumbnail-size), 100%), 1fr)); gap: var(--card-gap); }
    #gallery.layout-masonry { display: flex; align-items: flex-start; gap: var(--card-gap); }
    #gallery.layout-masonry .masonry-column { display: flex; min-width: 0; flex: 1 1 0; flex-direction: column; gap: var(--card-gap); }
    #gallery.layout-masonry .image-card { display: flex; width: 100%; margin: 0; }
    .folder-group + .folder-group { margin-top: 28px; }
    .folder-heading { margin: 0 0 10px; color: var(--vscode-descriptionForeground); font-size: 1.1em; font-weight: 600; overflow-wrap: anywhere; }
    .folder-toggle { width: 100%; color: inherit; background: transparent; text-align: left; padding: 2px 0; }
    .folder-toggle::before { content: "▾"; display: inline-block; width: 1.1em; }
    .folder-toggle:hover { color: var(--vscode-foreground); background: transparent; }
    .folder-group.is-collapsed .folder-toggle::before { content: "▸"; }
    .folder-group.is-collapsed .folder-grid { display: none; }
    /* Strong card separation keeps dense previews scannable in both light and dark VS Code themes. */
    .image-card { position: relative; display: flex; min-width: 0; flex-direction: column; overflow: hidden; color: inherit; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-input-border, rgba(127,127,127,.6))); border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.05)); box-shadow: 0 1px 3px rgba(0,0,0,.22), inset 0 0 0 1px rgba(127,127,127,.08); cursor: pointer; text-align: left; padding: 0; }
    .image-card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 3px 8px rgba(0,0,0,.26); }
    .image-card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    /* In stretched Grid and Folder rows, keep captions fixed and give surplus height to this centered bitmap container. */
    .thumbnail { display: grid; width: 100%; min-height: 0; flex: 1 1 auto; aspect-ratio: var(--image-aspect-ratio, 1); place-items: center; overflow: hidden; background-color: var(--vscode-editor-background); background-image: linear-gradient(45deg, rgba(127,127,127,.16) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.16) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.16) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.16) 75%); background-position: 0 0,0 8px,8px -8px,-8px 0; background-size: 16px 16px; }
    .thumbnail img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .thumbnail img:not([src]) { visibility: hidden; }
    /* Masonry keeps a bounded measured height, unlike Grid and Folder natural-ratio cards. */
    #gallery.layout-masonry .thumbnail { height: var(--masonry-thumbnail-height, calc(var(--thumbnail-size) * .75)); min-height: 0; max-height: none; flex: 0 0 auto; aspect-ratio: auto; }
    #gallery.layout-masonry .thumbnail img { height: 100%; max-height: none; object-fit: contain; }
    .image-card.is-failed .thumbnail::after { content: "Preview unavailable"; padding: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    .image-card.is-failed img { display: none; }
    .caption { flex: 0 0 auto; overflow: hidden; padding: 7px 9px; color: var(--vscode-foreground); border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, rgba(127,127,127,.35))); font-size: .9em; text-overflow: ellipsis; white-space: nowrap; }
    .hover-details { position: absolute; z-index: 2; right: 6px; bottom: 6px; left: 6px; display: none; gap: 3px; max-width: calc(100% - 12px); padding: 7px 8px; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border)); border-radius: 4px; background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); box-shadow: 0 2px 8px rgba(0,0,0,.28); font-size: .82em; line-height: 1.25; }
    .image-card:hover .hover-details, .image-card:focus-visible .hover-details { display: grid; }
    .hover-detail { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px; text-align: left; }
    .hover-detail-label { color: var(--vscode-descriptionForeground); }
    .hover-detail-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 48px 24px; color: var(--vscode-descriptionForeground); text-align: center; }
    dialog { width: min(560px, calc(100vw - 32px)); border: 1px solid var(--vscode-widget-border); border-radius: 6px; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); box-shadow: 0 12px 40px var(--vscode-widget-shadow); padding: 0; }
    dialog::backdrop { background: rgba(0, 0, 0, .35); }
    .settings-content { display: grid; gap: 14px; padding: 18px; }
    .settings-content h2 { margin: 0; font-size: 1.1em; }
    .settings-content p { margin: -6px 0 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
    .settings-field { display: grid; gap: 6px; color: var(--vscode-foreground); font-weight: 600; }
    .settings-field textarea { width: 100%; min-height: 78px; resize: vertical; color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; background: var(--vscode-input-background); font: inherit; padding: 6px 8px; }
    .settings-field small { color: var(--vscode-descriptionForeground); font-weight: 400; }
    .settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    #image-context-menu { position: fixed; z-index: 20; min-width: 178px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: 4px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); box-shadow: 0 4px 14px var(--vscode-widget-shadow); padding: 4px; }
    #image-context-menu button { display: block; width: 100%; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; padding: 6px 9px; }
    #image-context-menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    #image-context-menu .danger { color: var(--vscode-errorForeground); }
    #notice { position: fixed; z-index: 25; right: 18px; bottom: 18px; max-width: min(420px, calc(100vw - 36px)); color: var(--vscode-notifications-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border)); border-radius: 4px; background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); box-shadow: 0 4px 14px var(--vscode-widget-shadow); padding: 8px 11px; }
    @media (max-width: 720px) { .toolbar { flex-wrap: wrap; gap: 8px; } .root { flex-basis: 100%; order: 2; } #status { margin-left: auto; } }
  </style>
</head>
<body>
  <div class="page">
    <header class="toolbar">
      <span class="root" title="${escapeAttribute(rootLabel)}">${escapeHtml(rootLabel)}</span>
      <label class="control" for="layout">Layout <select id="layout" aria-label="Layout"><option value="grid">Grid</option><option value="masonry">Masonry</option><option value="folders">By folder</option></select></label>
      <label class="control" for="column-count">Cols <input id="column-count" type="range" min="1" max="12" step="1" value="4" aria-label="Number of columns"><output id="column-value">4</output></label>
      <button id="collapse-folders" type="button" hidden>Collapse folders</button>
      <button id="expand-folders" type="button" hidden>Expand folders</button>
      <button id="continue-scan" type="button" hidden>Continue scan</button>
      <button id="rescan" type="button" title="Start a new incremental scan">Refresh</button>
      <button id="settings" class="icon-button" type="button" title="Directory preview settings" aria-label="Directory preview settings">⚙</button>
      <span id="status" role="status">Starting directory preview (build 0.5.0)…</span>
    </header>
    <main id="scroll" aria-label="Directory images">
      <div id="top-spacer"></div>
      <section id="gallery" class="layout-grid" aria-live="polite"></section>
      <div id="bottom-spacer"></div>
    </main>
  </div>
  <dialog id="directory-settings" aria-labelledby="settings-title">
    <form class="settings-content" method="dialog">
      <h2 id="settings-title">Directory preview settings</h2>
      <p>Keywords match root-relative folder paths case-insensitively. Excluded folders always take priority.</p>
      <label class="settings-field" for="included-folder-keywords">Allowed folder keywords
        <textarea id="included-folder-keywords" spellcheck="false" placeholder="figures&#10;supplement"></textarea>
        <small>One per line or comma-separated. Leave empty to include all folders not excluded.</small>
      </label>
      <label class="settings-field" for="excluded-folder-keywords">Excluded folder keywords
        <textarea id="excluded-folder-keywords" spellcheck="false" placeholder="node_modules&#10;archive"></textarea>
        <small>Matching folders and their children are not scanned.</small>
      </label>
      <div class="settings-actions">
        <button id="close-settings" type="button">Cancel</button>
        <button id="apply-settings" type="button">Apply and rescan</button>
      </div>
    </form>
  </dialog>
  <div id="image-context-menu" role="menu" hidden>
    <button id="copy-relative-path" type="button" role="menuitem">Copy relative path</button>
    <button id="delete-image" class="danger" type="button" role="menuitem">Move to Recycle Bin…</button>
  </div>
  <div id="notice" role="status" hidden></div>
  <!-- Kept as non-executing raw text while the external controller owns startup. -->
  <script type="application/x-directory-preview-legacy">
  (() => {
    const status = document.getElementById("status");
    status.textContent = "Connecting to directory scanner…";
    const vscode = acquireVsCodeApi();
    const WINDOW_BEFORE = 72;
    const WINDOW_AFTER = 96;
    const PREFETCH_DISTANCE = 44;
    const scroll = document.getElementById("scroll");
    const gallery = document.getElementById("gallery");
    const topSpacer = document.getElementById("top-spacer");
    const bottomSpacer = document.getElementById("bottom-spacer");
    const layoutControl = document.getElementById("layout");
    const sizeControl = document.getElementById("thumbnail-size");
    const sizeValue = document.getElementById("thumbnail-value");
    const continueScan = document.getElementById("continue-scan");
    const rescan = document.getElementById("rescan");
    const saved = vscode.getState() || {};
    const state = { items: [], hasMore: true, loading: false, skippedDirectories: 0, automaticScanRequests: 0, userHasScrolled: false, layout: saved.layout || "grid", thumbnailSize: Number(saved.thumbnailSize) || 180, renderedStart: -1, renderedEnd: -1, renderFrame: 0 };

    /** Persists only UI preferences; image metadata stays in the extension-host scan session. */
    function persistPreferences() {
      vscode.setState({ layout: state.layout, thumbnailSize: state.thumbnailSize });
    }

    /** Applies a layout and thumbnail-size change without requesting or loading every image. */
    function applyPreferences() {
      document.documentElement.style.setProperty("--thumbnail-size", state.thumbnailSize + "px");
      layoutControl.value = state.layout;
      sizeControl.value = String(state.thumbnailSize);
      sizeValue.textContent = state.thumbnailSize + " px";
      persistPreferences();
    }

    /** Returns a conservative visible column count for the scroll-height estimate. */
    function getColumnCount() {
      const available = Math.max(1, scroll.clientWidth - 32);
      const gap = 12;
      return Math.max(1, Math.floor((available + gap) / (state.thumbnailSize + gap)));
    }

    /** Estimates the height occupied by an image prefix so prior cards can be unmounted. */
    function estimateHeightForItems(count) {
      const columns = getColumnCount();
      const cardHeight = state.thumbnailSize + 43;
      if (state.layout === "masonry") {
        return Math.ceil(count / columns) * (state.thumbnailSize * 1.34 + 43);
      }
      if (state.layout === "folders") {
        return Math.ceil(count / columns) * cardHeight + Math.ceil(count / 36) * 29;
      }
      return Math.ceil(count / columns) * cardHeight;
    }

    /** Maps a scroll position to an approximate item index for the bounded render window. */
    function getApproximateIndex() {
      const totalEstimate = Math.max(1, estimateHeightForItems(state.items.length));
      return Math.max(0, Math.min(state.items.length - 1, Math.floor((scroll.scrollTop / totalEstimate) * state.items.length)));
    }

    /** Creates one thumbnail card; this is the only point that assigns an image src. */
    function createCard(item) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "image-card";
      card.title = item.folder ? item.folder + "/" + item.name : item.name;
      card.dataset.resourceUri = item.resourceUri;
      const thumbnail = document.createElement("span");
      thumbnail.className = "thumbnail";
      const image = document.createElement("img");
      image.src = item.src;
      image.alt = item.name;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => card.classList.add("is-failed"), { once: true });
      thumbnail.append(image);
      const caption = document.createElement("span");
      caption.className = "caption";
      caption.textContent = item.name;
      card.append(thumbnail, caption);
      return card;
    }

    /** Renders a contiguous metadata slice with grouped headings when the folder layout is selected. */
    function appendFolderCards(fragment, items) {
      let currentFolder = null;
      let group = null;
      for (const item of items) {
        const folder = item.folder || "Top level";
        if (folder !== currentFolder) {
          currentFolder = folder;
          group = document.createElement("section");
          group.className = "folder-group";
          const heading = document.createElement("h2");
          heading.className = "folder-heading";
          heading.textContent = folder;
          const grid = document.createElement("div");
          grid.className = "folder-grid";
          group.append(heading, grid);
          fragment.append(group);
          group = grid;
        }
        group.append(createCard(item));
      }
    }

    /** Mounts a small viewport-centered image window and drops offscreen image elements. */
    function renderWindow(force) {
      if (!state.items.length) {
        gallery.replaceChildren();
        topSpacer.style.height = "0px";
        bottomSpacer.style.height = "0px";
        return;
      }
      const centeredIndex = getApproximateIndex();
      const start = Math.max(0, centeredIndex - WINDOW_BEFORE);
      const end = Math.min(state.items.length, centeredIndex + WINDOW_AFTER);
      if (!force && start === state.renderedStart && end === state.renderedEnd) {
        requestMoreIfNeeded(end);
        return;
      }
      state.renderedStart = start;
      state.renderedEnd = end;
      gallery.className = "layout-" + state.layout;
      topSpacer.style.height = estimateHeightForItems(start) + "px";
      bottomSpacer.style.height = Math.max(0, estimateHeightForItems(state.items.length) - estimateHeightForItems(end)) + "px";
      const fragment = document.createDocumentFragment();
      const visibleItems = state.items.slice(start, end);
      if (state.layout === "folders") {
        appendFolderCards(fragment, visibleItems);
      } else {
        for (const item of visibleItems) {
          fragment.append(createCard(item));
        }
      }
      gallery.replaceChildren(fragment);
      requestMoreIfNeeded(end);
    }

    /** Requests the next filesystem batch only when the mounted window nears discovered content. */
    function requestMoreIfNeeded(renderedEnd) {
      if (state.hasMore && !state.loading && renderedEnd >= state.items.length - PREFETCH_DISTANCE) {
        requestNextPage(!state.userHasScrolled);
      }
    }

    /** Requests one bounded extension-host scan batch. */
    function requestNextPage(isAutomatic) {
      if (state.loading || !state.hasMore) {
        return;
      }
      // Cap opening-time discovery so a deeply nested non-image tree does not delay the tab.
      if (isAutomatic && state.automaticScanRequests >= 2) {
        updateStatus();
        return;
      }
      state.loading = true;
      if (isAutomatic) {
        state.automaticScanRequests += 1;
      }
      updateStatus();
      vscode.postMessage({ type: "nextPage" });
    }

    /** Schedules rendering after scrolling without running one DOM rebuild per scroll event. */
    function scheduleRender() {
      if (state.renderFrame) {
        return;
      }
      state.renderFrame = requestAnimationFrame(() => {
        state.renderFrame = 0;
        renderWindow(false);
      });
    }

    /** Shows discovery progress without claiming an incomplete scan is a final count. */
    function updateStatus() {
      if (state.loading) {
        status.textContent = "Scanning… " + state.items.length + " found";
      } else if (state.hasMore) {
        status.textContent = state.items.length + " found · continue scanning on demand";
      } else if (state.skippedDirectories) {
        status.textContent = state.items.length + " images · " + state.skippedDirectories + " folders unavailable";
      } else {
        status.textContent = state.items.length + " images";
      }
      continueScan.hidden = state.loading || !state.hasMore;
      continueScan.disabled = state.loading || !state.hasMore;
    }

    /** Clears client metadata after a user-requested scan restart. */
    function resetScan() {
      state.items = [];
      state.hasMore = true;
      state.loading = false;
      state.skippedDirectories = 0;
      state.automaticScanRequests = 0;
      state.userHasScrolled = false;
      state.renderedStart = -1;
      state.renderedEnd = -1;
      scroll.scrollTop = 0;
      renderWindow(true);
      updateStatus();
    }

    layoutControl.addEventListener("change", () => {
      state.layout = layoutControl.value;
      state.renderedStart = -1;
      state.renderedEnd = -1;
      applyPreferences();
      renderWindow(true);
    });
    sizeControl.addEventListener("input", () => {
      state.thumbnailSize = Number(sizeControl.value);
      state.renderedStart = -1;
      state.renderedEnd = -1;
      applyPreferences();
      renderWindow(true);
    });
    continueScan.addEventListener("click", () => requestNextPage(false));
    rescan.addEventListener("click", () => vscode.postMessage({ type: "rescan" }));
    scroll.addEventListener("scroll", () => {
      state.userHasScrolled = true;
      scheduleRender();
    }, { passive: true });
    gallery.addEventListener("click", (event) => {
      const card = event.target.closest(".image-card");
      if (card && card.dataset.resourceUri) {
        vscode.postMessage({ type: "openImage", resourceUri: card.dataset.resourceUri });
      }
    });
    window.addEventListener("resize", () => {
      state.renderedStart = -1;
      state.renderedEnd = -1;
      renderWindow(true);
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "reset") {
        resetScan();
        return;
      }
      if (message.type !== "scanBatch") {
        return;
      }
      state.loading = false;
      state.items.push(...(message.items || []));
      state.hasMore = Boolean(message.hasMore);
      state.skippedDirectories = Number(message.skippedDirectories) || 0;
      state.renderedStart = -1;
      state.renderedEnd = -1;
      renderWindow(true);
      updateStatus();
      // Two small opening batches cover common root-plus-child trees without recursively exhausting a large tree.
      if (state.hasMore && state.automaticScanRequests < 2 && !state.userHasScrolled) {
        requestNextPage(true);
      }
      if (!state.hasMore && !state.items.length) {
        gallery.innerHTML = "<p class=\"empty\">No supported image files were found in this directory.</p>";
      }
    });
    applyPreferences();
    vscode.postMessage({ type: "ready" });
  })();
  </script>
</body>
</html>`;
}

/** Returns whether a filesystem entry includes the directory bit. */
function isDirectory(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.Directory) !== 0;
}

/** Returns whether a filesystem entry includes the ordinary-file bit. */
function isFile(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.File) !== 0;
}

/** Returns whether a filesystem entry is a symbolic link. */
function isSymbolicLink(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.SymbolicLink) !== 0;
}

/** Checks whether a URI has a browser-supported raster or SVG extension. */
function isSupportedImageUri(uri: vscode.Uri): boolean {
  return isDirectoryPreviewImageFile(uri.path);
}

/** Joins an Explorer-relative display path without using platform-specific separators. */
function joinRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

/** Checks that a clicked URI stays under the directory supplied to the command. */
function isDescendantUri(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) {
    return false;
  }
  if (root.scheme === "file") {
    const relative = path.relative(root.fsPath, candidate.fsPath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  }
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return candidate.path === root.path || candidate.path.startsWith(rootPath);
}

/** Produces a file-name title for local and remote directory URIs. */
function getUriBaseName(uri: vscode.Uri): string {
  return path.posix.basename(uri.path) || uri.authority || uri.toString();
}

/** Produces an unambiguous but compact directory label for the toolbar. */
function getUriDisplayPath(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

/** Reads persisted folder-keyword settings scoped to the selected preview root. */
function readDirectoryPreviewFolderFilters(rootUri: vscode.Uri): DirectoryPreviewFolderFilters {
  const configuration = vscode.workspace.getConfiguration("pandocManuscriptTools", rootUri);
  return {
    includedFolderKeywords: normalizeFolderKeywords(configuration.get<unknown>("imageDirectoryPreviewIncludedFolderKeywords", [])),
    excludedFolderKeywords: normalizeFolderKeywords(configuration.get<unknown>("imageDirectoryPreviewExcludedFolderKeywords", [])),
  };
}

/** Saves folder-keyword settings to the most specific available configuration scope. */
async function writeDirectoryPreviewFolderFilters(rootUri: vscode.Uri, filters: DirectoryPreviewFolderFilters): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("pandocManuscriptTools", rootUri);
  const target = vscode.workspace.getWorkspaceFolder(rootUri)
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Global;
  await configuration.update("imageDirectoryPreviewIncludedFolderKeywords", [...filters.includedFolderKeywords], target);
  await configuration.update("imageDirectoryPreviewExcludedFolderKeywords", [...filters.excludedFolderKeywords], target);
}

/** Returns a slash-separated path relative to the selected preview directory. */
function getRootRelativePath(root: vscode.Uri, child: vscode.Uri): string | undefined {
  if (!isDescendantUri(root, child) || root.toString() === child.toString()) {
    return undefined;
  }
  if (root.scheme === "file") {
    return normalizePreviewRelativePath(path.relative(root.fsPath, child.fsPath).split(path.sep).join("/"));
  }
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return child.path.startsWith(rootPath) ? normalizePreviewRelativePath(child.path.slice(rootPath.length)) : undefined;
}

/** Escapes text inserted into HTML body content. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes text inserted into an HTML attribute. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/** Formats an unknown error for the extension output channel. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
