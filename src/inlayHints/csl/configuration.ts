import * as path from "node:path";
import * as vscode from "vscode";
import { isAlias, isMap, isScalar, parseDocument, Scalar, YAMLMap } from "yaml";
import { getYamlHeader } from "../../manuscriptStyle/document";
import { SET_CSL_STYLE_COMMAND } from "../commands";

const STYLE_NAMES = new Set(["style.yml", "style.yaml", "style-project.yml", "style-project.yaml"]);

/** Compares Papper's camelCase, kebab-case and snake_case configuration spellings. */
function normalizeCslKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

/** Recognizes supported local project style files without depending on the configuration hover provider. */
export function isCslStyleDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && STYLE_NAMES.has(path.basename(document.uri.fsPath).toLowerCase());
}

/** Validates the metadata scope while retaining actual YAML key spellings for edits. */
export function getCslSettingPath(document: vscode.TextDocument, requested?: unknown): string[] {
  const style = isCslStyleDocument(document);
  if (!style && !["markdown", "mdx"].includes(document.languageId)) throw new Error("请先打开稿件或 style.yml，再设置参考文献样式");
  const keys = requested === undefined ? (style ? ["pandocMetadata", "csl"] : ["csl"]) : requested;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) throw new Error("无效的参考文献样式字段");
  const normalized = keys.map(normalizeCslKey).join(".");
  const valid = style ? /^(reply\.)?pandocmetadata\.csl$/ : /^(csl|pappersettings\.(reply\.)?pandocmetadata\.csl)$/;
  if (!valid.test(normalized)) throw new Error("无效的参考文献样式配置范围");
  if (requested === undefined) {
    let node: unknown = parseDocument(getCslConfigurationContent(document) ?? "").contents;
    // Palette calls must reuse existing alias spellings rather than creating a second metadata map.
    return keys.map((key) => {
      const pair = isMap(node) ? node.items.find((item) => isScalar(item.key) && normalizeCslKey(String(item.key.value)) === normalizeCslKey(key)) : undefined;
      node = pair?.value;
      return pair && isScalar(pair.key) ? String(pair.key.value) : key;
    });
  }
  return keys;
}

/** Captures just frontmatter for manuscript edits, and the full YAML document for project style edits. */
export function getCslConfigurationContent(document: vscode.TextDocument): string | undefined {
  return isCslStyleDocument(document) ? document.getText() : getYamlHeader(document.getText())?.content;
}

/** Parses a writable CSL scope and rejects shared YAML nodes that could change unrelated settings. */
function parseCslConfiguration(document: vscode.TextDocument, keys: string[]) {
  const text = document.getText();
  const header = isCslStyleDocument(document) ? undefined : getYamlHeader(text);
  const yaml = parseDocument(isCslStyleDocument(document) ? text : header?.content ?? "");
  if (yaml.errors.length) throw new Error(`参考文献样式配置无法解析：${yaml.errors[0].message}`);
  if (!yaml.contents || (isScalar(yaml.contents) && yaml.contents.value === null)) yaml.contents = yaml.createNode({}) as YAMLMap.Parsed;
  let node: unknown = yaml.contents;
  for (let index = 0; index <= keys.length; index++) {
    if (isAlias(node) || ((isMap(node) || isScalar(node)) && node.anchor)) throw new Error("参考文献样式配置使用了 YAML anchor 或 alias，请先展开后设置");
    if (index === keys.length) {
      if (node !== undefined && !(isScalar(node) && (node.value === null || typeof node.value === "string"))) throw new Error("csl 必须是文件路径文本");
    } else if (node !== undefined && !isMap(node)) throw new Error("参考文献样式的上级配置必须是对象");
    node = isMap(node) ? node.get(keys[index], true) : undefined;
  }
  return { text, header, yaml };
}

/** Validates configuration before opening the search page or downloading anything. */
export function validateCslConfiguration(document: vscode.TextDocument, keys: string[]): void {
  parseCslConfiguration(document, keys);
}

/** Updates the selected YAML scope as one undoable edit, preserving comments and revealing its new path. */
export async function applyCslConfiguration(document: vscode.TextDocument, keys: string[], value: string,
  original: string | undefined, output: vscode.OutputChannel): Promise<void> {
  const sourceEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
  const editor = await vscode.window.showTextDocument(document, { viewColumn: sourceEditor?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, preview: false });
  if (original !== getCslConfigurationContent(document)) throw new Error("设置期间参考文献样式配置已改变，请重新设置");
  const { text, header, yaml } = parseCslConfiguration(document, keys);
  const previous = yaml.getIn(keys, true);
  if (!isScalar(previous) || previous.value !== value) {
    const replacement = yaml.createNode(value) as Scalar;
    replacement.type = Scalar.QUOTE_DOUBLE;
    if (isScalar(previous)) {
      replacement.comment = previous.comment;
      replacement.commentBefore = previous.commentBefore;
      replacement.spaceBefore = previous.spaceBefore;
    }
    yaml.setIn(keys, replacement);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const serialized = yaml.toString({ lineWidth: 0 }).replace(/\n/g, newline);
    const style = isCslStyleDocument(document);
    const start = header?.start ?? (style || !text.startsWith("\uFEFF") ? 0 : 1);
    const end = header?.end ?? (style ? text.length : start);
    // A command can target an absent manuscript header; insert frontmatter rather than replacing its body.
    const content = style || header ? serialized : `---${newline}${serialized}---${newline}`;
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const applied = await editor.edit(
      /** Groups the chosen scope's change into one Undo operation. */
      (builder) => builder.replace(range, content), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) throw new Error("VS Code 拒绝了参考文献样式配置编辑");
    output.appendLine(`[CSL] Updated ${keys.join(".")} in ${document.uri.fsPath}`);
  }
  const updated = parseCslConfiguration(document, keys);
  const node = updated.yaml.getIn(keys, true);
  if (isScalar(node) && node.range) {
    const offset = updated.header?.start ?? 0;
    editor.selection = new vscode.Selection(document.positionAt(offset + node.range[0]), document.positionAt(offset + node.range[1]));
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Adds a trusted action for the exact hovered metadata field, with no network work until clicked. */
export function appendCslConfigurationAction(markdown: vscode.MarkdownString, document: vscode.TextDocument, keys: string[]): void {
  if (document.uri.scheme !== "file") return;
  try { getCslSettingPath(document, keys); } catch { return; }
  const args = encodeURIComponent(JSON.stringify([document.uri.toString(), keys]));
  markdown.isTrusted = { enabledCommands: [SET_CSL_STYLE_COMMAND] };
  markdown.appendMarkdown(`\n\nPapper: [设置参考文献样式](command:${SET_CSL_STYLE_COMMAND}?${args})`);
}
