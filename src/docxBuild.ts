import * as cp from "child_process";
import * as fs from "fs/promises";
import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { CAN_BUILD_DOCX_CONTEXT, CAN_BUILD_HTML_CONTEXT } from "./constants";
import { cacheHtmlMetafileImages } from "./htmlPreviewResourceCache";
import { isBuildableMarkdownDocument } from "./vscodeUtils";

type PandocManuscriptProject = { rootUri: vscode.Uri };
type DocxDownloadServer = { uri: vscode.Uri; dispose: () => void };
type RunProcessOptions = { cwd?: string; output?: vscode.OutputChannel };
type HtmlPreviewMessage = { type?: string; ratio?: number };

export class PandocBuildRunner {
  declare output: import("vscode").OutputChannel;
  declare contextRefreshId: number;
  declare htmlPreviewPanel: vscode.WebviewPanel | undefined;
  declare htmlPreviewDocumentUri: vscode.Uri | undefined;
  declare htmlPreviewTimer: NodeJS.Timeout | undefined;
  declare htmlPreviewBuildId: number;
  declare htmlPreviewSyncing: boolean;
  declare htmlPreviewBuildRunning: boolean;
  declare htmlPreviewRefreshPending: boolean;
  declare htmlPreviewLastPreviewMessageAt: number;
  declare htmlPreviewScrollSyncUntil: number;
  declare htmlPreviewLastSourceRatio: number;
  /**
   * Creates the Papper build runner used by the editor-title commands.
   *
   * @param output Output channel for build logs.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.contextRefreshId = 0;
    this.htmlPreviewPanel = undefined;
    this.htmlPreviewDocumentUri = undefined;
    this.htmlPreviewTimer = undefined;
    this.htmlPreviewBuildId = 0;
    this.htmlPreviewSyncing = false;
    this.htmlPreviewBuildRunning = false;
    this.htmlPreviewRefreshPending = false;
    this.htmlPreviewLastPreviewMessageAt = 0;
    this.htmlPreviewScrollSyncUntil = 0;
    this.htmlPreviewLastSourceRatio = -1;
  }

  /**
   * Recomputes whether the active editor should show the Papper build buttons.
   *
   */
  async refreshContext() {
    const refreshId = this.contextRefreshId + 1;
    this.contextRefreshId = refreshId;

    const canBuild = await this.canBuildActiveDocument();
    const canBuildHtml = await this.canBuildHtmlActiveDocument();
    if (refreshId !== this.contextRefreshId) {
      return;
    }

    await vscode.commands.executeCommand("setContext", CAN_BUILD_DOCX_CONTEXT, canBuild);
    await vscode.commands.executeCommand("setContext", CAN_BUILD_HTML_CONTEXT, canBuildHtml);
  }

  /**
   * Returns whether the current editor is a buildable manuscript Markdown file.
   *
   */
  async canBuildActiveDocument() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      return false;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    if (!project) {
      return false;
    }

