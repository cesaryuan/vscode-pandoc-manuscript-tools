import * as vscode from "vscode";
import { checkForPapperUpdate, upgradePapper } from "./papperBuildUtils";

const INITIAL_CHECK_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const LAST_UPDATE_CHECK_KEY = "papper.lastUpdateCheckAt";

/** Periodically checks for Papper updates and asks before upgrading. */
export class PapperUpdateChecker {
  private initialCheckTimer: NodeJS.Timeout | undefined;
  private updateCheckTimer: NodeJS.Timeout | undefined;
  private checkRunning = false;
  private promptRunning = false;

  /** Creates a checker that persists the last check across VS Code sessions. */
  constructor(private readonly state: vscode.Memento) {}

  /** Starts the delayed initial check and recurring checks every three hours. */
  start() {
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = undefined;
      void this.check();
    }, INITIAL_CHECK_DELAY_MS);
    this.updateCheckTimer = setInterval(() => {
      void this.check();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  /** Stops future checks when the extension is deactivated. */
  dispose() {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = undefined;
    }
    if (this.updateCheckTimer) {
      clearInterval(this.updateCheckTimer);
      this.updateCheckTimer = undefined;
    }
  }

  /** Checks uv's tool receipt and asks the user before running an upgrade. */
  private async check() {
    if (this.checkRunning || this.promptRunning) {
      return;
    }
    const now = Date.now();
    if (now - this.state.get<number>(LAST_UPDATE_CHECK_KEY, 0) < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }
    this.checkRunning = true;
    try {
      // Record an attempt before networking so transient failures do not prompt on every restart.
      await this.state.update(LAST_UPDATE_CHECK_KEY, now);
      const update = await checkForPapperUpdate();
      if (!update) {
        return;
      }

      this.promptRunning = true;
      const action = await vscode.window.showInformationMessage(
        `Papper 有可用更新（${update.summary}），是否现在更新？`,
        "更新",
        "稍后",
      );
      if (action !== "更新") {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在更新 Papper" },
        async () => upgradePapper(),
      );
      void vscode.window.showInformationMessage("Papper 已更新。");
    } catch (error) {
      const message = `Papper 更新失败: ${String(error)}`;
      void vscode.window.showErrorMessage(message);
    } finally {
      this.promptRunning = false;
      this.checkRunning = false;
    }
  }
}
