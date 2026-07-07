import * as vscode from "vscode";
import { EXTENSION_NAME, PANDOC_SELECTOR, MATH_HOVER_SELECTOR, BUILD_DOCX_COMMAND, OPEN_IMAGE_PREVIEW_COMMAND, METAFILE_PREVIEW_EDITOR_VIEW_TYPE } from "./constants";
import { PandocWorkspaceIndex } from "./workspaceIndex";
import { PandocBuildRunner } from "./docxBuild";
import { FencedDivHighlighter } from "./fencedDivHighlighter";
import { MathJaxRenderer } from "./mathJaxRenderer";
import { ParagraphTranslator } from "./paragraphTranslator";
import { ImagePreviewRenderer } from "./imagePreview";
import { ImagePreviewSidePanel } from "./imagePreview/sidePreview";
import { MetafilePreviewCustomEditorProvider } from "./imagePreview/customEditor";
import { getConfiguration } from "./configuration";
import { isPandocDocument } from "./vscodeUtils";
import { PandocDefinitionProvider, PandocReferenceProvider, PandocHoverProvider, ImagePreviewHoverProvider, PandocDocumentSymbolProvider, PandocCompletionProvider, updateDiagnosticsForOpenDocuments, updateDiagnostics } from "./providers";

/**
 * Activates the local Pandoc Markdown helper extension.
 *
 * @param {vscode.ExtensionContext} context VS Code extension context.
 */
export function activate(context) {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection("pandoc-manuscript-tools");
  const index = new PandocWorkspaceIndex(output);
  const mathRenderer = new MathJaxRenderer(output);
  const paragraphTranslator = new ParagraphTranslator(output);
  const imagePreviewRenderer = new ImagePreviewRenderer(output);
  const imagePreviewSidePanel = new ImagePreviewSidePanel(imagePreviewRenderer, output);
  const metafilePreviewEditorProvider = new MetafilePreviewCustomEditorProvider(imagePreviewRenderer, output);
  const buildRunner = new PandocBuildRunner(output);
  const fencedDivHighlighter = new FencedDivHighlighter(index, output);

  output.appendLine("Activated Pandoc Manuscript Tools.");
  if (getConfiguration().get("enableParagraphHoverTranslation", false)) {
    void paragraphTranslator.initialize();
  }

  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(PANDOC_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(PANDOC_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(PANDOC_SELECTOR, new ImagePreviewHoverProvider(imagePreviewRenderer, output)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MATH_HOVER_SELECTOR, new PandocHoverProvider(index, mathRenderer, paragraphTranslator, output)));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(METAFILE_PREVIEW_EDITOR_VIEW_TYPE, metafilePreviewEditorProvider, {
    webviewOptions: {
      retainContextWhenHidden: true,
    },
  }));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(PANDOC_SELECTOR, new PandocDocumentSymbolProvider(index), { label: EXTENSION_NAME }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(PANDOC_SELECTOR, new PandocCompletionProvider(index), "@", ":"));
  context.subscriptions.push({ dispose: () => mathRenderer.dispose() });
  context.subscriptions.push({ dispose: () => imagePreviewRenderer.dispose() });
  context.subscriptions.push({ dispose: () => imagePreviewSidePanel.dispose() });
  context.subscriptions.push({ dispose: () => fencedDivHighlighter.dispose() });

  context.subscriptions.push(vscode.commands.registerCommand("pandocManuscriptTools.rebuildIndex", async () => {
    await index.refreshWorkspace();
    updateDiagnosticsForOpenDocuments(index, diagnostics);
    vscode.window.showInformationMessage("Pandoc Manuscript Tools index rebuilt.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand(BUILD_DOCX_COMMAND, async () => {
    await buildRunner.buildActiveMarkdownDocx();
  }));

  context.subscriptions.push(vscode.commands.registerCommand(OPEN_IMAGE_PREVIEW_COMMAND, async (uri) => {
    await imagePreviewSidePanel.open(uri);
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
    if (
      event.affectsConfiguration("pandocManuscriptTools.highlightFencedDivs")
      || event.affectsConfiguration("pandocManuscriptTools.highlightBracketedSpans")
    ) {
      fencedDivHighlighter.updateVisibleEditors();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
    if (isPandocDocument(document)) {
      index.updateDocument(document);
      updateDiagnostics(document, index, diagnostics);
      void buildRunner.refreshContext();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isPandocDocument(event.document)) {
      index.updateDocument(event.document);
      updateDiagnostics(event.document, index, diagnostics);
      fencedDivHighlighter.updateVisibleEditors(event.document);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (isPandocDocument(document)) {
      index.updateDocument(document);
      await index.refreshWorkspace();
      updateDiagnosticsForOpenDocuments(index, diagnostics);
    }
    await imagePreviewSidePanel.refreshIfOpen(document);
  }));

  void index.refreshWorkspace().then(() => updateDiagnosticsForOpenDocuments(index, diagnostics));
  void buildRunner.refreshContext();
  fencedDivHighlighter.updateVisibleEditors();
}

/**
 * Deactivates the extension.
 */
export function deactivate() {}

