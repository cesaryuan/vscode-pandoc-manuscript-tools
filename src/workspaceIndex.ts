import * as vscode from "vscode";
import { parsePandocDocument } from "./parser";
import { getConfiguration } from "./configuration";
import { isPandocDocument } from "./vscodeUtils";
import { isReviewerReplyPath, mergeReviewerReplyDefinitions, resolveReviewerReplyDefinitions } from "./reviewerReplyDefinitions";

export type ParsedCacheEntry = {
  uri: import("vscode").Uri;
  version?: number;
  parsed: ReturnType<typeof parsePandocDocument>;
};

export class PandocWorkspaceIndex {
  declare output: import("vscode").OutputChannel;
  declare documents: Map<string, ParsedCacheEntry>;
  /**
   * Creates a workspace-wide Markdown index.
   *
   * @param output Output channel for useful diagnostics.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.documents = new Map();
  }

  /**
   * Refreshes Markdown files from the workspace.
   *
   * Open documents are parsed from their editor buffer so unsaved label edits are
   * still visible to definitions, references, hovers, and diagnostics.
   *
   */
  async refreshWorkspace() {
    const includeWorkspace = getConfiguration().get("includeWorkspaceReferences", false);
    const openPandocDocuments = vscode.workspace.textDocuments.filter(isPandocDocument);
    let reviewerManuscriptCount = 0;

    for (const document of openPandocDocuments) {
      this.updateDocument(document);
      if (await this.updateReviewerManuscriptDefinitions(document)) {
        reviewerManuscriptCount += 1;
      }
    }

    if (!includeWorkspace) {
      const reviewerSourceSummary = reviewerManuscriptCount > 0
        ? ` and ${reviewerManuscriptCount} reviewer manuscript definition source(s)`
        : "";
      this.output.appendLine(`Indexed ${openPandocDocuments.length} open Pandoc document(s)${reviewerSourceSummary}.`);
      return;
    }

    try {
      // `.mdx` shares the same parser/index behavior as Markdown for hover and
      // cross-reference features, so workspace preloading should include both.
      const files = await vscode.workspace.findFiles("**/*.{md,mdx}", "**/{.git,node_modules,output,tmp}/**", 1000);
      for (const uri of files) {
        const openDocument = openPandocDocuments.find((document) => document.uri.toString() === uri.toString());
        if (openDocument) {
          continue;
        }
        await this.updateUri(uri);
      }
      this.output.appendLine(`Indexed ${this.documents.size} Pandoc document(s).`);
    } catch (error) {
      this.output.appendLine(`Failed to refresh Pandoc document index: ${String(error)}`);
    }
  }

