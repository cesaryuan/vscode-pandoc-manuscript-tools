import * as path from "path";
import * as vscode from "vscode";

const REFRESH_DEBOUNCE_MS = 150;

/**
 * Watches one local preview source and refreshes only while its WebviewPanel is visible.
 *
 * Hidden preview tabs keep a pending refresh flag so external edits are applied
 * when the user returns to the preview without spending conversion work in the
 * background.
 */
export class VisiblePreviewFileWatcher {
  private readonly panel: vscode.WebviewPanel;
  private readonly uri: vscode.Uri;
  private readonly refresh: () => Thenable<void> | Promise<void> | void;
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingRefresh = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private runningRefresh: Promise<void> | undefined;
  private disposed = false;

  /**
   * Creates a watcher for a file-backed preview panel.
   *
   * @param panel Preview panel whose visibility gates refresh work.
   * @param uri Source image URI.
   * @param refresh Render callback for the preview.
   * @param output Output channel for refresh diagnostics.
   */
  constructor(panel: vscode.WebviewPanel, uri: vscode.Uri, refresh: () => Thenable<void> | Promise<void> | void, output: vscode.OutputChannel) {
    this.panel = panel;
    this.uri = uri;
    this.refresh = refresh;
    this.output = output;

    this.disposables.push(panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible && this.pendingRefresh) {
        this.scheduleRefresh();
      }
    }));

    if (uri.scheme === "file") {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(uri.fsPath), "*"),
      );
      const requestIfTargetChanged = (changedUri: vscode.Uri) => {
        if (isSameFileUri(changedUri, this.uri)) {
          this.requestRefresh();
        }
      };
      this.disposables.push(
        watcher,
        watcher.onDidChange(requestIfTargetChanged),
        watcher.onDidCreate(requestIfTargetChanged),
        watcher.onDidDelete(requestIfTargetChanged),
      );
    }
  }

  /**
   * Requests a refresh after a save or file-system event.
   *
   * If the panel is hidden, this intentionally defers rendering until the next
   * visible view-state event to avoid EMF/WMF conversion work in the background.
   */
  requestRefresh(): void {
    if (this.disposed) {
      return;
    }

    this.pendingRefresh = true;
    if (this.panel.visible) {
      this.scheduleRefresh();
    }
  }

  /**
   * Releases the file watcher, timers, and view-state listener.
   */
  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * Debounces bursts of file-system events into one visible refresh.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.runRefresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Runs the render callback, preserving one queued refresh if another event
   * arrives while rendering is still in progress.
   */
  private async runRefresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.panel.visible) {
      this.pendingRefresh = true;
      return;
    }
    if (this.runningRefresh) {
      this.pendingRefresh = true;
      return;
    }

    this.pendingRefresh = false;
    this.runningRefresh = Promise.resolve(this.refresh())
      .catch((error) => {
        this.output.appendLine(`Image preview auto-refresh failed for ${this.uri.fsPath}: ${formatError(error)}`);
      })
      .finally(() => {
        this.runningRefresh = undefined;
        if (!this.disposed && this.pendingRefresh && this.panel.visible) {
          this.scheduleRefresh();
        }
      });

    await this.runningRefresh;
  }
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compares two file URIs using normalized platform paths.
 *
 * @param left First URI.
 * @param right Second URI.
 */
function isSameFileUri(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.scheme !== "file" || right.scheme !== "file") {
    return left.toString() === right.toString();
  }

  const leftPath = path.normalize(left.fsPath);
  const rightPath = path.normalize(right.fsPath);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}
