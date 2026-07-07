import * as cp from "child_process";
import * as fs from "fs/promises";
import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { CAN_BUILD_DOCX_CONTEXT } from "./constants";
import { isBuildableMarkdownDocument } from "./vscodeUtils";

const BUILD_SCRIPT_PATH = "scripts/build.py";

type PandocManuscriptProject = { rootUri: vscode.Uri; buildScript: string };
type DocxDownloadServer = { uri: vscode.Uri; dispose: () => void };
type RunProcessOptions = { cwd?: string; output?: vscode.OutputChannel };

export class PandocBuildRunner {
  declare output: import("vscode").OutputChannel;
  declare contextRefreshId: number;
  /**
   * Creates the DOCX build runner used by the editor-title command.
   *
   * @param output Output channel for build logs.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.contextRefreshId = 0;
  }

  /**
   * Recomputes whether the active editor should show the DOCX build button.
   *
   */
  async refreshContext() {
    const refreshId = this.contextRefreshId + 1;
    this.contextRefreshId = refreshId;

    const canBuild = await this.canBuildActiveDocument();
    if (refreshId !== this.contextRefreshId) {
      return;
    }

    await vscode.commands.executeCommand("setContext", CAN_BUILD_DOCX_CONTEXT, canBuild);
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

    return isUvAvailable();
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

    if (!(await isUvAvailable())) {
      vscode.window.showErrorMessage("Cannot build DOCX because `uv` is not available on PATH.");
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
   * Runs `uv run scripts/build... docx <current-file>` and opens the output DOCX.
   *
   * @param project Detected manuscript project root.
   * @param document Markdown document to build.
   */
  async runDocxBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);
    const docxUri = getExpectedDocxUri(project.rootUri, document.uri);
    const args = ["run", project.buildScript, "docx", markdownRelativePath];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[DOCX] Building ${markdownRelativePath}`);
    this.output.appendLine(`[DOCX] Working directory: ${project.rootUri.fsPath}`);
    this.output.appendLine(`[DOCX] Command: uv ${args.join(" ")}`);

    try {
      await runProcess("uv", args, { cwd: project.rootUri.fsPath, output: this.output });
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

  return { rootUri, buildScript: BUILD_SCRIPT_PATH };
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
 * Returns the DOCX path produced by scripts/build.py for a Markdown input file.
 *
 * @param rootUri Project root URI.
 * @param markdownUri Markdown file URI.
 */
function getExpectedDocxUri(rootUri: vscode.Uri, markdownUri: vscode.Uri) {
  const outputName = `${path.parse(markdownUri.fsPath).name}.docx`;
  return vscode.Uri.file(path.join(rootUri.fsPath, "output", "docx", outputName));
}

/**
 * Checks whether `uv` can be executed from the VS Code extension host.
 *
 */
async function isUvAvailable() {
  try {
    await runProcess("uv", ["--version"], {});
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






