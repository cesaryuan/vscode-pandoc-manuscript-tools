/** Exposes exported attribute help in local and unsaved Markdown/MDX documents. */
import * as vscode from "vscode";
import { getConfigurationRevision } from "../configurationContract";
import { getAttributeGroups, type AttributeGroup } from "./parser";
import { getAttributeSuggestions, getAttributeHoverEntries, type AttributeHelp, type AttributeHoverInfo } from "./model";

/** Escapes descriptions from an executable export rather than enabling trusted Markdown commands. */
function documentation(help: AttributeHelp): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendText(help.description);
  if (help.targets.length) markdown.appendText(`\n\n输出格式：${help.targets.join("、")}`);
  if (help.values.length) markdown.appendText(`\n\n取值 / 示例：${help.values.map((value) => JSON.stringify(value)).join("、")}`);
  if (help.aliases.length) markdown.appendText(`\n\n其他合法写法：${help.aliases.join("、")}`);
  return markdown;
}

/** Shares scanning across hover/completion and invalidates help when installed Papper changes. */
export class ElementAttributeProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
  private readonly cache = new WeakMap<vscode.TextDocument, { version: number; revision: number;
    groups: AttributeGroup[]; hovers: AttributeHoverInfo[] }>();

  /** Uses the existing configuration query, executable cache and bundled offline definitions. */
  constructor(private readonly ensure: () => Promise<void> = async () => {}) {}

  /** Accepts the same editor buffers as the manuscript YAML providers. */
  private accepts(document: vscode.TextDocument): boolean {
    return ["markdown", "mdx"].includes(document.languageId) && ["file", "untitled"].includes(document.uri.scheme);
  }

  /** Parses each document version once and rebuilds derived help for a new contract revision. */
  private parsed(document: vscode.TextDocument) {
    const previous = this.cache.get(document);
    const revision = getConfigurationRevision();
    if (previous?.version === document.version && previous.revision === revision) return previous;
    const text = document.getText();
    const groups = previous?.version === document.version ? previous.groups : getAttributeGroups(text);
    const current = { version: document.version, revision, groups, hovers: getAttributeHoverEntries(text, groups) };
    this.cache.set(document, current);
    return current;
  }

  /** Inserts keys with a value placeholder and replaces values inside their existing quotes. */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
    if (token.isCancellationRequested || !this.accepts(document)) return undefined;
    await this.ensure();
    if (token.isCancellationRequested) return undefined;
    const suggestions = getAttributeSuggestions(document.getText(), document.offsetAt(position), this.parsed(document).groups);
    return suggestions?.map((suggestion) => {
      const item = new vscode.CompletionItem(suggestion.label,
        suggestion.kind === "key" ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Value);
      item.range = new vscode.Range(document.positionAt(suggestion.start), document.positionAt(suggestion.end));
      item.documentation = documentation(suggestion);
      item.detail = `Papper · ${suggestion.targets.join(" / ")}`;
      if (suggestion.placeholder !== undefined) {
        const snippet = new vscode.SnippetString();
        snippet.appendText(suggestion.insertText.slice(0, suggestion.placeholder));
        snippet.appendPlaceholder("");
        snippet.appendText(suggestion.insertText.slice(suggestion.placeholder));
        item.insertText = snippet;
        item.command = { command: "editor.action.triggerSuggest", title: "Complete Papper attribute value" };
      } else item.insertText = suggestion.insertText;
      return item;
    });
  }

  /** Shows only the innermost recognized attribute when page-story Markdown contains a nested span. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (token.isCancellationRequested || !this.accepts(document)) return undefined;
    await this.ensure();
    if (token.isCancellationRequested) return undefined;
    const offset = document.offsetAt(position);
    const entry = this.parsed(document).hovers.filter((entry) => entry.start <= offset && offset < entry.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    return entry ? new vscode.Hover(documentation(entry),
      new vscode.Range(document.positionAt(entry.start), document.positionAt(entry.end))) : undefined;
  }
}
