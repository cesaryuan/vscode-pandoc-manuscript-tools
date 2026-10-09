import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import type { PapperMarkdownPreviewController } from "../src/papperMarkdownPreview/controller";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Gives tests control over completion order without timing-dependent delays. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: resolve! };
}

/** Supplies the source URI identity consumed by the real preview controller. */
function fileUri(name: string): vscode.Uri {
  const fsPath = path.resolve("preview-fixture", name);
  return { scheme: "file", fsPath, path: fsPath.replace(/\\/g, "/"),
    /** Identifies the source consistently across open-document and preview lookups. */
    toString: () => `file:${fsPath}` } as vscode.Uri;
}

/** Models Webview lifecycle events and observes only user-visible HTML updates. */
class PreviewPanel {
  title = "";
  html = "";
  writes: string[] = [];
  messages: Array<{ type: string; html?: string; token?: string }> = [];
  listener: (message: unknown) => void;
  disposed: () => void;
  readonly webview: object;

  /** Records host rendering while retaining acknowledgement control for race tests. */
  constructor() {
    const panel = this;
    this.webview = {
      options: {}, cspSource: "webview:",
      /** Reads the current displayed HTML. */
      get html() { return panel.html; },
      /** Records complete document replacements. */
      set html(value: string) { panel.html = value; panel.writes.push(value); },
      /** Installs the actual controller's message callback. */
      onDidReceiveMessage(listener: (message: unknown) => void) { panel.listener = listener; },
      /** Records incremental replacements without acknowledging until the test requests it. */
      async postMessage(message: { type: string; html?: string; token?: string }) { panel.messages.push(message); return true; },
      /** Keeps resource transformation independent of the fixture browser. */
      asWebviewUri(uri: vscode.Uri) { return uri; },
    };
  }

  /** Exposes panel disposal to the controller. */
  onDidDispose(callback: () => void): void { this.disposed = callback; }
  /** Satisfies the editor-group operation without opening an editor. */
  reveal(): void {}
  /** Simulates closing this panel. */
  dispose(): void { this.disposed(); }
}

/** Exercises public preview commands using real scheduling and controllable external work. */
class PreviewFixture {
  readonly panels: PreviewPanel[] = [];
  readonly documents: vscode.TextDocument[] = [];
  readonly conversions: string[] = [];
  readonly errors: string[] = [];
  readonly controller: PapperMarkdownPreviewController;
  conversionGate: ReturnType<typeof deferred<string>> | undefined;
  preparationGate: ReturnType<typeof deferred<void>> | undefined;
  projectGate: ReturnType<typeof deferred<void>> | undefined;