    return isUvxAvailable();
  }

  /**
   * Returns whether the active Markdown file can be rendered by Papper as HTML.
   *
   * HTML preview uses the same saved-file and `style.yml` project boundary as
   * the DOCX command, so non-Papper workspaces do not expose this feature.
   */
  async canBuildHtmlActiveDocument() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      return false;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    return Boolean(project) && isUvxAvailable();
  }

  /**
   * Builds the active Markdown file as DOCX and opens the result externally.
   *
   * The button is hidden unless these checks pass, but command-palette calls can
   * still reach this path, so the user gets a precise reason instead of silence.
   *
   */
  async buildActiveMarkdownDocx() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      vscode.window.showWarningMessage("Open a saved Markdown file before building DOCX.");
      return;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    if (!project) {
      vscode.window.showWarningMessage("This Markdown file is not inside a Pandoc manuscript template project.");
      await this.refreshContext();
      return;
    }

    if (!(await isUvxAvailable())) {
      vscode.window.showErrorMessage("Cannot build DOCX because `uvx` is not available on PATH.");
      await this.refreshContext();
      return;
    }

    const docxUri = getExpectedDocxUri(project.rootUri, editor.document.uri);
    if (await isFileLockedForOverwrite(docxUri)) {
      const message = getCloseDocxBeforeBuildMessage(path.basename(docxUri.fsPath));
      this.output.appendLine(`[DOCX] Target DOCX is already open or not writable: ${docxUri.fsPath}`);
      await vscode.window.showWarningMessage(message, { modal: true });
      return;
    }

    const saved = await editor.document.save();
    if (!saved) {
      vscode.window.showWarningMessage("The Markdown file must be saved before building DOCX.");
      return;
    }

    await this.runDocxBuild(project, editor.document);
    await this.refreshContext();
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

    if (!(await isUvxAvailable())) {
      vscode.window.showErrorMessage("Cannot build HTML preview because `uvx` is not available on PATH.");
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

  /**
   * Synchronizes the source editor's visible line with the HTML preview.
   *
   * The generated Papper HTML does not expose Pandoc source-line markers, so
   * the stable fallback is proportional document-to-page scrolling.
   *
   * @param editor Editor whose visible range changed.
   */
  syncHtmlPreviewFromEditor(editor: vscode.TextEditor) {
    if (!this.htmlPreviewPanel || !this.htmlPreviewDocumentUri || !isSameUri(this.htmlPreviewDocumentUri, editor.document.uri) || this.htmlPreviewSyncing || Date.now() < this.htmlPreviewScrollSyncUntil) {
      return;
    }

    const visibleRange = editor.visibleRanges[0];
    const denominator = Math.max(1, editor.document.lineCount - 1);
    const ratio = Math.max(0, Math.min(1, visibleRange.start.line / denominator));
    if (Math.abs(ratio - this.htmlPreviewLastSourceRatio) < 0.01) {
      return;
    }
    this.htmlPreviewLastSourceRatio = ratio;
    void this.htmlPreviewPanel.webview.postMessage({ type: "sourceScroll", ratio });
  }

  /**
   * Disposes preview resources when the extension deactivates.
   */
  dispose() {
    if (this.htmlPreviewTimer) {
      clearTimeout(this.htmlPreviewTimer);
    }
    this.htmlPreviewPanel?.dispose();
    this.htmlPreviewPanel = undefined;
  }

  /**
   * Runs `uvx papper build docx <current-file>` and opens the output DOCX.
   *
   * @param project Detected manuscript project root.
   * @param document Markdown document to build.
   */
  async runDocxBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);
    const docxUri = getExpectedDocxUri(project.rootUri, document.uri);
    const args = ["papper", "build", "docx", markdownRelativePath];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[DOCX] Building ${markdownRelativePath}`);
    this.output.appendLine(`[DOCX] Working directory: ${project.rootUri.fsPath}`);
    this.output.appendLine(`[DOCX] Command: uvx ${args.join(" ")}`);

    try {
      await runProcess("uvx", args, { cwd: project.rootUri.fsPath, output: this.output });
      if (!(await pathExists(docxUri))) {
        throw new Error(`Build finished, but the expected DOCX was not found: ${docxUri.fsPath}`);
      }

      const opened = await openDocxInLocalWord(docxUri, this.output);
      if (!opened) {
        throw new Error(`VS Code could not open the DOCX in local Word: ${docxUri.fsPath}`);
      }

      this.output.appendLine(`[DOCX] Opened ${docxUri.fsPath}`);
      vscode.window.setStatusBarMessage(`$(check) Built and opened ${path.basename(docxUri.fsPath)}.`, 5000);
    } catch (error) {
      const message = `Failed to build DOCX: ${String(error.message || error)}`;
      this.output.appendLine(`[DOCX] ${message}`);
      vscode.window.showErrorMessage(message);
    }
  }

  /**
   * Runs Papper's HTML target and updates the open side preview panel.
   *
   * @param project Detected manuscript project root.
   * @param document Markdown document to build.
   */
  async runHtmlBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const buildId = ++this.htmlPreviewBuildId;
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);
    const htmlUri = getExpectedHtmlUri(project.rootUri, document.uri);
    const htmlRelativePath = path.relative(project.rootUri.fsPath, htmlUri.fsPath);
    const temporaryMarkdownPath = path.join(path.dirname(document.uri.fsPath), `.pmt-preview-${process.pid}-${buildId}-${path.basename(document.uri.fsPath)}`);
    const temporaryMarkdownRelativePath = path.relative(project.rootUri.fsPath, temporaryMarkdownPath);
    const args = ["papper", "build", "html", temporaryMarkdownRelativePath, "--output-file", htmlRelativePath];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[HTML] Building ${markdownRelativePath}`);
    this.output.appendLine(`[HTML] Working directory: ${project.rootUri.fsPath}`);
    this.output.appendLine(`[HTML] Command: uvx ${args.join(" ")}`);

    try {
      await fs.writeFile(temporaryMarkdownPath, document.getText(), "utf8");
      await runProcess("uvx", args, { cwd: project.rootUri.fsPath, output: this.output });
      if (buildId !== this.htmlPreviewBuildId) {
        return;
      }
      if (!(await pathExists(htmlUri))) {
        throw new Error(`Build finished, but the expected HTML was not found: ${htmlUri.fsPath}`);
      }

      await this.updateHtmlPreviewPanel(htmlUri, document, project);
      this.output.appendLine(`[HTML] Updated side preview ${htmlUri.fsPath}`);
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
  openHtmlPreview(document: vscode.TextDocument, project: PandocManuscriptProject) {
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
    panel.webview.onDidReceiveMessage((message: HtmlPreviewMessage) => {
      if (message.type === "ready") {
        this.htmlPreviewLastSourceRatio = -1;
        const editor = vscode.window.visibleTextEditors.find((candidate) => this.htmlPreviewDocumentUri && isSameUri(candidate.document.uri, this.htmlPreviewDocumentUri));
        if (editor) {
          this.syncHtmlPreviewFromEditor(editor);
        }
        return;
      }
      if (message.type !== "previewScroll" || typeof message.ratio !== "number" || !this.htmlPreviewDocumentUri) {
        return;
      }
      const now = Date.now();
      if (now - this.htmlPreviewLastPreviewMessageAt < 60) {
        return;
      }
      this.htmlPreviewLastPreviewMessageAt = now;
      const editor = vscode.window.visibleTextEditors.find((candidate) => isSameUri(candidate.document.uri, this.htmlPreviewDocumentUri!));
      if (!editor) {
        return;
      }
      const line = Math.round(Math.max(0, Math.min(1, message.ratio)) * Math.max(0, editor.document.lineCount - 1));
      this.htmlPreviewSyncing = true;
      this.htmlPreviewScrollSyncUntil = now + 220;
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      setTimeout(() => {
        this.htmlPreviewSyncing = false;
      }, 80);
    });
    panel.onDidDispose(() => {
      if (this.htmlPreviewPanel === panel) {
        this.htmlPreviewPanel = undefined;
        this.htmlPreviewDocumentUri = undefined;
      }
    });
  }

  /**
   * Rebuilds the current preview and keeps the side panel alive.
   *
   * @param document Source Markdown document.
   * @param project Optional already detected Papper project.
   */
  async refreshHtmlPreview(document: vscode.TextDocument, project?: PandocManuscriptProject) {
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
    this.htmlPreviewPanel.webview.html = injectHtmlPreviewBridge(rewrittenHtml, nonce, this.htmlPreviewPanel.webview.cspSource);
    const visibleRange = vscode.window.visibleTextEditors.find((editor) => isSameUri(editor.document.uri, document.uri))?.visibleRanges[0];
    if (visibleRange) {
      const ratio = Math.max(0, Math.min(1, visibleRange.start.line / Math.max(1, document.lineCount - 1)));
      this.htmlPreviewLastSourceRatio = ratio;
      void this.htmlPreviewPanel.webview.postMessage({ type: "sourceScroll", ratio });
    }
  }
}


