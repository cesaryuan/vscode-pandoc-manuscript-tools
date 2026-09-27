import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CAN_BUILD_HTML_CONTEXT } from "../constants";
import { cacheHtmlMetafileImages } from "../htmlPreviewResourceCache";
import { findPandocManuscriptProject, isPapperBuildAvailable, pathExists, preparePapperEnvironment, resolvePapperExecutable, runProcess, type PandocManuscriptProject } from "../papperBuildUtils";
import { isBuildableMarkdownDocument } from "../vscodeUtils";
import { HtmlPreviewClickNavigation, type HtmlPreviewBlockDescriptor, type HtmlPreviewClickMessage } from "./clickNavigation";
import { HtmlPreviewScrollSync, type HtmlPreviewMessage } from "./scrollSync";
import { countHtmlElements, createNonce, getExpectedHtmlUri, injectHtmlPreviewBridge, removeTemporaryMarkdown, rewriteHtmlResourceUris, waitForWebviewUpdate } from "./webview";

/** Owns Papper Markdown HTML builds, preview panel lifecycle, and refresh scheduling. */
export class PapperMarkdownPreviewController {
  private contextRefreshId = 0;
  private htmlPreviewPanel: vscode.WebviewPanel | undefined;
  private htmlPreviewDocumentUri: vscode.Uri | undefined;
  private htmlPreviewTimer: NodeJS.Timeout | undefined;
  private htmlPreviewBuildId = 0;
  private htmlPreviewBuildRunning = false;
  private htmlPreviewRefreshPending = false;
  private htmlPreviewWebviewReady = false;
  private htmlPreviewUpdateToken = 0;
  private htmlPreviewPendingUpdate: { token: string; resolve: (confirmed: boolean) => void } | undefined;
  private readonly scrollSync: HtmlPreviewScrollSync;
  private readonly clickNavigation: HtmlPreviewClickNavigation;

  /** Creates a preview controller that reports preview failures to the shared output channel. */
  constructor(private readonly output: vscode.OutputChannel) {
    this.scrollSync = new HtmlPreviewScrollSync();
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
    const buildId = ++this.htmlPreviewBuildId;
    const htmlUri = getExpectedHtmlUri(project.rootUri, document.uri);
    const htmlRelativePath = path.relative(project.rootUri.fsPath, htmlUri.fsPath);
    const temporaryMarkdownPath = path.join(path.dirname(document.uri.fsPath), `.pmt-preview-${process.pid}-${buildId}-${path.basename(document.uri.fsPath)}`);
    const temporaryMarkdownRelativePath = path.relative(project.rootUri.fsPath, temporaryMarkdownPath);
    const args = [
      "build",
      "html",
      temporaryMarkdownRelativePath,
      "--output-file",
      htmlRelativePath,
    ];

    try {
      await fs.writeFile(temporaryMarkdownPath, document.getText(), "utf8");

      const papperExecutable = await resolvePapperExecutable(this.output);

      const papperEnvironment = await preparePapperEnvironment(papperExecutable);

      await runProcess(papperExecutable, args, {
        cwd: project.rootUri.fsPath,
        output: this.output,
        env: papperEnvironment.env,
      });
      if (buildId !== this.htmlPreviewBuildId) {
        return;
      }

      if (!(await pathExists(htmlUri))) {
        throw new Error(`Build finished, but the expected HTML was not found: ${htmlUri.fsPath}`);
      }

      await this.updateHtmlPreviewPanel(htmlUri, document, project);
    } catch (error) {
      const message = `Failed to build HTML preview: ${String(error.message || error)}`;
      this.output.appendLine(`[HTML] ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      await removeTemporaryMarkdown(temporaryMarkdownPath, this.output);
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
    panel.webview.onDidReceiveMessage((message: HtmlPreviewMessage & Partial<HtmlPreviewClickMessage> & { blocks?: HtmlPreviewBlockDescriptor[] }) => {
      if (message.type === "ready") {
        this.htmlPreviewWebviewReady = true;
        this.scrollSync.resetSourcePosition();
        const sourceEditor = vscode.window.visibleTextEditors.find((editor) => isSameUri(editor.document.uri, document.uri));
        if (sourceEditor) {
          this.scrollSync.syncFromEditor(panel, this.htmlPreviewDocumentUri, sourceEditor);
        }
        // The host assigns the first complete HTML before the Webview emits
        // `ready`; rebuilding here would duplicate the initial build.
        return;
      }
      if (message.type === "previewKatexFailed" || message.type === "previewKatexUnavailable") {
        this.output.appendLine(`[HTML] ${message.type}${message.detail ? `: ${message.detail}` : ""}`);
        return;
      }
      if (message.type === "previewUpdateFinished" || message.type === "previewUpdateFailed") {
        const pending = this.htmlPreviewPendingUpdate;
        if (pending && pending.token === message.detail) {
          this.htmlPreviewPendingUpdate = undefined;
          pending.resolve(message.type === "previewUpdateFinished");
        }
        return;
      }
      if (message.type === "previewBlockClick") {
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
    } catch (error) {
      this.output.appendLine(`[HTML] Preview block mapping failed: ${String(error)}`);
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
    const html = await fs.readFile(htmlUri.fsPath, "utf8");
    const nonce = createNonce();
    const cachedHtml = await cacheHtmlMetafileImages(
      html,
      path.dirname(document.uri.fsPath),
      project.rootUri.fsPath,
      path.join(project.rootUri.fsPath, ".pmt", "cache", "html-preview", "metafile-svg"),
      (filePath) => this.htmlPreviewPanel!.webview.asWebviewUri(vscode.Uri.file(filePath)).toString(),
      this.output,
    );

    const rewrittenHtml = rewriteHtmlResourceUris(cachedHtml.html, this.htmlPreviewPanel.webview, path.dirname(document.uri.fsPath));
    if (countHtmlElements(html, "style") !== countHtmlElements(rewrittenHtml, "style")) {
      this.output.appendLine(`[HTML] Preserving Pandoc styles failed: style element count changed for ${htmlUri.fsPath}`);
      return;
    }
    const preparedHtml = injectHtmlPreviewBridge(rewrittenHtml, nonce, this.htmlPreviewPanel.webview.cspSource);
    const updateExistingWebview = this.htmlPreviewWebviewReady;
    if (updateExistingWebview) {
      const token = `${Date.now()}-${++this.htmlPreviewUpdateToken}`;
      const confirmation = new Promise<boolean>((resolve) => {
        this.htmlPreviewPendingUpdate = { token, resolve };
      });
      const delivered = await this.htmlPreviewPanel.webview.postMessage({ type: "replacePreviewHtml", html: preparedHtml, token });
      const confirmed = delivered && await waitForWebviewUpdate(confirmation);
      if (!confirmed) {
        if (this.htmlPreviewPendingUpdate?.token === token) {
          this.htmlPreviewPendingUpdate = undefined;
        }
        this.output.appendLine("[HTML] Incremental preview update timed out; reloading the WebView.");
        this.htmlPreviewWebviewReady = false;
        this.htmlPreviewPanel.webview.html = preparedHtml;
      }
    } else {
      this.htmlPreviewPanel.webview.html = preparedHtml;
    }
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
