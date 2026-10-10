import * as vscode from "vscode";
import { EXTENSION_NAME, PANDOC_SELECTOR, IMAGE_PREVIEW_SELECTOR, MATH_HOVER_SELECTOR, BUILD_DOCX_COMMAND, BUILD_HTML_COMMAND, INSTALL_OR_UPDATE_PAPPER_COMMAND, OPEN_IMAGE_PREVIEW_COMMAND, OPEN_IMAGE_DIRECTORY_PREVIEW_COMMAND, OPEN_SVG_PREVIEW_COMMAND, OPEN_SVG_SOURCE_TEXT_COMMAND, METAFILE_PREVIEW_EDITOR_VIEW_TYPE, SVG_PREVIEW_EDITOR_VIEW_TYPE } from "./constants";
import { PandocWorkspaceIndex } from "./workspaceIndex";
import { PandocBuildRunner } from "./docxBuild";
import { PapperMarkdownPreviewController } from "./papperMarkdownPreview/controller";
import { FencedDivHighlighter } from "./fencedDivHighlighter";
import { InlineFoldController } from "./inlineFoldController";
import { MathJaxRenderer } from "./mathJaxRenderer";
import { ParagraphTranslator } from "./paragraphTranslator";
import { CommentHoverProvider } from "./commentTranslation/commentHoverProvider";
import { ImagePreviewRenderer } from "./imagePreview";
import { ImagePreviewSidePanel } from "./imagePreview/sidePreview";
import { ImageDirectoryPreview } from "./imageDirectoryPreview";
import { MetafilePreviewCustomEditorProvider } from "./imagePreview/customEditor";
import { getConfiguration } from "./configuration";
import { isBuildableMarkdownDocument, isPandocDocument } from "./vscodeUtils";
import { PandocDefinitionProvider, PandocReferenceProvider, PandocHoverProvider, ImagePreviewHoverProvider, PandocDocumentSymbolProvider, PandocFoldingRangeProvider, PandocCompletionProvider, updateDiagnosticsForOpenDocuments, updateDiagnostics } from "./providers";
import { CustomImagePreviewContext } from "./customImagePreviewContext";
import { NumberingInlayHints } from "./numberingInlayHints";
import { PapperUpdateChecker } from "./papperUpdateChecker";
import { installOrUpdatePapper } from "./papperBuildUtils";
import { STYLE_CONFIGURATION_SELECTOR, StyleConfigurationCompletionProvider, StyleConfigurationCodeLensProvider, isStyleConfigurationDocument, mergeStyleExampleIntoEditor } from "./styleConfiguration";

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
  const commentHoverProvider = new CommentHoverProvider(paragraphTranslator, output);
  const imagePreviewRenderer = new ImagePreviewRenderer(output);
  const imagePreviewSidePanel = new ImagePreviewSidePanel(imagePreviewRenderer, output);
  const imageDirectoryPreview = new ImageDirectoryPreview(context.extensionUri, output);
  const metafilePreviewEditorProvider = new MetafilePreviewCustomEditorProvider(imagePreviewRenderer, output);
  const buildRunner = new PandocBuildRunner(output);
  const markdownPreview = new PapperMarkdownPreviewController(output);
  const numberingInlayHints = new NumberingInlayHints(buildRunner, output);
  const papperUpdateChecker = new PapperUpdateChecker(context.globalState);
  let papperMaintenanceRunning = false;
  const fencedDivHighlighter = new FencedDivHighlighter(index, output);
  const inlineFoldController = new InlineFoldController(index, output);
  const customImagePreviewContext = new CustomImagePreviewContext((key, value) => {
    // Releases containing upstream PR #327736 use this key to suppress the duplicate SVG action.
    void vscode.commands.executeCommand("setContext", key, value).then(undefined, (error) => {
      output.appendLine(`Could not update the custom image preview context: ${String(error)}`);
    });
  });

  output.appendLine("Activated Papper Tools.");
  customImagePreviewContext.enable();
  if (getConfiguration().get("enableParagraphHoverTranslation", false)) {
    void paragraphTranslator.initialize();
  }

  context.subscriptions.push(output, diagnostics, customImagePreviewContext, metafilePreviewEditorProvider, commentHoverProvider);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(PANDOC_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(PANDOC_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(IMAGE_PREVIEW_SELECTOR, new ImagePreviewHoverProvider(imagePreviewRenderer, output)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MATH_HOVER_SELECTOR, new PandocHoverProvider(index, mathRenderer, paragraphTranslator, output)));
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: "*" }, commentHoverProvider));
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
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(PANDOC_SELECTOR, new PandocFoldingRangeProvider(index)));
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(PANDOC_SELECTOR, numberingInlayHints));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(PANDOC_SELECTOR, new PandocCompletionProvider(index), "@", ":"));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(STYLE_CONFIGURATION_SELECTOR, new StyleConfigurationCompletionProvider(), ":", " ", "{", ","));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(STYLE_CONFIGURATION_SELECTOR, new StyleConfigurationCodeLensProvider()));
  context.subscriptions.push({ dispose: () => mathRenderer.dispose() });
  context.subscriptions.push({ dispose: () => imagePreviewRenderer.dispose() });
  context.subscriptions.push({ dispose: () => imagePreviewSidePanel.dispose() });
  context.subscriptions.push({ dispose: () => imageDirectoryPreview.dispose() });
  context.subscriptions.push({ dispose: () => markdownPreview.dispose() });
  context.subscriptions.push({ dispose: () => fencedDivHighlighter.dispose() });
  context.subscriptions.push({ dispose: () => inlineFoldController.dispose() });
  context.subscriptions.push(numberingInlayHints);
  context.subscriptions.push(papperUpdateChecker);
  papperUpdateChecker.start();

  context.subscriptions.push(vscode.commands.registerCommand("pandocManuscriptTools.rebuildIndex", async () => {
    await index.refreshWorkspace();
    updateDiagnosticsForOpenDocuments(index, diagnostics);
    vscode.window.showInformationMessage("Papper Tools index rebuilt.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand(BUILD_DOCX_COMMAND, async (uri: vscode.Uri | undefined) => {
    await buildRunner.buildActiveMarkdownDocx(uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand(BUILD_HTML_COMMAND, async (uri: vscode.Uri | undefined) => {
    await markdownPreview.buildActiveMarkdownHtml(uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("pandocManuscriptTools.mergeStyleExample",
    /** Applies the example to the CodeLens resource, including inactive editor groups. */
    async (uri: vscode.Uri | undefined) => {
      try {
        const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
        if (!document || !isStyleConfigurationDocument(document)) {
          void vscode.window.showWarningMessage("请先打开 style.yml 或 style.yaml 配置文件");
          return;
        }
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const examplePath = vscode.Uri.joinPath(context.extensionUri, "assets", "style-project.yml").fsPath;
        await mergeStyleExampleIntoEditor(editor, examplePath, output);
      } catch (error) {
        output.appendLine(`Could not merge the style example: ${String(error)}`);
        void vscode.window.showErrorMessage(`合并示例配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  /** Installs or updates Papper and refreshes features without reopening the Markdown editor. */
  context.subscriptions.push(vscode.commands.registerCommand(INSTALL_OR_UPDATE_PAPPER_COMMAND, async () => {
    output.show(true);
    if (papperMaintenanceRunning) {
      void vscode.window.showInformationMessage("Papper 正在安装或更新，请稍候");
      return;
    }
    papperMaintenanceRunning = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在安装或更新 Papper" },
        /** Streams uv progress to the shared extension output channel. */
        async () => {
          await installOrUpdatePapper(output);
        },
      );
      await markdownPreview.refreshContext();
      numberingInlayHints.refreshOpenDocuments();
      void vscode.window.showInformationMessage("Papper 已安装或更新。");
    } catch (error) {
      output.appendLine(`[Papper] Installation or update failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Papper 安装或更新失败: ${String(error)}`);
    } finally {
      papperMaintenanceRunning = false;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand(OPEN_IMAGE_PREVIEW_COMMAND, async (uri) => {
    await imagePreviewSidePanel.open(uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_IMAGE_DIRECTORY_PREVIEW_COMMAND, async (uri) => {
    await imageDirectoryPreview.open(uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_SVG_PREVIEW_COMMAND, async (uri) => {
    metafilePreviewEditorProvider.beginSvgDiffPreview(vscode.window.tabGroups.activeTabGroup.activeTab);
    try {
      await reopenResourceWithSvgPreview(uri);
    } finally {
      metafilePreviewEditorProvider.endSvgDiffPreview();
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_SVG_SOURCE_TEXT_COMMAND, async (uri) => {
    await reopenResourceWithDefaultEditor(uri);
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void markdownPreview.refreshContext();
    fencedDivHighlighter.updateVisibleEditors();
    inlineFoldController.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    // Output channels and preview documents also emit visible-range events;
    // only a saved Markdown source can drive Papper HTML scroll sync.
    if (isBuildableMarkdownDocument(event.textEditor.document)) {
      markdownPreview.handleEditorVisibleRangesChange(event.textEditor);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    fencedDivHighlighter.updateVisibleEditors();
    inlineFoldController.updateVisibleEditors();
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (isBuildableMarkdownDocument(event.textEditor.document)) {
      markdownPreview.handleEditorSelectionChange(event);
    }
    inlineFoldController.updateEditor(event.textEditor);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void markdownPreview.refreshContext();
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
    if (event.affectsConfiguration("pandocManuscriptTools.enableNumberInlayHints")) {
      numberingInlayHints.refreshOpenDocuments();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
    if (isPandocDocument(document)) {
      await index.prepareDocument(document);
      updateDiagnostics(document, index, diagnostics);
      numberingInlayHints.scheduleRefresh(document);
      void markdownPreview.refreshContext();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isPandocDocument(event.document)) {
      index.updateDocument(event.document);
      numberingInlayHints.scheduleRefresh(event.document);
      if (index.isDefinitionSourceForOpenReviewerReply(event.document)) {
        updateDiagnosticsForOpenDocuments(index, diagnostics);
      } else {
        updateDiagnostics(event.document, index, diagnostics);
      }
      fencedDivHighlighter.updateVisibleEditors(event.document);
      inlineFoldController.updateVisibleEditors(event.document);
      // Dirty-state/save notifications contain no edits and must not suppress scrolling.
      if (event.contentChanges.length) {
        markdownPreview.scheduleHtmlPreviewRefresh(event.document);
      }
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (isPandocDocument(document)) {
      index.updateDocument(document);
      numberingInlayHints.scheduleRefresh(document, 0);
      await index.refreshWorkspace();
      updateDiagnosticsForOpenDocuments(index, diagnostics);
    }
    await imagePreviewSidePanel.refreshIfOpen(document);
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    numberingInlayHints.closeDocument(document);
  }));

  // Closed manuscript files can change or disappear outside the editor. Refresh
  // dependent reviewer diagnostics without waiting for another document save.
  const manuscriptWatcher = vscode.workspace.createFileSystemWatcher("**/manuscript.md");
  let manuscriptRefreshRunning = false;
  let manuscriptRefreshPending = false;
  /** Reloads reviewer definition sources after external manuscript file events. */
  const refreshManuscriptDefinitions = async () => {
    manuscriptRefreshPending = true;
    if (manuscriptRefreshRunning) return;
    manuscriptRefreshRunning = true;
    try {
      // Atomic saves emit bursts; serialize reads so an older snapshot cannot win last.
      while (manuscriptRefreshPending) {
        manuscriptRefreshPending = false;
        await index.refreshWorkspace();
      }
      updateDiagnosticsForOpenDocuments(index, diagnostics);
    } catch (error) {
      output.appendLine(`Could not refresh manuscript definitions: ${String(error)}`);
    } finally {
      manuscriptRefreshRunning = false;
    }
  };
  context.subscriptions.push(manuscriptWatcher,
    manuscriptWatcher.onDidCreate(refreshManuscriptDefinitions),
    manuscriptWatcher.onDidChange(refreshManuscriptDefinitions),
    manuscriptWatcher.onDidDelete(refreshManuscriptDefinitions));

  void index.refreshWorkspace().then(() => updateDiagnosticsForOpenDocuments(index, diagnostics));
  for (const document of vscode.workspace.textDocuments) {
    numberingInlayHints.scheduleRefresh(document);
  }
  void markdownPreview.refreshContext();
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
