import * as vscode from "vscode";
import { getYamlHeader } from "../manuscriptStyle/document";
import { createManuscriptMetadataEdit, getBuiltMetadataValue, getManuscriptMetadataRange, getManuscriptMetadataValue, INLAY_METADATA_FIELDS, isInlayMetadataField, isInlayMetadataValue, type InlayMetadataField, type InlayMetadataValue } from "./settings";
import { SET_CSL_STYLE_COMMAND, SET_INLAY_METADATA_COMMAND } from "./commands";

/** Applies and reveals one manuscript metadata setting, sharing Undo and concurrent-edit behavior across hint actions. */
export async function applyInlayMetadataSetting(document: vscode.TextDocument, field: InlayMetadataField, value: InlayMetadataValue,
  originalHeader: string | undefined, output: vscode.OutputChannel): Promise<void> {
  const uriText = document.uri.toString();
  const sourceEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uriText);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: sourceEditor?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, preview: false,
  });
  // Prompts and downloads can outlive a user's metadata edits; preserve those changes rather than overwriting them.
  if (originalHeader !== getYamlHeader(document.getText())?.content) throw new Error("设置期间 YAML header 已改变，请重新点击按钮");
  const edit = createManuscriptMetadataEdit(document.getText(), field, value);
  if (edit) {
    const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
    const applied = await editor.edit(
      /** Replaces only frontmatter in a single Undo operation; body text remains untouched. */
      (builder) => builder.replace(range, edit.text), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) throw new Error("VS Code 拒绝了 YAML header 编辑");
    output.appendLine(`[Inlay hints] Updated ${field} in manuscript header: ${document.uri.fsPath}`);
  }
  // Reparse after serialization because inserted fields and normalized YAML change source offsets.
  const target = getManuscriptMetadataRange(document.getText(), field);
  if (target) {
    editor.selection = new vscode.Selection(document.positionAt(target.start), document.positionAt(target.end));
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Adds trusted hover actions using the source URI rather than whichever editor currently has focus. */
export function appendInlayMetadataActions(tooltip: vscode.MarkdownString, uriText: string, fields: InlayMetadataField[], ast: unknown): void {
  if (!fields.length) return;
  tooltip.isTrusted = { enabledCommands: fields.includes("csl") ? [SET_INLAY_METADATA_COMMAND, SET_CSL_STYLE_COMMAND] : [SET_INLAY_METADATA_COMMAND] };
  tooltip.appendMarkdown(`${tooltip.value ? "\n\n" : ""}Papper: `);
  for (const [index, field] of fields.entries()) {
    if (index) tooltip.appendMarkdown(" · ");
    const command = field === "csl" ? SET_CSL_STYLE_COMMAND : SET_INLAY_METADATA_COMMAND;
    const args = encodeURIComponent(JSON.stringify(field === "csl" ? [uriText] : [uriText, field, getBuiltMetadataValue(ast, field)]));
    tooltip.appendMarkdown(`[设置${INLAY_METADATA_FIELDS[field]}](command:${command}?${args})`);
  }
  tooltip.appendMarkdown(fields.includes("csl") ? "\n\n作用于当前稿件的参考文献引用和文末列表" : "\n\n作用于当前稿件中同一类型的引用或题注");
}

/** Opens editing controls only on click, then applies one undoable manuscript-header edit. */
export class InlayMetadataController {
  /** Uses the extension log for explicit setting changes and edit failures. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Edits a documented prefix/title field without changing styles or another active document. */
  async setMetadata(uriText: unknown, requested: unknown, builtValue: unknown): Promise<void> {
    try {
      if (typeof uriText !== "string" || !isInlayMetadataField(requested)) throw new Error("无效的引用或题注设置请求");
      const uri = vscode.Uri.parse(uriText);
      if (uri.scheme !== "file") throw new Error("引用和题注设置仅支持本地 Markdown 文档");
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== "markdown") throw new Error("请在 Markdown 文档中设置引用或题注");
      const originalHeader = getYamlHeader(document.getText())?.content;
      const current = getManuscriptMetadataValue(document.getText(), requested)
        ?? (isInlayMetadataValue(builtValue) ? builtValue : "");
      const value = await this.promptValue(requested, current);
      if (value === undefined) return;
      await applyInlayMetadataSetting(document, requested, value, originalHeader, this.output);
    } catch (error) {
      this.output.appendLine(`[Inlay hints] Could not set reference/caption metadata: ${String(error)}`);
      void vscode.window.showErrorMessage(`设置引用或题注失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Prefills actual built values and preserves an existing singular/plural prefix list. */
  private async promptValue(field: InlayMetadataField, current: InlayMetadataValue): Promise<InlayMetadataValue | undefined> {
    const values = Array.isArray(current) ? current : [current];
    const updated: string[] = [];
    for (const [index, value] of values.entries()) {
      const variant = Array.isArray(current) ? `（${index === 0 ? "单数" : index === 1 ? "复数" : `形式 ${index + 1}`}）` : "";
      const result = await vscode.window.showInputBox({
        title: `设置${INLAY_METADATA_FIELDS[field]}${variant}`,
        prompt: `${field}：应用于当前稿件的同类引用或题注，可留空以去掉前缀`,
        value, ignoreFocusOut: true,
      });
      if (result === undefined) return undefined;
      updated.push(result);
    }
    return Array.isArray(current) ? updated : updated[0];
  }
}
