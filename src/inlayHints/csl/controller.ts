import * as path from "node:path";
import * as vscode from "vscode";
import { findPandocManuscriptProject } from "../../papperBuildUtils";
import { applyInlayMetadataSetting } from "../actions";
import { applyCslConfiguration, getCslConfigurationContent, getCslSettingPath, isCslStyleDocument, validateCslConfiguration } from "./configuration";
import { ZoteroStyleRepository } from "./zotero";
import { pickZoteroStyle } from "./picker";
import { saveCslStyle } from "./files";

/** Connects commands and hover actions to journal search, local CSL download and the selected YAML scope. */
export class CslStyleController {
  /** Reuses the repository index across explicit searches without performing network work on hover. */
  constructor(private readonly output: vscode.OutputChannel, private readonly repository = new ZoteroStyleRepository()) {}

  /** Downloads a journal style and updates the explicit hover target or active editor's default metadata scope. */
  async setCsl(uriText?: unknown, requestedPath?: unknown): Promise<void> {
    try {
      const uri = uriText === undefined ? vscode.window.activeTextEditor?.document.uri
        : typeof uriText === "string" ? vscode.Uri.parse(uriText) : uriText instanceof vscode.Uri ? uriText : undefined;
      if (!uri) throw new Error("请先打开稿件或 style.yml，再设置参考文献样式");
      if (uri.scheme !== "file") throw new Error("参考文献样式设置仅支持本地稿件或 style.yml");
      const document = await vscode.workspace.openTextDocument(uri);
      const keys = getCslSettingPath(document, requestedPath);
      const original = getCslConfigurationContent(document);
      validateCslConfiguration(document, keys);
      const style = await pickZoteroStyle(this.repository);
      if (!style) return;
      if (original !== getCslConfigurationContent(document)) throw new Error("搜索期间参考文献样式配置已改变，请重新设置");
      // Alternate style filenames may not mark a Papper project; their paths still resolve beside the style file.
      const projectRoot = isCslStyleDocument(document) ? path.dirname(uri.fsPath) : (await findPandocManuscriptProject(uri)).rootUri.fsPath;
      const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
      this.output.appendLine(`[CSL] Downloading Zotero style: ${style.name}`);
      const xml = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `正在下载参考文献样式：${style.title}`, cancellable: true }, async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          if (token.isCancellationRequested) return undefined;
          return await this.repository.downloadStyle(style, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return undefined;
          throw error;
        } finally { cancellation.dispose(); }
      });
      if (xml === undefined) return;
      if (original !== getCslConfigurationContent(document)) throw new Error("下载期间参考文献样式配置已改变，请重新设置");
      const filename = await saveCslStyle(root, style.name, xml);
      // Papper builds run from the discovered project root; forward slashes keep the YAML path portable.
      const relativePath = path.relative(projectRoot, filename).replace(/\\/g, "/");
      this.output.appendLine(`[CSL] Saved Zotero style: ${filename}`);
      if (!isCslStyleDocument(document) && keys.length === 1 && keys[0] === "csl") {
        await applyInlayMetadataSetting(document, "csl", relativePath, original, this.output);
      } else {
        await applyCslConfiguration(document, keys, relativePath, original, this.output);
      }
    } catch (error) {
      this.output.appendLine(`[CSL] Could not set citation style: ${String(error)}`);
      void vscode.window.showErrorMessage(`设置参考文献样式失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
