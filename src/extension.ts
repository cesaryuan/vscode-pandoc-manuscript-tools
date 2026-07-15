import * as vscode from "vscode";
import { EXTENSION_NAME, PANDOC_SELECTOR, IMAGE_PREVIEW_SELECTOR, MATH_HOVER_SELECTOR, BUILD_DOCX_COMMAND, OPEN_IMAGE_PREVIEW_COMMAND, OPEN_SVG_PREVIEW_COMMAND, OPEN_SVG_SOURCE_TEXT_COMMAND, METAFILE_PREVIEW_EDITOR_VIEW_TYPE, SVG_PREVIEW_EDITOR_VIEW_TYPE } from "./constants";
import { PandocWorkspaceIndex } from "./workspaceIndex";
import { PandocBuildRunner } from "./docxBuild";
import { FencedDivHighlighter } from "./fencedDivHighlighter";
import { InlineFoldController } from "./inlineFoldController";
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
 * @param context VS Code extension context.
 */
export function activate(context: vscode.ExtensionContext) {
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
  const inlineFoldController = new InlineFoldController(index, output);

  output.appendLine("Activated Pandoc Manuscript Tools.");
  if (getConfiguration().get("enableParagraphHoverTranslation", false)) {
    void paragraphTranslator.initialize();
  }

  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(PANDOC_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(PANDOC_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(IMAGE_PREVIEW_SELECTOR, new ImagePreviewHoverProvider(imagePreviewRenderer, output)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MATH_HOVER_SELECTOR, new PandocHoverProvider(index, mathRenderer, paragraphTranslator, output)));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(METAFILE_PREVIEW_EDITOR_VIEW_TYPE, metafilePreviewEditorProvider, {
    webviewOptions: {
      retainContextWhenHidden: true,
    },
  }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(SVG_PREVIEW_EDITOR_VIEW_TYPE, metafilePreviewEditorProvider, {
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
  context.subscriptions.push({ dispose: () => inlineFoldController.dispose() });

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
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_SVG_PREVIEW_COMMAND, async (uri) => {
    await reopenResourceWithSvgPreview(uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_SVG_SOURCE_TEXT_COMMAND, async (uri) => {
    await reopenResourceWithDefaultEditor(uri);
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void buildRunner.refreshContext();
    fencedDivHighlighter.updateVisibleEditors();
    inlineFoldController.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    fencedDivHighlighter.updateVisibleEditors();
    inlineFoldController.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    inlineFoldController.updateEditor(event.textEditor);
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
    if (
      event.affectsConfiguration("pandocManuscriptTools.foldLineExcerptCodeSpans")
      || event.affectsConfiguration("pandocManuscriptTools.foldRevisionCharSpanAttributes")
    ) {
      inlineFoldController.updateVisibleEditors();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
    if (isPandocDocument(document)) {
      await index.prepareDocument(document);
      updateDiagnostics(document, index, diagnostics);
      void buildRunner.refreshContext();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isPandocDocument(event.document)) {
      index.updateDocument(event.document);
      if (index.isDefinitionSourceForOpenReviewerReply(event.document)) {
        updateDiagnosticsForOpenDocuments(index, diagnostics);
      } else {
        updateDiagnostics(event.document, index, diagnostics);
      }
      fencedDivHighlighter.updateVisibleEditors(event.document);
      inlineFoldController.updateVisibleEditors(event.document);
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
  inlineFoldController.updateVisibleEditors();
}

/**
 * Deactivates the extension.
 */
export function deactivate() {}

/**
 * Reopens an SVG source document with the extension's SVG preview custom editor.
 *
 * @param uri Optional command resource URI supplied by editor/title.
 */
async function reopenResourceWithSvgPreview(uri: vscode.Uri | undefined): Promise<void> {
  const resourceUri = uri || vscode.window.activeTextEditor?.document.uri;
  if (!resourceUri && !hasActiveEditorTab()) {
    await vscode.window.showWarningMessage("No SVG source editor is active.");
    return;
  }

  await reopenActiveEditorWith(SVG_PREVIEW_EDITOR_VIEW_TYPE, resourceUri);
}

/**
 * Reopens the active custom-editor resource with VS Code's default text editor.
 *
 * @param uri Optional command resource URI supplied by editor/title.
 */
async function reopenResourceWithDefaultEditor(uri: vscode.Uri | undefined): Promise<void> {
  const resourceUri = uri || getActiveCustomEditorUri();
  if (!resourceUri && !hasActiveEditorTab()) {
    await vscode.window.showWarningMessage("No SVG preview is active.");
    return;
  }

  await reopenActiveEditorWith("default", resourceUri);
}

/**
 * Reopens the active editor with a specific editor id.
 *
 * VS Code's public `vscode.openWith` command operates on one URI. In a diff
 * editor that drops the original side, so use the workbench reopen command first
 * and keep `openWith` only as a single-resource fallback.
 *
 * @param editorId Target editor id, for example `default` or the SVG preview id.
 * @param fallbackUri Optional single-resource fallback URI.
 */
async function reopenActiveEditorWith(editorId: string, fallbackUri: vscode.Uri | undefined): Promise<void> {
  try {
    await vscode.commands.executeCommand("reopenActiveEditorWith", editorId);
    return;
  } catch (error) {
    if (!fallbackUri) {
      throw error;
    }
  }

  await vscode.commands.executeCommand("vscode.openWith", fallbackUri, editorId, vscode.ViewColumn.Active);
}

/**
 * Checks whether VS Code currently has an active editor tab.
 */
function hasActiveEditorTab(): boolean {
  return Boolean(vscode.window.tabGroups.activeTabGroup.activeTab);
}

/**
 * Returns the URI from the active custom editor tab, if any.
 */
function getActiveCustomEditorUri(): vscode.Uri | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}
