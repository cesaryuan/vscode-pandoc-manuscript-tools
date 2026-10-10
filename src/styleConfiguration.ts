import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { isMap, isScalar, isSeq, isAlias, YAMLMap, parseDocument, visit } from "yaml";

/**
 * Provides completion, hover help and example-configuration editing for Papper `style.yml` files.
 *
 * The completion data mirrors the public style configuration guide. The example
 * merge deliberately edits the parsed YAML tree so existing values and comments
 * remain in place while missing settings are added in one undoable operation.
 */

export const STYLE_CONFIGURATION_SELECTOR: vscode.DocumentSelector = [
  { language: "yaml", scheme: "file", pattern: "**/{style,style-project}.yml" },
  { language: "yaml", scheme: "file", pattern: "**/{style,style-project}.yaml" },
];

const STYLE_FILE_NAMES = new Set(["style.yml", "style.yaml", "style-project.yml", "style-project.yaml"]);

type StyleField = {
  description: string;
  values?: readonly string[];
  children?: Record<string, StyleField>;
  dynamicChildren?: boolean;
};

const BOOLEAN_VALUES = ["true", "false"] as const;

const DOCX_STYLE_FIELDS: Record<string, StyleField> = {
  fontFamily: { description: "字体名称，或分别指定西文和中文字体", children: {
    western: { description: "西文字体名称，例如 Times New Roman" },
    chinese: { description: "中文字体名称，例如 宋体" },
  } },
  fontName: { description: "兼容旧配置的字体名称" },
  fontSize: { description: "字体大小，例如 10.5pt、小五或四号；也可输入其他正磅值", values: ["10.5pt", "12pt", "小五", "五号", "小四", "四号", "小三", "三号"] },
  fontColor: { description: "字体颜色，例如 #000000、rgb(0, 0, 0) 或 [0, 0, 0]；十六进制颜色必须加引号", values: ['"#000000"', '"#FF0000"', '"#0000FF"'] },
  bold: { description: "是否使用粗体", values: BOOLEAN_VALUES },
  lineSpacing: { description: "行距倍数、single、one-half、double 或精确磅值", values: ["single", "one-half", "double", "1.5", "18pt"] },
  alignment: { description: "段落对齐方式", values: ["left", "center", "right", "justify", "distribute", "centre"] },
  firstLineIndentChars: { description: "Word 字符数形式的首行缩进" },
  indentation: {
    description: "长度形式的段落缩进",
    children: {
      left: { description: "左缩进，例如 0.5cm" },
      right: { description: "右缩进，例如 0.5cm" },
      firstLine: { description: "首行缩进，例如 0.5cm" },
      hanging: { description: "悬挂缩进，例如 0.5cm" },
    },
  },
  paragraphSpacing: {
    description: "段前和段后间距",
    children: {
      before: { description: "段前间距，例如 6pt" },
      after: { description: "段后间距，例如 6pt" },
    },
  },
  font: { description: "兼容旧配置的字体对象", children: { family: { description: "兼容旧配置的字体名称" } } },
};

const PANDOC_METADATA_FIELDS: Record<string, StyleField> = {
  figureTitle: { description: "图题前缀" },
  tableTitle: { description: "表题前缀" },
  titleDelim: { description: "编号和题注之间的分隔符" },
  figPrefix: { description: "图引用前缀" },
  tblPrefix: { description: "表引用前缀" },
  secPrefix: { description: "章节引用前缀" },
  eqnPrefix: { description: "公式引用前缀" },
  linkReferences: { description: "是否将交叉引用转换为超链接", values: BOOLEAN_VALUES },
  autoSectionLabels: { description: "是否自动为章节添加 sec: 标签", values: BOOLEAN_VALUES },
  autoEqnLabels: { description: "是否自动为行间公式编号", values: BOOLEAN_VALUES },
  numberSections: { description: "是否为章节编号", values: BOOLEAN_VALUES },
  sectionsDepth: { description: "章节编号深度" },
  chapters: { description: "是否启用章节编号", values: BOOLEAN_VALUES },
  chaptersDepth: { description: "章节编号深度" },
  chapDelim: { description: "章节编号分隔符" },
  subfigGrid: { description: "是否支持子图网格布局", values: BOOLEAN_VALUES },
  subfigureChildTemplate: { description: "子图题注模板，$$i$$ 为编号，$$t$$ 为文字" },
  subfigureTemplate: { description: "父图题注模板，$$i$$ 为编号，$$t$$ 为文字" },
  "reference-section-title": { description: "参考文献章节标题" },
  "link-citations": { description: "是否将引文链接到参考文献", values: BOOLEAN_VALUES },
  csl: { description: "CSL 引用样式文件路径" },
  lang: { description: "文档语言，例如 zh-CN 或 en-US" },
};

