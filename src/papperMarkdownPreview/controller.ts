import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CAN_BUILD_HTML_CONTEXT } from "../constants";
import { cacheHtmlMetafileImages } from "../htmlPreviewResourceCache";
import { findPandocManuscriptProject, isPapperBuildAvailable, pathExists, preparePapperEnvironment, resolvePapperExecutable, runProcess, type PandocManuscriptProject } from "../papperBuildUtils";
import { isBuildableMarkdownDocument } from "../vscodeUtils";
import { HtmlPreviewClickNavigation, type HtmlPreviewBlockDescriptor, type HtmlPreviewClickMessage } from "./clickNavigation";
import { HtmlPreviewScrollSync, type HtmlPreviewMessage } from "./scrollSync";
import { countHtmlElements, createNonce, formatElapsedMs, getExpectedHtmlUri, injectHtmlPreviewBridge, removeTemporaryMarkdown, rewriteHtmlResourceUris, waitForWebviewUpdate } from "./webview";

/** Owns Papper Markdown HTML builds, preview panel lifecycle, and refresh scheduling. */
export class PapperMarkdownPreviewController {
  private contextRefreshId = 0;
  private htmlPreviewPanel: vscode.WebviewPanel | undefined;
  private htmlPreviewDocumentUri: vscode.Uri | undefined;
  private htmlPreviewTimer: NodeJS.Timeout | undefined;
  private htmlPreviewBuildId = 0;
  private htmlPreviewBuildRunning = false;
  private htmlPreviewRefreshPending = false;
  private htmlPreviewVerbose: boolean;
  private htmlPreviewWebviewReady = false;
  private htmlPreviewUpdateToken = 0;
  private htmlPreviewPendingUpdate: { token: string; resolve: (confirmed: boolean) => void } | undefined;
  private readonly scrollSync: HtmlPreviewScrollSync;
  private readonly clickNavigation: HtmlPreviewClickNavigation;

  /** Creates a preview controller that writes build progress to the shared output channel. */
  constructor(private readonly output: vscode.OutputChannel, verboseHtmlBuilds = false) {
    this.htmlPreviewVerbose = verboseHtmlBuilds;
    this.scrollSync = new HtmlPreviewScrollSync(output);
    this.clickNavigation = new HtmlPreviewClickNavigation(output);
  }

  /** Clears the preview refresh timer and closes its WebView panel. */
  dispose() {
    if (this.htmlPreviewTimer) {
      clearTimeout(this.htmlPreviewTimer);
    }
    this.htmlPreviewPanel?.dispose();
    this.htmlPreviewPanel = undefined;
  }

  /** Recomputes whether the active editor can use the Papper HTML preview. */
  async refreshContext() {
    const refreshId = ++this.contextRefreshId;
    const canBuildHtml = await this.canBuildHtmlActiveDocument();
    if (refreshId !== this.contextRefreshId) {
      return;
    }
    await vscode.commands.executeCommand("setContext", CAN_BUILD_HTML_CONTEXT, canBuildHtml);
  }

