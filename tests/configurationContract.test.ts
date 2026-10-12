import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Shares one real contract model across completion, header and settings consumers. */
function fixture() {
  const modules = new SourceModuleFixture({ vscode: {} });
  return {
    contract: modules.load<typeof import("../src/configurationContract")>("src/configurationContract.ts"),
    completion: modules.load<typeof import("../src/styleConfiguration")>("src/styleConfiguration.ts"),
    header: modules.load<typeof import("../src/markdownYamlHeader")>("src/markdownYamlHeader.ts"),
    settings: modules.load<typeof import("../src/papperSettings/model")>("src/papperSettings/model.ts"),
  };
}

/** Requests real completion edits at the end of a YAML input fragment. */
function suggestions(api: ReturnType<typeof fixture>, text: string) {
  return api.completion.getStyleSuggestions(text, text.length);
}

test("a newer Papper contract immediately enables completion, header help and settings for a new field", () => {
  const api = fixture();
  const next = structuredClone(api.contract.getConfigurationContract());
  next.schemas.style.properties.journalMode = { description: "Choose the journal mode", type: "string", enum: ["review", "final"] };
  api.contract.applyConfigurationContract(next);
  const key = suggestions(api, "journalM").find((item) => item.label === "journalMode");
  assert(key);
  const completed = "journalM".slice(0, key.start) + key.insertText;
  assert.deepEqual(parse(completed), { journalMode: null });
  const value = suggestions(api, "journalMode: rev").find((item) => item.label === "review");
  assert(value);
  const source = "journalMode: rev";
  assert.equal(parse(source.slice(0, value.start) + value.insertText + source.slice(value.end)).journalMode, "review");
  const header = "---\npapperSettings:\n  journalMode: review\n---\nUnchanged body\n";
  assert(api.header.getMarkdownHeaderHoverEntries(header).some((entry) => entry.description === "Choose the journal mode"));
  const row = api.settings.getSettingsRows(header, false, "main", "general").find((entry) => entry.title === "journalMode");
  assert(row);
  const edit = api.settings.createSettingsEdit(header, false, row.path, "final");
  const updated = header.slice(0, edit.start) + edit.text + header.slice(edit.end);
  assert(updated.endsWith("Unchanged body\n"));
  assert.equal(parse(updated.split("---")[1]).papperSettings.journalMode, "final");
});

test("unsupported or damaged exports preserve the active template, help and editable settings", () => {
  const api = fixture();
  const before = api.contract.getConfigurationContract();
  const revision = api.contract.getConfigurationRevision();
  for (const damage of [
    { ...before, contractVersion: 99 },
    { ...before, templates: {} },
    { ...before, schemas: { ...before.schemas, manuscriptFrontmatter: { properties: {} } } },
    { ...before, rules: [{ scope: "style", kind: "atMostOne", paths: [null as unknown] }] },
  ]) assert.throws(() => api.contract.applyConfigurationContract(damage));
  assert.equal(api.contract.getConfigurationRevision(), revision);
  assert.equal(api.contract.getConfigurationContract(), before);
  const input = "# Keep my override\nmathtype: false\n";
  const merged = api.completion.mergeStyleExample(input, api.contract.getConfigurationContract().templates.styleProject);
  assert(merged.text.includes("# Keep my override"));
  assert.equal(parse(merged.text).mathtype, false);
  assert.equal(api.completion.mergeStyleExample(merged.text, before.templates.styleProject).text, merged.text);
});

test("exported rules suppress conflicting alias spellings without suppressing unrelated indentation", () => {
  const api = fixture();
  const text = "docx-style:\n  Journal:\n    indentation: { first-line: 0.5cm }\n    ";
  assert(!suggestions(api, text).some((item) => item.label === "firstLineIndentChars"));
  const nested = "docxStyle:\n  Journal:\n    first-line-indent-chars: 2\n    indentation:\n      ";
  const keys = suggestions(api, nested).map((item) => item.label);
  assert(!keys.includes("firstLine") && !keys.includes("hanging"));
  assert(keys.includes("left") && keys.includes("right"));
  const pixels = "docx-svg-to-png-width: 1200\n";
  assert(!suggestions(api, pixels).some((item) => item.label === "docxSvgToPngDpi" || item.label === "docxSvgToPngScale"));
});

test("footer and page-width edits preserve explicit null, empty content, source comments and manuscript text", () => {
  const api = fixture();
  let source = "---\ntitle: Paper # title note\n---\nBody\n";
  for (const [keys, input] of [
    [["papperSettings", "docxFooter", "content"], ''],
    [["papperSettings", "docxPageWidth"], '21cm'],
  ] as const) {
    const edit = api.settings.createSettingsEdit(source, false, [...keys], input);
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  assert.deepEqual(parse(source.split("---")[1]).papperSettings, { docxFooter: { content: "" }, docxPageWidth: "21cm" });
  const edit = api.settings.createSettingsEdit(source, false, ["papperSettings", "docxFooter"], "null");
  source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  assert.equal(parse(source.split("---")[1]).papperSettings.docxFooter, null);
  assert(source.includes("# title note") && source.endsWith("Body\n"));
});
