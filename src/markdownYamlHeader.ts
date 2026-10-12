import * as vscode from "vscode";
import { getYamlHeader } from "./manuscriptStyle/document";
import { MANUSCRIPT_FIELDS, getConfigurationRevision } from "./configurationContract";
import {
  getStyleSuggestions, getStyleHoverEntries,
  createConfigurationCompletionItems, createConfigurationHover,
  type StyleSuggestion, type StyleHoverInfo,
} from "./styleConfiguration";

export { MANUSCRIPT_FIELDS } from "./configurationContract";

/** Restricts header language features to local or unsaved Markdown/MDX editor buffers. */
function isMarkdownEditor(document: vscode.TextDocument): boolean {
  return ["markdown", "mdx"].includes(document.languageId) && ["file", "untitled"].includes(document.uri.scheme);
}

/** Returns header-only completions whose replacement offsets point into the original Markdown. */
export function getMarkdownHeaderSuggestions(text: string, offset: number): StyleSuggestion[] | undefined {
  const header = getYamlHeader(text, true);
  if (!header || offset < header.start || offset > header.end || (offset === header.end && header.end < text.length)) return undefined;
  return getStyleSuggestions(header.content, offset - header.start, MANUSCRIPT_FIELDS)
    .map((suggestion) => ({ ...suggestion, start: suggestion.start + header.start, end: suggestion.end + header.start }));
}

/** Builds header help without parsing Markdown body content as YAML. */
export function getMarkdownHeaderHoverEntries(text: string): StyleHoverInfo[] {
  const header = getYamlHeader(text, true);
  if (!header) return [];
  return getStyleHoverEntries(header.content, MANUSCRIPT_FIELDS)
    .map((entry) => ({ ...entry, start: entry.start + header.start, end: entry.end + header.start }));
}

/** Offers manuscript metadata and per-manuscript Papper settings while editing YAML frontmatter. */
export class MarkdownYamlHeaderCompletionProvider implements vscode.CompletionItemProvider {
  /** Shares installed definitions with style-file completion. */
  constructor(private readonly ensure: () => Promise<void> = async () => {}) {}

  /** Uses the shared completion renderer after translating YAML offsets to source-document offsets. */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
    if (token.isCancellationRequested || !isMarkdownEditor(document)) return undefined;
    await this.ensure();
    if (token.isCancellationRequested) return undefined;
    const suggestions = getMarkdownHeaderSuggestions(document.getText(), document.offsetAt(position));
    return suggestions ? createConfigurationCompletionItems(document, suggestions) : undefined;
  }
}

/** Shows help for filled header fields while retaining only the latest parsed document version. */
export class MarkdownYamlHeaderHoverProvider implements vscode.HoverProvider {
  private readonly cache = new WeakMap<vscode.TextDocument, { version: number; revision: number; entries: StyleHoverInfo[] }>();

  /** Refreshes exported help without disturbing the Markdown document. */
  constructor(private readonly ensure: () => Promise<void> = async () => {}) {}

  /** Resolves the hovered header token and leaves body hovers to existing Markdown providers. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (token.isCancellationRequested || !isMarkdownEditor(document)) return undefined;
    await this.ensure();
    if (token.isCancellationRequested) return undefined;
    let cached = this.cache.get(document);
    const revision = getConfigurationRevision();
    if (!cached || cached.version !== document.version || cached.revision !== revision) {
      cached = { version: document.version, revision, entries: getMarkdownHeaderHoverEntries(document.getText()) };
      this.cache.set(document, cached);
    }
    const offset = document.offsetAt(position);
    const info = cached.entries.find((entry) => entry.start <= offset && offset < entry.end);
    return info ? createConfigurationHover(document, info) : undefined;
  }
}
