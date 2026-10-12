import * as path from "node:path";
import * as vscode from "vscode";
import { findPandocManuscriptProject } from "../../papperBuildUtils";
import { applyInlayMetadataSetting } from "../actions";
import { applyCslConfiguration, getCslConfigurationContent, getCslSettingPath, isCslStyleDocument, validateCslConfiguration } from "./configuration";
import { ZoteroStyleRepository, type ZoteroStyle } from "./zotero";
import { saveCslStyle } from "./files";

/** Downloads and applies explicit choices from the unified settings page to the selected YAML scope. */
export class CslStyleController {
  /** Reuses the repository index across explicit searches without performing network work on hover. */
  constructor(private readonly output: vscode.OutputChannel, readonly repository = new ZoteroStyleRepository()) {}

  /** Downloads an explicitly chosen style for a settings page without creating a second search window. */
  async applyStyle(document: vscode.TextDocument, keys: string[], style: ZoteroStyle, original: string | undefined, signal?: AbortSignal): Promise<boolean> {
    const uri = document.uri;
    getCslSettingPath(document, keys);
    validateCslConfiguration(document, keys);
    if (signal?.aborted) return false;
    if (original !== getCslConfigurationContent(document)) throw new Error("搜索期间参考文献样式配置已改变，请重新设置");
    // Alternate style filenames may not mark a Papper project; their paths still resolve beside the style file.
    const projectRoot = isCslStyleDocument(document) ? path.dirname(uri.fsPath) : (await findPandocManuscriptProject(uri)).rootUri.fsPath;
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
    this.output.appendLine(`[CSL] Downloading Zotero style: ${style.name}`);
    const xml = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `正在下载参考文献样式：${style.title}`, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      /** Stops downloads when the containing settings window closes. */
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (token.isCancellationRequested || signal?.aborted) return undefined;
        return await this.repository.downloadStyle(style, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        throw error;
      } finally { cancellation.dispose(); signal?.removeEventListener("abort", abort); }
    });
    if (xml === undefined) return false;
    if (signal?.aborted) return false;
    if (original !== getCslConfigurationContent(document)) throw new Error("下载期间参考文献样式配置已改变，请重新设置");
    const filename = await saveCslStyle(root, style.name, xml);
    if (signal?.aborted) return false;
    // Papper builds run from the discovered project root; forward slashes keep the YAML path portable.
    const relativePath = path.relative(projectRoot, filename).replace(/\\/g, "/");
    this.output.appendLine(`[CSL] Saved Zotero style: ${filename}`);
    if (!isCslStyleDocument(document) && keys.length === 1 && keys[0] === "csl") {
      await applyInlayMetadataSetting(document, "csl", relativePath, original, this.output);
    } else {
      await applyCslConfiguration(document, keys, relativePath, original, this.output);
    }
    return true;
  }
}
