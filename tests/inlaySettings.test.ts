import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { createManuscriptMetadataEdit, getManuscriptMetadataValue } from "../src/inlayHints/settings";
import { getYamlHeader } from "../src/manuscriptStyle/document";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Applies the same header-only replacement the editor command uses. */
function applySetting(text: string, field: Parameters<typeof createManuscriptMetadataEdit>[1], value: string | string[]): string {
  const edit = createManuscriptMetadataEdit(text, field, value);
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
}

test("prefix and caption edits preserve comments, body, BOM, CRLF and manuscript precedence", () => {
  const source = '\uFEFF---\r\ntitle: Paper # keep title\r\nfigPrefix: Old # keep prefix comment\r\npapperSettings:\r\n  pandocMetadata:\r\n    figPrefix: Nested\r\n...\r\n\r\n![Caption](image.png){#fig:one}\r\nSee @fig:one\r\n';
  const updated = applySetting(source, "figPrefix", "Fig. # literal");
  assert.equal(updated.slice(getYamlHeader(updated).bodyStart), source.slice(getYamlHeader(source).bodyStart));
  assert(updated.startsWith("\uFEFF---\r\n"));
  assert(!/(?<!\r)\n/.test(updated));
  assert(updated.includes("# keep title") && updated.includes("# keep prefix comment"));
  const metadata = parse(getYamlHeader(updated).content);
  assert.equal(metadata.figPrefix, "Fig. # literal");
  assert.equal(metadata.papperSettings.pandocMetadata.figPrefix, "Nested");
  assert.equal(applySetting(updated, "figPrefix", "Fig. # literal"), updated);
  const title = applySetting(updated, "figureTitle", "");
  assert.equal(parse(getYamlHeader(title).content).figureTitle, "");
  assert.equal(title.slice(getYamlHeader(title).bodyStart), source.slice(getYamlHeader(source).bodyStart));
});

test("settings create missing frontmatter and retain singular/plural prefix lists", () => {
  const source = "\uFEFF# Heading\r\n\r\nSee @fig:one\r\n";
  const updated = applySetting(source, "figPrefix", ["Fig.", "Figs."]);
  assert.deepEqual(getManuscriptMetadataValue(updated, "figPrefix"), ["Fig.", "Figs."]);
  assert.equal(updated.slice(getYamlHeader(updated).bodyStart), source.slice(1));
  assert.equal(applySetting(updated, "figPrefix", ["Fig.", "Figs."]), updated);
  const commented = "---\nfigPrefix:\n  - Figure # singular help\n  - Figures # plural help\n---\nBody\n";
  const changed = applySetting(commented, "figPrefix", ["Fig.", "Figs."]);
  assert(changed.includes("# singular help") && changed.includes("# plural help"));
  assert.deepEqual(getManuscriptMetadataValue(changed, "figPrefix"), ["Fig.", "Figs."]);
});

test("setting edits refuse invalid metadata and shared anchors instead of changing unrelated values", () => {
  for (const source of [
    "---\nfigPrefix: A\nfigPrefix: B\n---\nBody",
    "---\nfigPrefix: [\n---\nBody",
    "---\nfigPrefix: &prefix Figure\nother: *prefix\n---\nBody",
    "---\nother: &prefix Figure\nfigPrefix: *prefix\n---\nBody",
    "---\nfigPrefix: [&prefix Figure, Figures]\nother: *prefix\n---\nBody",
    "---\nfigPrefix: {invalid: shape}\n---\nBody",
    "---\nfigPrefix: Old\nBody",
  ]) assert.throws(() => applySetting(source, "figPrefix", "Fig."));
});