  /** Substitutes editor UI, conversion, and image work while keeping the controller intact. */
  constructor() {
    const fixture = this;
    const host = {
      workspace: {
        textDocuments: this.documents,
        /** Returns sources selected by public command URI. */
        async openTextDocument(uri: vscode.Uri) { return fixture.documents.find((document) => document.uri.fsPath === uri.fsPath); },
      },
      window: {
        visibleTextEditors: [] as vscode.TextEditor[],
        /** Creates an independent panel each time the previous panel is closed. */
        createWebviewPanel() { const panel = new PreviewPanel(); fixture.panels.push(panel); return panel; },
        /** Captures errors so obsolete failures can be asserted not to disturb the user. */
        showErrorMessage(message: string) { fixture.errors.push(message); },
      },
      commands: { /** Supplies the context update boundary. */ async executeCommand() {} },
      ViewColumn: { Beside: 2 }, Uri: { file: fileUri },
    };
    /** Implements only the unrelated navigation bridge's controller-facing surface. */
    class ScrollBridge {
      /** Releases pending navigation. */ dispose(): void {}
      /** Resets viewport deduplication. */ resetSourcePosition(): void {}
      /** Receives source position updates. */ syncFromEditor(): void {}
    }
    const module = new SourceModuleFixture({
      vscode: host,
      "src/papperBuildUtils.ts": {
        /** Delays project lookup to verify that request serialization begins before its await. */
        async findPandocManuscriptProject() {
          const gate = fixture.projectGate;
          fixture.projectGate = undefined;
          await gate?.promise;
          return { rootUri: fileUri("") };
        },
        /** Leaves tool installation out of preview lifecycle tests. */
        async isPapperBuildAvailable() { return true; },
      },
      "src/vscodeUtils.ts": { /** Accepts the fixture's saved Markdown sources. */ isBuildableMarkdownDocument: () => true },
      "src/papperHtmlServer.ts": { PapperHtmlServerClient: class {
        /** Returns the submitted buffer, optionally delaying the first conversion. */
        async convert(_project: string, source: string, text: string) {
          fixture.conversions.push(path.basename(source));
          const gate = fixture.conversionGate;
          fixture.conversionGate = undefined;
          return gate ? gate.promise : `<p>${text}</p>`;
        }
        /** Keeps shared-service shutdown out of the controller test. */ dispose(): void {}
      } },
      "src/htmlPreviewResourceCache.ts": {
        /** Delays resource preparation independently of conversion. */
        async cacheHtmlMetafileImages(html: string) {
          const gate = fixture.preparationGate;
          fixture.preparationGate = undefined;
          await gate?.promise;
          return { html, converted: 0, reused: 0 };
        },
      },
      "src/papperMarkdownPreview/scrollSync.ts": { HtmlPreviewScrollSync: ScrollBridge },
      "src/papperMarkdownPreview/editorScrollIntent.ts": { HtmlPreviewEditorScrollIntent: ScrollBridge },
      "src/papperMarkdownPreview/clickNavigation.ts": { HtmlPreviewClickNavigation: class {} },
      "src/papperMarkdownPreview/webview.ts": {
        /** Makes HTML comparisons independent of injected browser code. */ injectHtmlPreviewBridge: (html: string) => html,
        /** Leaves HTML unchanged when no local resources exist. */ rewriteHtmlResourceUris: (html: string) => html,
        /** Supplies deterministic nonce generation. */ createNonce: () => "nonce",
        /** Preserves the controller's style-count check. */ countHtmlElements: () => 0,
        /** Leaves acknowledgement waiting under explicit test control. */ waitForWebviewUpdate: (promise: Promise<boolean>) => promise,
      },
    }).load<{ PapperMarkdownPreviewController: typeof PapperMarkdownPreviewController }>("src/papperMarkdownPreview/controller.ts");
    this.controller = new module.PapperMarkdownPreviewController({ /** Discards routine timings. */ appendLine() {} } as unknown as vscode.OutputChannel);
  }

  /** Creates a saved source with observable buffer content. */
  document(name: string): vscode.TextDocument {
    const document = { uri: fileUri(name), version: 1, /** Returns the source name as its buffer. */ getText: () => name } as unknown as vscode.TextDocument;
    this.documents.push(document);
    return document;
  }
}

