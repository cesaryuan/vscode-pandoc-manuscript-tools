import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CAN_BUILD_HTML_CONTEXT } from "../constants";
import { cacheHtmlMetafileImages } from "../htmlPreviewResourceCache";
import { findPandocManuscriptProject, isPapperBuildAvailable, preparePapperEnvironment, resolvePapperExecutable, runProcess, type PandocManuscriptProject } from "../papperBuildUtils";
import { PapperHtmlServerClient } from "../papperHtmlServer";
import { isBuildableMarkdownDocument } from "../vscodeUtils";
import { HtmlPreviewClickNavigation, type HtmlPreviewBlockDescriptor, type HtmlPreviewClickMessage } from "./clickNavigation";
import { HtmlPreviewScrollSync, type HtmlPreviewMessage } from "./scrollSync";
import { HtmlPreviewEditorScrollIntent } from "./editorScrollIntent";
import { countHtmlElements, createNonce, injectHtmlPreviewBridge, removeTemporaryMarkdownDirectory, rewriteHtmlResourceUris, waitForWebviewUpdate } from "./webview";

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
  private readonly editorScrollIntent: HtmlPreviewEditorScrollIntent;
  private readonly clickNavigation: HtmlPreviewClickNavigation;
  private readonly htmlServer: PapperHtmlServerClient;

  /** Creates a preview controller that reports preview failures to the shared output channel. */
  constructor(private readonly output: vscode.OutputChannel) {
    this.scrollSync = new HtmlPreviewScrollSync();
    this.editorScrollIntent = new HtmlPreviewEditorScrollIntent((editor, position) => {
      this.scrollSync.syncFromEditor(this.htmlPreviewPanel, this.htmlPreviewDocumentUri, editor, position);
    });
    this.clickNavigation = new HtmlPreviewClickNavigation(output);
    this.htmlServer = new PapperHtmlServerClient(output, this.startHtmlServer.bind(this));
  }

  /** Clears the preview refresh timer and closes its WebView panel. */
  dispose() {
    this.editorScrollIntent.dispose();
    if (this.htmlPreviewTimer) {
      clearTimeout(this.htmlPreviewTimer);
    }
    this.htmlPreviewPanel?.dispose();
    this.htmlPreviewPanel = undefined;
    this.htmlServer.dispose();
  }

  /** Checks tool availability independently of focus; menus filter their own resource. */
  async refreshContext() {
    const refreshId = ++this.contextRefreshId;
    // Focusing a Webview clears activeTextEditor and previously hid source-editor buttons.
    const canBuildHtml = await isPapperBuildAvailable();
    if (refreshId !== this.contextRefreshId) {
      return;
    }
    await vscode.commands.executeCommand("setContext", CAN_BUILD_HTML_CONTEXT, canBuildHtml);
  }

  /**
   * Opens the title action's Markdown file, or the active file for palette commands.
   *
   * The preview is built from the current editor buffer, including unsaved
   * changes, and keeps the generated standalone HTML inside a Webview panel.
   */
  async buildActiveMarkdownHtml(uri?: vscode.Uri) {
    // Inactive editor title actions pass their resource; activeTextEditor may be another file.
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !isBuildableMarkdownDocument(document)) {
      vscode.window.showWarningMessage("Open a Markdown file before starting HTML preview.");
      return;
    }

    const project = await resolveHtmlPreviewProject(document.uri);

    if (!(await isPapperBuildAvailable())) {
      vscode.window.showErrorMessage("Cannot build HTML preview because `papper` is not on PATH and `uv` is not available to install it.");
      await this.refreshContext();
      return;
    }

    this.openHtmlPreview(document, project);
    await this.refreshHtmlPreview(document, project);
    await this.refreshContext();
  }

  /**
   * Schedules a live HTML preview rebuild for the currently previewed document.
   *
   * Unsaved text is sent directly to the project service without changing the
   * user's document or launching a new CLI process for each refresh.
   *
   * @param document Changed Markdown document.
   */
  scheduleHtmlPreviewRefresh(document: vscode.TextDocument) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, document.uri)) {
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (isSameUri(editor.document.uri, document.uri)) {
        this.editorScrollIntent.onDocumentChanged(editor);
      }
    }

    if (this.htmlPreviewTimer) {
      clearTimeout(this.htmlPreviewTimer);
    }
    this.htmlPreviewTimer = setTimeout(() => {
      this.htmlPreviewTimer = undefined;
      void this.refreshHtmlPreview(document);
    }, 350);
  }

  /** Filters viewport events before synchronizing the currently previewed source. */
  handleEditorVisibleRangesChange(editor: vscode.TextEditor) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, editor.document.uri)) {
      return;
    }
    this.editorScrollIntent.onVisibleRangesChanged(editor);
  }

  /** Filters selection events so dragging, typing, and commands cannot scroll the preview. */
  handleEditorSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, event.textEditor.document.uri)) {
      return;
    }
    const kind = event.kind === vscode.TextEditorSelectionChangeKind.Mouse ? "mouse"
      : event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ? "keyboard" : undefined;
    this.editorScrollIntent.onSelectionChanged(event.textEditor, kind);
  }

  /**
   * Converts the current buffer through Papper's service and updates the side preview.
   *
   * @param project Detected manuscript project root.
   * @param document Markdown document to build.
   */
  private async runHtmlBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const buildId = ++this.htmlPreviewBuildId;
    try {
      const html = await this.htmlServer.convert(project.rootUri.fsPath, document.uri.fsPath, document.getText());
      if (buildId !== this.htmlPreviewBuildId) {
        return;
      }
      await this.updateHtmlPreviewPanel(html, document, project);
    } catch (error) {
      const message = `Failed to build HTML preview: ${String(error.message || error)}`;
      this.output.appendLine(`[HTML] ${message}`);
      vscode.window.showErrorMessage(message);
    }
  }

  /** Bootstraps a missing service once with Papper's normal project configuration. */
  private async startHtmlServer(projectDirectory: string, sourcePath: string, port: number): Promise<void> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-preview-start-"));
    try {
      const executable = await resolvePapperExecutable(this.output);
      const environment = await preparePapperEnvironment(executable);
      const bootstrapMarkdown = path.join(temporaryDirectory, path.basename(sourcePath));
      // Startup also builds HTML. An empty temporary source avoids parsing an
      // outdated/invalid disk version when the editor contains a corrected buffer;
      // the subsequent HTTP request supplies the real path, text, and resource context.
      await fs.writeFile(bootstrapMarkdown, "", "utf8");
      await runProcess(executable, [
        "build", "html", bootstrapMarkdown, "--start-server", "--server-port", String(port),
        "--output-file", path.join(temporaryDirectory, "startup.html"),
      ], { cwd: projectDirectory, output: this.output, env: environment.env });
    } finally {
      await removeTemporaryMarkdownDirectory(temporaryDirectory, this.output);
    }
  }

  /**
   * Opens or focuses the Papper HTML preview beside the source editor.
   *
   * @param document Source Markdown document.
   * @param project Detected Papper project.
   */
  private openHtmlPreview(document: vscode.TextDocument, project: PandocManuscriptProject) {
    this.editorScrollIntent.dispose();
    for (const editor of vscode.window.visibleTextEditors) {
      if (isSameUri(editor.document.uri, document.uri)) {
        this.editorScrollIntent.observe(editor);
      }
    }
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
        this.editorScrollIntent.dispose();
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
   * @param project Optional already resolved preview root.
   */
  private async refreshHtmlPreview(document: vscode.TextDocument, project?: PandocManuscriptProject) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, document.uri)) {
      return;
    }
    if (this.htmlPreviewBuildRunning) {
      this.htmlPreviewRefreshPending = true;
      return;
    }
    const resolvedProject = project || await resolveHtmlPreviewProject(document.uri);
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
   * Wraps generated HTML with the scroll-sync bridge used by the
   * Webview panel.
   *
   * @param html Generated HTML returned by the project service.
   * @param document Source Markdown document.
   * @param project Detected Papper project that bounds image resource access.
   */
  private async updateHtmlPreviewPanel(html: string, document: vscode.TextDocument, project: PandocManuscriptProject) {
    if (!this.htmlPreviewPanel) {
      return;
    }
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
      this.output.appendLine(`[HTML] Preserving Pandoc styles failed: style element count changed for ${document.uri.fsPath}`);
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

/** Keeps configured projects intact and gives other saved Markdown a preview root. */
async function resolveHtmlPreviewProject(markdownUri: vscode.Uri): Promise<PandocManuscriptProject> {
  const project = await findPandocManuscriptProject(markdownUri);
  if (project) {
    return project;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(markdownUri);
  return { rootUri: workspaceFolder?.uri || vscode.Uri.file(path.dirname(markdownUri.fsPath)) };
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