  /**
   * Returns whether the active Markdown file can be rendered by Papper as HTML.
   *
   * HTML preview uses the same saved-file and `style.yml` project boundary as
   * the DOCX command, so non-Papper workspaces do not expose this feature.
   */
  private async canBuildHtmlActiveDocument() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      return false;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    return Boolean(project) && isPapperBuildAvailable();
  }

  /**
   * Opens the active Markdown file in the Papper HTML side preview.
   *
   * The preview is built from the current editor buffer, including unsaved
   * changes, and keeps the generated standalone HTML inside a Webview panel.
   */
  async buildActiveMarkdownHtml() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      vscode.window.showWarningMessage("Open a Markdown file before starting HTML preview.");
      return;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    if (!project) {
      vscode.window.showWarningMessage("This Markdown file is not inside a Papper project with style.yml.");
      await this.refreshContext();
      return;
    }

    if (!(await isPapperBuildAvailable())) {
      vscode.window.showErrorMessage("Cannot build HTML preview because `papper` is not on PATH and `uv` is not available to install it.");
      await this.refreshContext();
      return;
    }

    this.openHtmlPreview(editor.document, project);
    await this.refreshHtmlPreview(editor.document, project);
    await this.refreshContext();
  }

  /**
   * Schedules a live HTML preview rebuild for the currently previewed document.
   *
   * Unsaved text is rendered through a temporary Markdown mirror next to the
   * source file, so refreshing the preview never changes the user's document.
   *
   * @param document Changed Markdown document.
   */
  scheduleHtmlPreviewRefresh(document: vscode.TextDocument) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, document.uri)) {
      return;
    }

    if (this.htmlPreviewTimer) {
      clearTimeout(this.htmlPreviewTimer);
    }
    this.htmlPreviewTimer = setTimeout(() => {
      this.htmlPreviewTimer = undefined;
      void this.refreshHtmlPreview(document);
    }, 350);
  }

  /** Sends the editor viewport or active cursor position to the open preview. */
  syncFromEditor(editor: vscode.TextEditor, selectedPosition?: vscode.Position) {
    if (!isBuildableMarkdownDocument(editor.document)) {
      return;
    }
    this.scrollSync.syncFromEditor(this.htmlPreviewPanel, this.htmlPreviewDocumentUri, editor, selectedPosition);
  }

  /**
   * Runs Papper's HTML target and updates the open side preview panel.
   *
   * @param project Detected manuscript project root.
   * @param document Markdown document to build.
   */
  private async runHtmlBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const totalStartedAt = Date.now();
    const buildId = ++this.htmlPreviewBuildId;
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);
    const htmlUri = getExpectedHtmlUri(project.rootUri, document.uri);
    const htmlRelativePath = path.relative(project.rootUri.fsPath, htmlUri.fsPath);
    const temporaryMarkdownPath = path.join(path.dirname(document.uri.fsPath), `.pmt-preview-${process.pid}-${buildId}-${path.basename(document.uri.fsPath)}`);
    const temporaryMarkdownRelativePath = path.relative(project.rootUri.fsPath, temporaryMarkdownPath);
    const args = [
      "build",
      ...(this.htmlPreviewVerbose ? ["--verbose"] : []),
      "html",
      temporaryMarkdownRelativePath,
      "--output-file",
      htmlRelativePath,
    ];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[HTML] Building ${markdownRelativePath}`);
    this.output.appendLine(`[HTML] Working directory: ${project.rootUri.fsPath}`);
    this.output.appendLine(`[HTML] Command: papper ${args.join(" ")}`);

    try {
      const writeStartedAt = Date.now();
      await fs.writeFile(temporaryMarkdownPath, document.getText(), "utf8");
      this.output.appendLine(`[HTML][timing] Temporary Markdown write: ${formatElapsedMs(writeStartedAt)}`);

      const resolveStartedAt = Date.now();
      const papperExecutable = await resolvePapperExecutable(this.output);
      this.output.appendLine(`[HTML][timing] Papper executable resolution: ${formatElapsedMs(resolveStartedAt)}`);
      this.output.appendLine(`[HTML] Resolved executable: ${papperExecutable}`);

      const environmentStartedAt = Date.now();
      const papperEnvironment = await preparePapperEnvironment(papperExecutable);
      this.output.appendLine(`[HTML][timing] Papper environment preparation: ${formatElapsedMs(environmentStartedAt)}`);
      this.output.appendLine(`[HTML] Pandoc tool PATH entries: ${papperEnvironment.toolPathEntries.length ? papperEnvironment.toolPathEntries.join(path.delimiter) : "none"}`);

      const papperStartedAt = Date.now();
      const slowOutputGapMs = 5000;
      let lastPapperOutputAt = papperStartedAt;
      let receivedPapperOutput = false;
      /** Locates intermittent slow builds that Papper's untimestamped verbose output cannot explain. */
      const recordPapperOutput = (stream: "stdout" | "stderr") => {
        const now = Date.now();
        const outputGapMs = now - lastPapperOutputAt;
        if (outputGapMs >= slowOutputGapMs) {
          const gapStart = receivedPapperOutput ? "previous output" : "process start";
          this.output.appendLine(`[HTML][timing] Papper subprocess output resumed after ${formatElapsedMs(outputGapMs)} (${gapStart}, ${stream})`);
        }
        lastPapperOutputAt = now;
        receivedPapperOutput = true;
      };
      try {
        await runProcess(papperExecutable, args, {
          cwd: project.rootUri.fsPath,
          output: this.output,
          env: papperEnvironment.env,
          onOutputChunk: recordPapperOutput,
        });
      } finally {
        const finalOutputGapMs = Date.now() - lastPapperOutputAt;
        if (finalOutputGapMs >= slowOutputGapMs) {
          const silenceStart = receivedPapperOutput ? "last output" : "process start";
          this.output.appendLine(`[HTML][timing] Papper subprocess silent for ${formatElapsedMs(finalOutputGapMs)} before exit (${silenceStart})`);
        }
      }
      this.output.appendLine(`[HTML][timing] Papper build (including Pandoc): ${formatElapsedMs(papperStartedAt)}`);
      if (buildId !== this.htmlPreviewBuildId) {
        return;
      }

      const outputCheckStartedAt = Date.now();
      if (!(await pathExists(htmlUri))) {
        throw new Error(`Build finished, but the expected HTML was not found: ${htmlUri.fsPath}`);
      }
      this.output.appendLine(`[HTML][timing] Generated HTML check: ${formatElapsedMs(outputCheckStartedAt)}`);

      const panelStartedAt = Date.now();
      await this.updateHtmlPreviewPanel(htmlUri, document, project);
      this.output.appendLine(`[HTML][timing] WebView preparation and update: ${formatElapsedMs(panelStartedAt)}`);
      this.output.appendLine(`[HTML][timing] Total refresh: ${formatElapsedMs(totalStartedAt)}`);
      this.output.appendLine(`[HTML] Updated side preview ${htmlUri.fsPath}`);
    } catch (error) {
      this.output.appendLine(`[HTML][timing] Failed refresh total: ${formatElapsedMs(totalStartedAt)}`);
      const message = `Failed to build HTML preview: ${String(error.message || error)}`;
      this.output.appendLine(`[HTML] ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      const cleanupStartedAt = Date.now();
      await removeTemporaryMarkdown(temporaryMarkdownPath, this.output);
      this.output.appendLine(`[HTML][timing] Temporary Markdown cleanup: ${formatElapsedMs(cleanupStartedAt)}`);
    }
  }

  /**
   * Opens or focuses the Papper HTML preview beside the source editor.
   *
   * @param document Source Markdown document.
   * @param project Detected Papper project.
   */
  private openHtmlPreview(document: vscode.TextDocument, project: PandocManuscriptProject) {
    this.htmlPreviewDocumentUri = document.uri;
    if (this.htmlPreviewPanel) {
      this.htmlPreviewPanel.title = `${path.basename(document.uri.fsPath)} — Papper HTML Preview`;
      this.htmlPreviewPanel.webview.options = {
        ...this.htmlPreviewPanel.webview.options,
        enableScripts: true,
        localResourceRoots: [project.rootUri],
      };
      this.htmlPreviewPanel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "pandocManuscriptTools.htmlPreview",
      `${path.basename(document.uri.fsPath)} — Papper HTML Preview`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [project.rootUri],
      },
    );
    this.htmlPreviewPanel = panel;
    this.htmlPreviewWebviewReady = false;
    this.output.appendLine(`[HTML][scroll] preview panel opened for ${document.uri.fsPath}`);
    panel.webview.onDidReceiveMessage((message: HtmlPreviewMessage & Partial<HtmlPreviewClickMessage> & { blocks?: HtmlPreviewBlockDescriptor[] }) => {
      if (message.type === "ready") {
        this.htmlPreviewWebviewReady = true;
        this.output.appendLine("[HTML][scroll] preview WebView ready");
        this.scrollSync.resetSourcePosition();
        const sourceEditor = vscode.window.visibleTextEditors.find((editor) => isSameUri(editor.document.uri, document.uri));
        if (sourceEditor) {
          this.output.appendLine("[HTML][scroll] synchronizing editor position after WebView ready");
          this.scrollSync.syncFromEditor(panel, this.htmlPreviewDocumentUri, sourceEditor);
        }
        // The host assigns the first complete HTML before the Webview emits
        // `ready`; rebuilding here would duplicate the initial build.
        return;
      }
      if (message.type === "previewKatexFailed" || message.type === "previewKatexUnavailable") {
        this.output.appendLine(`[HTML][webview] ${message.type}${message.detail ? `: ${message.detail}` : ""}`);
        return;
      }
      if (message.type === "previewUpdateStarted" || message.type === "previewUpdateFinished" || message.type === "previewUpdateFailed" || message.type === "previewKatexStarted" || message.type === "previewKatexFinished") {
        this.output.appendLine(`[HTML][webview] ${message.type}${message.detail ? `: ${message.detail}` : ""}`);
        if (message.type === "previewUpdateFinished" || message.type === "previewUpdateFailed") {
          const pending = this.htmlPreviewPendingUpdate;
          if (pending && pending.token === message.detail) {
            this.htmlPreviewPendingUpdate = undefined;
            pending.resolve(message.type === "previewUpdateFinished");
          }
        }
        return;
      }
      if (message.type === "scrollSyncTrace") {
        this.output.appendLine(`[HTML][scroll] WebView ${message.detail || "trace"}`);
        return;
      }
      if (message.type === "previewBlockClick") {
        this.output.appendLine(`[HTML][click] preview block type=${message.blockType || "unknown"} label=${message.label || "none"}`);
        this.scrollSync.suppressEditorSync();
        void this.clickNavigation.handlePreviewClick(this.htmlPreviewDocumentUri, message as HtmlPreviewClickMessage).catch((error) => {
          this.output.appendLine(`[HTML][click] source reveal failed: ${String(error)}`);
        });
        return;
      }
      if (message.type === "previewBlocks") {
        void this.mapPreviewBlocks(panel, message.blocks as HtmlPreviewBlockDescriptor[]);
        return;
      }
      if (message.type === "previewScroll") {
        this.output.appendLine(`[HTML][scroll] preview -> host ratio=${typeof message.ratio === "number" ? message.ratio.toFixed(3) : "invalid"} sourceLine=${typeof message.sourceLine === "number" ? message.sourceLine + 1 : "none"} block=${message.blockId || "none"} offset=${typeof message.blockOffsetRatio === "number" ? message.blockOffsetRatio.toFixed(3) : "none"}`);
      }
      this.scrollSync.handlePreviewScroll(this.htmlPreviewDocumentUri, message);
    });
    panel.onDidDispose(() => {
      if (this.htmlPreviewPanel === panel) {
        this.htmlPreviewPanel = undefined;
        this.htmlPreviewDocumentUri = undefined;
        this.htmlPreviewWebviewReady = false;
      }
    });
  }

  /** Maps WebView blocks to source lines and returns the mapping to the bridge. */
  private async mapPreviewBlocks(panel: vscode.WebviewPanel, blocks: HtmlPreviewBlockDescriptor[]) {
    if (!this.htmlPreviewDocumentUri || !Array.isArray(blocks)) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(this.htmlPreviewDocumentUri);
      const mappings = this.clickNavigation.mapPreviewBlocks(document, blocks);
      await panel.webview.postMessage({ type: "previewBlockMap", mappings });
      this.output.appendLine(`[HTML][scroll] preview block map matched=${mappings.length}/${blocks.length}`);
    } catch (error) {
      this.output.appendLine(`[HTML][scroll] preview block map failed: ${String(error)}`);
    }
  }

  /**
   * Rebuilds the current preview and keeps the side panel alive.
   *
   * @param document Source Markdown document.
   * @param project Optional already detected Papper project.
   */
  private async refreshHtmlPreview(document: vscode.TextDocument, project?: PandocManuscriptProject) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, document.uri)) {
      return;
    }
    if (this.htmlPreviewBuildRunning) {
      this.htmlPreviewRefreshPending = true;
      return;
    }
    const resolvedProject = project || await findPandocManuscriptProject(document.uri);
    if (!resolvedProject) {
      return;
    }
    this.htmlPreviewBuildRunning = true;
    try {
      await this.runHtmlBuild(resolvedProject, document);
    } finally {
      this.htmlPreviewBuildRunning = false;
      if (this.htmlPreviewRefreshPending) {
        this.htmlPreviewRefreshPending = false;
        const latestDocument = vscode.workspace.textDocuments.find((candidate) => isSameUri(candidate.uri, document.uri));
        if (latestDocument) {
          void this.refreshHtmlPreview(latestDocument);
        }
      }
    }
  }

  /**
   * Reads generated HTML and wraps it with the scroll-sync bridge used by the
   * Webview panel.
   *
   * @param htmlUri Generated HTML file.
   * @param document Source Markdown document.
   * @param project Detected Papper project that bounds image resource access.
   */
  private async updateHtmlPreviewPanel(htmlUri: vscode.Uri, document: vscode.TextDocument, project: PandocManuscriptProject) {
    if (!this.htmlPreviewPanel) {
      return;
    }
    const readStartedAt = Date.now();
    const html = await fs.readFile(htmlUri.fsPath, "utf8");
    this.output.appendLine(`[HTML][timing] Generated HTML read (${html.length} chars): ${formatElapsedMs(readStartedAt)}`);
    const nonce = createNonce();
    const cacheStartedAt = Date.now();
    const cachedHtml = await cacheHtmlMetafileImages(
      html,
      path.dirname(document.uri.fsPath),
      project.rootUri.fsPath,
      path.join(project.rootUri.fsPath, ".pmt", "cache", "html-preview", "metafile-svg"),
      (filePath) => this.htmlPreviewPanel!.webview.asWebviewUri(vscode.Uri.file(filePath)).toString(),
      this.output,
    );
    this.output.appendLine(`[HTML][timing] EMF/WMF cache and conversion: ${formatElapsedMs(cacheStartedAt)}`);

    const rewriteStartedAt = Date.now();
    const rewrittenHtml = rewriteHtmlResourceUris(cachedHtml.html, this.htmlPreviewPanel.webview, path.dirname(document.uri.fsPath));
    this.output.appendLine(`[HTML][timing] Local resource URI rewrite: ${formatElapsedMs(rewriteStartedAt)}`);
    if (countHtmlElements(html, "style") !== countHtmlElements(rewrittenHtml, "style")) {
      this.output.appendLine(`[HTML] Preserving Pandoc styles failed: style element count changed for ${htmlUri.fsPath}`);
      return;
    }
    const injectStartedAt = Date.now();
    const preparedHtml = injectHtmlPreviewBridge(rewrittenHtml, nonce, this.htmlPreviewPanel.webview.cspSource);
    const updateExistingWebview = this.htmlPreviewWebviewReady;
    if (updateExistingWebview) {
      const token = `${Date.now()}-${++this.htmlPreviewUpdateToken}`;
      const confirmation = new Promise<boolean>((resolve) => {
        this.htmlPreviewPendingUpdate = { token, resolve };
      });
      const delivered = await this.htmlPreviewPanel.webview.postMessage({ type: "replacePreviewHtml", html: preparedHtml, token });
      this.output.appendLine(`[HTML][webview] Incremental update message: ${delivered ? "delivered" : "rejected"} (${token})`);
      const confirmed = delivered && await waitForWebviewUpdate(confirmation);
      if (!confirmed) {
        if (this.htmlPreviewPendingUpdate?.token === token) {
          this.htmlPreviewPendingUpdate = undefined;
        }
        this.output.appendLine(`[HTML][webview] Incremental update timed out; falling back to full HTML reload (${token})`);
        this.htmlPreviewWebviewReady = false;
        this.htmlPreviewPanel.webview.html = preparedHtml;
      }
    } else {
      this.htmlPreviewPanel.webview.html = preparedHtml;
    }
    this.output.appendLine(`[HTML][timing] WebView HTML injection: ${formatElapsedMs(injectStartedAt)}`);
    const sourceEditor = vscode.window.visibleTextEditors.find((editor) => isSameUri(editor.document.uri, document.uri));
    if (!updateExistingWebview && sourceEditor) {
      this.scrollSync.resetSourcePosition();
      this.scrollSync.syncFromEditor(this.htmlPreviewPanel, this.htmlPreviewDocumentUri, sourceEditor);
    }
  }
}

/** Compares two file URIs using platform-aware filesystem path rules. */
function isSameUri(left: vscode.Uri, right: vscode.Uri) {
  const normalizedLeft = path.resolve(left.fsPath);
  const normalizedRight = path.resolve(right.fsPath);
  if (left.scheme !== right.scheme) {
    return false;
  }
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