/** Provides a source editor distinct from the active editor and records actual command-side edits. */
function commandFixture(initial: string, answers: Array<string | undefined>, onPrompt?: () => void) {
  let text = initial;
  let edits = 0;
  let shownUri = "";
  let selection: { start: { offset: number }; end: { offset: number } } | undefined;
  let revealed: typeof selection;
  const prompts: Array<{ value: string; title: string }> = [];
  const errors: string[] = [];
  const uriText = "file:///manuscript.md";
  const document = {
    uri: { scheme: "file", fsPath: "/manuscript.md", toString: () => uriText }, languageId: "markdown",
    getText: () => text, positionAt: (offset: number) => ({ offset }),
  };
  const editor = {
    document, viewColumn: 2,
    /** Records the user-visible selection after a setting is applied. */
    set selection(value: typeof selection) { selection = value; },
    /** Returns the range selected in the source editor. */
    get selection() { return selection; },
    /** Records the source range scrolled into view. */
    revealRange: (range: typeof selection) => { revealed = range; },
    /** Applies one undoable header replacement and records the resulting manuscript. */
    edit: async (callback: (builder: unknown) => void, options: unknown) => {
      assert.deepEqual(options, { undoStopBefore: true, undoStopAfter: true });
      callback({ replace: (range: { start: { offset: number }; end: { offset: number } }, replacement: string) => {
        text = text.slice(0, range.start.offset) + replacement + text.slice(range.end.offset);
      } });
      edits++;
      return true;
    },
  };
  /** Stores source offsets for the editor replacement. */
  class Range {
    /** Keeps the two original offset positions. */
    constructor(public start: { offset: number }, public end: { offset: number }) {}
  }
  const fixture = new SourceModuleFixture({ vscode: {
    Range, Selection: Range, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ViewColumn: { One: 1 }, Uri: { parse: (value: string) => { assert.equal(value, uriText); return document.uri; } },
    workspace: { openTextDocument: async () => document },
    window: {
      visibleTextEditors: [editor], activeTextEditor: { document: { uri: { toString: () => "file:///other.md" } } },
      showInputBox: async (options: { value: string; title: string }) => { prompts.push(options); onPrompt?.(); return answers.shift(); },
      showTextDocument: async (shown: typeof document, options: { viewColumn: number }) => {
        shownUri = shown.uri.toString(); assert.equal(options.viewColumn, 2); return editor;
      },
      showErrorMessage: (message: string) => errors.push(message),
    },
  } });
  const { InlayMetadataController } = fixture.load<{ InlayMetadataController: new (output: unknown) => {
    setMetadata(uri: string, field: string, value: unknown): Promise<void>;
  } }>("src/inlayHints/actions.ts");
  return {
    controller: new InlayMetadataController({ appendLine() {} }), uriText,
    getText: () => text, getEdits: () => edits, getShownUri: () => shownUri, prompts, errors,
    getSelectedText: () => selection ? text.slice(selection.start.offset, selection.end.offset) : undefined,
    getRevealedText: () => revealed ? text.slice(revealed.start.offset, revealed.end.offset) : undefined,
    setText: (value: string) => { text = value; },
  };
}

test("clicked hint edits its source using the actual inherited value and the latest explicit override", async () => {
  const inherited = commandFixture("See @fig:one\n", ["Fig."]);
  await inherited.controller.setMetadata(inherited.uriText, "figPrefix", "图");
  assert.equal(inherited.prompts[0].value, "图");
  assert.equal(inherited.getShownUri(), inherited.uriText);
  assert.equal(inherited.getEdits(), 1);
  assert.equal(inherited.getSelectedText(), '"Fig."');
  assert.equal(inherited.getRevealedText(), '"Fig."');
  assert.equal(parse(getYamlHeader(inherited.getText()).content).figPrefix, "Fig.");
  assert.equal(inherited.getText().slice(getYamlHeader(inherited.getText()).bodyStart), "See @fig:one\n");
  const explicit = commandFixture('---\nfigPrefix: Explicit\n---\nSee @fig:one\n', ["New"]);
  await explicit.controller.setMetadata(explicit.uriText, "figPrefix", "Old build value");
  assert.equal(explicit.prompts[0].value, "Explicit");
  assert.equal(parse(getYamlHeader(explicit.getText()).content).figPrefix, "New");
  assert.equal(explicit.getSelectedText(), '"New"');
  assert.equal(explicit.getRevealedText(), '"New"');
});

test("setting navigation finds the top-level value for unchanged, empty and plural fields", async () => {
  for (const value of ["Same", "", ["Fig.", "Figs."]]) {
    const source = `\uFEFF---\r\n# figPrefix: misleading comment\r\npapperSettings:\r\n  pandocMetadata:\r\n    figPrefix: Nested\r\n"figPrefix": ${JSON.stringify(value)} # keep\r\n...\r\nBody figPrefix: misleading\r\n`;
    const answers = Array.isArray(value) ? value : [value];
    const fixture = commandFixture(source, [...answers]);
    await fixture.controller.setMetadata(fixture.uriText, "figPrefix", "Inherited");
    assert.equal(fixture.getEdits(), 0);
    assert.equal(fixture.getText(), source);
    assert.deepEqual(parse(fixture.getSelectedText()), value);
    assert.equal(fixture.getSelectedText(), fixture.getRevealedText());
  }
});

test("cancelled singular/plural prompts never partially edit metadata", async () => {
  const source = "See @fig:one\n";
  const fixture = commandFixture(source, ["Fig.", undefined]);
  await fixture.controller.setMetadata(fixture.uriText, "figPrefix", ["Figure", "Figures"]);
  assert.deepEqual(fixture.prompts.map((prompt) => prompt.value), ["Figure", "Figures"]);
  assert.equal(fixture.getEdits(), 0);
  assert.equal(fixture.getText(), source);
  assert.equal(fixture.getSelectedText(), undefined);
});

test("a hover setting never overwrites metadata edited while its prompt is open", async () => {
  const concurrent = "---\nfigureTitle: Concurrent\n---\nBody\n";
  const fixture = commandFixture("---\nfigureTitle: Original\n---\nBody\n", ["New"], () => fixture.setText(concurrent));
  await fixture.controller.setMetadata(fixture.uriText, "figureTitle", "Original");
  assert.equal(fixture.getEdits(), 0);
  assert.equal(fixture.getText(), concurrent);
  assert.equal(fixture.getSelectedText(), undefined);
  assert.match(fixture.errors[0], /YAML header 已改变/);
});
