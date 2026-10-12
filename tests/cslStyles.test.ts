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
import { parseCommunityIndex } from "../src/inlayHints/csl/chinese";

const CSL_NS = "http://purl.org/net/xbiblio/csl";

/** Creates an independent formatting style or journal alias without reproducing production resolution code. */
function csl(parent?: string, locale = ""): string {
  return `<?xml version="1.0"?><style xmlns="${CSL_NS}" version="1.0"${locale ? ` default-locale="${locale}"` : ""}>
<info><title>Journal</title><id>http://www.zotero.org/styles/journal</id>${parent ? `<link rel="independent-parent" href="${parent}"/>` : ""}</info>
${parent ? "" : '<citation><layout><text variable="title"/></layout></citation>'}</style>`;
}

test("Zotero index retains searchable journals, abbreviations and formats and retries failed loads", async () => {
  let calls = 0;
  const repository = new ZoteroStyleRepository(async (url) => {
    if (!url.endsWith("styles.json")) throw new Error("Community unavailable");
    if (++calls === 1) throw new Error("Temporary network failure");
    return JSON.stringify([
      { name: "journal", title: "Journal of Testing", titleShort: "J Test", categories: { format: "numeric" } },
      { name: "../escape", title: "Invalid" }, { name: "con", title: "Invalid Windows name" },
    ]);
  });
  await assert.rejects(repository.getStyles(), /network/);
  const styles = await repository.getStyles();
  assert.deepEqual(styles, [{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric", dependent: false }]);
  assert.deepEqual(await repository.getStyles(), styles);
  assert.equal(calls, 2);
});

/** Models the community's published summary bundle, including its JavaScript string escaping. */
function communityBundle(entries: unknown[]): string { return `const styles=JSON.parse(${JSON.stringify(JSON.stringify(entries))});`; }

/** Supplies the current asset-discovery contract while letting tests control metadata and CSL resources. */
function communityResource(url: string, entries: unknown[]): string | undefined {
  if (url === "https://zotero-chinese.com/styles/") return '<script src="/assets/chunks/theme.fixture.js"></script>';
  if (url.endsWith("/theme.fixture.js")) return 'import("./StyleCards.fixture.js")';
  if (url.endsWith("/StyleCards.fixture.js")) return communityBundle(entries);
  return undefined;
}

test("community styles remain searchable and downloadable when official loading fails, then merge on retry", async () => {
  let officialAvailable = false;
  const urls: string[] = [];
  const entry = { dir: "示例大学学位论文", file: "示例大学学位论文.csl", title: "示例大学学位论文", key: "abc123", citation_format: "numeric", tags: ["双语"], summary: "GB/T 7714" };
  const repository = new ZoteroStyleRepository(async url => {
    urls.push(url);
    const index = communityResource(url, [entry, { ...entry, dir: "../escape" }]);
    if (index !== undefined) return index;
    if (url.endsWith("styles.json")) {
      if (!officialAvailable) throw Error("Official offline");
      return JSON.stringify([{ name: "journal", title: "Journal" }]);
    }
    if (url.endsWith(".json")) return JSON.stringify({ citations: "<sup>1</sup> 中文引注", bibliography: '<div class="csl-entry">中文参考文献</div>' });
    return csl(undefined, "zh-CN").replace(' version="1.0" default-locale', ' version="1.0mlz1" default-locale');
  });
  const styles = await repository.getStyles();
  assert.equal(styles.length, 1);
  assert.match(repository.indexWarnings.join(" "), /Zotero 官方/);
  const fixture = new SourceModuleFixture({ vscode: {} });
  const { searchZoteroStyles } = fixture.load<typeof import("../src/inlayHints/csl/picker")>("src/inlayHints/csl/picker.ts");
  assert.equal(searchZoteroStyles(styles, "学位论文 双语 GB/T")[0], styles[0]);
  const preview = await repository.getPreview(styles[0]);
  assert.match(renderZoteroPreview(preview), /中文引注/);
  assert.match(preview.bibliography, /中文参考文献/);
  const xml = await repository.downloadStyle(styles[0]);
  assert.match(xml, /version="1.0mlz1"/);
  assert.ok(urls.includes("https://zotero-chinese.com/styles/" + encodeURIComponent(entry.dir) + "/" + encodeURIComponent(entry.file)));
  const root = await mkdtemp(path.join(os.tmpdir(), "pmt-community-test-"));
  try { assert.equal(await readFile(await saveCslStyle(root, styles[0].name, xml), "utf8"), xml); }
  finally { await rm(root, { recursive: true, force: true }); }
  officialAvailable = true;
  const merged = await repository.getStyles();
  assert.equal(merged.length, 2);
  assert.deepEqual(repository.indexWarnings, []);
  assert.equal(await repository.getStyles(), merged);
  assert.equal(urls.filter(url => url === "https://zotero-chinese.com/styles/").length, 1);
});

test("community index treats generated bundles only as data and rejects unsafe resource paths", () => {
  const entry = { dir: "中国期刊", file: "中国期刊.csl", title: "中国期刊's 样式", key: "aa12" };
  const literal = JSON.stringify([entry]).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  assert.equal(parseCommunityIndex(`var styles=JSON.parse('${literal}');throw Error('never executed');`)[0].title, entry.title);
  assert.throws(() => parseCommunityIndex('JSON.parse(fetch("https://example.org"))'));
  assert.throws(() => parseCommunityIndex(communityBundle([{ ...entry, file: "../outside.csl" }])));
  assert.throws(() => parseCommunityIndex(communityBundle([{ ...entry, key: "../outside" }])));
});

test("community downloads resolve official parents with locale preserved and reject external parent URLs", async () => {
  const style: ZoteroStyle = { name: "zotero-chinese-aa12", title: "中文别名", source: "chinese",
    community: { directory: "中文别名", file: "中文别名.csl", previewKey: "aa12" } };
  const repository = new ZoteroStyleRepository(async url => url.startsWith("https://zotero-chinese.com/")
    ? csl("http://www.zotero.org/styles/parent", "zh-CN") : csl(undefined, "en-US"));
  const xml = await repository.downloadStyle(style);
  assert.match(xml, /default-locale="zh-CN"/);
  assert.doesNotMatch(xml, /independent-parent/);
  await assert.rejects(new ZoteroStyleRepository(async () => csl("https://example.org/styles/parent")).downloadStyle(style), /母样式链接/);
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

test("same-named official and community styles retain their own selection and preview source", async () => {
  const picker = new PickerFixture();
  const official: ZoteroStyle = { name: "same-name", title: "Official" };
  const community: ZoteroStyle = { name: "same-name", title: "中文社区", source: "chinese" };
  const selected: ZoteroStyle[] = [];
  const previewed: ZoteroStyle[] = [];
  const fixture = new SourceModuleFixture({ vscode: {} });
  const { attachZoteroSearch } = fixture.load<typeof import("../src/inlayHints/csl/picker")>("src/inlayHints/csl/picker.ts");
  const bridge = attachZoteroSearch(picker.webview as any, { getStyles: async () => [official, community],
    /** Records which source the selected row requests for preview. */
    getPreview: async (style: ZoteroStyle) => { previewed.push(style); return { citations: [style.title], bibliography: "" }; } } as any,
  style => selected.push(style), () => {}, () => {});
  try {
    picker.send({ type: "ready" });
    await new Promise(resolve => setImmediate(resolve));
    const results = picker.messages.find(message => message.type === "results");
    assert.equal(new Set(results.styles.map((style: { name: string }) => style.name)).size, 2);
    picker.send({ type: "select", name: "same-name" });
    picker.send({ type: "select", name: "chinese/same-name" });
    assert.deepEqual(selected, [official, community]);
    picker.send({ type: "preview", name: "chinese/same-name" });
    await new Promise(resolve => setTimeout(resolve, 210));
    assert.deepEqual(previewed, [community]);
    assert.equal(picker.messages.find(message => message.type === "preview").name, "chinese/same-name");
  } finally { bridge.dispose(); }
});

test("journal search ranks exact names and abbreviations and discards loading results after cancel", async () => {
  const picker = new PickerFixture();
  const fixture = new SourceModuleFixture({ vscode: { ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => picker } } });
  const { attachZoteroSearch, searchZoteroStyles } = fixture.load<typeof import("../src/inlayHints/csl/picker")>("src/inlayHints/csl/picker.ts");
  let complete: (styles: ZoteroStyle[]) => void;
  const loaded = new Promise<ZoteroStyle[]>((resolve) => { complete = resolve; });
  let selected: ZoteroStyle;
  const bridge = attachZoteroSearch(picker.webview as any, { getStyles: () => loaded } as any,
    (style) => { selected = style; }, () => {}, () => {});
  picker.send({ type: "ready" });
  picker.send({ type: "search", query: "J Test", revision: 1 });
  complete([{ name: "journal", title: "Journal of Testing", titleShort: "J Test", format: "numeric" }]);
  await Promise.resolve();
  const results = picker.messages.find((message) => message.type === "results");
  assert.equal(results.revision, 1);
  assert.equal(results.styles[0].title, "Journal of Testing");
  assert.match(results.styles[0].description, /J Test/);
  picker.send({ type: "select", name: "journal" });
  assert.equal(selected.name, "journal");
  bridge.dispose();
  const cancelled = new PickerFixture();
  const cancelledFixture = new SourceModuleFixture({ vscode: { ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => cancelled } } });
  const pickerModule = cancelledFixture.load<typeof import("../src/inlayHints/csl/picker")>("src/inlayHints/csl/picker.ts");
  let late: (styles: ZoteroStyle[]) => void;
  const pending = pickerModule.attachZoteroSearch(cancelled.webview as any,
    { getStyles: () => new Promise<ZoteroStyle[]>((resolve) => { late = resolve; }) } as any, () => {}, () => {}, () => {});
  pending.dispose();
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
  let cancelDownload = false;
  const fixture = new SourceModuleFixture({
    "src/papperBuildUtils.ts": { findPandocManuscriptProject: async () => ({ rootUri: { fsPath: projectRoot } }) },
    vscode: {
      Range, Selection: Range, TextEditorRevealType: { InCenterIfOutsideViewport: 2 }, ViewColumn: { One: 1 }, ProgressLocation: { Notification: 15 },
      Uri: { parse: () => document.uri },
      workspace: { openTextDocument: async () => document, getWorkspaceFolder: () => ({ uri: { fsPath: root } }) },
      window: {
        visibleTextEditors: [editor], activeTextEditor: editor,
        showTextDocument: async (shown: typeof document) => { assert.equal(shown, document); return editor; },
        withProgress: async (_options: unknown, callback: (progress: unknown, token: unknown) => Promise<unknown>) => callback({}, {
          isCancellationRequested: cancelDownload, onCancellationRequested: () => ({ dispose() {} }),
        }),
      },
    },
  });
  const { CslStyleController } = fixture.load<typeof import("../src/inlayHints/csl/controller")>("src/inlayHints/csl/controller.ts");
  const { getCslSettingPath, getCslConfigurationContent } = fixture.load<typeof import("../src/inlayHints/csl/configuration")>("src/inlayHints/csl/configuration.ts");
  const repository = { getStyles: async () => [{ name: "journal", title: "Journal" }], downloadStyle: async () => csl() };
  const controller = new CslStyleController({ appendLine() {} } as any, repository as any);
  /** Applies the chosen style using the displayed source snapshot and exact field scope. */
  function choose(keys?: string[]) {
    return controller.applyStyle(document as any, getCslSettingPath(document as any, keys), { name: "journal", title: "Journal" }, getCslConfigurationContent(document as any));
  }
  try {
    await choose();
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
    await assert.rejects(choose(), /Download failed/);
    assert.equal(text, configured);
    assert.deepEqual(await readdir(path.join(root, "pandoc", "csl")), files);

    cancelDownload = true;
    assert.equal(await choose(), false);
    cancelDownload = false;
    assert.equal(text, configured);

    repository.downloadStyle = async () => csl();
    // Settings navigation retains the exact selected scope, including its spelling.
    for (const scenario of [
      { source: "---\ncsl: # fill this\n---\nBody\n", language: "markdown", filename: "manuscript.md", keys: undefined, scope: ["csl"] },
      { source: "# project defaults\nmathtype: false\n", language: "yaml", filename: "style.yml", keys: undefined, scope: ["pandocMetadata", "csl"] },
      { source: "pandoc-metadata:\n  csl: old.csl # keep\n", language: "yaml", filename: "style.yml", keys: undefined, scope: ["pandoc-metadata", "csl"] },
      { source: "pandocMetadata:\n  csl: main.csl\nreply:\n  pandoc-metadata:\n    csl: old.csl # keep\n", language: "yaml", filename: "style.yaml", keys: ["reply", "pandoc-metadata", "csl"], scope: ["reply", "pandoc-metadata", "csl"] },
      { source: "---\ncsl: main.csl\npapper-settings:\n  pandocMetadata:\n    csl: old.csl # keep\n---\nBody\n", language: "markdown", filename: "manuscript.md", keys: ["papper-settings", "pandocMetadata", "csl"], scope: ["papper-settings", "pandocMetadata", "csl"] },
    ]) {
      text = scenario.source;
      document.languageId = scenario.language;
      document.uri.fsPath = path.join(projectRoot, scenario.filename);
      await choose(scenario.keys);
      const configuredYaml = parse(scenario.language === "yaml" ? text : getYamlHeader(text).content);
      const selectedPath = scenario.scope.reduce((node, key) => node[key], configuredYaml);
      assert.equal(path.resolve(projectRoot, selectedPath), path.join(root, "pandoc", "csl", "journal.csl"));
      assert.equal(parse(text.slice(selected.start.offset, selected.end.offset)), selectedPath);
      assert.equal(revealed, selected);
      if (scenario.source.includes("main.csl")) assert.equal((configuredYaml.csl ?? configuredYaml.pandocMetadata.csl), "main.csl");
      if (scenario.source.includes("# keep")) assert(text.includes("# keep"));
      if (scenario.language === "markdown") assert.equal(text.slice(getYamlHeader(text).bodyStart), "Body\n");
      else assert(!text.startsWith("---"), "A style file must remain a plain configuration document");
      if (scenario.scope[0] === "pandoc-metadata") assert.equal(configuredYaml.pandocMetadata, undefined);
    }

    // Project edits during search must survive without applying a stale selected style.
    text = "pandocMetadata:\n  csl: initial.csl\n";
    document.languageId = "yaml";
    document.uri.fsPath = path.join(projectRoot, "style.yml");
    const original = getCslConfigurationContent(document as any);
    text = "pandocMetadata:\n  csl: concurrent.csl\n";
    await assert.rejects(controller.applyStyle(document as any, ["pandocMetadata", "csl"], { name: "journal", title: "Journal" }, original), /配置已改变/);
    assert.equal(parse(text).pandocMetadata.csl, "concurrent.csl");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CSL key and path hovers offer style selection for their own source and metadata scope", () => {
  /** Models hover markdown so the test can follow the actual command URI presented to users. */
  class MarkdownString {
    value = "";
    isTrusted: unknown;
    /** Adds field help text. */
    appendText(text: string) { this.value += text; }
    /** Adds the rendered command link. */
    appendMarkdown(text: string) { this.value += text; }
  }
  /** Retains hover contents and range as the VS Code host would. */
  class Hover {
    /** Exposes rendered help for key and value hover interactions. */
    constructor(public contents: MarkdownString, public range: unknown) {}
  }
  /** Carries offsets through the hover API. */
  class Range {
    /** Stores both token endpoints. */
    constructor(public start: number, public end: number) {}
  }
  const fixture = new SourceModuleFixture({ vscode: { MarkdownString, Hover, Range } });
  const { MarkdownYamlHeaderHoverProvider } = fixture.load<typeof import("../src/markdownYamlHeader")>("src/markdownYamlHeader.ts");
  const { StyleConfigurationHoverProvider } = fixture.load<typeof import("../src/styleConfiguration")>("src/styleConfiguration.ts");
  for (const scenario of [
    { text: "---\ncsl: chosen.csl\n---\nBody\n", language: "markdown", filename: "manuscript.md", keys: ["csl"] },
    { text: "---\npapper-settings:\n  pandocMetadata: { csl: chosen.csl }\n---\n", language: "markdown", filename: "manuscript.md", keys: ["papper-settings", "pandocMetadata", "csl"] },
    { text: "reply:\n  pandoc-metadata:\n    csl: chosen.csl\n", language: "yaml", filename: "style.yml", keys: ["reply", "pandoc-metadata", "csl"] },
  ]) {
    const uri = `file:///${scenario.filename}`;
    const document = { version: 1, uri: { scheme: "file", fsPath: scenario.filename, toString: () => uri }, languageId: scenario.language,
      getText: () => scenario.text, positionAt: (offset: number) => offset, offsetAt: (position: number) => position };
    const provider = scenario.language === "yaml" ? new StyleConfigurationHoverProvider() : new MarkdownYamlHeaderHoverProvider();
    for (const offset of [scenario.text.indexOf("csl:"), scenario.text.indexOf("chosen.csl")]) {
      const hover = provider.provideHover(document as any, offset as any, { isCancellationRequested: false } as any) as unknown as Hover;
      const link = /\[设置参考文献样式\]\(command:([^?]+)\?([^)]*)\)/.exec(hover.contents.value);
      assert(link, "Both the CSL key and file path should offer selection");
      assert.deepEqual(JSON.parse(decodeURIComponent(link[2])), [uri, scenario.keys]);
      assert.deepEqual(hover.contents.isTrusted, { enabledCommands: [link[1]] });
    }
  }
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
  const { attachZoteroSearch } = fixture.load<typeof import("../src/inlayHints/csl/picker")>("src/inlayHints/csl/picker.ts");
  const pending = new Map<string, { resolve: (value: unknown) => void; signal: AbortSignal }>();
  const choosing = attachZoteroSearch(picker.webview as any, { getStyles: async () => [{ name: "first", title: "First" }, { name: "second", title: "Second" }],
    getPreview: (style: ZoteroStyle, signal: AbortSignal) => new Promise((resolve) => pending.set(style.name, { resolve, signal })) } as any, () => {}, () => {}, () => {});
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
  choosing.dispose();
  pending.get("first").resolve({ citations: ["late"], bibliography: "late" });
  await Promise.resolve();
  assert.equal(picker.messages.filter((message) => message.type === "preview").length, 1);
});
