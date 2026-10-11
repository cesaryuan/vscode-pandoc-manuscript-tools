import * as vscode from "vscode";
import type { ZoteroStyle, ZoteroStyleRepository } from "./zotero";

type StyleItem = vscode.QuickPickItem & { style: ZoteroStyle };
const FORMAT_LABELS: Record<string, string> = { numeric: "数字编号", "author-date": "作者年份", author: "作者", note: "脚注", label: "标签" };

/** Searches Zotero's journal names, abbreviations and style names using the editor's native searchable picker. */
export function pickZoteroStyle(repository: ZoteroStyleRepository): Promise<ZoteroStyle | undefined> {
  const picker = vscode.window.createQuickPick<StyleItem>();
  picker.title = "选择参考文献 CSL（Zotero）";
  picker.placeholder = "输入期刊名称或缩写搜索，例如 Nature、PLOS ONE";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = true;
  picker.busy = true;
  return new Promise((resolve, reject) => {
    let closed = false;
    const subscriptions: vscode.Disposable[] = [];
    /** Settles once and releases the picker even if loading finishes after cancellation. */
    const finish = (style?: ZoteroStyle, error?: unknown): void => {
      if (closed) return;
      closed = true;
      for (const subscription of subscriptions) subscription.dispose();
      picker.hide();
      picker.dispose();
      if (error) reject(error);
      else resolve(style);
    };
    subscriptions.push(picker.onDidHide(() => finish()));
    subscriptions.push(picker.onDidAccept(() => {
      const selected = picker.selectedItems[0] ?? picker.activeItems[0];
      if (!picker.busy && selected) finish(selected.style);
    }));
    picker.show();
    void repository.getStyles().then((styles) => {
      if (closed) return;
      picker.items = styles.map((style) => ({ label: style.title,
        description: [style.titleShort, FORMAT_LABELS[style.format] ?? style.format].filter(Boolean).join(" · "),
        detail: style.name, style }));
      picker.busy = false;
    }).catch((error) => finish(undefined, error));
  });
}
