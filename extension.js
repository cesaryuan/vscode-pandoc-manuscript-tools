"use strict";

const vscode = require("vscode");
const {
  parsePandocDocument,
  findMathBlockAtPosition,
  findTokenAtPosition,
} = require("./parser");

const EXTENSION_NAME = "Pandoc Crossref Helper";
const MARKDOWN_SELECTOR = [{ language: "markdown" }];

/**
 * Activates the local Pandoc Markdown helper extension.
 *
 * @param {vscode.ExtensionContext} context VS Code extension context.
 */
function activate(context) {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection("pandoc-crossref-helper");
  const index = new PandocWorkspaceIndex(output);

  output.appendLine("Activated Pandoc Crossref Helper.");

  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(MARKDOWN_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(MARKDOWN_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MARKDOWN_SELECTOR, new PandocHoverProvider(index)));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(MARKDOWN_SELECTOR, new PandocDocumentSymbolProvider(index), { label: EXTENSION_NAME }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(MARKDOWN_SELECTOR, new PandocCompletionProvider(index), "@", ":"));

  context.subscriptions.push(vscode.commands.registerCommand("pandocCrossrefHelper.rebuildIndex", async () => {
    await index.refreshWorkspace();
    updateDiagnosticsForOpenDocuments(index, diagnostics);
    vscode.window.showInformationMessage("Pandoc Crossref Helper index rebuilt.");
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
    if (isMarkdownDocument(document)) {
      index.updateDocument(document);
      updateDiagnostics(document, index, diagnostics);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isMarkdownDocument(event.document)) {
      index.updateDocument(event.document);
      updateDiagnostics(event.document, index, diagnostics);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (isMarkdownDocument(document)) {
      index.updateDocument(document);
      await index.refreshWorkspace();
      updateDiagnosticsForOpenDocuments(index, diagnostics);
    }
  }));

  void index.refreshWorkspace().then(() => updateDiagnosticsForOpenDocuments(index, diagnostics));
}

/**
 * Deactivates the extension.
 */
function deactivate() {}

class PandocWorkspaceIndex {
  /**
   * Creates a workspace-wide Markdown index.
   *
   * @param {vscode.OutputChannel} output Output channel for useful diagnostics.
   */
  constructor(output) {
    this.output = output;
    this.documents = new Map();
  }

  /**
   * Refreshes Markdown files from the workspace.
   *
   * Open documents are parsed from their editor buffer so unsaved label edits are
   * still visible to definitions, references, hovers, and diagnostics.
   *
   * @returns {Promise<void>}
   */
  async refreshWorkspace() {
    const includeWorkspace = getConfiguration().get("includeWorkspaceReferences", true);
    const openMarkdownDocuments = vscode.workspace.textDocuments.filter(isMarkdownDocument);

    for (const document of openMarkdownDocuments) {
      this.updateDocument(document);
    }

    if (!includeWorkspace) {
      this.output.appendLine(`Indexed ${openMarkdownDocuments.length} open Markdown document(s).`);
      return;
    }

    try {
      const files = await vscode.workspace.findFiles("**/*.md", "**/{.git,node_modules,output,tmp}/**", 1000);
      for (const uri of files) {
        const openDocument = openMarkdownDocuments.find((document) => document.uri.toString() === uri.toString());
        if (openDocument) {
          continue;
        }
        await this.updateUri(uri);
      }
      this.output.appendLine(`Indexed ${this.documents.size} Markdown document(s).`);
    } catch (error) {
      this.output.appendLine(`Failed to refresh Markdown index: ${String(error)}`);
    }
  }

  /**
   * Parses and caches an open text document.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {ParsedCacheEntry}
   */
  updateDocument(document) {
    const uriText = document.uri.toString();
    const existing = this.documents.get(uriText);
    if (existing && existing.version === document.version) {
      return existing;
    }

    const parsed = parsePandocDocument(document.getText(), uriText);
    const entry = { uri: document.uri, version: document.version, parsed };
    this.documents.set(uriText, entry);
    return entry;
  }

  /**
   * Reads, parses, and caches a Markdown file URI.
   *
   * @param {vscode.Uri} uri Markdown file URI.
   * @returns {Promise<ParsedCacheEntry | undefined>}
   */
  async updateUri(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parsePandocDocument(text, uri.toString());
      const entry = { uri, version: undefined, parsed };
      this.documents.set(uri.toString(), entry);
      return entry;
    } catch (error) {
      this.output.appendLine(`Failed to index ${uri.fsPath}: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Returns the cached parse for a document, parsing it if needed.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {import("./parser").ParsedPandocDocument}
   */
  getParsedDocument(document) {
    return this.updateDocument(document).parsed;
  }

  /**
   * Finds all definitions for a Pandoc label.
   *
   * @param {string} label Pandoc label.
   * @returns {import("./parser").LabelEntry[]}
   */
  getDefinitions(label) {
    return this.getAllEntriesByLabel("labels", label);
  }

  /**
   * Finds all references for a Pandoc label.
   *
   * @param {string} label Pandoc label.
   * @returns {import("./parser").ReferenceEntry[]}
   */
  getReferences(label) {
    return this.getAllEntriesByLabel("references", label);
  }

  /**
   * Returns all labels currently known to the index.
   *
   * @returns {import("./parser").LabelEntry[]}
   */
  getAllLabels() {
    return Array.from(this.documents.values()).flatMap((entry) => entry.parsed.labels);
  }

  /**
   * Returns entries of a given parsed collection matching one label.
   *
   * @param {"labels" | "references"} collection Parsed collection name.
   * @param {string} label Pandoc label.
   * @returns {Array<import("./parser").LabelEntry | import("./parser").ReferenceEntry>}
   */
  getAllEntriesByLabel(collection, label) {
    const entries = [];
    for (const cached of this.documents.values()) {
      entries.push(...cached.parsed[collection].filter((entry) => entry.label === label));
    }
    return entries;
  }

  /**
   * Returns a map from label to all matching definitions.
   *
   * @returns {Map<string, import("./parser").LabelEntry[]>}
   */
  getDefinitionMap() {
    const map = new Map();
    for (const label of this.getAllLabels()) {
      if (!map.has(label.label)) {
        map.set(label.label, []);
      }
      map.get(label.label).push(label);
    }
    return map;
  }
}

class PandocDefinitionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides go-to-definition for Pandoc cross references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.Location[] | undefined}
   */
  provideDefinition(document, position) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    return this.index.getDefinitions(token.entry.label).map(toLocation);
  }
}

class PandocReferenceProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides find-all-references for Pandoc labels and references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @param {{includeDeclaration: boolean}} options Reference options.
   * @returns {vscode.Location[] | undefined}
   */
  provideReferences(document, position, options) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    const locations = this.index.getReferences(token.entry.label).map(toLocation);
    if (options.includeDeclaration) {
      locations.unshift(...this.index.getDefinitions(token.entry.label).map(toLocation));
    }
    return locations;
  }
}

class PandocHoverProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides label, reference, and math-block hover information.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.Hover | undefined}
   */
  provideHover(document, position) {
    const parsed = this.index.getParsedDocument(document);
    const plainPosition = toPlainPosition(position);
    const token = findTokenAtPosition(parsed, plainPosition);
    if (token) {
      return new vscode.Hover(buildLabelHover(token.entry, this.index), toRange(token.entry.fullRange));
    }

    const mathBlock = findMathBlockAtPosition(parsed, plainPosition);
    if (mathBlock) {
      return new vscode.Hover(buildMathHover(mathBlock, this.index), toRange(mathBlock.selectionRange));
    }

    return undefined;
  }
}

class PandocDocumentSymbolProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides a Pandoc-aware outline that is not confused by `$$ {#eq:...}`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {vscode.DocumentSymbol[]}
   */
  provideDocumentSymbols(document) {
    const parsed = this.index.getParsedDocument(document);
    const headingSymbols = buildHeadingTree(parsed.headings);
    if (getConfiguration().get("includeLabelSymbols", true)) {
      addLabelSymbols(parsed.labels, headingSymbols);
    }
    return headingSymbols;
  }
}

class PandocCompletionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides label completions after `@`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.CompletionItem[] | undefined}
   */
  provideCompletionItems(document, position) {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = linePrefix.match(/@([A-Za-z0-9_:.~-]*)$/);
    if (!match) {
      return undefined;
    }

    const replacementStart = position.translate(0, -match[1].length);
    const replacementRange = new vscode.Range(replacementStart, position);
    const seen = new Set();

    return this.index.getAllLabels()
      .filter((entry) => !seen.has(entry.label) && seen.add(entry.label))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((entry) => {
        const item = new vscode.CompletionItem(entry.label, vscode.CompletionItemKind.Reference);
        item.insertText = entry.label;
        item.detail = entry.kind;
        item.documentation = entry.preview;
        item.range = replacementRange;
        return item;
      });
  }
}

/**
 * Builds a hover body for a label or cross-reference token.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Label or reference entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @returns {vscode.MarkdownString}
 */
function buildLabelHover(entry, index) {
  const definitions = index.getDefinitions(entry.label);
  const references = index.getReferences(entry.label);
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${entry.kind}** \`${entry.label}\`\n\n`);
  markdown.appendMarkdown(`Definitions: **${definitions.length}**  \n`);
  markdown.appendMarkdown(`References: **${references.length}**`);

  if (definitions.length === 0) {
    markdown.appendMarkdown("\n\n$(warning) No definition found for this Pandoc cross reference.");
  } else if (definitions.length > 1) {
    markdown.appendMarkdown("\n\n$(warning) Duplicate definitions were found for this label.");
  } else {
    markdown.appendMarkdown(`\n\nDefined at \`${definitions[0].preview}\``);
  }

  return markdown;
}

/**
 * Builds a hover body for display math blocks.
 *
 * VS Code hovers may render Markdown math in recent builds; the TeX code block
 * is kept as a fallback for environments where math rendering is unavailable.
 *
 * @param {import("./parser").MathBlockEntry} mathBlock Math block entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @returns {vscode.MarkdownString}
 */
function buildMathHover(mathBlock, index) {
  const markdown = new vscode.MarkdownString(undefined, true);
  const label = mathBlock.label || "unlabeled equation";
  const referenceCount = mathBlock.label ? index.getReferences(mathBlock.label).length : 0;

  markdown.appendMarkdown(`**Equation** \`${label}\``);
  if (mathBlock.label) {
    markdown.appendMarkdown(`  \nReferences: **${referenceCount}**`);
  }

  if (mathBlock.tex) {
    markdown.appendMarkdown(`\n\n$$\n${mathBlock.tex}\n$$\n\n`);
    markdown.appendCodeblock(mathBlock.tex, "tex");
  }

  return markdown;
}

/**
 * Builds a nested heading tree for VS Code's Outline view.
 *
 * @param {import("./parser").HeadingEntry[]} headings Parsed headings.
 * @returns {vscode.DocumentSymbol[]}
 */
function buildHeadingTree(headings) {
  const roots = [];
  const stack = [];

  for (const heading of headings) {
    const symbol = new vscode.DocumentSymbol(
      heading.title,
      heading.label || "",
      vscode.SymbolKind.Namespace,
      toRange(heading.range),
      toRange(heading.selectionRange),
    );

    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(symbol);
    } else {
      stack[stack.length - 1].symbol.children.push(symbol);
    }

    stack.push({ level: heading.level, symbol });
  }

  return roots;
}

