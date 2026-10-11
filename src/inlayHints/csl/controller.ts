import * as path from "node:path";
import * as vscode from "vscode";
import { getYamlHeader } from "../../manuscriptStyle/document";
import { findPandocManuscriptProject } from "../../papperBuildUtils";
import { applyInlayMetadataSetting } from "../actions";
import { getManuscriptMetadataValue } from "../settings";
import { ZoteroStyleRepository } from "./zotero";
import { pickZoteroStyle } from "./picker";
import { saveCslStyle } from "./files";

/** Connects bibliography-hint actions to journal search, local CSL download and manuscript configuration. */
export class CslStyleController {
  /** Reuses the repository index across explicit searches without performing network work on hover. */
  constructor(private readonly output: vscode.OutputChannel, private readonly repository = new ZoteroStyleRepository()) {}

  /** Downloads the chosen journal style into the source's workspace, then sets and reveals the manuscript CSL path. */
  async setCsl(uriText: unknown): Promise<void> {
    try {
      if (typeof uriText !== "string") throw new Error("无效的 CSL 设置请求");
      const uri = vscode.Uri.parse(uriText);
      if (uri.scheme !== "file") throw new Error("CSL 设置仅支持本地 Markdown 文档");
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== "markdown") throw new Error("请在 Markdown 文档中设置 CSL");
      const originalHeader = getYamlHeader(document.getText())?.content;
      getManuscriptMetadataValue(document.getText(), "csl");
      const style = await pickZoteroStyle(this.repository);
      if (!style) return;
      if (originalHeader !== getYamlHeader(document.getText())?.content) throw new Error("搜索期间 YAML header 已改变，请重新点击按钮");
      const project = await findPandocManuscriptProject(uri);
      const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
      this.output.appendLine(`[CSL] Downloading Zotero style: ${style.name}`);
      const xml = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `正在下载 CSL：${style.title}`, cancellable: true }, async (_progress, token) => {
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
      if (originalHeader !== getYamlHeader(document.getText())?.content) throw new Error("下载期间 YAML header 已改变，请重新点击按钮");
      const filename = await saveCslStyle(root, style.name, xml);
      // Papper builds run from the discovered project root; forward slashes keep the YAML path portable.
      const relativePath = path.relative(project.rootUri.fsPath, filename).replace(/\\/g, "/");
      this.output.appendLine(`[CSL] Saved Zotero style: ${filename}`);
      await applyInlayMetadataSetting(document, "csl", relativePath, originalHeader, this.output);
    } catch (error) {
      this.output.appendLine(`[CSL] Could not set citation style: ${String(error)}`);
      void vscode.window.showErrorMessage(`设置参考文献 CSL 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