const STYLE_FIELDS: Record<string, StyleField> = {
  mathtype: { description: "是否将 DOCX 公式转换为可编辑 MathType 公式", values: BOOLEAN_VALUES },
  mathtypeConversionMethod: { description: "MathType 转换后端", values: ["rust", "rust-sdk", "set-data", "auto", "both"] },
  mathtypeSvgBackend: { description: "MathType 公式 SVG 渲染器", values: ["ratex", "typst"] },
  mathtypeTypstMathFont: {
    description: "Typst 数学字体名称或字体文件路径",
    values: ["XITS Math", "STIX Two Math", "New Computer Modern Math"],
    children: {
      font: { description: "普通数学符号字体，与 calligraphicFont 一起填写；也可输入字体文件路径", values: ["XITS Math", "STIX Two Math", "New Computer Modern Math"] },
      calligraphicFont: { description: "花体数学符号字体，与 font 一起填写；也可输入字体文件路径", values: ["XITS Math", "STIX Two Math", "New Computer Modern Math"] },
    },
  },
  docxNativeCrossref: { description: "是否使用 Word 原生 REF/SEQ 域和章节编号", values: BOOLEAN_VALUES },
  docxEmbedSvgImages: { description: "是否内嵌 SVG 引用的本地子图像", values: BOOLEAN_VALUES },
  docxConvertSvgToPng: { description: "是否将 DOCX 中的 SVG 栅格化为 PNG", values: BOOLEAN_VALUES },
  docxSvgToPngWidth: { description: "SVG 转 PNG 的像素宽度" },
  docxSvgToPngDpi: { description: "SVG 转 PNG 的 DPI" },
  docxSvgToPngScale: { description: "SVG 转 PNG 的缩放比例" },
  citationNumberRangeDelimiter: { description: "数字引文范围分隔符，例如 - 生成 [1-3]" },
  docxShowLineNumbers: { description: "DOCX 行号模式", values: ["true", "false", "continuous", "restart-page", "restart-section", "连续", "每页", "每节", "关闭"] },
  docxShowPageNumbers: { description: "是否显示 DOCX 页脚页码", values: ["true", "false", "null"] },
  tableAutofit: { description: "手写表格默认布局", values: ["window", "content", "fixed", "none"] },
  docxPageMargins: {
    description: "DOCX 页面边距",
    values: ["null"],
    children: {
      top: { description: "上边距，例如 2.54cm" },
      bottom: { description: "下边距，例如 2.54cm" },
      left: { description: "左边距，例如 3.17cm" },
      right: { description: "右边距，例如 3.17cm" },
      inside: { description: "左侧边距别名" },
      outside: { description: "右侧边距别名" },
    },
  },
  docxStyle: { description: "按精确 DOCX 样式名称设置段落或字符样式", children: DOCX_STYLE_FIELDS, dynamicChildren: true },
  pandocMetadata: { description: "传给 Pandoc、pandoc-crossref 和 citeproc 的元数据", children: PANDOC_METADATA_FIELDS, dynamicChildren: false },
};
// Reply may override any Papper setting; it does not recursively contain another reply.
STYLE_FIELDS.reply = { description: "审稿回复构建的覆盖配置", children: { ...STYLE_FIELDS } };

