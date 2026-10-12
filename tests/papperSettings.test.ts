import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { getYamlHeader } from "../src/manuscriptStyle/document";
import { SourceModuleFixture } from "./helpers/sourceModule";

const model = new SourceModuleFixture({ vscode: {} }).load<typeof import("../src/papperSettings/model")>("src/papperSettings/model.ts");

/** Applies the production edit to a source buffer without replacing source offsets with a test implementation. */
function apply(text: string, style: boolean, keys: string[], input: string, reset = false): string {
  const edit = model.createSettingsEdit(text, style, keys, input, reset);
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

test("unified settings update formula, table and custom DOCX fields while preserving source prose and comments", () => {
  let text = '\uFEFF---\r\ntitle: Paper # keep title\r\npapper-settings:\r\n  mathtype: false # keep formula\r\n---\r\nBody with $x$ and a table\r\n';
  text = apply(text, false, ["papperSettings", "mathtype"], "true");
  text = apply(text, false, ["papperSettings", "tableAutofit"], "content");
  text = apply(text, false, ["papperSettings", "docxStyle", "Journal Body", "fontSize"], "10.5pt");
  text = apply(text, false, ["papperSettings", "docxStyle", "Journal Body", "bold"], "false");
  const header = getYamlHeader(text);
  const settings = parse(header.content)["papper-settings"];
  assert.equal(settings.mathtype, true);
  assert.equal(settings.tableAutofit, "content");
  assert.deepEqual(settings.docxStyle["Journal Body"], { fontSize: "10.5pt", bold: false });
  assert.equal(text.slice(header.bodyStart), "Body with $x$ and a table\r\n");
  assert(text.startsWith("\uFEFF---\r\n"));
  assert(text.includes("# keep title") && text.includes("# keep formula"));
  assert.equal(settings.papperSettings, undefined);
  const restored = apply(text, false, ["papperSettings", "mathtype"], "", true);
  assert.equal(parse(getYamlHeader(restored).content)["papper-settings"].mathtype, undefined);
  const standalone = apply("Body\n", false, ["papperSettings", "mathtype"], "true");
  assert.equal(parse(getYamlHeader(standalone).content).papperSettings.mathtype, true);
  assert.equal(standalone.slice(getYamlHeader(standalone).bodyStart), "Body\n");
});

test("settings preserve project and reply scopes, show inherited values and refuse shared-node edits", () => {
  const project = "mathtype: false\ntableAutofit: window\nreply:\n  tableAutofit: fixed\npandoc-metadata:\n  figPrefix: [Fig., Figs.]\ndocx-style:\n  Journal Body:\n    fontFamily: Times New Roman\n";
  const inherited = model.getSettingsRows("Body\n", false, "main", "math", "Body Text", project);
  assert.equal(inherited.find((row) => row.title === "mathtype").inherited, "false");
  assert.equal(inherited.find((row) => row.title === "mathtype").configured, false);
  const replyRows = model.getSettingsRows("mathtype: true\nreply: {}\n", true, "reply", "math");
  assert.equal(replyRows.find((row) => row.title === "mathtype").inherited, "true");
  const updated = apply(project, true, ["reply", "tableAutofit"], "content");
  assert.equal(parse(updated).tableAutofit, "window");
  assert.equal(parse(updated).reply.tableAutofit, "content");
  const refs = apply(updated, true, ["pandocMetadata", "figPrefix"], "[Figure, Figures]");
  assert.deepEqual(parse(refs)["pandoc-metadata"].figPrefix, ["Figure", "Figures"]);
  assert.equal(parse(refs).pandocMetadata, undefined);
  assert(model.getSettingsStyleNames(project, true, "main").includes("Journal Body"));
  assert.equal(model.getSettingsRows(project, true, "main", "docx", "Journal Body").find((row) => row.title === "fontFamily").value, "Times New Roman");
  assert.throws(() => apply("defaults: &shared {mathtype: false}\nreply: *shared\n", true, ["reply", "mathtype"], "true"), /anchor|alias/);
  assert.throws(() => apply(project, true, ["arbitrarySetting"], "true"), /不支持/);
});

/** Models a settings panel's event bridge, allowing actual host lifecycle and user actions to run. */
class SettingsPanel {
  messages: Array<Record<string, any>> = [];
  private listeners = new Set<(message: unknown) => void>();
  private disposeListeners = new Set<() => void>();
  disposed = false;
  reveals = 0;
  webview = {
    html: "",
    /** Captures the state delivered to the settings UI. */
    postMessage: async (message: Record<string, any>) => { this.messages.push(message); return true; },
    /** Subscribes settings and Zotero handlers independently. */
    onDidReceiveMessage: (listener: (message: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; },
  };
  /** Registers panel closure handlers. */
  onDidDispose(listener: () => void) { this.disposeListeners.add(listener); return { dispose: () => this.disposeListeners.delete(listener) }; }
  /** Models focusing the same page during navigation. */
  reveal() { this.reveals++; }
  /** Closes the panel exactly once. */
  dispose() { if (this.disposed) return; this.disposed = true; [...this.disposeListeners].forEach((listener) => listener()); }
  /** Sends a user interaction to all registered host bridges. */
  send(message: Record<string, unknown>) { [...this.listeners].forEach((listener) => listener(message)); }
  /** Returns the latest rendered configuration. */
  state() { return this.messages.filter((message) => message.type === "settingsState").at(-1); }
}

test("CSL entry navigates the reusable settings window, and downloads only after confirmation inside its bibliography section", async () => {
  let text = "mathtype: false\npandoc-metadata:\n  csl: existing.csl\n";
  let indexLoads = 0;
  let applications = 0;
  let changed: (event: unknown) => void;
  const panels: SettingsPanel[] = [];
  /** Supplies actual source identity and URI serialization to both entry points. */
  class Uri {
    scheme = "file";
    fsPath = "C:/project/style.yml";
    /** Returns the bound source, independent of focus. */
    toString() { return "file:///C:/project/style.yml"; }
    /** Parses the source encoded by a hover. */
    static parse() { return new Uri(); }
  }
  /** Carries source edit offsets. */
  class Range { /** Stores the replacement range. */ constructor(public start: number, public end: number) {} }
  /** Captures the workspace edit used while the settings page retains focus. */
  class WorkspaceEdit {
    edit?: { range: Range; text: string };
    /** Records the pending source change. */
    replace(_uri: Uri, range: Range, value: string) { this.edit = { range, text: value }; }
  }
  const document = { uri: new Uri(), languageId: "yaml", getText: () => text, positionAt: (offset: number) => offset };
  const fixture = new SourceModuleFixture({ vscode: {
    Uri, Range, WorkspaceEdit, ViewColumn: { Active: -1 },
    workspace: {
      openTextDocument: async () => document,
      onDidChangeTextDocument: (listener: typeof changed) => { changed = listener; return { dispose() {} }; },
      applyEdit: async (edit: WorkspaceEdit) => { text = text.slice(0, edit.edit.range.start) + edit.edit.text + text.slice(edit.edit.range.end); changed({ document }); return true; },
    },
    window: { activeTextEditor: { document }, createWebviewPanel: () => { const panel = new SettingsPanel(); panels.push(panel); return panel; }, showErrorMessage: () => {} },
  } });
  const { PapperSettingsController } = fixture.load<typeof import("../src/papperSettings/controller")>("src/papperSettings/controller.ts");
  const csl = { repository: { getStyles: async () => { indexLoads++; return [{ name: "journal", title: "Journal" }]; } },
    applyStyle: async (_document: unknown, keys: string[], _style: unknown, original: string) => {
      assert.equal(original, text); applications++;
      text = apply(text, true, keys, "pandoc/csl/journal.csl"); return true;
    } };
  const controller = new PapperSettingsController({ appendLine() {} } as any, csl as any);
  /** Allows asynchronous host messages and configuration refreshes to finish. */
  async function settle() { await new Promise((resolve) => setImmediate(resolve)); }
  await controller.open(undefined, "bibliography", ["pandoc-metadata", "csl"]);
  const panel = panels[0];
  panel.send({ type: "settingsReady" }); await settle();
  assert.equal(panel.state().section, "bibliography");
  assert.equal(panel.state().rows.find((row: any) => row.title === "csl").value, "existing.csl");
  assert.equal(applications, 0);
  panel.send({ type: "ready" }); await settle();
  assert.equal(indexLoads, 1);
  panel.send({ type: "select", name: "journal" }); await settle();
  assert.equal(applications, 1);
  assert.equal(parse(text)["pandoc-metadata"].csl, "pandoc/csl/journal.csl");
  assert.equal(panel.disposed, false, "Applying a bibliography style keeps the unified settings window open");
  await controller.open(undefined, "math");
  assert.equal(panels.length, 1);
  assert.equal(panel.state().section, "math");
  panel.send({ type: "settingsSave", path: ["mathtype"], input: "true", original: panel.state().content }); await settle();
  assert.equal(parse(text).mathtype, true);
  const stale = panel.state().content;
  text = "mathtype: false # external change\n";
  changed({ document });
  panel.send({ type: "settingsSave", path: ["mathtype"], input: "true", original: stale }); await settle();
  assert.equal(parse(text).mathtype, false);
  assert(panel.messages.some((message) => message.type === "settingsError"));
  controller.dispose();
  assert(panel.disposed);
});
