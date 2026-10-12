import assert from "node:assert/strict";
import test from "node:test";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Exercises real source parsing and the same exported definitions used by the editor. */
function fixture() {
  const modules = new SourceModuleFixture({ vscode: {} });
  return {
    contract: modules.load<typeof import("../src/configurationContract")>("src/configurationContract.ts"),
    model: modules.load<typeof import("../src/elementAttributes/model")>("src/elementAttributes/model.ts"),
  };
}

/** Resolves a marked cursor and applies actual completion edits without discarding the suffix. */
function complete(api: ReturnType<typeof fixture>, input: string, label: string): string {
  const offset = input.indexOf("¦");
  assert(offset >= 0);
  const text = input.replace("¦", "");
  const item = api.model.getAttributeSuggestions(text, offset)?.find((item) => item.label === label);
  assert(item, `Missing ${label} in ${input}`);
  return text.slice(0, item.start) + item.insertText + text.slice(item.end);
}

/** Requests suggestions at a marker while retaining complete attributes after the cursor. */
function labels(api: ReturnType<typeof fixture>, input: string): string[] {
  return api.model.getAttributeSuggestions(input.replace("¦", ""), input.indexOf("¦"))?.map((item) => item.label) ?? [];
}

test("table attribute edits retain labels, aliases, values and surrounding manuscript text", () => {
  const api = fixture();
  assert.equal(complete(api, ': Results {#tbl:results cell_mar¦gin="2pt"}\nBody', "cell_margin"),
    ': Results {#tbl:results cell_margin="2pt"}\nBody');
  assert.equal(complete(api, ': Results {#tbl:results alignment="ce¦nter" row_height="1cm"}', "center"),
    ': Results {#tbl:results alignment="center" row_height="1cm"}');
  assert.equal(complete(api, 'Table: Results {#tbl:results cell-m¦}', "cell-margin"),
    'Table: Results {#tbl:results cell-margin=""}');
  assert(!labels(api, ': Results {cell-margin="2pt" ¦}').includes("cell_margin"));
  const text = ': Results {cell-margin="2pt" revision_rows="1,3"}';
  assert(api.model.getAttributeHoverEntries(text).some((entry) => entry.label === "cell-margin" && entry.description.includes("内边距")));
  assert.equal(api.model.getAttributeSuggestions('Plain paragraph {', 17), undefined);
  assert.deepEqual(labels(api, ': Results {#tbl:par¦}'), []);
});

test("empty spans select their exact t domain even when t follows the cursor", () => {
  const api = fixture();
  assert.deepEqual(labels(api, '[]{¦ t="toc"}').sort(), ["depth", "title"]);
  assert.deepEqual(labels(api, '[]{t="pageBreak" ¦}'), []);
  assert.deepEqual(labels(api, '[]{t="unknown" ¦}'), []);
  assert.deepEqual(labels(api, '[]{t="TOC" ¦}'), []);
  assert.equal(complete(api, '[]{t=to¦c}', "toc"), '[]{t="toc"}');
  assert.equal(complete(api, "[]{t='toc' depth='¦'}", "3"), "[]{t='toc' depth='3'}");
  assert.equal(complete(api, '[]{t="toc" de¦', "depth"), '[]{t="toc" depth=""');
  assert(labels(api, '[]{t="currentDate" format="¦"}').includes("yyyy-MM-dd"));
  const toc = api.model.getAttributeHoverEntries('[]{t="toc" depth="3" format="decimal"}');
  assert(toc.some((entry) => entry.label === "t" && entry.description.includes("目录")));
  assert(toc.some((entry) => entry.label === "depth" && entry.description.includes("1 到 9")));
  assert(!toc.some((entry) => entry.label === "format"));
});