/**
 * Adds figure, table, and equation labels below their nearest heading symbol.
 *
 * @param {import("./parser").LabelEntry[]} labels Parsed label definitions.
 * @param {vscode.DocumentSymbol[]} headingSymbols Heading symbols.
 */
function addLabelSymbols(labels, headingSymbols) {
  const nonSectionLabels = labels.filter((entry) => entry.prefix !== "sec");
  for (const label of nonSectionLabels) {
    const symbol = new vscode.DocumentSymbol(
      label.label,
      label.kind,
      toSymbolKind(label.prefix),
      toRange(label.fullRange),
      toRange(label.range),
    );

    const parent = findNearestHeadingSymbol(headingSymbols, label.line);
    if (parent) {
      parent.children.push(symbol);
    } else {
      headingSymbols.push(symbol);
    }
  }
}

/**
 * Finds the innermost heading symbol preceding a line.
 *
 * @param {vscode.DocumentSymbol[]} symbols Candidate heading symbols.
 * @param {number} line Target line.
 * @returns {vscode.DocumentSymbol | undefined}
 */
function findNearestHeadingSymbol(symbols, line) {
  let nearest;
  for (const symbol of symbols) {
    const symbolLine = symbol.selectionRange.start.line;
    if (symbolLine <= line) {
      nearest = symbol;
    }

    const childNearest = findNearestHeadingSymbol(symbol.children, line);
    if (childNearest && childNearest.selectionRange.start.line <= line) {
      nearest = childNearest;
    }
  }
  return nearest;
}