  /**
   * Parses and caches an open text document.
   *
   * @param document Markdown document.
   */
  updateDocument(document: vscode.TextDocument) {
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
   * Prepares one open document and any definition source it depends on.
   *
   * @param document Markdown document.
   */
  async prepareDocument(document: vscode.TextDocument): Promise<ParsedCacheEntry> {
    const entry = this.updateDocument(document);
    await this.updateReviewerManuscriptDefinitions(document);
    return entry;
  }

  /**
   * Reads, parses, and caches a Markdown file URI.
   *
   * @param uri Markdown file URI.
   */
  async updateUri(uri: vscode.Uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parsePandocDocument(text, uri.toString());
      const entry: ParsedCacheEntry = { uri, version: undefined, parsed };
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
   * @param document Markdown document.
   */
  getParsedDocument(document: vscode.TextDocument) {
    return this.updateDocument(document).parsed;
  }

  /**
   * Finds definitions for a Pandoc label in one Markdown document.
   *
   * @param document Markdown document whose labels define the lookup scope.
   * @param label Pandoc label.
   */
  getDefinitions(document: vscode.TextDocument, label: string): import("./parser").LabelEntry[] {
    const localDefinitions = this.getParsedDocument(document).labels.filter((entry) => entry.label === label);
    const manuscriptDefinitions = this.getReviewerManuscriptDefinitions(document).filter((entry) => entry.label === label);
    return resolveReviewerReplyDefinitions(document.uri.path, localDefinitions, manuscriptDefinitions);
  }

  /**
   * Finds references for a Pandoc label in one Markdown document.
   *
   * @param document Markdown document whose references define the lookup scope.
   * @param label Pandoc label.
   */
  getReferences(document: vscode.TextDocument, label: string): import("./parser").ReferenceEntry[] {
    return this.getParsedDocument(document).references.filter((entry) => entry.label === label);
  }

  /**
   * Returns all labels from one Markdown document.
   *
   * @param document Markdown document whose labels should be returned.
   */
  getAllLabels(document: vscode.TextDocument) {
    return this.getEffectiveDefinitions(document);
  }

  /**
   * Returns entries from one parsed document collection matching one label.
   *
   * @param document Markdown document whose parsed entries should be searched.
   * @param collection Parsed collection name.
   * @param label Pandoc label.
   */
  getDocumentEntriesByLabel(document: vscode.TextDocument, collection: "labels" | "references", label: string): Array<import("./parser").LabelEntry | import("./parser").ReferenceEntry> {
    const parsed = this.getParsedDocument(document);
    return parsed[collection].filter((entry) => entry.label === label);
  }

  /**
   * Returns a map from label to definitions in one Markdown document.
   *
   * @param document Markdown document whose labels define the duplicate scope.
   */
  getDefinitionMap(document: vscode.TextDocument) {
    const map = new Map();
    // Duplicate-label diagnostics remain document-local. A reviewer reply may
    // intentionally repeat a manuscript label while quoting revised content.
    for (const label of this.getParsedDocument(document).labels) {
      if (!map.has(label.label)) {
        map.set(label.label, []);
      }
      map.get(label.label).push(label);
    }
    return map;
  }

  /**
   * Checks whether one open document supplies definitions to an open reviewer reply.
   *
   * This lets edits in `manuscript.md` refresh dependent reply diagnostics without
   * broadening every Markdown document to a workspace-wide diagnostic scope.
   *
   * @param document Potential manuscript definition source.
   */
  isDefinitionSourceForOpenReviewerReply(document: vscode.TextDocument): boolean {
    return vscode.workspace.textDocuments
      .filter(isPandocDocument)
      .some((candidate) => this.getReviewerManuscriptUri(candidate)?.toString() === document.uri.toString());
  }

  /**
   * Returns definitions visible from one document.
   *
   * Reviewer replies see their local definitions followed by definitions from
   * `<workspace>/manuscript.md`; every other document remains document-local.
   *
   * @param document Markdown document whose definition scope is requested.
   */
  private getEffectiveDefinitions(document: vscode.TextDocument): import("./parser").LabelEntry[] {
    const localDefinitions = this.getParsedDocument(document).labels;
    const manuscriptDefinitions = this.getReviewerManuscriptDefinitions(document);
    return mergeReviewerReplyDefinitions(document.uri.path, localDefinitions, manuscriptDefinitions);
  }

  /**
   * Returns cached definitions from the reviewer reply's workspace manuscript.
   *
   * @param document Potential reviewer-reply document.
   */
  private getReviewerManuscriptDefinitions(document: vscode.TextDocument): import("./parser").LabelEntry[] {
    const manuscriptUri = this.getReviewerManuscriptUri(document);
    return manuscriptUri ? this.documents.get(manuscriptUri.toString())?.parsed.labels || [] : [];
  }

  /**
   * Loads the workspace manuscript used as an extra definition source by a reply.
   *
   * @param document Potential reviewer-reply document.
   */
  private async updateReviewerManuscriptDefinitions(document: vscode.TextDocument): Promise<ParsedCacheEntry | undefined> {
    const manuscriptUri = this.getReviewerManuscriptUri(document);
    if (!manuscriptUri) {
      return undefined;
    }

    const openManuscript = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === manuscriptUri.toString());
    if (openManuscript) {
      return this.updateDocument(openManuscript);
    }

    return this.updateUri(manuscriptUri);
  }

  /**
   * Resolves `<workspace>/manuscript.md` for the named reviewer-reply file.
   *
   * @param document Potential reviewer-reply document.
   */
  private getReviewerManuscriptUri(document: vscode.TextDocument): vscode.Uri | undefined {
    if (!isReviewerReplyPath(document.uri.path)) {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    return workspaceFolder ? vscode.Uri.joinPath(workspaceFolder.uri, "manuscript.md") : undefined;
  }
}




