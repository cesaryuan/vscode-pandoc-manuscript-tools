import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument, isScalar } from "yaml";
import { findPandocManuscriptProject } from "../papperBuildUtils";
import { CslStyleController } from "../inlayHints/csl/controller";
import { getCslConfigurationContent, getCslSettingPath, isCslStyleDocument } from "../inlayHints/csl/configuration";
import { attachZoteroSearch } from "../inlayHints/csl/picker";
import { buildPapperSettingsHtml } from "./html";
import { createSettingsEdit, getSettingsRows, getSettingsStyleNames, SETTINGS_SECTIONS, type SettingsSection, type SettingsScope } from "./model";

export const OPEN_PAPPER_SETTINGS_COMMAND = "pandocManuscriptTools.openSettings";

/** Owns one reusable settings window per source, preserving the source binding when other editors gain focus. */
export class PapperSettingsController implements vscode.Disposable {
  private readonly sessions = new Map<string, SettingsSession>();
  private lastSource?: string;

  /** Shares downloaded styles and preview caches across all settings windows. */
  constructor(private readonly output: vscode.OutputChannel, private readonly csl: CslStyleController,
    private readonly ensureConfiguration: () => Promise<void> = async () => {}) {}

  /** Opens the unified page and optionally navigates directly to a setting section or a hovered CSL scope. */
  async open(uriText?: unknown, section: SettingsSection = "math", cslPath?: unknown): Promise<void> {
    try {
      const uri = uriText === undefined ? vscode.window.activeTextEditor?.document.uri ?? (this.lastSource ? vscode.Uri.parse(this.lastSource) : undefined)
        : typeof uriText === "string" ? vscode.Uri.parse(uriText) : uriText instanceof vscode.Uri ? uriText : undefined;
      if (!uri || uri.scheme !== "file") throw new Error("请先打开本地稿件或 style.yml，再打开 Papper 设置");
      const document = await vscode.workspace.openTextDocument(uri);
      getCslSettingPath(document);
      const key = uri.toString();
      let session = this.sessions.get(key);
      if (!session) {
        session = new SettingsSession(document, this.output, this.csl, () => this.sessions.delete(key), this.ensureConfiguration);
        this.sessions.set(key, session);
      }
      this.lastSource = key;
      await session.navigate(section, cslPath);
    } catch (error) {
      this.output.appendLine(`[Settings] Could not open settings: ${String(error)}`);
      void vscode.window.showErrorMessage(`打开 Papper 设置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Releases panels and source-change subscriptions when the extension deactivates. */
  dispose(): void { for (const session of this.sessions.values()) session.dispose(); this.sessions.clear(); }
}

/** Coordinates source edits, section navigation and Zotero previews inside one persistent settings window. */
class SettingsSession implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private section: SettingsSection = "math";
  private scope: SettingsScope = "main";
  private styleName = "Body Text";
  private cslPath?: string[];
  private ready = false;
  private closed = false;
  private busy = false;
  private refreshing = 0;
  private inherited = "";
  private displayedContent?: string;
  private downloadController?: AbortController;

  /** Installs the host bridge before rendering HTML so its first ready message cannot be lost. */
  constructor(private readonly document: vscode.TextDocument, private readonly output: vscode.OutputChannel,
    private readonly csl: CslStyleController, private readonly onClose: () => void,
    private readonly ensureConfiguration: () => Promise<void> = async () => {}) {
    this.panel = vscode.window.createWebviewPanel("pandocManuscriptTools.settings", "Papper 设置", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    this.subscriptions.push(this.panel.onDidDispose(() => this.dispose()));
    this.subscriptions.push(attachZoteroSearch(this.panel.webview, csl.repository,
      (style) => {
        if (this.busy) return;
        this.busy = true;
        this.downloadController = new AbortController();
        const keys = this.cslPath ?? getCslSettingPath(this.document);
        const snapshot = this.displayedContent;
        void this.panel.webview.postMessage({ type: "cslBusy", busy: true });
        void this.csl.applyStyle(this.document, keys, style, snapshot, this.downloadController.signal).then(async (applied) => {
          if (this.closed) return;
          this.panel.reveal();
          if (applied) void this.panel.webview.postMessage({ type: "settingsSaved", path: keys });
          await this.refresh();
        }).catch((error) => this.error(error)).finally(() => {
          this.busy = false;
          if (!this.closed) void this.panel.webview.postMessage({ type: "cslBusy", busy: false });
        });
      }, () => { void this.navigate("math"); }, (error) => {
        this.output.appendLine(`[Settings] Zotero search failed: ${String(error)}`);
        void this.panel.webview.postMessage({ type: "indexError", error: error instanceof Error ? error.message : String(error) });
      }, true));
    this.subscriptions.push(this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message).catch((error) => this.error(error)); }));
    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString() && !this.closed && !this.busy
      ) {
        try { if (getCslConfigurationContent(document) === this.displayedContent) return; } catch { /* An unfinished header still needs a refresh notice. */ }
        void this.panel.webview.postMessage({ type: "sourceChanged" });
      }
    }));
    this.panel.webview.html = buildPapperSettingsHtml();
  }

  /** Navigates existing windows without creating a dedicated CSL picker, retaining the hover's exact metadata scope. */
  async navigate(section: SettingsSection, requested?: unknown): Promise<void> {
    this.section = section;
    if (section === "bibliography" && requested === undefined) { this.cslPath = undefined; this.scope = "main"; }
    if (requested !== undefined) {
      this.cslPath = getCslSettingPath(this.document, requested);
      this.scope = this.cslPath.some((key) => key.toLowerCase() === "reply") ? "reply" : "main";
    }
    this.panel.reveal();
    if (this.ready) await this.refresh();
  }

  /** Renders configuration values after an explicit refresh, navigation or successful application. */
  private async refresh(): Promise<void> {
    const revision = ++this.refreshing;
    await this.ensureConfiguration();
    if (this.closed || revision !== this.refreshing) return;
    const style = isCslStyleDocument(this.document);
    if (!style) {
      const project = await findPandocManuscriptProject(this.document.uri);
      try {
        const styleDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(project.rootUri.fsPath, "style.yml")));
        this.inherited = styleDocument.getText();
      } catch { this.inherited = ""; } // Standalone manuscripts intentionally work without a project style file.
    }
    if (this.closed || revision !== this.refreshing) return;
    const rows = getSettingsRows(this.document.getText(), style, this.scope, this.section, this.styleName, this.inherited);
    if (this.section === "bibliography") {
      const row = rows.find((item) => item.title === "csl");
      this.cslPath ??= getCslSettingPath(this.document, row.path);
      const yaml = parseDocument(getCslConfigurationContent(this.document) ?? "");
      const value = yaml.getIn(this.cslPath, true);
      row.path = this.cslPath;
      row.configured = value !== undefined;
      row.value = isScalar(value) ? String(value.value ?? "") : "";
    }
    this.displayedContent = getCslConfigurationContent(this.document);
    void this.panel.webview.postMessage({ type: "settingsState", uri: this.document.uri.toString(), section: this.section,
      scope: this.scope, styleName: this.styleName, styleNames: getSettingsStyleNames(this.document.getText(), style, this.scope, this.inherited),
      title: SETTINGS_SECTIONS.find((section) => section.id === this.section).title,
      sourceLabel: `${style ? "项目设置" : "稿件设置"} · ${this.document.uri.fsPath}`, content: this.displayedContent, rows });
  }

  /** Handles validated settings operations; external YAML changes require refresh instead of being overwritten. */
  private async receive(message: unknown): Promise<void> {
    if (this.closed || !message || typeof message !== "object") return;
    const request = message as Record<string, unknown>;
    if (request.type === "settingsReady") { this.ready = true; await this.refresh(); }
    else if (request.type === "settingsView") {
      if (!SETTINGS_SECTIONS.some((section) => section.id === request.section) || !["main", "reply"].includes(String(request.scope))) return;
      if (this.scope !== request.scope) this.cslPath = undefined;
      this.scope = request.scope as SettingsScope;
      this.section = request.section as SettingsSection;
      if (typeof request.styleName === "string" && request.styleName.trim() && request.styleName.length <= 200) this.styleName = request.styleName.trim();
      await this.refresh();
    } else if (request.type === "settingsSource") await vscode.window.showTextDocument(this.document, { preview: false });
    else if (request.type === "settingsSave") {
      if (this.busy) throw new Error("正在应用设置，请稍后再试");
      if (typeof request.input !== "string" || !Array.isArray(request.path)) throw new Error("无效的设置请求");
      if (request.original !== getCslConfigurationContent(this.document)) throw new Error("源配置已改变，请先刷新后再应用");
      this.busy = true;
      try {
        const edit = createSettingsEdit(this.document.getText(), isCslStyleDocument(this.document), request.path as string[], request.input, request.reset === true);
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(this.document.uri, new vscode.Range(this.document.positionAt(edit.start), this.document.positionAt(edit.end)), edit.text);
        if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error("VS Code 拒绝了配置编辑");
        this.output.appendLine(`[Settings] ${request.reset ? "Reset" : "Updated"} ${(request.path as string[]).join(".")} in ${this.document.uri.fsPath}`);
        void this.panel.webview.postMessage({ type: "settingsSaved", path: request.path });
        await this.refresh();
      } finally { this.busy = false; }
    }
  }

  /** Reports recoverable source or network errors inline so the rest of the settings page stays usable. */
  private error(error: unknown): void {
    this.output.appendLine(`[Settings] Could not apply settings: ${String(error)}`);
    if (!this.closed) void this.panel.webview.postMessage({ type: "settingsError", error: error instanceof Error ? error.message : String(error) });
  }

  /** Cancels page work and detaches all listeners exactly once. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.downloadController?.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
    this.onClose();
  }
}