const COMMON_DOCX_STYLES = ["Normal", "Body Text", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Caption", "Revision Char", "正文", "正文文本", "标题 1", "标题 2", "标题 3"];

/** Resolves supported camelCase, kebab-case and snake_case Papper field spellings. */
function canonicalField(key: string, fields: Record<string, StyleField>): string {
  return Object.keys(fields).find((field) => field.replace(/[-_]/g, "").toLowerCase() === key.replace(/[-_]/g, "").toLowerCase()) ?? key;
}

/** Checks whether a document is one of the supported style configuration files. */
export function isStyleConfigurationDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && STYLE_FILE_NAMES.has(path.basename(document.uri.fsPath).toLowerCase());
}

/** Returns a field schema for a nested completion path. */
function fieldsAtPath(pathParts: string[]): Record<string, StyleField> | undefined {
  let fields: Record<string, StyleField> | undefined = STYLE_FIELDS;
  for (let index = 0; index < pathParts.length; index += 1) {
    if (!fields) return undefined;
    const field = fields[canonicalField(pathParts[index], fields)];
    if (field?.dynamicChildren) {
      if (index === pathParts.length - 1) {
        return Object.fromEntries(COMMON_DOCX_STYLES.map((name) => [name, { description: "Word 内置或常用样式；也可输入任意自定义样式名" }]));
      }
      index += 1; // DOCX style names are user-defined, including quoted names and Chinese aliases.
      fields = DOCX_STYLE_FIELDS;
      continue;
    }
    if (!field?.children) return undefined;
    fields = field.children;
  }
  return fields;
}

type CompletionSegment = { start: number; end: number; isValue: boolean; hasColon: boolean; prefix: string };
type CompletionContext = { path: string[]; map: YAMLMap; key?: string };
export type StyleSuggestion = CompletionSegment & { label: string; insertText: string; description: string; values?: readonly string[] };
const COMPLETION_MARKER = "__papper_style_completion__";

