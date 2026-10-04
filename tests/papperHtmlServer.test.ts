import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { PapperHtmlServerClient } from "../src/papperHtmlServer";

/** Provides real HTTP services and persisted state without invoking Python in client tests. */
class HtmlServiceFixture {
  readonly home: string;
  readonly servers: http.Server[] = [];
  starts = 0;
  rejectConversions = false;
  nativeState = false;

  /** Places project connection state outside the user's Papper home. */
  constructor(readonly directory: string) {
    this.home = path.join(directory, "papper-home");
  }

  /** Allocates isolated fixture storage and registers service/file cleanup. */
  static async create(context: TestContext): Promise<HtmlServiceFixture> {
    const fixture = new HtmlServiceFixture(await fs.mkdtemp(path.join(os.tmpdir(), "pmt-http-test-")));
    context.after(async () => {
      for (const server of fixture.servers) {
        await fixture.stop(server);
      }
      await fs.rm(fixture.directory, { recursive: true, force: true });
    });
    return fixture;
  }

  /** Creates a saved source so tests can observe source preservation. */
  async project(name: string): Promise<{ root: string; source: string }> {
    const root = path.join(this.directory, name);
    const source = path.join(root, "manuscript.md");
    await fs.mkdir(root);
    await fs.writeFile(source, "Saved document", "utf8");
    return { root, source };
  }

  /** Implements the Papper startup boundary, with requests handled by a real local server. */
  async start(root: string, _source: string, port: number): Promise<void> {
    const project = await fs.realpath(root);
    // This fixture returns the received snapshot as HTML; native output is
    // independently covered by Papper's real-worker integration tests.
    const server = http.createServer(async (request, response) => {
      if (request.url === "/version") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ protocol: "pmt-html-v1", source_text: true, project_dir: project }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (this.rejectConversions || !payload.path.startsWith(project + path.sep)) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "Invalid manuscript" }));
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<html><body data-project="${path.basename(project)}">${payload.text}</body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    this.servers.push(server);
    this.starts++;
    const canonical = process.platform === "win32" ? project.toLowerCase() : project;
    const projectId = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const state = path.join(this.home, "projects", projectId, ...(this.nativeState ? ["work", "rust-v1"] : []));
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, this.nativeState ? "server-config.json" : "pandoc-server-config.json"), JSON.stringify({ project_dir: project }));
    await fs.writeFile(path.join(state, this.nativeState ? "server-state.json" : "pandoc-server.json"), JSON.stringify({
      host: "127.0.0.1", port: (server.address() as import("net").AddressInfo).port,
    }));
  }

  /** Closes active keep-alive sockets as well as the listening port. */
  async stop(server: http.Server): Promise<void> {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  /** Creates a production client using the fixture's startup boundary and state location. */
  client(context: TestContext): PapperHtmlServerClient {
    const client = new PapperHtmlServerClient({ appendLine() {} }, this.start.bind(this), this.home);
    context.after(() => client.dispose());
    return client;
  }
}

/** Verifies lazy startup, warm refreshes, cross-session reuse, and source preservation. */
async function rendersUnsavedBuffersWithState(context: TestContext, nativeState: boolean): Promise<void> {
  const fixture = await HtmlServiceFixture.create(context);
  fixture.nativeState = nativeState;
  const { root, source } = await fixture.project("first-project");
  const client = fixture.client(context);
  assert.equal(fixture.starts, 0);
  const first = await client.convert(root, source, "Unsaved 编辑器文本");
  assert.match(first, /Unsaved 编辑器文本/);
  const second = await client.convert(root, source, "New unsaved paragraph");
  assert.match(second, /New unsaved paragraph/);
  assert.doesNotMatch(second, /Unsaved 编辑器文本/);
  const empty = await client.convert(root, source, "");
  assert.match(empty, /<body[^>]*><\/body>/);
  const anotherClient = fixture.client(context);
  assert.match(await anotherClient.convert(root, source, "Reopened preview"), /Reopened preview/);
  assert.equal(fixture.starts, 1, "Warm updates and reopened previews must reuse the running service");
  assert.equal(await fs.readFile(source, "utf8"), "Saved document");
}

/** Verifies the legacy persisted state layout remains supported. */
async function rendersUnsavedBuffers(context: TestContext): Promise<void> {
  await rendersUnsavedBuffersWithState(context, false);
}

/** Verifies Rust state discovery renders buffers and reuses services across preview sessions. */
async function rendersNativeUnsavedBuffers(context: TestContext): Promise<void> {
  await rendersUnsavedBuffersWithState(context, true);
}

/** Verifies a stopped Rust service cannot hide a live legacy service for the same project. */
async function reusesLegacyAfterStaleNativeState(context: TestContext): Promise<void> {
  const fixture = await HtmlServiceFixture.create(context);
  const { root, source } = await fixture.project("mixed-layout-project");
  fixture.nativeState = true;
  await fixture.client(context).convert(root, source, "Native session");
  await fixture.stop(fixture.servers[0]);
  fixture.nativeState = false;
  await fixture.start(root, source, 0);
  assert.match(await fixture.client(context).convert(root, source, "Legacy session"), /Legacy session/);
  assert.equal(fixture.starts, 2, "Discovering a healthy legacy service must not start a third worker");
}

/** Verifies actual service loss recovers while conversion errors leave a healthy service alive. */
async function recoversOnlyTransportFailures(context: TestContext): Promise<void> {
  const fixture = await HtmlServiceFixture.create(context);
  const { root, source } = await fixture.project("recovery-project");
  const client = fixture.client(context);
  await client.convert(root, source, "Before restart");
  await fixture.stop(fixture.servers[0]);
  assert.match(await client.convert(root, source, "After restart"), /After restart/);
  assert.equal(fixture.starts, 2);
  fixture.rejectConversions = true;
  await assert.rejects(client.convert(root, source, "Bad input"), /HTTP 400.*Invalid manuscript/);
  fixture.rejectConversions = false;
  assert.match(await client.convert(root, source, "Corrected input"), /Corrected input/);
  assert.equal(fixture.starts, 2, "Input errors must not restart the warm worker");
}

/** Verifies projects retain their own service when switching previews. */
async function isolatesProjects(context: TestContext): Promise<void> {
  const fixture = await HtmlServiceFixture.create(context);
  const first = await fixture.project("project-a");
  const second = await fixture.project("project-b");
  const client = fixture.client(context);
  const [firstHtml, secondHtml] = await Promise.all([
    client.convert(first.root, first.source, "First project"),
    client.convert(second.root, second.source, "Second project"),
  ]);
  assert.match(firstHtml, /data-project="project-a">First project/);
  assert.match(secondHtml, /data-project="project-b">Second project/);
  assert.match(await client.convert(first.root, first.source, "Back to first"), /data-project="project-a">Back to first/);
  assert.equal(fixture.starts, 2);
}

test("renders unsaved and empty editor buffers using one reusable service", rendersUnsavedBuffers);
test("renders unsaved buffers and reuses services discovered from Rust state", rendersNativeUnsavedBuffers);
test("reuses a healthy legacy service when native state is stale", reusesLegacyAfterStaleNativeState);
test("recovers a stopped service without restarting it for Markdown errors", recoversOnlyTransportFailures);
test("keeps different project previews on separate services", isolatesProjects);
