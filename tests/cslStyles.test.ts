import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";
import { DOMParser } from "@xmldom/xmldom";
import { ZoteroStyleRepository, type ZoteroStyle } from "../src/inlayHints/csl/zotero";
import { saveCslStyle } from "../src/inlayHints/csl/files";
import { getYamlHeader } from "../src/manuscriptStyle/document";
import { SourceModuleFixture } from "./helpers/sourceModule";
import { renderZoteroPreview, sanitizePreviewHtml } from "../src/inlayHints/csl/previewHtml";

const CSL_NS = "http://purl.org/net/xbiblio/csl";

/** Creates an independent formatting style or journal alias without reproducing production resolution code. */
function csl(parent?: string, locale = ""): string {
  return `<?xml version="1.0"?><style xmlns="${CSL_NS}" version="1.0"${locale ? ` default-locale="${locale}"` : ""}>
<info><title>Journal</title><id>http://www.zotero.org/styles/journal</id>${parent ? `<link rel="independent-parent" href="${parent}"/>` : ""}</info>
${parent ? "" : '<citation><layout><text variable="title"/></layout></citation>'}</style>`;
}

test("Zotero index retains searchable journals, abbreviations and formats and retries failed loads", async () => {
  let calls = 0;
  const repository = new ZoteroStyleRepository(async () => {
    if (++calls === 1) throw new Error("Temporary network failure");
    return JSON.stringify([
      { name: "journal", title: "Journal of Testing", titleShort: "J Test", categories: { format: "numeric" } },
      { name: "../escape", title: "Invalid" }, { name: "con", title: "Invalid Windows name" },
    ]);
  });
  await assert.rejects(repository.getStyles(), /network/);
  const styles = await repository.getStyles();
  assert.deepEqual(styles, [{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric", dependent: false }]);
  assert.equal(await repository.getStyles(), styles);
  assert.equal(calls, 2);
});

test("dependent journal downloads produce usable local CSL without another online dependency and preserve locale", async () => {
  const requested: string[] = [];
  const repository = new ZoteroStyleRepository(async (url) => {
    requested.push(url);
    if (url.endsWith("/journal")) return csl("http://www.zotero.org/styles/parent", "fr-FR");
    return csl(undefined, "en-US");
  });
  const xml = await repository.downloadStyle({ name: "journal", title: "Journal" });
  assert.deepEqual(requested, ["https://www.zotero.org/styles/journal", "https://www.zotero.org/styles/parent"]);
  const root = new DOMParser().parseFromString(xml, "application/xml").documentElement;
  assert.equal(root.getAttribute("default-locale"), "fr-FR");
  assert.equal(root.getElementsByTagNameNS(CSL_NS, "citation").length, 1);
  assert.equal(root.getElementsByTagNameNS(CSL_NS, "link").length, 0);
});

test("style downloads reject HTML, malformed CSL, external parents and cyclic dependencies", async () => {
  for (const xml of ["<html>Unavailable</html>", '<style xmlns="http://purl.org/net/xbiblio/csl"><info>',
    csl("https://example.org/styles/parent"), csl("http://www.zotero.org/styles/journal")]) {
    await assert.rejects(new ZoteroStyleRepository(async () => xml).downloadStyle({ name: "journal", title: "Journal" }));
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(new ZoteroStyleRepository(async () => { calls++; return csl(); })
    .downloadStyle({ name: "journal", title: "Journal" }, controller.signal));
  assert.equal(calls, 0);
});

test("local CSL download reuses identical files and preserves customized files on name collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pmt-csl-files-test-"));
  try {
    const original = await saveCslStyle(root, "journal", csl());
    const identical = await saveCslStyle(root, "journal", csl());
    assert.equal(identical, original);
    const changedXml = csl(undefined, "fr-FR");
    const changed = await saveCslStyle(root, "journal", changedXml);
    assert.notEqual(changed, original);
    assert.equal(await readFile(original, "utf8"), csl());
    assert.equal(await readFile(changed, "utf8"), changedXml);
    await assert.rejects(saveCslStyle(root, "../../escaped", csl()));
    assert.equal((await readdir(path.join(root, "pandoc", "csl"))).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** Emulates the search page's host bridge so tests drive actual searches, previews and confirmation messages. */
class PickerFixture {
  disposed = false;
  messages: Array<Record<string, any>> = [];
  private receive?: (message: unknown) => void;
  private hidden?: () => void;
  webview = {
    html: "",
    /** Records messages that the search page would render. */
    postMessage: async (message: Record<string, unknown>) => { this.messages.push(message); return true; },
    /** Attaches the extension's handler for browser search and preview events. */
    onDidReceiveMessage: (listener: (message: unknown) => void) => { this.receive = listener; return { dispose: () => { this.receive = undefined; } }; },
  };
  /** Registers page closure and returns a disposable listener. */
  onDidDispose(listener: () => void) { this.hidden = listener; return { dispose: () => { this.hidden = undefined; } }; }
  /** Releases the panel, including when the user closes its editor tab. */
  dispose() { if (this.disposed) return; this.disposed = true; this.hidden?.(); }
  /** Sends an actual search-page interaction through the registered bridge. */
  send(message: Record<string, unknown>) { this.receive?.(message); }
}

test("journal search ranks exact names and abbreviations and discards loading results after cancel", async () => {
  const picker = new PickerFixture();
  const fixture = new SourceModuleFixture({ vscode: { ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => picker } } });
  const { pickZoteroStyle, searchZoteroStyles } = fixture.load<{
    pickZoteroStyle(repository: unknown): Promise<ZoteroStyle | undefined>;
    searchZoteroStyles(styles: ZoteroStyle[], query: string): ZoteroStyle[];
  }>("src/inlayHints/csl/picker.ts");
  let complete: (styles: ZoteroStyle[]) => void;
  const loaded = new Promise<ZoteroStyle[]>((resolve) => { complete = resolve; });
  const selected = pickZoteroStyle({ getStyles: () => loaded });
  picker.send({ type: "ready" });
  picker.send({ type: "search", query: "J Test", revision: 1 });
  complete([{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric" }]);
  await Promise.resolve();
  const results = picker.messages.find((message) => message.type === "results");
  assert.equal(results.revision, 1);
  assert.equal(results.styles[0].title, "Journal of Testing");
  assert.match(results.styles[0].description, /J Test/);
  picker.send({ type: "select", name: "journal" });
  assert.equal((await selected).name, "journal");
  assert(picker.disposed);
  const cancelled = new PickerFixture();
  const cancelledFixture = new SourceModuleFixture({ vscode: { ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => cancelled } } });
  const pickerModule = cancelledFixture.load<{ pickZoteroStyle(repository: unknown): Promise<unknown> }>("src/inlayHints/csl/picker.ts");
  let late: (styles: ZoteroStyle[]) => void;
  const pending = pickerModule.pickZoteroStyle({ getStyles: () => new Promise<ZoteroStyle[]>((resolve) => { late = resolve; }) });
  cancelled.dispose();
  assert.equal(await pending, undefined);
  late([{ name: "late", title: "Late" }]);
  await Promise.resolve();
  assert.equal(cancelled.messages.length, 0);
  const styles = [{ name: "nature-medicine", title: "Nature Medicine" }, { name: "nature", title: "Nature" },
    { name: "test", title: "Testing Journal", titleShort: "J Test" }];
  assert.equal(searchZoteroStyles(styles, "NATURE")[0].name, "nature");
  assert.equal(searchZoteroStyles(styles, "J Test")[0].name, "test");
  assert.deepEqual(searchZoteroStyles(styles, "unmatched"), []);
});

test("selected journal downloads into its own workspace, sets a build-relative CSL path and reveals the YAML field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pmt-csl-command-test-"));
  const projectRoot = path.join(root, "project");
  const fsPath = path.join(projectRoot, "manuscript.md");
  const uriText = "file:///selected-manuscript.md";
  let text = "---\ntitle: Manuscript # keep\n---\nSee @paper\n";
  let selected: { start: { offset: number }; end: { offset: number } };
  let revealed: typeof selected;
  const errors: string[] = [];
  const document = { uri: { scheme: "file", fsPath, toString: () => uriText }, languageId: "markdown", getText: () => text,
    positionAt: (offset: number) => ({ offset }) };
  /** Keeps the offsets used by the editor selection and edit range. */
  class Range {
    /** Stores source offsets. */
    constructor(public start: { offset: number }, public end: { offset: number }) {}
  }
  const editor = { document, viewColumn: 2,
    /** Captures the actual source selection. */
    set selection(value: typeof selected) { selected = value; },
    /** Returns the source selection to reveal. */
    get selection() { return selected; },
    revealRange: (range: typeof selected) => { revealed = range; },
    edit: async (callback: (builder: unknown) => void) => {
      callback({ replace: (range: Range, replacement: string) => { text = text.slice(0, range.start.offset) + replacement + text.slice(range.end.offset); } });
      return true;
    },
  };
  let picker = new PickerFixture();
  const fixture = new SourceModuleFixture({
    "src/papperBuildUtils.ts": { findPandocManuscriptProject: async () => ({ rootUri: { fsPath: projectRoot } }) },
    vscode: {
      Range, Selection: Range, TextEditorRevealType: { InCenterIfOutsideViewport: 2 }, ViewColumn: { One: 1 }, ProgressLocation: { Notification: 15 },
      Uri: { parse: () => document.uri },
      workspace: { openTextDocument: async () => document, getWorkspaceFolder: () => ({ uri: { fsPath: root } }) },
      window: {
        createWebviewPanel: () => { picker = new PickerFixture(); return picker; }, visibleTextEditors: [editor],
        showTextDocument: async (shown: typeof document) => { assert.equal(shown, document); return editor; },
        withProgress: async (_options: unknown, callback: (progress: unknown, token: unknown) => Promise<unknown>) => callback({}, {
          isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
        }),
        showErrorMessage: (message: string) => errors.push(message),
      },
    },
  });
  const { CslStyleController } = fixture.load<{ CslStyleController: new (output: unknown, repository: unknown) => { setCsl(uri: string): Promise<void> } }>("src/inlayHints/csl/controller.ts");
  const repository = { getStyles: async () => [{ name: "journal", title: "Journal" }], downloadStyle: async () => csl() };
  const controller = new CslStyleController({ appendLine() {} }, repository);
  try {
    const pending = controller.setCsl(uriText);
    // Let the source open and cached index populate before simulating the user's journal selection.
    await new Promise((resolve) => setImmediate(resolve));
    picker.send({ type: "select", name: "journal" });
    await pending;
    assert.deepEqual(errors, []);
    const metadata = parse(getYamlHeader(text).content);
    const filename = path.resolve(projectRoot, metadata.csl);
    assert.equal(filename, path.join(root, "pandoc", "csl", "journal.csl"));
    assert.equal(await readFile(filename, "utf8"), csl());
    assert.equal(text.slice(getYamlHeader(text).bodyStart), "See @paper\n");
    assert.equal(parse(text.slice(selected.start.offset, selected.end.offset)), metadata.csl);
    assert.equal(revealed, selected);

    const configured = text;
    const files = await readdir(path.join(root, "pandoc", "csl"));
    repository.downloadStyle = async () => { throw new Error("Download failed"); };
    const failed = controller.setCsl(uriText);
    await new Promise((resolve) => setImmediate(resolve));
    picker.send({ type: "select", name: "journal" });
    await failed;
    assert.match(errors[0], /Download failed/);
    assert.equal(text, configured);
    assert.deepEqual(await readdir(path.join(root, "pandoc", "csl")), files);

    const cancelled = controller.setCsl(uriText);
    await new Promise((resolve) => setImmediate(resolve));
    picker.dispose();
    await cancelled;
    assert.equal(errors.length, 1);
    assert.equal(text, configured);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Zotero preview fetches independent and dependent samples and retries failures without caching them", async () => {
  const urls: string[] = [];
  let fail = true;
  const repository = new ZoteroStyleRepository(async (url) => {
    urls.push(url);
    if (fail) { fail = false; throw new Error("Preview temporarily unavailable"); }
    return JSON.stringify({ citation: ["<sup>1</sup>", "<sup>2</sup>"], bibliography: '<div class="csl-entry"><i>Journal</i></div>' });
  });
  const style = { name: "journal", title: "Journal", dependent: true };
  await assert.rejects(repository.getPreview(style), /temporarily/);
  const preview = await repository.getPreview(style);
  assert.deepEqual(preview.citations, ["<sup>1</sup>", "<sup>2</sup>"]);
  assert.equal(await repository.getPreview(style), preview);
  assert.equal(urls.length, 2);
  assert(urls[1].endsWith("/dependent/journal.json"));
  await repository.getPreview({ name: "nature", title: "Nature" });
  assert(urls[2].endsWith("/combined/nature.json"));
});

test("preview preserves citation typography, bibliography indents and text while removing executable HTML", () => {
  const html = renderZoteroPreview({ citations: ["<sup>1</sup>"], bibliography:
    '<div class="csl-bib-body" style="padding-left: 1em; text-indent:-1em; line-height:1.35">'
    + '<div class="csl-entry"><i>Book &amp; Journal</i> <b>26</b></div></div>' });
  assert(html.includes("<sup>1</sup>"));
  assert(html.includes("<i>Book &amp; Journal</i> <b>26</b>"));
  assert(html.includes("text-indent:-1em"));
  const safe = sanitizePreviewHtml('<div onclick="alert(1)" style="background:url(https://example.com); text-indent:-1em">'
    + '<script>alert(1)</script><img src="https://example.com/x"><a href="javascript:alert(1)">DOI</a><em>safe</em></div>');
  assert(!/script|onclick|src=|href=|url\(/i.test(safe));
  assert(safe.includes("DOI<em>safe</em>"));
  assert(safe.includes("text-indent:-1em"));
});

test("switching and closing a preview prevents obsolete responses from replacing the current journal", async () => {
  const picker = new PickerFixture();
  const fixture = new SourceModuleFixture({ vscode: { ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => picker } } });
  const { pickZoteroStyle } = fixture.load<{ pickZoteroStyle(repository: unknown): Promise<unknown> }>("src/inlayHints/csl/picker.ts");
  const pending = new Map<string, { resolve: (value: unknown) => void; signal: AbortSignal }>();
  const choosing = pickZoteroStyle({ getStyles: async () => [{ name: "first", title: "First" }, { name: "second", title: "Second" }],
    getPreview: (style: ZoteroStyle, signal: AbortSignal) => new Promise((resolve) => pending.set(style.name, { resolve, signal })) });
  picker.send({ type: "ready" });
  await Promise.resolve();
  picker.send({ type: "preview", name: "first" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  picker.send({ type: "preview", name: "second" });
  assert(pending.get("first").signal.aborted);
  await new Promise((resolve) => setTimeout(resolve, 200));
  pending.get("second").resolve({ citations: ["(Second, 2024)"], bibliography: "Second reference" });
  await Promise.resolve();
  pending.get("first").resolve({ citations: ["(First, 2023)"], bibliography: "First reference" });
  await Promise.resolve();
  const previews = picker.messages.filter((message) => message.type === "preview");
  assert.equal(previews.length, 1);
  assert.equal(previews[0].name, "second");
  picker.send({ type: "preview", name: "first" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  picker.dispose();
  assert.equal(await choosing, undefined);
  pending.get("first").resolve({ citations: ["late"], bibliography: "late" });
  await Promise.resolve();
  assert.equal(picker.messages.filter((message) => message.type === "preview").length, 1);
});