/** Locates the YAML token under the cursor without crossing comments or quoted delimiters. */
function completionSegment(text: string, offset: number): CompletionSegment | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let quote = "";
  let start = lineStart;
  let isValue = false;
  for (let index = lineStart; index < offset; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && char === "\\") { index += 1; continue; }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else quote = "";
      }
      continue;
    }
    if ((char === '"' || char === "'") && !text.slice(start, index).trim()) quote = char;
    else if (char === "#" && (index === lineStart || /\s/.test(text[index - 1]))) return undefined;
    else if (char === "{" || char === ",") { start = index + 1; isValue = false; }
    else if (char === ":" && (!text[index + 1] || /[\s{\[]/.test(text[index + 1]))) { start = index + 1; isValue = true; }
  }
  while (start < offset && /[ \t]/.test(text[start])) start += 1;
  if (/^[-&*!|>\[\]}]/.test(text.slice(start, offset))) return undefined;
  let end = offset;
  for (; end < text.length && text[end] !== "\n" && text[end] !== "\r"; end += 1) {
    const char = text[end];
    if (quote) {
      if (quote === '"' && char === "\\") { end += 1; continue; }
      if (char === quote) { quote = ""; continue; }
    } else if (/[,:}\]#]/.test(char)) break;
  }
  const hasColon = text[end] === ":";
  while (end > offset && /[ \t]/.test(text[end - 1])) end -= 1;
  return { start, end, isValue, hasColon, prefix: text.slice(start, offset).replace(/^["']/, "").replace(/["']$/, "").trim() };
}

/** Finds the probe token's enclosing map and domain path in the YAML tree. */
function findCompletionContext(node: unknown, pathParts: string[] = []): CompletionContext | undefined {
  if (!isMap(node)) return undefined;
  for (const pair of node.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    if (key === COMPLETION_MARKER) return { path: pathParts, map: node };
    if (isScalar(pair.value) && pair.value.value === COMPLETION_MARKER) return { path: pathParts, map: node, key };
    const nested = findCompletionContext(pair.value, [...pathParts, key]);
    if (nested) return nested;
  }
  return undefined;
}

/** Prevents style completions inside multiline scalar content such as caption templates. */
function isMultilineScalarContent(text: string, offset: number): boolean {
  const parsed = parseDocument(text);
  let inside = false;
  visit(parsed, {
    /** Checks parsed scalar ranges while allowing a new token after the last newline. */
    Scalar(_key, scalar) {
      const range = scalar.range;
      if (!range || offset <= range[0] || offset >= range[1]) return;
      if (text.slice(range[0], offset).includes("\n")) inside = true;
    },
  });
  return inside;
}

/** Returns keys that are incompatible with settings already present in this map. */
function conflictingKeys(existing: Set<string>): Set<string> {
  const blocked = new Set<string>();
  const rasterization = ["docxSvgToPngWidth", "docxSvgToPngDpi", "docxSvgToPngScale"];
  if (rasterization.some((key) => existing.has(key))) rasterization.forEach((key) => blocked.add(key));
  if (existing.has("firstLine")) blocked.add("hanging");
  if (existing.has("hanging")) blocked.add("firstLine");
  return blocked;
}

/** Builds completion edits from a temporary YAML probe, including incomplete and flow maps. */
export function getStyleSuggestions(text: string, offset: number): StyleSuggestion[] {
  if (isMultilineScalarContent(text, offset)) return [];
  const segment = completionSegment(text, offset);
  if (!segment) return [];
  const needsSpace = segment.isValue && text[segment.start - 1] === ":";
  const probe = (needsSpace ? " " : "") + COMPLETION_MARKER + (!segment.isValue && !segment.hasColon ? ": null" : "");
  const parsed = parseDocument(text.slice(0, segment.start) + probe + text.slice(segment.end));
  const context = findCompletionContext(parsed.contents);
  if (!context) return [];
  const fields = fieldsAtPath(context.path);
  if (!fields) return [];
  const prefix = segment.prefix.toLowerCase();
  if (context.key) {
    const field = fields[canonicalField(context.key, fields)];
    return (field?.values ?? []).filter((value) => value.replace(/^["']/, "").toLowerCase().startsWith(prefix)).map((value) => ({
      ...segment, label: value, insertText: (needsSpace ? " " : "") + value, description: field.description, values: field.values,
    }));
  }
  const existing = new Set(context.map.items.flatMap((pair) => isScalar(pair.key) ? [canonicalField(String(pair.key.value), fields)] : []));
  const blocked = conflictingKeys(existing);
  // Character-based first-line indents conflict only with firstLine/hanging, not left/right.
  const indentation = context.map.get("indentation", true);
  if (isMap(indentation) && (indentation.has("firstLine") || indentation.has("hanging"))) blocked.add("firstLineIndentChars");
  if (context.path.at(-1) === "indentation") {
    const parent = parsed.getIn(context.path.slice(0, -1), true);
    if (isMap(parent) && parent.has("firstLineIndentChars")) { blocked.add("firstLine"); blocked.add("hanging"); }
  }
  return Object.entries(fields)
    .filter(([key]) => key.replace(/[-_]/g, "").toLowerCase().startsWith(prefix.replace(/[-_]/g, "")) && !existing.has(key) && !blocked.has(key))
    .map(([key, field]) => ({ ...segment, label: key, insertText: key + (segment.hasColon ? "" : ": "), description: field.description, values: field.values }));
}

/** Provides key and enum-value suggestions for style YAML. */
export class StyleConfigurationCompletionProvider implements vscode.CompletionItemProvider {
  /** Provides style keys or allowed scalar values at the cursor. */
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    if (!isStyleConfigurationDocument(document)) return undefined;
    return getStyleSuggestions(document.getText(), document.offsetAt(position))
      .map((suggestion) => {
        const item = new vscode.CompletionItem(suggestion.label, suggestion.isValue ? vscode.CompletionItemKind.Value : vscode.CompletionItemKind.Property);
        item.insertText = suggestion.insertText;
        item.range = new vscode.Range(document.positionAt(suggestion.start), document.positionAt(suggestion.end));
        // Show the setting's purpose in the suggestion row without requiring the details popup.
        const valuesHint = suggestion.values?.length ? suggestion.values.join(" / ") : undefined;
        item.detail = suggestion.description + (valuesHint ? `（${valuesHint}）` : "");
        const documentation = new vscode.MarkdownString(suggestion.description);
        if (valuesHint) documentation.appendText(`\n\n取值提示：${valuesHint}`);
        item.documentation = documentation;
        return item;
      });
  }
}

export type StyleHoverInfo = {
  start: number;
  end: number;
  path: string[];
  description: string;
  values?: readonly string[];
  currentValue?: string;
};

/** Resolves a field's documentation, including arbitrary names under docxStyle. */
function hoverField(pathParts: string[], key: string): StyleField | undefined {
  const fields = fieldsAtPath(pathParts);
  const field = fields?.[canonicalField(key, fields)];
  if (field) return field;
  const ownerFields = fieldsAtPath(pathParts.slice(0, -1));
  const owner = ownerFields?.[canonicalField(pathParts.at(-1) ?? "", ownerFields)];
  if (owner?.dynamicChildren) {
    return { description: "DOCX 段落或字符样式；按精确样式名称应用，可在本节设置字体、对齐、缩进和段落间距" };
  }
  return undefined;
}

/** Collects exact YAML token ranges so comments and surrounding whitespace have no field hover. */
function collectStyleHovers(node: unknown, text: string, pathParts: string[], entries: StyleHoverInfo[]): void {
  if (!isMap(node)) return;
  for (const pair of node.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const field = hoverField(pathParts, key);
    if (field) {
      const value = pair.value;
      const valueRange = isScalar(value) || isMap(value) || isSeq(value) || isAlias(value) ? value.range : undefined;
      const info = {
        path: [...pathParts, key], description: field.description, values: field.values,
        currentValue: valueRange && valueRange[1] > valueRange[0] ? text.slice(valueRange[0], valueRange[1]).trim() : undefined,
      };
      if (pair.key.range) entries.push({ ...info, start: pair.key.range[0], end: pair.key.range[1] });
      collectStyleValueHovers(value, info, entries);
    }
    collectStyleHovers(pair.value, text, [...pathParts, key], entries);
  }
}

/** Associates scalar values and sequence items with their owning field without covering nested maps. */
function collectStyleValueHovers(node: unknown, info: Omit<StyleHoverInfo, "start" | "end">, entries: StyleHoverInfo[]): void {
  if (isScalar(node) || isAlias(node)) {
    if (node.range && node.range[1] > node.range[0]) entries.push({ ...info, start: node.range[0], end: node.range[1] });
  } else if (isSeq(node)) {
    for (const item of node.items) collectStyleValueHovers(item, info, entries);
  }
}

/** Builds documentation locations from the same field definitions used by completion. */
export function getStyleHoverEntries(text: string): StyleHoverInfo[] {
  const entries: StyleHoverInfo[] = [];
  // Incomplete unrelated lines should not hide help for fields that still parse successfully.
  const document = parseDocument(text);
  collectStyleHovers(document.contents, text, [], entries);
  return entries;
}

/** Shows field documentation for existing YAML keys and values, caching each document version. */
export class StyleConfigurationHoverProvider implements vscode.HoverProvider {
  private readonly cache = new WeakMap<vscode.TextDocument, { version: number; entries: StyleHoverInfo[] }>();

  /** Renders the hovered setting's purpose, exact configuration path and value hints. */
  provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | undefined {
    if (token.isCancellationRequested || !isStyleConfigurationDocument(document)) return undefined;
    let cached = this.cache.get(document);
    if (!cached || cached.version !== document.version) {
      cached = { version: document.version, entries: getStyleHoverEntries(document.getText()) };
      this.cache.set(document, cached);
    }
    const offset = document.offsetAt(position);
    const info = cached.entries.find((entry) => entry.start <= offset && offset < entry.end);
    if (!info) return undefined;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("**Papper 配置帮助**\n\n");
    markdown.appendText(info.description);
    markdown.appendText("\n\n配置路径：");
    markdown.appendCodeblock(info.path.join(" → "), "text");
    if (info.values?.length) markdown.appendText(`\n\n取值提示：${info.values.join(" / ")}`);
    if (info.currentValue !== undefined) {
      markdown.appendText("\n\n当前配置：");
      markdown.appendCodeblock(info.currentValue, "yaml");
    }
    return new vscode.Hover(markdown, new vscode.Range(document.positionAt(info.start), document.positionAt(info.end)));
  }
}

/** Provides the clickable text action shown above a style configuration file. */
export class StyleConfigurationCodeLensProvider implements vscode.CodeLensProvider {
  /** Creates a CodeLens on the first line so the action remains visible while editing. */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isStyleConfigurationDocument(document)) return [];
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: "Papper: 合并示例配置",
      command: "pandocManuscriptTools.mergeStyleExample",
      arguments: [document.uri],
    })];
  }
}

