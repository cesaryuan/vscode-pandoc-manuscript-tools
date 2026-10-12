import * as vscode from "vscode";
import type { ZoteroStyle, ZoteroStyleRepository } from "./zotero";
import { buildCslPickerHtml } from "./pickerHtml";
import { renderZoteroPreview } from "./previewHtml";

const FORMAT_LABELS: Record<string, string> = { numeric: "数字编号", "author-date": "作者年份", author: "作者", note: "脚注", label: "标签" };

/** Searches Zotero names and abbreviations, ranking exact and title-prefix matches ahead of other results. */
export function searchZoteroStyles(styles: ZoteroStyle[], query: string): ZoteroStyle[] {
  const normalized = query.trim().toLocaleLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  /** Scores the most useful match without changing the repository's shared index. */
  const score = (style: ZoteroStyle): number => {
    const title = style.title.toLocaleLowerCase();
    return [title, style.name, style.titleShort?.toLocaleLowerCase()].includes(normalized) ? 0 : title.startsWith(normalized) ? 1 : 2;
  };
  return styles.filter((style) => {
    const searchable = `${style.title} ${style.titleShort ?? ""} ${style.name}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  }).sort((left, right) => score(left) - score(right) || left.title.localeCompare(right.title));
}

/** Shows searchable journal results and rich previews in one page; explicit confirmation alone chooses a style. */
export function pickZoteroStyle(repository: ZoteroStyleRepository): Promise<ZoteroStyle | undefined> {
  const panel = vscode.window.createWebviewPanel("pandocManuscriptTools.cslPicker", "设置参考文献样式", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  return new Promise((resolve, reject) => {
    let closed = false;
    let styles: ZoteroStyle[] | undefined;
    let activeName: string | undefined;
    let previewController: AbortController | undefined;
    let previewTimer: NodeJS.Timeout | undefined;
    let query = "";
    let revision = 0;
    let ready = false;
    const subscriptions: vscode.Disposable[] = [];
    /** Releases the page and cancels preview work once the user accepts or closes it. */
    const finish = (style?: ZoteroStyle, error?: unknown): void => {
      if (closed) return;
      closed = true;
      if (previewTimer) clearTimeout(previewTimer);
      previewController?.abort();
      for (const subscription of subscriptions) subscription.dispose();
      panel.dispose();
      if (error) reject(error);
      else resolve(style);
    };
    /** Publishes bounded results after both the page and repository index are ready. */
    const publishResults = (): void => {
      if (!ready || !styles || closed) return;
      const matches = searchZoteroStyles(styles, query);
      void panel.webview.postMessage({ type: "results", revision, count: matches.length, styles: matches.slice(0, 100).map((style) => ({
        name: style.name, title: style.title, description: [style.titleShort, FORMAT_LABELS[style.format] ?? style.format].filter(Boolean).join(" · "),
      })) });
    };
    /** Loads only the current preview and prevents slower previous requests from replacing it. */
    const showPreview = (style: ZoteroStyle): void => {
      activeName = style.name;
      if (previewTimer) clearTimeout(previewTimer);
      previewController?.abort();
      const controller = new AbortController();
      previewController = controller;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        void repository.getPreview(style, controller.signal).then((preview) => {
          if (!closed && !controller.signal.aborted && activeName === style.name) {
            void panel.webview.postMessage({ type: "preview", name: style.name, html: renderZoteroPreview(preview) });
          }
        }).catch((error) => {
          if (!closed && !controller.signal.aborted && activeName === style.name) {
            void panel.webview.postMessage({ type: "previewError", name: style.name, error: error instanceof Error ? error.message : String(error) });
          }
        });
      }, 180);
    };
    subscriptions.push(panel.onDidDispose(() => finish()));
    subscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (closed || !message || typeof message !== "object") return;
      const request = message as Record<string, unknown>;
      if (request.type === "ready") { ready = true; void panel.webview.postMessage({ type: "ready" }); publishResults(); }
      else if (request.type === "cancel") finish();
      else if (request.type === "search" && typeof request.query === "string" && typeof request.revision === "number") {
        query = request.query.slice(0, 500); revision = request.revision; activeName = undefined;
        if (previewTimer) clearTimeout(previewTimer);
        previewController?.abort(); publishResults();
      } else if ((request.type === "preview" || request.type === "select") && typeof request.name === "string") {
        const style = styles?.find((candidate) => candidate.name === request.name);
        if (!style) return;
        if (request.type === "preview") showPreview(style);
        else finish(style);
      }
    }));
    panel.webview.html = buildCslPickerHtml();
    void repository.getStyles().then((loaded) => { if (!closed) { styles = loaded; publishResults(); } }).catch((error) => finish(undefined, error));
  });
}
