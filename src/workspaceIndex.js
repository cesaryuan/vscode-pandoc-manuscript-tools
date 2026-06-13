"use strict";

const vscode = require("vscode");
const { parsePandocDocument } = require("./parser");
const { getConfiguration } = require("./configuration");
const { isMarkdownDocument } = require("./vscodeUtils");

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
    const includeWorkspace = getConfiguration().get("includeWorkspaceReferences", false);
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
   * Finds definitions for a Pandoc label in one Markdown document.
   *
   * @param {vscode.TextDocument} document Markdown document whose labels define the lookup scope.
   * @param {string} label Pandoc label.
   * @returns {import("./parser").LabelEntry[]}
   */
  getDefinitions(document, label) {
    return this.getDocumentEntriesByLabel(document, "labels", label);
  }

  /**
   * Finds references for a Pandoc label in one Markdown document.
   *
   * @param {vscode.TextDocument} document Markdown document whose references define the lookup scope.
   * @param {string} label Pandoc label.
   * @returns {import("./parser").ReferenceEntry[]}
   */
  getReferences(document, label) {
    return this.getDocumentEntriesByLabel(document, "references", label);
  }

  /**
   * Returns all labels from one Markdown document.
   *
   * @param {vscode.TextDocument} document Markdown document whose labels should be returned.
   * @returns {import("./parser").LabelEntry[]}
   */
  getAllLabels(document) {
    return this.getParsedDocument(document).labels;
  }

  /**
   * Returns entries from one parsed document collection matching one label.
   *
   * @param {vscode.TextDocument} document Markdown document whose parsed entries should be searched.
   * @param {"labels" | "references"} collection Parsed collection name.
   * @param {string} label Pandoc label.
   * @returns {Array<import("./parser").LabelEntry | import("./parser").ReferenceEntry>}
   */
  getDocumentEntriesByLabel(document, collection, label) {
    const parsed = this.getParsedDocument(document);
    return parsed[collection].filter((entry) => entry.label === label);
  }

  /**
   * Returns a map from label to definitions in one Markdown document.
   *
   * @param {vscode.TextDocument} document Markdown document whose labels define the duplicate scope.
   * @returns {Map<string, import("./parser").LabelEntry[]>}
   */
  getDefinitionMap(document) {
    const map = new Map();
    // Duplicate and undefined-reference diagnostics are document-local because
    // separate manuscripts often reuse labels intentionally.
    for (const label of this.getAllLabels(document)) {
      if (!map.has(label.label)) {
        map.set(label.label, []);
      }
      map.get(label.label).push(label);
    }
    return map;
  }
}


module.exports = {
  PandocWorkspaceIndex,
};

/**
 * @typedef {{uri: vscode.Uri, version?: number, parsed: import("./parser").ParsedPandocDocument}} ParsedCacheEntry
 */
