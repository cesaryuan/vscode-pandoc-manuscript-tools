import * as path from "node:path";
import * as vscode from "vscode";
import { isMap, isScalar, isSeq, isAlias, YAMLMap, parseDocument, visit } from "yaml";
import { DOCX_STYLE_FIELDS, type StyleField } from "./manuscriptStyle/fields";
import { STYLE_FIELDS, PANDOC_METADATA_FIELDS, getConfigurationContract, getConfigurationRevision } from "./configurationContract";
import { appendCslConfigurationAction } from "./inlayHints/csl/configuration";

/**
 * Provides completion, hover help and example-configuration editing for Papper `style.yml` files.
 *
 * The completion data comes from Papper's versioned configuration export. The example
 * merge deliberately edits the parsed YAML tree so existing values and comments
 * remain in place while missing settings are added in one undoable operation.
 */

export const STYLE_CONFIGURATION_SELECTOR: vscode.DocumentSelector = [
  { language: "yaml", scheme: "file", pattern: "**/{style,style-project}.yml" },
  { language: "yaml", scheme: "file", pattern: "**/{style,style-project}.yaml" },
];

const STYLE_FILE_NAMES = new Set(["style.yml", "style.yaml", "style-project.yml", "style-project.yaml"]);

export { STYLE_FIELDS, PANDOC_METADATA_FIELDS } from "./configurationContract";

const COMMON_DOCX_STYLES = ["Normal", "Body Text", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Caption", "Revision Char", "正文", "正文文本", "标题 1", "标题 2", "标题 3"];

/** Resolves supported camelCase, kebab-case and snake_case Papper field spellings. */
function canonicalField(key: string, fields: Record<string, StyleField>): string {
  return Object.keys(fields).find((field) => fields[field].aliases?.includes(key)
    || field.replace(/[-_]/g, "").toLowerCase() === key.replace(/[-_]/g, "").toLowerCase()) ?? key;
}

/** Checks whether a document is one of the supported style configuration files. */
export function isStyleConfigurationDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && STYLE_FILE_NAMES.has(path.basename(document.uri.fsPath).toLowerCase());
}

/** Returns a field schema for a nested completion path. */
function fieldsAtPath(pathParts: string[], rootFields: Record<string, StyleField> = STYLE_FIELDS): Record<string, StyleField> | undefined {
  let fields: Record<string, StyleField> | undefined = rootFields;
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
    // Author lists contain mapping items; their sequence index is not a configuration key.
    if (field.sequenceItems && /^\d+$/.test(pathParts[index + 1] ?? "")) index += 1;
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
  // lastIndexOf clamps a negative position to zero, which would skip a leading blank line.
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
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
  // A block sequence item's dash precedes its first mapping key, e.g. `- name: Author`.
  if (text.slice(start, start + 2) === "- ") {
    start += 2;
    while (start < offset && /[ \t]/.test(text[start])) start += 1;
  }
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
  if (isSeq(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      const nested = findCompletionContext(node.items[index], [...pathParts, String(index)]);
      if (nested) return nested;
    }
  }
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

/** Builds completion edits from a temporary YAML probe, including incomplete and flow maps. */
export function getStyleSuggestions(text: string, offset: number, rootFields: Record<string, StyleField> = STYLE_FIELDS): StyleSuggestion[] {
  if (isMultilineScalarContent(text, offset)) return [];
  const segment = completionSegment(text, offset);
  if (!segment) return [];
  const needsSpace = segment.isValue && text[segment.start - 1] === ":";
  const probe = (needsSpace ? " " : "") + COMPLETION_MARKER + (!segment.isValue && !segment.hasColon ? ": null" : "");
  const parsed = parseDocument(text.slice(0, segment.start) + probe + text.slice(segment.end));
  const context = findCompletionContext(parsed.contents);
  if (!context) return [];
  const fields = fieldsAtPath(context.path, rootFields);
  if (!fields) return [];
  const prefix = segment.prefix.toLowerCase();
  if (context.key) {
    const field = fields[canonicalField(context.key, fields)];
    return (field?.values ?? []).filter((value) => value.replace(/^["']/, "").toLowerCase().startsWith(prefix)).map((value) => ({
      ...segment, label: value, insertText: (needsSpace ? " " : "") + value, description: field.description, values: field.values,
    }));
  }
  const existing = new Set(context.map.items.flatMap((pair) => isScalar(pair.key) ? [canonicalField(String(pair.key.value), fields)] : []));
  const blocked = new Set<string>();
  for (const rule of getConfigurationContract().rules) {
    for (const candidate of rule.paths) {
      const parentPath = candidate.slice(0, -1);
      if (parentPath.length && parentPath.some((key, index) =>
        (context.path[context.path.length - parentPath.length + index] ?? "").replace(/[-_]/g, "").toLowerCase()
          !== key.replace(/[-_]/g, "").toLowerCase())) continue;
      const ownerPath = parentPath.length ? context.path.slice(0, -parentPath.length) : context.path;
      const ownerIsTextStyle = ownerPath.length >= 2 && ownerPath.at(-2).replace(/[-_]/g, "").toLowerCase() === "docxstyle";
      if (rule.scope === "docxTextStyle" && !ownerIsTextStyle) continue;
      if (rule.scope === "style" && ownerPath.length && !["reply", "pappersettings"].includes(
        ownerPath.at(-1).replace(/[-_]/g, "").toLowerCase())) continue;
      const owner = parsed.getIn(ownerPath, true);
      if (!isMap(owner)) continue;
      if (rule.paths.some((other) => other !== candidate && hasRulePath(owner, other))) blocked.add(candidate.at(-1));
    }
  }
  return Object.entries(fields)
    .filter(([key]) => key.replace(/[-_]/g, "").toLowerCase().startsWith(prefix.replace(/[-_]/g, "")) && !existing.has(key) && !blocked.has(key))
    .map(([key, field]) => ({ ...segment, label: key, insertText: key + (segment.hasColon ? "" : ": "), description: field.description, values: field.values }));
}

/** Finds configured constraint members through accepted YAML field aliases. */
function hasRulePath(root: YAMLMap, parts: string[]): boolean {
  let node: unknown = root;
  for (const key of parts) {
    if (!isMap(node)) return false;
    const pair = node.items.find((entry) => isScalar(entry.key)
      && String(entry.key.value).replace(/[-_]/g, "").toLowerCase() === key.replace(/[-_]/g, "").toLowerCase());
    if (!pair) return false;
    node = pair.value;
  }
  return true;
}

/** Provides key and enum-value suggestions for style YAML. */
export class StyleConfigurationCompletionProvider implements vscode.CompletionItemProvider {
  /** Refreshes definitions lazily when the installed executable changes. */
  constructor(private readonly ensure: () => Promise<void> = async () => {}) {}

  /** Provides style keys or allowed scalar values at the cursor. */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    if (!isStyleConfigurationDocument(document)) return undefined;
    await this.ensure();
    return createConfigurationCompletionItems(document, getStyleSuggestions(document.getText(), document.offsetAt(position)));
  }
}

