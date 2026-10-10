import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { isMap, isScalar, parse, parseDocument } from "yaml";
import { addManuscriptStyle, getManuscriptStyleTargets, getYamlHeader } from "../src/manuscriptStyle/document";
import { findReferenceStyle, readReferenceStyles } from "../src/manuscriptStyle/referenceStyles";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Constructs an independent Word reference fixture with inheritance and partial paragraph overrides. */
function referenceDocx(): Uint8Array {
  return zipSync({
    "word/styles.xml": strToU8(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Default Latin" w:eastAsia="默认中文"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/><w:spacing w:before="120" w:after="80" w:line="360"/><w:ind w:firstLineChars="200" w:left="240"/></w:pPr><w:rPr><w:b/><w:color w:val="FF0088"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="localized-id"><w:name w:val="Body Text"/><w:basedOn w:val="Base"/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="宋体"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Base"/><w:pPr><w:ind w:hanging="360"/><w:spacing w:line="400" w:lineRule="exact"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="ImageCaption"><w:name w:val="Image Caption"/><w:basedOn w:val="Base"/><w:pPr><w:spacing w:beforeAutospacing="1" w:line="360" w:lineRule="atLeast"/></w:pPr><w:rPr><w:color w:val="auto"/></w:rPr></w:style>
    </w:styles>`),
  });
}

/** Confirms real style inheritance and OpenXML unit conversion rather than hard-coded extension defaults. */
function readsEffectiveReferenceFormatting(): void {
  const styles = readReferenceStyles(referenceDocx());
  const body = findReferenceStyle(styles, "正文文本");
  assert.deepEqual(body.values.fontFamily, { western: "Default Latin", chinese: "宋体" });
  assert.equal(body.values.fontSize, "12pt");
  assert.equal(body.values.lineSpacing, 1.5);
  assert.equal(body.values.firstLineIndentChars, 2);
  assert.equal(body.values.bold, true);
  assert.equal(body.values.fontColor, "#FF0088");
  assert.equal(body.values.alignment, "justify");
  assert.deepEqual(body.values.paragraphSpacing, { before: "0pt", after: "0pt" });
  assert.deepEqual(body.values.indentation, { left: "12pt", right: "0pt" });
  const heading = findReferenceStyle(styles, "标题 1");
  assert.equal(heading.values.lineSpacing, "20pt");
  assert.equal(heading.values.firstLineIndentChars, undefined);
  assert.deepEqual(heading.values.indentation, { left: "12pt", right: "0pt", hanging: "18pt" });
}

/** Keeps Word-only auto/at-least values out of generated Papper configuration. */
function preservesUnrepresentableWordFormatting(): void {
  const caption = findReferenceStyle(readReferenceStyles(referenceDocx()), "Image Caption");
  assert.equal(caption.values.lineSpacing, undefined);
  assert.equal(caption.values.fontColor, undefined);
  assert.equal((caption.values.paragraphSpacing as Record<string, string>).before, undefined);
  assert.match(caption.notes.lineSpacing, /至少 18pt/);
  assert.match(caption.notes.fontColor, /auto/);
  assert.match(caption.notes["paragraphSpacing.before"], /自动/);
}

/** Verifies header creation and updates preserve exact manuscript body, BOM, comments and user overrides. */
function editsFrontmatterWithoutLosingContent(): void {
  const defaults = findReferenceStyle(readReferenceStyles(referenceDocx()), "正文文本").values;
  const withoutHeader = "\uFEFF# 研究\r\n\r\n正文内容\r\n";
  const created = addManuscriptStyle(withoutHeader, "正文文本", defaults).text;
  const createdHeader = getYamlHeader(created);
  assert.equal(created.slice(createdHeader.bodyStart), `\r\n${withoutHeader.slice(1)}`);
  assert.equal(parse(createdHeader.content)["papperSettings"].docxStyle.正文文本.firstLineIndentChars, 2);
  const createdStyle = parseDocument(createdHeader.content).getIn(["papperSettings", "docxStyle", "正文文本"], true);
  assert.ok(isMap(createdStyle));
  /** Checks inserted leaf help as user-visible YAML comments without duplicating schema strings. */
  const checkInlineHelp = (map: typeof createdStyle): void => {
    for (const entry of map.items) {
      if (isMap(entry.value)) checkInlineHelp(entry.value);
      else {
        assert.ok(isScalar(entry.value));
        assert.ok(entry.value.comment?.trim(), `Missing inline help for ${String(entry.key)}`);
      }
    }
  };
  checkInlineHelp(createdStyle);
  assert.match(created, /firstLineIndentChars: 2 #[^\r\n]+/);
  assert.match(created, /before: 0pt #[^\r\n]+/);
  const original = "---\r\ntitle: Paper # keep title\r\npapperSettings:\r\n  docx-style:\r\n    Body Text:\r\n      fontSize: 10.5pt # keep size\r\n      paragraphSpacing: {before: 8pt}\r\n      indentation: {hanging: 0.5cm}\r\n...\r\n\r\n# Body\r\nUntouched  text\r\n";
  const merged = addManuscriptStyle(original, "正文文本", defaults);
  const header = getYamlHeader(merged.text);
  const body = parse(header.content)["papperSettings"]["docx-style"]["Body Text"];
  assert.equal(merged.styleName, "Body Text");
  assert.equal(body.fontSize, "10.5pt");
  assert.equal(body.paragraphSpacing.before, "8pt");
  assert.equal(body.paragraphSpacing.after, "0pt");
  assert.equal(body.indentation.hanging, "0.5cm");
  assert.equal(body.firstLineIndentChars, undefined);
  assert.ok(merged.text.includes("# keep title") && merged.text.includes("# keep size"));
  const mergedSize = parseDocument(header.content).getIn(["papperSettings", "docx-style", "Body Text", "fontSize"], true);
  assert.ok(isScalar(mergedSize));
  assert.equal(mergedSize.comment?.trim(), "keep size");
  assert.equal(merged.text.slice(header.bodyStart), original.slice(getYamlHeader(original).bodyStart));
  assert.equal(addManuscriptStyle(merged.text, "正文文本", defaults).text, merged.text);
}

/** Refuses malformed frontmatter rather than silently discarding existing document metadata. */
function rejectsInvalidMetadata(): void {
  assert.throws(() => addManuscriptStyle("---\ntitle: x\nBody", "正文文本", {}), /结束分隔符/);
  assert.throws(() => addManuscriptStyle("---\npapperSettings: text\n---\nBody", "正文文本", {}), /对象/);
  assert.throws(() => addManuscriptStyle("---\npapperSettings:\n  docxStyle: &styles {}\n  other: *styles\n---\nBody", "正文文本", {}), /anchor/);
}

/** Exercises real source categories and excludes misleading elements inside code, math, YAML and comments. */
function detectsMarkdownElements(): void {
  const markdown = ["---", "title: Hidden heading", "---", "# Section", "", "Body ![caption](figure.png) more", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "```markdown", "# Fake heading", "![fake](fake.png)", "```", "", "<!-- hidden", "# hidden too", "-->", "", "$$", "fake text", "$$", "", "Setext heading", "===", "", "Literal `![fake](fake.png)`", "", "::: {custom-style=\"Quote\"}", "Quoted paragraph", ":::"] .join("\n");
  const targets = getManuscriptStyleTargets(markdown);
  assert.equal(targets.find((entry) => entry.line === 3).name, "标题 1");
  assert.equal(targets.find((entry) => entry.line === 5 && entry.name === "Image Caption").startCharacter, 5);
  assert.deepEqual(targets.filter((entry) => entry.line >= 7 && entry.line <= 9).map((entry) => entry.name), ["Table Text", "Table Text", "Table Text"]);
  assert.equal(targets.find((entry) => entry.line === 24).name, "标题 1");
  assert.equal(targets.find((entry) => entry.line === 30).name, "Quote");
  assert.equal(targets.filter((entry) => entry.name === "Image Caption").length, 1);
  assert.ok(!targets.some((entry) => entry.line < 3 || (entry.line >= 11 && entry.line <= 22)));
  assert.equal(getManuscriptStyleTargets("\\[x+y\\]\n\nVisible body").find((entry) => entry.line === 2).name, "正文文本");
}

/** Verifies a source hover renders only its button without needing an installed/exportable Papper. */
function showsOnlyStyleButton(): void {
  /** Captures the rendered hover Markdown independently of VS Code. */
  class HoverMarkdown {
    value = "";
    isTrusted: unknown;

    /** Records the content the user would see. */
    appendMarkdown(value: string): void { this.value += value; }
  }
  /** Represents the hover result returned synchronously to the editor. */
  class HoverResult {
    /** Keeps its content available for user-visible output assertions. */
    constructor(readonly content: HoverMarkdown, readonly range: unknown) {}
  }
  const { ManuscriptStyleController } = new SourceModuleFixture({
    vscode: {
      MarkdownString: HoverMarkdown,
      Hover: HoverResult,
      Range: class {
        /** Accepts source coordinates without accessing VS Code. */
        constructor(..._coordinates: number[]) {}
      },
    },
    // No Papper APIs are provided: a hover must remain usable before Papper has been installed.
    "src/papperBuildUtils.ts": {},
  }).load<typeof import("../src/manuscriptStyle/controller")>("src/manuscriptStyle/controller.ts");
  const uriText = "file:///paper.md";
  const document = {
    uri: { scheme: "file", toString: () => uriText },
    version: 1,
    getText: () => "# Heading",
  } as never;
  const controller = new ManuscriptStyleController({ globalStorageUri: { fsPath: os.tmpdir() } } as never, undefined);
  const hover = controller.provideHover(document, { line: 0, character: 2 } as never, { isCancellationRequested: false } as never) as unknown;
  assert.ok(hover instanceof HoverResult);
  const button = /^\[([^\]]+)\]\(command:([^?]+)\?([^\n]+)\)$/.exec(hover.content.value);
  assert.ok(button, "Hover must contain one button link and no additional content");
  assert.match(button[1], /^Papper: .*标题 1/);
  assert.deepEqual(JSON.parse(decodeURIComponent(button[3])), [uriText, "标题 1"]);
}

/** Verifies first-use deduplication, disk reuse and invalidation when formatting actually changes. */
async function cachesOnlyFormattingInputs(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pmt-style-test-"));
  try {
    const executable = path.join(directory, "papper.exe");
    const source = path.join(directory, "paper.md");
    const styleFile = path.join(directory, "style.yml");
    await writeFile(executable, "fixture");
    await writeFile(styleFile, "docxStyle: {}\n");
    let text = "---\nlang: zh-CN\n---\nUnsaved body";
    let exports = 0;
    const snapshots: string[] = [];
    const messages: string[] = [];
    const output = { appendLine: (message: string) => messages.push(message) };
    /** Creates a cache with the production implementation and a deterministic external Papper boundary. */
    const makeCache = () => {
      const module = new SourceModuleFixture({
        vscode: {},
        "src/papperBuildUtils.ts": {
          findPandocManuscriptProject: async () => ({ rootUri: { fsPath: directory } }),
          findExistingPapperExecutable: async () => executable,
          preparePapperEnvironment: async () => ({ env: {} }),
          /** Simulates only CLI export, inspecting the real unsaved snapshot and writing a real DOCX ZIP. */
          runProcess: async (_command: string, args: string[]) => {
            exports += 1;
            snapshots.push(await readFile(args[2], "utf8"));
            assert.equal(path.dirname(args[2]), directory);
            await writeFile(args[4], referenceDocx());
          },
        },
      }).load<typeof import("../src/manuscriptStyle/controller")>("src/manuscriptStyle/controller.ts");
      return new module.ReferenceStyleCache(path.join(directory, "cache"), output as never);
    };
    const document = { uri: { fsPath: source, toString: () => `file://${source}` }, getText: () => text } as never;
    const cache = makeCache();
    await Promise.all([cache.get(document), cache.get(document)]);
    assert.equal(exports, 1);
    assert.equal(snapshots[0], text);
    text += "\nMore body";
    await cache.get(document);
    await makeCache().get(document);
    assert.equal(exports, 1);
    text = text.replace("lang: zh-CN", "lang: en-US");
    await cache.get(document);
    assert.equal(exports, 2);
    await writeFile(styleFile, "docxStyle: {Body Text: {fontSize: 11pt}}\n");
    await cache.get(document);
    assert.equal(exports, 3);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith(".pmt-style-")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reference defaults resolve inheritance, translated styles and Word units", readsEffectiveReferenceFormatting);
test("Word-only defaults are described without adding inaccurate Papper values", preservesUnrepresentableWordFormatting);
test("style action preserves metadata, body, aliases, overrides and indentation alternatives", editsFrontmatterWithoutLosingContent);
test("style action rejects malformed or unsafe existing metadata", rejectsInvalidMetadata);
test("style hovers identify source elements and ignore literal/hidden blocks", detectsMarkdownElements);
test("source hover shows only a button without launching Papper", showsOnlyStyleButton);
test("reference export is cached across body edits and extension sessions", cachesOnlyFormattingInputs);
