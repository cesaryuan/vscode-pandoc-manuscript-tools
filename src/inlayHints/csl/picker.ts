import * as vscode from "vscode";
import type { ZoteroStyle, ZoteroStyleRepository } from "./zotero";
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

/** Connects journal searches and safe previews to the bibliography section without owning another window. */
export function attachZoteroSearch(webview: vscode.Webview, repository: ZoteroStyleRepository,
  select: (style: ZoteroStyle) => void, cancel: () => void, fail: (error: unknown) => void, lazy = false): vscode.Disposable {
  let closed = false;
  let styles: ZoteroStyle[] | undefined;
  let activeName: string | undefined;
  let previewController: AbortController | undefined;
  let previewTimer: NodeJS.Timeout | undefined;
  let query = "";
  let revision = 0;
  let ready = false;
  let loading = false;
  const subscriptions: vscode.Disposable[] = [];
  /** Releases event handlers and cancels obsolete preview work when the containing page closes. */
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (previewTimer) clearTimeout(previewTimer);
    previewController?.abort();
    for (const subscription of subscriptions) subscription.dispose();
  };
  /** Publishes bounded results after both the page and repository index are ready. */
  const publishResults = (): void => {
    if (!ready || !styles || closed) return;
    const matches = searchZoteroStyles(styles, query);
    void webview.postMessage({ type: "results", revision, count: matches.length, styles: matches.slice(0, 100).map((style) => ({
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
          void webview.postMessage({ type: "preview", name: style.name, html: renderZoteroPreview(preview) });
        }
      }).catch((error) => {
        if (!closed && !controller.signal.aborted && activeName === style.name) {
          void webview.postMessage({ type: "previewError", name: style.name, error: error instanceof Error ? error.message : String(error) });
        }
      });
    }, 180);
  };
  /** Loads styles on first bibliography visit and permits an explicit retry after a network failure. */
  const loadIndex = (): void => {
    if (loading || styles) return;
    loading = true;
    void repository.getStyles().then((loaded) => { if (!closed) { styles = loaded; publishResults(); } })
      .catch((error) => { if (!closed) fail(error); }).finally(() => { loading = false; });
  };
  subscriptions.push(webview.onDidReceiveMessage((message: unknown) => {
    if (closed || !message || typeof message !== "object") return;
    const request = message as Record<string, unknown>;
    if (request.type === "ready") {
      ready = true;
      loadIndex();
      void webview.postMessage({ type: "ready" }); publishResults();
    }
    else if (request.type === "cancel") cancel();
    else if (request.type === "search" && typeof request.query === "string" && typeof request.revision === "number") {
      query = request.query.slice(0, 500); revision = request.revision; activeName = undefined;
      if (previewTimer) clearTimeout(previewTimer);
      previewController?.abort(); loadIndex(); publishResults();
    } else if ((request.type === "preview" || request.type === "select") && typeof request.name === "string") {
      const style = styles?.find((candidate) => candidate.name === request.name);
      if (!style) return;
      if (request.type === "preview") showPreview(style);
      else select(style);
    }
  }));
  if (!lazy) loadIndex();
  return { dispose };
}