async function findPandocManuscriptProject(markdownUri: vscode.Uri): Promise<PandocManuscriptProject | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(markdownUri);
  const stopAtPath = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
  let currentPath = path.dirname(markdownUri.fsPath);

  while (true) {
    const project = await readPandocManuscriptProject(vscode.Uri.file(currentPath));
    if (project) {
      return project;
    }

    if (stopAtPath && isSameFsPath(currentPath, stopAtPath)) {
      return undefined;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

/**
 * Returns manuscript project metadata when a directory has the required layout.
 *
 * `style.yml` marks the main manuscript directory in current templates. The
 * older Pandoc defaults path is no longer required for showing the DOCX button.
 *
 * @param rootUri Candidate project root.
 */
async function readPandocManuscriptProject(rootUri: vscode.Uri) {
  if (!(await pathExists(vscode.Uri.joinPath(rootUri, "style.yml")))) {
    return undefined;
  }

  return { rootUri };
}

/**
 * Checks whether a file or directory exists.
 *
 * @param uri File or directory URI.
 */
async function pathExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether an existing output file is likely locked by Word.
 *
 * The build overwrites and post-processes the DOCX in place. On Windows, Word
 * usually denies a read/write open while the document is open, so this catches
 * the common failure before Pandoc spends time rebuilding the manuscript.
 *
 * @param uri Target DOCX URI.
 */
async function isFileLockedForOverwrite(uri: vscode.Uri) {
  if (!(await pathExists(uri))) {
    return false;
  }

  let handle;
  try {
    handle = await fs.open(uri.fsPath, "r+");
    return false;
  } catch (error) {
    return isFileLockError(error);
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

/**
 * Returns whether a filesystem error indicates a file lock or write denial.
 *
 * @param error Filesystem error.
 */
function isFileLockError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && ["EBUSY", "EPERM", "EACCES"].includes(String(error.code)));
}

/**
 * Returns the modal warning text for a locked DOCX output file.
 *
 * @param fileName DOCX filename.
 */
function getCloseDocxBeforeBuildMessage(fileName: string) {
  if (isChineseVscodeLanguage()) {
    return `目标 Word 文件 ${fileName} 已经打开或无法写入。请先在 Word 中关闭它，然后再重新编译。`;
  }
  return `The target Word file ${fileName} is already open or not writable. Close it in Word, then try building again.`;
}

/**
 * Checks whether VS Code is currently using a Chinese UI locale.
 *
 */
function isChineseVscodeLanguage() {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

/**
 * Opens a generated DOCX with the user's local Word application.
 *
 * Remote extension hosts cannot write a local temp file directly. For remote
 * workspaces, serve the remote DOCX through a short-lived forwarded URL and ask
 * the local Word URI handler to download and open that URL.
 *
 * @param docxUri Generated DOCX URI.
 * @param output Output channel for diagnostics.
 */
async function openDocxInLocalWord(docxUri: vscode.Uri, output: vscode.OutputChannel) {
  if (!vscode.env.remoteName) {
    return vscode.env.openExternal(docxUri);
  }

  if (vscode.env.uiKind === vscode.UIKind.Web) {
    throw new Error("Opening local Word is not available from the VS Code web UI.");
  }

  const downloadServer = await createRemoteDocxDownloadServer(docxUri, output);
  try {
    const externalUri = await vscode.env.asExternalUri(downloadServer.uri);
    const wordUri = vscode.Uri.parse(`ms-word:ofv|u|${externalUri.toString(true)}`);
    output.appendLine(`[DOCX] Opening local Word through forwarded URL: ${externalUri.toString(true)}`);
    output.appendLine(`[DOCX] Word URI: ${wordUri.toString(true)}`);
    const opened = await vscode.env.openExternal(wordUri);
    if (!opened) {
      downloadServer.dispose();
    }
    return opened;
  } catch (error) {
    downloadServer.dispose();
    throw error;
  }
}

/**
 * Creates a short-lived HTTP server that serves one generated DOCX file.
 *
 * @param docxUri Generated DOCX URI on the extension host.
 * @param output Output channel for diagnostics.
 */
async function createRemoteDocxDownloadServer(docxUri: vscode.Uri, output: vscode.OutputChannel) {
  const fileName = path.basename(docxUri.fsPath);
  const token = crypto.randomBytes(16).toString("hex");
  const requestPathPrefix = `/download/${token}/`;
  const requestPath = `${requestPathPrefix}${encodeURIComponent(fileName)}`;
  const stat = await fs.stat(docxUri.fsPath);

  return new Promise<DocxDownloadServer>((resolve, reject) => {
    let closeTimer: NodeJS.Timeout | undefined;
    const server = http.createServer(async (request, response) => {
      try {
        logDocxDownloadRequest(request, output);
        if (!isDocxDownloadRequest(request, requestPath, requestPathPrefix)) {
          output.appendLine(`[DOCX] Rejected forwarded DOCX request: ${request.method || "UNKNOWN"} ${request.url || "/"}`);
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        if (request.method === "OPTIONS") {
          writeDocxOptionsResponse(response);
          closeTimer = scheduleServerClose(server, closeTimer, 120000);
          return;
        }

        if (request.method === "PROPFIND") {
          writeDocxPropfindResponse(response, requestPath, fileName, stat);
          closeTimer = scheduleServerClose(server, closeTimer, 120000);
          return;
        }

        const range = parseHttpRange(request.headers.range, stat.size);
        if (request.headers.range && !range) {
          response.writeHead(416, {
            "Content-Range": `bytes */${stat.size}`,
          });
          response.end();
          closeTimer = scheduleServerClose(server, closeTimer, 120000);
          return;
        }

        const responseHeaders: Record<string, string | number> = {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${escapeHeaderFileName(fileName)}"`,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        };

        if (range) {
          responseHeaders["Accept-Ranges"] = "bytes";
          responseHeaders["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
          responseHeaders["Content-Length"] = range.end - range.start + 1;
          response.writeHead(206, responseHeaders);
        } else {
          responseHeaders["Accept-Ranges"] = "bytes";
          responseHeaders["Content-Length"] = stat.size;
          response.writeHead(200, responseHeaders);
        }

        if (request.method === "HEAD") {
          response.end();
          closeTimer = scheduleServerClose(server, closeTimer, 120000);
          return;
        }

        const bytes = await fs.readFile(docxUri.fsPath);
        response.end(range ? bytes.subarray(range.start, range.end + 1) : bytes);
        output.appendLine(`[DOCX] Served forwarded DOCX download${range ? ` range ${range.start}-${range.end}` : ""}: ${docxUri.fsPath}`);
        closeTimer = scheduleServerClose(server, closeTimer, 30000);
      } catch (error) {
        output.appendLine(`[DOCX] Failed to serve forwarded DOCX download: ${String(error)}`);
        response.writeHead(500);
        response.end("Failed to read DOCX");
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine DOCX download server port."));
        return;
      }

      const uri = vscode.Uri.parse(`http://127.0.0.1:${address.port}${requestPath}`);
      closeTimer = scheduleServerClose(server, closeTimer, 120000);
      output.appendLine(`[DOCX] Started temporary DOCX download server: ${uri.toString(true)}`);
      resolve({
        uri,
        dispose: () => {
          if (closeTimer) {
            clearTimeout(closeTimer);
          }
          server.close();
        },
      });
    });
  });
}

/**
 * Writes the Office/WebDAV capability response Word asks for before fetching.
 *
 * @param response HTTP response.
 */
function writeDocxOptionsResponse(response: import("http").ServerResponse) {
  response.writeHead(200, {
    "Allow": "GET, HEAD, OPTIONS, PROPFIND",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, PROPFIND",
    "Access-Control-Allow-Origin": "*",
    "DAV": "1, 2",
    "MS-Author-Via": "DAV",
    "X-MSDAVEXT": "1",
    "Content-Length": 0,
  });
  response.end();
}

/**
 * Writes a minimal WebDAV property response for Word's URL probe.
 *
 * @param response HTTP response.
 * @param requestPath Tokenized full download path.
 * @param fileName DOCX filename.
 * @param stat DOCX file stat.
 */
function writeDocxPropfindResponse(response: import("http").ServerResponse, requestPath: string, fileName: string, stat: import("fs").Stats) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${escapeXml(requestPath)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(fileName)}</D:displayname>
        <D:getcontentlength>${stat.size}</D:getcontentlength>
        <D:getcontenttype>application/vnd.openxmlformats-officedocument.wordprocessingml.document</D:getcontenttype>
        <D:getlastmodified>${stat.mtime.toUTCString()}</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  response.writeHead(207, {
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "DAV": "1, 2",
    "MS-Author-Via": "DAV",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(body);
}

/**
 * Logs one forwarded DOCX request without dumping all headers.
 *
 * @param request HTTP request.
 * @param output Output channel for diagnostics.
 */
function logDocxDownloadRequest(request: import("http").IncomingMessage, output: vscode.OutputChannel) {
  const host = request.headers.host || "";
  const userAgent = request.headers["user-agent"] || "";
  const range = request.headers.range || "";
  output.appendLine(`[DOCX] Forwarded DOCX request: ${request.method || "UNKNOWN"} ${request.url || "/"} host=${host} range=${range} ua=${userAgent}`);
}

/**
 * Checks whether an HTTP request is allowed to download the generated DOCX.
 *
 * @param request HTTP request.
 * @param requestPath Tokenized download path.
 * @param requestPathPrefix Tokenized download path prefix.
 */
function isDocxDownloadRequest(request: import("http").IncomingMessage, requestPath: string, requestPathPrefix: string) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && request.method !== "PROPFIND") {
    return false;
  }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  return requestUrl.pathname === requestPath || requestUrl.pathname === requestPathPrefix;
}

/**
 * Parses a single HTTP byte range.
 *
 * @param rangeHeader Range header value.
 * @param size Total file size.
 */
function parseHttpRange(rangeHeader: string | undefined, size: number) {
  if (!rangeHeader || size <= 0) {
    return undefined;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return undefined;
  }

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) {
    return undefined;
  }

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return undefined;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

/**
 * Schedules an HTTP server close, replacing the existing close timer.
 *
 * @param server HTTP server.
 * @param existingTimer Existing close timer.
 * @param delayMs Delay before close.
 */
function scheduleServerClose(server: import("http").Server, existingTimer: NodeJS.Timeout | undefined, delayMs: number) {
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  return setTimeout(() => server.close(), delayMs);
}

/**
 * Escapes a filename for a simple quoted Content-Disposition header.
 *
 * @param fileName Filename.
 */
function escapeHeaderFileName(fileName: string) {
  return fileName.replace(/["\r\n]/g, "_");
}

/**
 * Escapes text for a small XML response body.
 *
 * @param value Raw XML text value.
 */
function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Returns the DOCX path produced by Papper for a Markdown input file.
 *
 * @param rootUri Project root URI.
 * @param markdownUri Markdown file URI.
 */
function getExpectedDocxUri(rootUri: vscode.Uri, markdownUri: vscode.Uri) {
  const outputName = `${path.parse(markdownUri.fsPath).name}.docx`;
  return vscode.Uri.file(path.join(rootUri.fsPath, "output", "docx", outputName));
}

/**
 * Returns the HTML path produced by Papper for a Markdown input file.
 *
 * @param rootUri Project root URI.
 * @param markdownUri Markdown file URI.
 */
function getExpectedHtmlUri(rootUri: vscode.Uri, markdownUri: vscode.Uri) {
  const outputName = `${path.parse(markdownUri.fsPath).name}.html`;
  return vscode.Uri.file(path.join(rootUri.fsPath, "output", "html", outputName));
}

/**
 * Checks whether `uvx` can be executed from the VS Code extension host.
 *
 */
async function isUvxAvailable() {
  try {
    await runProcess("uvx", ["--version"], {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a child process and optionally streams output to the extension channel.
 *
 * @param command Command executable.
 * @param args Command arguments.
 * @param options Process options.
 */
function runProcess(command: string, args: string[], options: RunProcessOptions) {
  return new Promise<void>((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    if (options.output) {
      child.stdout.on("data", (chunk) => options.output.append(chunk.toString()));
      child.stderr.on("data", (chunk) => options.output.append(chunk.toString()));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Compares filesystem paths with Windows casing rules.
 *
 * @param left Left path.
 * @param right Right path.
 */
function isSameFsPath(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

/**
 * Compares two file URIs using the same platform-aware path rules as project detection.
 *
 * @param left First URI.
 * @param right Second URI.
 */
function isSameUri(left: vscode.Uri, right: vscode.Uri) {
  return left.scheme === right.scheme && isSameFsPath(left.fsPath, right.fsPath);
}

/**
 * Creates a nonce for the inline Webview scroll bridge script.
 */
function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Removes a temporary Markdown mirror, retrying briefly if Papper still holds it.
 *
 * @param filePath Temporary Markdown path.
 * @param output Output channel for an unusual cleanup failure.
 */
async function removeTemporaryMarkdown(filePath: string, output: vscode.OutputChannel) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return;
    }
  }
  output.appendLine(`[HTML] Could not remove temporary Markdown mirror: ${filePath}`);
}

/**
 * Returns whether a filesystem error means the temporary file is already gone.
 *
 * @param error Filesystem error.
 */
function isFileNotFoundError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code) === "ENOENT");
}

/**
 * Counts one HTML element type without parsing or rewriting its contents.
 *
 * @param html HTML source.
 * @param elementName Element name to count.
 */
function countHtmlElements(html: string, elementName: string) {
  return (html.match(new RegExp(`<${elementName}\\b`, "gi")) || []).length;
}

/**
 * Rewrites local HTML resources into Webview-safe URIs.
 *
 * Papper's HTML output keeps relative image/resource paths. Webviews cannot
 * load those paths directly, so resolve them against the Markdown directory.
 *
 * @param html Generated HTML.
 * @param webview Target Webview.
 * @param sourceDirectory Directory containing the source Markdown file.
 */
function rewriteHtmlResourceUris(html: string, webview: vscode.Webview, sourceDirectory: string) {
  return html.replace(/(\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix: string, value: string, suffix: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) {
      return match;
    }
    const resourcePath = path.resolve(sourceDirectory, value);
    return `${prefix}${webview.asWebviewUri(vscode.Uri.file(resourcePath)).toString()}${suffix}`;
  });
}

/**
 * Injects the Webview scroll bridge into generated standalone HTML.
 *
 * @param html Generated HTML.
 * @param nonce Script nonce.
 * @param cspSource Webview CSP source token.
 */
function injectHtmlPreviewBridge(html: string, nonce: string, cspSource: string) {
  const bridge = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline' data: blob:; style-src-elem ${cspSource} 'unsafe-inline' data: blob:; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource} data: blob:; media-src ${cspSource} data: blob:;"><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let suppressScroll = false;
let scrollFrame = 0;
let lastSentRatio = -1;
function scrollRatio() {
  const root = document.documentElement;
  const max = Math.max(1, root.scrollHeight - window.innerHeight);
  return Math.max(0, Math.min(1, window.scrollY / max));
}
// Remove Webview-injected style elements while preserving every style from Pandoc's HTML.
const removeNonPandocStyles = () => {
  document.querySelectorAll('style:not([data-papper-preview-style="pandoc"])').forEach(style => style.remove());
};
const styleObserver = new MutationObserver(removeNonPandocStyles);
styleObserver.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', removeNonPandocStyles, { once: true });
removeNonPandocStyles();
window.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'sourceScroll') return;
  const root = document.documentElement;
  const max = Math.max(0, root.scrollHeight - window.innerHeight);
  suppressScroll = true;
  window.scrollTo({ top: Math.max(0, Math.min(1, event.data.ratio || 0)) * max, behavior: 'auto' });
  window.setTimeout(() => { suppressScroll = false; }, 180);
});
window.addEventListener('scroll', () => {
  if (suppressScroll || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (suppressScroll) return;
    const ratio = scrollRatio();
    if (Math.abs(ratio - lastSentRatio) < 0.01) return;
    lastSentRatio = ratio;
    vscode.postMessage({ type: 'previewScroll', ratio });
  });
}, { passive: true });
window.addEventListener('load', () => vscode.postMessage({ type: 'ready' }), { once: true });
vscode.postMessage({ type: 'ready' });
</script>`;
  const withoutExistingCsp = html.replace(/<meta\s+http-equiv=["']content-security-policy["'][^>]*>\s*/gi, "");
  const markedPandocStyles = withoutExistingCsp.replace(/<style(?=[\s>])/gi, '<style data-papper-preview-style="pandoc"');
  const headIndex = markedPandocStyles.search(/<head(?:\s[^>]*)?>/i);
  if (headIndex >= 0) {
    const end = markedPandocStyles.indexOf(">", headIndex) + 1;
    return `${markedPandocStyles.slice(0, end)}${bridge}${markedPandocStyles.slice(end)}`;
  }
  return `${bridge}${markedPandocStyles}`;
}