/** Recursively adds missing YAML map entries and returns the number of additions. */
function mergeYamlMaps(target: YAMLMap, source: YAMLMap, fields: Record<string, StyleField> = {}): number {
  let added = 0;
  for (const sourcePair of source.items) {
    if (!isScalar(sourcePair.key)) continue;
    const key = String(sourcePair.key.value);
    const targetPair = target.items.find((pair) => isScalar(pair.key) && canonicalField(String(pair.key.value), fields) === canonicalField(key, fields));
    if (!targetPair) {
      target.add(sourcePair.clone());
      added += 1;
      continue;
    }
    if (isMap(targetPair.value) && isMap(sourcePair.value)) {
      added += mergeYamlMaps(targetPair.value, sourcePair.value, fields[canonicalField(key, fields)]?.children);
    }
  }
  return added;
}

/** Merges the bundled example into a style document while preserving existing values. */
export function mergeStyleExample(currentText: string, exampleText: string): { text: string; addedKeys: number } {
  const current = parseDocument(currentText.replace(/\r\n/g, "\n"));
  const example = parseDocument(exampleText.replace(/\r\n/g, "\n"));
  if (current.errors.length) throw new Error(`当前 style.yml 无法解析：${current.errors[0].message}`);
  if (example.errors.length) throw new Error(`示例 style.yml 无法解析：${example.errors[0].message}`);
  if (!isMap(example.contents)) throw new Error("示例 style.yml 必须是 YAML 对象");
  const emptyScalar = isScalar(current.contents) && current.contents.value === null && current.contents.source === "";
  if (!current.contents || emptyScalar) {
    if (!currentText.trim()) return { text: exampleText, addedKeys: example.contents.items.length };
    // Empty documents can end with `...`; appending raw YAML would create a second document.
    const emptyNotes = current.contents ? [current.contents.commentBefore, current.contents.comment] : [];
    current.contents = example.contents.clone() as YAMLMap.Parsed;
    current.commentBefore = [current.commentBefore, current.comment, ...emptyNotes, example.commentBefore].filter(Boolean).join("\n");
    current.comment = example.comment;
    const text = current.toString({ lineWidth: 0 });
    return { text: currentText.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text, addedKeys: example.contents.items.length };
  }
  if (!isMap(current.contents)) throw new Error("当前 style.yml 顶层必须是 YAML 对象");
  const addedKeys = mergeYamlMaps(current.contents, example.contents, STYLE_FIELDS);
  if (!addedKeys) return { text: currentText, addedKeys: 0 };
  if (example.comment && !current.comment?.includes(example.comment)) {
    current.comment = [current.comment, example.comment].filter(Boolean).join("\n\n");
  }
  const text = current.toString({ lineWidth: 0 });
  return { text: currentText.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text, addedKeys };
}

/** Reads the bundled example and applies it to the active style editor. */
export async function mergeStyleExampleIntoEditor(editor: vscode.TextEditor, examplePath: string, output: vscode.OutputChannel): Promise<void> {
  const exampleText = await fs.readFile(examplePath, "utf8");
  const result = mergeStyleExample(editor.document.getText(), exampleText);
  if (result.text === editor.document.getText()) {
    void vscode.window.showInformationMessage("当前 style.yml 已包含示例配置");
    return;
  }
  const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
  const applied = await editor.edit(
    /** Groups the merge into one edit so a single Undo restores the original buffer. */
    (edit) => edit.replace(fullRange, result.text),
    { undoStopBefore: true, undoStopAfter: true });
  if (!applied) throw new Error("VS Code 拒绝了 style.yml 编辑");
  output.appendLine(`Merged ${result.addedKeys} missing style.yml keys into ${editor.document.uri.fsPath}.`);
  void vscode.window.showInformationMessage(`已合并示例配置，新增 ${result.addedKeys} 项`);
}