/** Lets all queued promise continuations reach their next controlled boundary. */
async function settle(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** Switching during either conversion or resource processing must display only the latest source. */
async function switchesSources(stage: "conversion" | "preparation"): Promise<void> {
  const fixture = new PreviewFixture();
  const a = fixture.document("a.md");
  const b = fixture.document("b.md");
  const conversion = deferred<string>();
  const preparation = deferred<void>();
  if (stage === "conversion") fixture.conversionGate = conversion;
  else fixture.preparationGate = preparation;
  const first = fixture.controller.buildActiveMarkdownHtml(a.uri);
  await settle();
  const second = fixture.controller.buildActiveMarkdownHtml(b.uri);
  await settle();
  conversion.resolve("<p>a.md</p>");
  preparation.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(fixture.conversions, ["a.md", "b.md"]);
  assert.match(fixture.panels[0].title, /^b\.md/);
  assert.equal(fixture.panels[0].html, "<p>b.md</p>");
  assert.ok(!fixture.panels[0].writes.includes("<p>a.md</p>"));
  fixture.controller.dispose();
}

/** Closing and reopening during conversion must not let a disposed panel update its replacement. */
async function closesAndReopensDuringBuild(): Promise<void> {
  const fixture = new PreviewFixture();
  const a = fixture.document("a.md");
  const b = fixture.document("b.md");
  const gate = fixture.conversionGate = deferred<string>();
  const first = fixture.controller.buildActiveMarkdownHtml(a.uri);
  await settle();
  fixture.panels[0].dispose();
  const second = fixture.controller.buildActiveMarkdownHtml(b.uri);
  await settle();
  gate.resolve("<p>a.md</p>");
  await Promise.all([first, second]);
  assert.equal(fixture.panels[0].html, "");
  assert.equal(fixture.panels[1].html, "<p>b.md</p>");
  assert.deepEqual(fixture.errors, []);
  fixture.controller.dispose();
}

/** Cancels an unacknowledged incremental update so a new source does not wait or reload old HTML. */
async function switchesDuringAcknowledgement(): Promise<void> {
  const fixture = new PreviewFixture();
  const a = fixture.document("a.md");
  const b = fixture.document("b.md");
  await fixture.controller.buildActiveMarkdownHtml(a.uri);
  const panel = fixture.panels[0];
  panel.listener({ type: "ready" });
  const update = fixture.controller.buildActiveMarkdownHtml(a.uri);
  await settle();
  assert.equal(panel.messages[0].type, "replacePreviewHtml");
  const second = fixture.controller.buildActiveMarkdownHtml(b.uri);
  await Promise.all([update, second]);
  assert.equal(panel.html, "<p>b.md</p>");
  fixture.controller.dispose();
}

/** Rapid source changes coalesce to the final request while all public commands settle. */
async function keepsLatestOfMultipleSources(): Promise<void> {
  const fixture = new PreviewFixture();
  const a = fixture.document("a.md");
  const b = fixture.document("b.md");
  const c = fixture.document("c.md");
  const gate = fixture.conversionGate = deferred<string>();
  const first = fixture.controller.buildActiveMarkdownHtml(a.uri);
  await settle();
  const second = fixture.controller.buildActiveMarkdownHtml(b.uri);
  await settle();
  const third = fixture.controller.buildActiveMarkdownHtml(c.uri);
  await settle();
  gate.resolve("<p>a.md</p>");
  await Promise.all([first, second, third]);
  assert.deepEqual(fixture.conversions, ["a.md", "c.md"]);
  assert.equal(fixture.panels[0].html, "<p>c.md</p>");
  fixture.controller.dispose();
}

/** A slow project lookup for a live refresh must not start an obsolete source after switching. */
async function switchesDuringProjectLookup(context: import("node:test").TestContext): Promise<void> {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = new PreviewFixture();
  const a = fixture.document("a.md");
  const b = fixture.document("b.md");
  await fixture.controller.buildActiveMarkdownHtml(a.uri);
  const gate = fixture.projectGate = deferred<void>();
  fixture.controller.scheduleHtmlPreviewRefresh(a);
  context.mock.timers.tick(350);
  await settle();
  const second = fixture.controller.buildActiveMarkdownHtml(b.uri);
  await settle();
  gate.resolve();
  await second;
  assert.deepEqual(fixture.conversions, ["a.md", "b.md"]);
  assert.equal(fixture.panels[0].html, "<p>b.md</p>");
  fixture.controller.dispose();
}

test("preview source switching discards a pending conversion", () => switchesSources("conversion"));
test("preview source switching discards pending resource preparation", () => switchesSources("preparation"));
test("preview closure isolates a replacement panel from old builds", closesAndReopensDuringBuild);
test("preview source switching cancels obsolete acknowledgement waits", switchesDuringAcknowledgement);
test("rapid preview source switches build the final queued document", keepsLatestOfMultipleSources);
test("preview source switching discards a pending project lookup", switchesDuringProjectLookup);
