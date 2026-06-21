"use strict";

const vscode = require("vscode");
const { EXTENSION_NAME, MARKDOWN_SELECTOR, BUILD_DOCX_COMMAND } = require("./constants");
const { PandocWorkspaceIndex } = require("./workspaceIndex");
const { PandocBuildRunner } = require("./docxBuild");
const { FencedDivHighlighter } = require("./fencedDivHighlighter");
const { MathJaxRenderer } = require("./mathJaxRenderer");
const { ParagraphTranslator } = require("./paragraphTranslator");
const { getConfiguration } = require("./configuration");
const { isMarkdownDocument } = require("./vscodeUtils");
const {
  PandocDefinitionProvider,
  PandocReferenceProvider,
  PandocHoverProvider,
  PandocDocumentSymbolProvider,
  PandocCompletionProvider,
  updateDiagnosticsForOpenDocuments,
  updateDiagnostics,
} = require("./providers");

/**
 * Activates the local Pandoc Markdown helper extension.
 *
 * @param {vscode.ExtensionContext} context VS Code extension context.
 */
function activate(context) {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection("pandoc-manuscript-tools");
  const index = new PandocWorkspaceIndex(output);
  const mathRenderer = new MathJaxRenderer(output);
  const paragraphTranslator = new ParagraphTranslator(output);
  const buildRunner = new PandocBuildRunner(output);
  const fencedDivHighlighter = new FencedDivHighlighter(index, output);

  output.appendLine("Activated Pandoc Manuscript Tools.");
  if (getConfiguration().get("enableParagraphHoverTranslation", false)) {
    void paragraphTranslator.initialize();
  }

  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(MARKDOWN_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(MARKDOWN_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MARKDOWN_SELECTOR, new PandocHoverProvider(index, mathRenderer, paragraphTranslator)));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(MARKDOWN_SELECTOR, new PandocDocumentSymbolProvider(index), { label: EXTENSION_NAME }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(MARKDOWN_SELECTOR, new PandocCompletionProvider(index), "@", ":"));
  context.subscriptions.push({ dispose: () => mathRenderer.dispose() });
  context.subscriptions.push({ dispose: () => fencedDivHighlighter.dispose() });

  context.subscriptions.push(vscode.commands.registerCommand("pandocManuscriptTools.rebuildIndex", async () => {
    await index.refreshWorkspace();
    updateDiagnosticsForOpenDocuments(index, diagnostics);
    vscode.window.showInformationMessage("Pandoc Manuscript Tools index rebuilt.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand(BUILD_DOCX_COMMAND, async () => {
    await buildRunner.buildActiveMarkdownDocx();
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void buildRunner.refreshContext();
    fencedDivHighlighter.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    fencedDivHighlighter.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void buildRunner.refreshContext();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("pandocManuscriptTools.highlightFencedDivs")) {
      fencedDivHighlighter.updateVisibleEditors();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
    if (isMarkdownDocument(document)) {
      index.updateDocument(document);
      updateDiagnostics(document, index, diagnostics);
      void buildRunner.refreshContext();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isMarkdownDocument(event.document)) {
      index.updateDocument(event.document);
      updateDiagnostics(event.document, index, diagnostics);
      fencedDivHighlighter.updateVisibleEditors(event.document);
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
  void buildRunner.refreshContext();
  fencedDivHighlighter.updateVisibleEditors();
}

/**
 * Deactivates the extension.
 */
function deactivate() {}


module.exports = {
  activate,
  deactivate,
};