test("quoted braces and embedded page stories do not mix inner and outer attribute domains", () => {
  const api = fixture();
  assert.equal(complete(api, '[]{t="sectionBreak" footer=\'Page []{t="pageNum" format="up¦perRoman"}\' kind="continuous"}', "upperRoman"),
    '[]{t="sectionBreak" footer=\'Page []{t="pageNum" format="upperRoman"}\' kind="continuous"}');
  assert(labels(api, '[]{t="sectionBreak" footer=\'Page []{t="pageNum"}\' ¦}').includes("kind"));
  assert.equal(complete(api, '[]{t="sectionBreak" footer="¦"}', '[]{t="pageNum"}'),
    '[]{t="sectionBreak" footer="[]{t=\\"pageNum\\"}"}');
  assert.equal(complete(api, '[]{t="toc" title="Braces {are text}" depth="¦"}', "3"),
    '[]{t="toc" title="Braces {are text}" depth="3"}');
  assert.equal(complete(api, '[]{t="toc" depth="¦', "3"), '[]{t="toc" depth="3"');
  assert.equal(complete(api, '[]{t="sectionBreak" footer="[]{t=\\"pageNum\\" format=\\"up¦perRoman\\"}"}', "upperRoman"),
    '[]{t="sectionBreak" footer="[]{t=\\"pageNum\\" format=\\"upperRoman\\"}"}');
  assert.equal(complete(api, '[]{t="sectionBreak" footer="[]{t=\\"pageNum\\" f¦}"}', "format"),
    '[]{t="sectionBreak" footer="[]{t=\\"pageNum\\" format=\'\'}"}');
  assert.equal(complete(api, '[]{t="sectionBreak" footer="[]{t=pa¦}"}', "pageNum"),
    '[]{t="sectionBreak" footer="[]{t=\'pageNum\'}"}');
});

test("literal examples never receive attribute help while following body content does", () => {
  const api = fixture();
  for (const text of [
    '---\nexample: []{t="toc" depth="¦"}\n---\n',
    '---\nexample: []{t="toc" depth="¦"}',
    '```markdown\n[]{t="toc" depth="¦"}\n```',
    '~~~~md\n[]{t="toc" depth="¦"}\n~~~\n~~~~',
    '    []{t="toc" depth="¦"}',
    '`[]{t="toc" depth="¦"}`',
    '<!-- []{t="toc" depth="¦"} -->',
    '<pre>[]{t="toc" depth="¦"}</pre>',
    '$[]{t="toc" depth="¦"}$',
    '$$\n[]{t="toc" depth="¦"}\n$$',
    '\\[]{t="toc" depth="¦"}',
    '![]{t="toc" depth="¦"}',
    '[Text]{t="toc" depth="¦"}',
  ]) assert.deepEqual(labels(api, text), [], text);
  assert(labels(api, '---\ntitle: Paper\n...\n```md\nLiteral\n```\n\n[]{t="toc" depth="¦"}').includes("3"));
});

test("new exported attributes and t variants become usable without an extension release", () => {
  const api = fixture();
  const next = structuredClone(api.contract.getConfigurationContract());
  next.elementAttributes!.table.properties.journalMode = { description: "Journal table mode", valueType: "string", values: ["review", "final"] };
  next.elementAttributes!.emptySpan.variants!.journalField = { description: "Journal field", properties: {
    mode: { description: "Journal mode", valueType: "string", values: ["review", "final"] },
  } };
  api.contract.applyConfigurationContract(next);
  assert.equal(complete(api, ': Table {journalMode="rev¦iew"}', "review"), ': Table {journalMode="review"}');
  assert.equal(complete(api, '[]{t="jour¦nalField"}', "journalField"), '[]{t="journalField"}');
  assert.equal(complete(api, '[]{t="journalField" mode="¦"}', "final"), '[]{t="journalField" mode="final"}');
  assert(api.model.getAttributeHoverEntries('[]{t="journalField" mode="review"}').some((entry) => entry.description === "Journal mode"));
});

test("older exports retain working attribute help and malformed new exports cannot partially replace it", () => {
  const api = fixture();
  const original = api.contract.getElementAttributeCatalog();
  const older = structuredClone(api.contract.getConfigurationContract());
  delete older.elementAttributes;
  api.contract.applyConfigurationContract(older);
  assert.equal(api.contract.getElementAttributeCatalog(), original);
  assert(labels(api, '[]{t="toc" ¦}').includes("depth"));
  const damaged: unknown[] = [null, [], { table: { description: "Broken", targets: [], properties: [] } },
    { table: { description: "Broken", targets: [], properties: { attr: { description: "Broken", valueType: "string", values: [3] } } } }];
  for (const broken of damaged) {
    const revision = api.contract.getConfigurationRevision();
    assert.throws(() => api.contract.applyConfigurationContract({ ...older, elementAttributes: broken }));
    assert.equal(api.contract.getConfigurationRevision(), revision);
    assert.equal(api.contract.getElementAttributeCatalog(), original);
  }
});
