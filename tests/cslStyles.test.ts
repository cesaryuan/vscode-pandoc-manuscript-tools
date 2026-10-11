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
  assert.deepEqual(styles, [{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric" }]);
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

/** Emulates QuickPick interactions while letting tests drive actual selection, input and cancellation events. */
class PickerFixture {
  title = "";
  placeholder = "";
  value = "";
  matchOnDescription = false;
  matchOnDetail = false;
  ignoreFocusOut = false;
  busy = false;
  disposed = false;
  items: Array<{ label: string; description: string; detail: string; style: ZoteroStyle }> = [];
  selectedItems: typeof this.items = [];
  activeItems: typeof this.items = [];
  private accept?: () => void;
  private hidden?: () => void;
  shown?: () => void;
  /** Registers acceptance and returns a disposable listener. */
  onDidAccept(listener: () => void) { this.accept = listener; return { dispose: () => { this.accept = undefined; } }; }
  /** Registers cancellation and returns a disposable listener. */
  onDidHide(listener: () => void) { this.hidden = listener; return { dispose: () => { this.hidden = undefined; } }; }
  /** Simulates opening the search UI. */
  show() { this.shown?.(); }
  /** Simulates closing the search UI. */
  hide() { this.hidden?.(); }
  /** Releases the picker instance. */
  dispose() { this.disposed = true; }
  /** Confirms the selected journal. */
  acceptSelection() { this.accept?.(); }
}

test("journal picker exposes searchable names and abbreviations and discards loading results after cancel", async () => {
  const picker = new PickerFixture();
  const fixture = new SourceModuleFixture({ vscode: { window: { createQuickPick: () => picker } } });
  const { pickZoteroStyle } = fixture.load<{ pickZoteroStyle(repository: unknown): Promise<ZoteroStyle | undefined> }>("src/inlayHints/csl/picker.ts");
  let complete: (styles: ZoteroStyle[]) => void;
  const loaded = new Promise<ZoteroStyle[]>((resolve) => { complete = resolve; });
  const selected = pickZoteroStyle({ getStyles: () => loaded });
  picker.value = "J Test";
  complete([{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric" }]);
  await Promise.resolve();
  assert.equal(picker.value, "J Test");
  assert(picker.matchOnDescription && picker.matchOnDetail);
  assert.equal(picker.items[0].label, "Journal of Testing");
  assert.match(picker.items[0].description, /J Test/);
  picker.selectedItems = [picker.items[0]];
  picker.acceptSelection();
  assert.equal((await selected).name, "journal");
  assert(picker.disposed);
  const cancelled = new PickerFixture();
  const cancelledFixture = new SourceModuleFixture({ vscode: { window: { createQuickPick: () => cancelled } } });
  const pickerModule = cancelledFixture.load<{ pickZoteroStyle(repository: unknown): Promise<unknown> }>("src/inlayHints/csl/picker.ts");
  let late: (styles: ZoteroStyle[]) => void;
  const pending = pickerModule.pickZoteroStyle({ getStyles: () => new Promise<ZoteroStyle[]>((resolve) => { late = resolve; }) });
  cancelled.hide();
  assert.equal(await pending, undefined);
  late([{ name: "late", title: "Late" }]);
  await Promise.resolve();
  assert.equal(cancelled.items.length, 0);
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
        createQuickPick: () => { picker = new PickerFixture(); return picker; }, visibleTextEditors: [editor],
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
    picker.selectedItems = [picker.items[0]];
    picker.acceptSelection();
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
    picker.selectedItems = [picker.items[0]];
    picker.acceptSelection();
    await failed;
    assert.match(errors[0], /Download failed/);
    assert.equal(text, configured);
    assert.deepEqual(await readdir(path.join(root, "pandoc", "csl")), files);

    const cancelled = controller.setCsl(uriText);
    await new Promise((resolve) => setImmediate(resolve));
    picker.hide();
    await cancelled;
    assert.equal(errors.length, 1);
    assert.equal(text, configured);
  } finally { await rm(root, { recursive: true, force: true }); }
});