/**
 * Updates diagnostics for all open Markdown documents.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnosticsForOpenDocuments(index, diagnostics) {
  for (const document of vscode.workspace.textDocuments) {
    if (isMarkdownDocument(document)) {
      updateDiagnostics(document, index, diagnostics);
    }
  }
}

/**
 * Updates diagnostics for one Markdown document.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnostics(document, index, diagnostics) {
  if (!getConfiguration().get("enableDiagnostics", true)) {
    diagnostics.delete(document.uri);
    return;
  }

  const parsed = index.getParsedDocument(document);
  const definitionMap = index.getDefinitionMap();
  const documentDiagnostics = [];

  for (const reference of parsed.references) {
    if (!definitionMap.has(reference.label)) {
      const diagnostic = new vscode.Diagnostic(
        toRange(reference.fullRange),
        `Undefined Pandoc cross reference: ${reference.label}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  for (const label of parsed.labels) {
    const definitions = definitionMap.get(label.label) || [];
    if (definitions.length > 1) {
      const diagnostic = new vscode.Diagnostic(
        toRange(label.fullRange),
        `Duplicate Pandoc label: ${label.label}`,
        vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  diagnostics.set(document.uri, documentDiagnostics);
}

/**
 * Returns the token at a document position.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.TextDocument} document Markdown document.
 * @param {vscode.Position} position Cursor position.
 * @returns {{type: string, entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry} | undefined}
 */
