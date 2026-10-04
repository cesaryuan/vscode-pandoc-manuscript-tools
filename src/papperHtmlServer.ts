import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

type PreviewOutput = { appendLine(message: string): void };
type ServerConnection = { host: string; port: number };
type ServerResponse = { body: string; headers: http.IncomingHttpHeaders };
type StartServer = (projectDirectory: string, sourcePath: string, port: number) => Promise<void>;

/** Reuses project-bound Papper services and sends unsaved Markdown over local HTTP. */
export class PapperHtmlServerClient {
  private readonly agent = new http.Agent({ keepAlive: true });
  private readonly connections = new Map<string, Promise<ServerConnection>>();
  private disposed = false;

  /** Keeps CLI startup lazy; a separate Papper home lets callers isolate service state. */
  constructor(
    private readonly output: PreviewOutput,
    private readonly startServer: StartServer,
    private readonly papperHome = process.env.PAPPER_HOME || path.join(os.homedir(), ".papper"),
  ) {}

  /** Closes this client's HTTP sockets while leaving reusable Papper services running. */
  dispose(): void {
    this.disposed = true;
    this.agent.destroy();
    this.connections.clear();
  }

  /** Converts the editor buffer without writing it to the user's source file. */
  async convert(projectDirectory: string, sourcePath: string, text: string): Promise<string> {
    const project = await fs.realpath(projectDirectory);
    const key = normalizePath(project);
    for (let attempt = 0; attempt < 2; attempt++) {
      const connection = await this.ensureConnection(project, sourcePath);
      const started = Date.now();
      try {
        const response = await this.request(connection, "/convert/raw", { path: sourcePath, text });
        this.output.appendLine(`[HTML][HTTP] Built ${path.basename(sourcePath)} in ${Date.now() - started} ms (HTML cache ${response.headers["x-pmt-cache"] || "unknown"}, citation cache ${response.headers["x-pmt-citeproc-cache"] || "unknown"})`);
        return response.body;
      } catch (error) {
        // Retry transport failures only: malformed Markdown and HTTP errors must
        // preserve the current preview instead of restarting a healthy worker.
        if (attempt > 0 || !["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code)) {
          throw error;
        }
        this.connections.delete(key);
        this.output.appendLine("[HTML][HTTP] Service connection lost; checking the project service again");
      }
    }
    throw new Error("Papper HTML service could not be reached");
  }

  /** Coalesces startup for the same canonical project directory. */
  private ensureConnection(project: string, sourcePath: string): Promise<ServerConnection> {
    if (this.disposed) {
      return Promise.reject(new Error("Papper HTML preview has been disposed"));
    }
    const key = normalizePath(project);
    let pending = this.connections.get(key);
    if (!pending) {
      pending = this.connect(project, sourcePath).catch((error) => {
        this.connections.delete(key);
        throw error;
      });
      this.connections.set(key, pending);
    }
    return pending;
  }

  /** Checks persisted state, starts a missing service once, and verifies its protocol. */
  private async connect(project: string, sourcePath: string): Promise<ServerConnection> {
    const existing = await this.readConnections(project);
    for (const connection of existing) {
      if (await this.isCompatible(connection, project)) {
        this.output.appendLine(`[HTML][HTTP] Reusing http://${connection.host}:${connection.port} for ${project}`);
        return connection;
      }
    }

    // Reuse a stopped project's port when possible, but never claim a port
    // currently occupied by another project or an unrelated HTTP service.
    const port = await findAvailablePort(existing[0]?.port);
    this.output.appendLine(`[HTML][HTTP] Starting Papper service for ${project} on port ${port}`);
    await this.startServer(project, sourcePath, port);
    if (this.disposed) {
      throw new Error("Papper HTML preview has been disposed");
    }
    // Probe the requested endpoint directly: CLI success can mean a one-shot
    // build on older Papper versions when the bootstrap source is external.
    const started = { host: "127.0.0.1", port };
    if (!await this.isCompatible(started, project)) {
      const stateDirectory = this.projectStateDirectory(project);
      throw new Error(`Papper HTML service at http://127.0.0.1:${port} did not pass the project/editor-text check; see the HTTP diagnostics above and ${path.join(stateDirectory, "work", "rust-v1", "server.log")} (Rust) or ${path.join(stateDirectory, "pandoc-server.log")} (legacy). Papper must support --start-server with a Markdown file outside the project`);
    }
    return started;
  }

  /** Derives the shared legacy/native project identity from its canonical directory. */
  private projectStateDirectory(project: string): string {
    const projectId = crypto.createHash("sha256").update(normalizePath(project)).digest("hex").slice(0, 20);
    return path.join(this.papperHome, "projects", projectId);
  }

  /** Reads both service layouts so stale native state cannot hide a healthy legacy service. */
  private async readConnections(project: string): Promise<ServerConnection[]> {
    const stateDirectory = this.projectStateDirectory(project);
    const layouts = [
      [path.join(stateDirectory, "work", "rust-v1"), "server-state.json", "server-config.json"],
      [stateDirectory, "pandoc-server.json", "pandoc-server-config.json"],
    ];
    const connections: ServerConnection[] = [];
    for (const [directory, stateName, configName] of layouts) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(directory, stateName), "utf8"));
        const configuration = JSON.parse(await fs.readFile(path.join(directory, configName), "utf8"));
        if (state.host !== "127.0.0.1" || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
          || typeof configuration.project_dir !== "string"
          || normalizePath(await fs.realpath(configuration.project_dir)) !== normalizePath(project)) {
          this.output.appendLine(`[HTML][HTTP] Ignoring invalid or mismatched service state: ${path.join(directory, stateName)}`);
          continue;
        }
        connections.push({ host: state.host, port: state.port });
      } catch (error) {
        // Missing, partial, or stale state must leave other layouts available.
        if (error.code !== "ENOENT") {
          this.output.appendLine(`[HTML][HTTP] Could not read service state ${path.join(directory, stateName)}: ${String(error.message || error)}`);
        }
      }
    }
    return connections;
  }

  /** Requires buffer support and project identity so an old or foreign service cannot render stale text. */
  private async isCompatible(connection: ServerConnection, project: string): Promise<boolean> {
    try {
      const response = await this.request(connection, "/version", undefined, 1500);
      const version = JSON.parse(response.body);
      const compatible = version.protocol === "pmt-html-v1" && version.source_text === true
        && typeof version.project_dir === "string" && normalizePath(version.project_dir) === normalizePath(project);
      if (!compatible) {
        this.output.appendLine(`[HTML][HTTP] Incompatible /version at http://${connection.host}:${connection.port}: ${response.body.slice(0, 8192)}`);
      }
      return compatible;
    } catch (error) {
      this.output.appendLine(`[HTML][HTTP] Service check failed at http://${connection.host}:${connection.port}/version: ${String(error.message || error)}`);
      return false;
    }
  }

  /** Uses a proxy-free keep-alive client with a deadline and readable HTTP failures. */
  private request(connection: ServerConnection, endpoint: string, payload?: object, timeout = 120000): Promise<ServerResponse> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");
      const request = http.request({
        hostname: connection.host,
        port: connection.port,
        path: endpoint,
        method: body ? "POST" : "GET",
        agent: this.agent,
        headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Papper ${endpoint} returned HTTP ${response.statusCode}: ${responseBody.slice(0, 8192)}`));
          } else {
            resolve({ body: responseBody, headers: response.headers });
          }
        });
      });
      const deadline = setTimeout(() => request.destroy(new Error(`Papper ${endpoint} timed out after ${timeout / 1000} seconds`)), timeout);
      request.on("close", () => clearTimeout(deadline));
      request.on("error", reject);
      request.end(body);
    });
  }
}

/** Matches Python os.path.normcase for Papper's project hash and identity checks. */
function normalizePath(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Reserves a free loopback port briefly, falling back when persisted state names a busy port. */
async function findAvailablePort(preferred?: number): Promise<number> {
  try {
    return await probePort(preferred || 0);
  } catch (error) {
    if (!preferred || error.code !== "EADDRINUSE") {
      throw error;
    }
    return probePort(0);
  }
}

/** Uses the OS allocator to choose a local port without hard-coding a shared project port. */
function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const assigned = (server.address() as net.AddressInfo).port;
      server.close((error) => error ? reject(error) : resolve(assigned));
    });
  });
}
