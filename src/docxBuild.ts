import * as fs from "fs/promises";
import * as http from "http";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { findExistingPapperExecutable, findPandocManuscriptProject, isPapperBuildAvailable, preparePapperEnvironment, resolvePapperExecutable, runProcess, type PandocManuscriptProject } from "./papperBuildUtils";
import { isBuildableMarkdownDocument } from "./vscodeUtils";

type DocxDownloadServer = { uri: vscode.Uri; dispose: () => void };

export class PandocBuildRunner {
  declare output: import("vscode").OutputChannel;

  /** Creates the Papper build runner used by DOCX and inlay-hint commands. */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * Builds the title action's Markdown file, or the active file for palette commands.
   *
   * Any saved Markdown is eligible; tool availability is checked on invocation.
   *
   */
  async buildActiveMarkdownDocx(uri?: vscode.Uri) {
    // An inactive editor title action must save/build its own resource, not the focused file.
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !isBuildableMarkdownDocument(document)) {
      vscode.window.showWarningMessage("Open a saved Markdown file before building DOCX.");
      return;
    }

    if (!(await isPapperBuildAvailable())) {
      vscode.window.showErrorMessage("Cannot build DOCX because `papper` is not on PATH and `uv` is not available to install it.");
      return;
    }

    const saved = await document.save();
    if (!saved) {
      vscode.window.showWarningMessage("The Markdown file must be saved before building DOCX.");
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在转换 DOCX：${path.basename(document.uri.fsPath)}`,
        cancellable: false,
      },
      /** Keeps progress indeterminate until preparation, conversion, and opening finish. */
      async () => {
        const project = await findPandocManuscriptProject(document.uri)
          || { rootUri: vscode.Uri.file(path.dirname(document.uri.fsPath)) };
        await this.runDocxBuild(project, document);
      },
    );
  }

  /**
   * Builds and reads PMT's processed JSON AST for the current editor buffer.
   *
   * The Markdown mirror and AST share an OS temporary directory. This path
   * only uses an installed Papper executable and never auto-installs a CLI
   * during ordinary editor hint refreshes.
   *
   * @param document Markdown document to build.
   */
  async buildJsonAstForDocument(document: vscode.TextDocument): Promise<unknown | undefined> {
    if (!isBuildableMarkdownDocument(document)) {
      return undefined;
    }

    const project = await findPandocManuscriptProject(document.uri);
    if (!project) {
      return undefined;
    }

    const papperExecutable = await findExistingPapperExecutable();
    if (!papperExecutable) {
      return undefined;
    }

    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-numbering-"));
    const markdownMirrorPath = path.join(outputDirectory, path.basename(document.uri.fsPath));
    const astPath = path.join(outputDirectory, "ast.json");

    try {
      await fs.writeFile(markdownMirrorPath, document.getText(), "utf8");
      const environment = await preparePapperEnvironment(papperExecutable);
      const jsonBuildStartedAt = Date.now();
      this.output.appendLine(`[Inlay hints][timing] Papper JSON build started: ${path.basename(document.uri.fsPath)} version=${document.version}`);
      try {
        await runProcess(papperExecutable, ["build", "json", markdownMirrorPath, "--output-file", astPath], {
          cwd: project.rootUri.fsPath,
          env: environment.env,
        });
      } finally {
        this.output.appendLine(`[Inlay hints][timing] Papper JSON build ended: ${path.basename(document.uri.fsPath)} version=${document.version} duration=${Date.now() - jsonBuildStartedAt} ms`);
      }
      return JSON.parse(await fs.readFile(astPath, "utf8")) as unknown;
    } finally {
      await fs.rm(outputDirectory, { recursive: true, force: true }).catch((error) => {
        this.output.appendLine(`[Inlay hints] Could not remove temporary build directory: ${String(error)}`);
      });
    }
  }

  /**
   * Builds a unique temporary DOCX and leaves it available for Word to open/edit.
   *
   * @param project Detected manuscript project root or the source directory.
   * @param document Markdown document to build.
   */
  async runDocxBuild(project: PandocManuscriptProject, document: vscode.TextDocument) {
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[DOCX] Building ${markdownRelativePath}`);
    this.output.appendLine(`[DOCX] Working directory: ${project.rootUri.fsPath}`);

    try {
      const papperExecutable = await resolvePapperExecutable(this.output);
      // Unique destinations avoid overwriting a previous build still open in Word.
      const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-docx-"));
      const docxUri = vscode.Uri.file(path.join(outputDirectory, `${path.parse(document.uri.fsPath).name}.docx`));
      const args = ["build", "docx", markdownRelativePath, "--output-file", docxUri.fsPath];
      this.output.appendLine(`[DOCX] Output file: ${docxUri.fsPath}`);
      this.output.appendLine(`[DOCX] Command: papper ${args.map(argument => JSON.stringify(argument)).join(" ")}`);
      this.output.appendLine(`[DOCX] Resolved executable: ${papperExecutable}`);
      await runProcess(papperExecutable, args, { cwd: project.rootUri.fsPath, output: this.output });
      if (!(await pathExists(docxUri))) {
        throw new Error(`Build finished, but the expected DOCX was not found: ${docxUri.fsPath}`);
      }

      // Word opens asynchronously; keep the temporary file after the command returns.
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