/** Converts shared YAML suggestions to editor items using absolute source offsets. */
export function createConfigurationCompletionItems(document: vscode.TextDocument, suggestions: StyleSuggestion[]): vscode.CompletionItem[] {
  return suggestions.map((suggestion) => {
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

export type StyleHoverInfo = {
  start: number;
  end: number;
  path: string[];
  description: string;
  values?: readonly string[];
  currentValue?: string;
};

/** Resolves a field's documentation, including arbitrary names under docxStyle. */
function hoverField(pathParts: string[], key: string, rootFields: Record<string, StyleField>): StyleField | undefined {
  const fields = fieldsAtPath(pathParts, rootFields);
  const field = fields?.[canonicalField(key, fields)];
  if (field) return field;
  const ownerFields = fieldsAtPath(pathParts.slice(0, -1), rootFields);
  const owner = ownerFields?.[canonicalField(pathParts.at(-1) ?? "", ownerFields)];
  if (owner?.dynamicChildren) {
    return { description: "DOCX 段落或字符样式；按精确样式名称应用，可在本节设置字体、对齐、缩进和段落间距" };
  }
  if (owner?.dynamicValueDescription) return { description: owner.dynamicValueDescription };
  return undefined;
}

/** Collects exact YAML token ranges so comments and surrounding whitespace have no field hover. */
function collectStyleHovers(node: unknown, text: string, pathParts: string[], entries: StyleHoverInfo[], rootFields: Record<string, StyleField>): void {
  if (isSeq(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      collectStyleHovers(node.items[index], text, [...pathParts, String(index)], entries, rootFields);
    }
  }
  if (!isMap(node)) return;
  for (const pair of node.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const field = hoverField(pathParts, key, rootFields);
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
    collectStyleHovers(pair.value, text, [...pathParts, key], entries, rootFields);
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
export function getStyleHoverEntries(text: string, rootFields: Record<string, StyleField> = STYLE_FIELDS): StyleHoverInfo[] {
  const entries: StyleHoverInfo[] = [];
  // Incomplete unrelated lines should not hide help for fields that still parse successfully.
  const document = parseDocument(text);
  collectStyleHovers(document.contents, text, [], entries, rootFields);
  return entries;
}

/** Shows field documentation for existing YAML keys and values, caching each document version. */
export class StyleConfigurationHoverProvider implements vscode.HoverProvider {
  private readonly cache = new WeakMap<vscode.TextDocument, { version: number; revision: number; entries: StyleHoverInfo[] }>();

  /** Refreshes installed help before reading or rebuilding cached entries. */
  constructor(private readonly ensure: () => Promise<void> = async () => {}) {}

  /** Renders the hovered setting's purpose and value hints. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (token.isCancellationRequested || !isStyleConfigurationDocument(document)) return undefined;
    await this.ensure();
    if (token.isCancellationRequested) return undefined;
    let cached = this.cache.get(document);
    const revision = getConfigurationRevision();
    if (!cached || cached.version !== document.version || cached.revision !== revision) {
      cached = { version: document.version, revision, entries: getStyleHoverEntries(document.getText()) };
      this.cache.set(document, cached);
    }
    const offset = document.offsetAt(position);
    const info = cached.entries.find((entry) => entry.start <= offset && offset < entry.end);
    if (!info) return undefined;
    return createConfigurationHover(document, info);
  }
}

/** Renders YAML field help safely for either a style file or a Markdown header. */
export function createConfigurationHover(document: vscode.TextDocument, info: StyleHoverInfo): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown("**Papper 配置帮助**\n\n");
  markdown.appendText(info.description);
  if (info.values?.length) markdown.appendText(`\n\n取值提示：${info.values.join(" / ")}`);
  if (info.path.at(-1)?.toLowerCase() === "csl") appendCslConfigurationAction(markdown, document, info.path);
  return new vscode.Hover(markdown, new vscode.Range(document.positionAt(info.start), document.positionAt(info.end)));
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
export async function mergeStyleExampleIntoEditor(editor: vscode.TextEditor, output: vscode.OutputChannel): Promise<void> {
  const exampleText = getConfigurationContract().templates.styleProject;
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