function getTokenAtDocumentPosition(index, document, position) {
  const parsed = index.getParsedDocument(document);
  return findTokenAtPosition(parsed, toPlainPosition(position));
}

/**
 * Converts a plain parser range into a VS Code range.
 *
 * @param {import("./parser").PlainRange} range Plain parser range.
 * @returns {vscode.Range}
 */
function toRange(range) {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

/**
 * Converts a parser entry to a VS Code location.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Parsed entry.
 * @returns {vscode.Location}
 */
function toLocation(entry) {
  return new vscode.Location(vscode.Uri.parse(entry.uriText), toRange(entry.range));
}

/**
 * Converts a VS Code position into a serializable parser position.
 *
 * @param {vscode.Position} position VS Code position.
 * @returns {{line: number, character: number}}
 */
function toPlainPosition(position) {
  return { line: position.line, character: position.character };
}

/**
 * Returns a VS Code symbol kind for a Pandoc label prefix.
 *
 * @param {string} prefix Pandoc label prefix.
 * @returns {vscode.SymbolKind}
 */
function toSymbolKind(prefix) {
  if (prefix === "eq") {
    return vscode.SymbolKind.Number;
  }
  if (prefix === "fig") {
    return vscode.SymbolKind.Object;
  }
  if (prefix === "tbl") {
    return vscode.SymbolKind.Array;
  }
  return vscode.SymbolKind.String;
}

/**
 * Checks whether a document is a Markdown document.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isMarkdownDocument(document) {
  return document.languageId === "markdown" && (document.uri.scheme === "file" || document.uri.scheme === "untitled");
}

/**
 * Returns this extension's workspace configuration.
 *
 * @returns {vscode.WorkspaceConfiguration}
 */
function getConfiguration() {
  return vscode.workspace.getConfiguration("pandocCrossrefHelper");
}

module.exports = {
  activate,
  deactivate,
};

/**
 * @typedef {{uri: vscode.Uri, version?: number, parsed: import("./parser").ParsedPandocDocument}} ParsedCacheEntry
 */
