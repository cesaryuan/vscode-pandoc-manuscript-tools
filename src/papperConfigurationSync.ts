/** Loads the installed Papper's editor contract once per executable change, with bounded failures. */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { findExistingPapperExecutable } from "./papperBuildUtils";
import { applyConfigurationContract } from "./configurationContract";

const executeFile = promisify(execFile);

/** Keeps exports deduplicated and cached while the executable remains unchanged. */
export class PapperConfigurationSync {
  private fingerprint: string | undefined;
  private pending: Promise<void> | undefined;
  private nextCheck = 0;

  /** Uses the shared log for export failures without interrupting normal editing. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Shares concurrent refreshes and retries after an explicit upgrade or executable change. */
  ensure(force = false): Promise<void> {
    if (this.pending) return force ? this.pending.then(() => this.ensure(true)) : this.pending;
    if (!force && Date.now() < this.nextCheck) return Promise.resolve();
    this.nextCheck = Date.now() + 5000;
    this.pending = this.refresh(force).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Reads only machine output; older versions, timeouts and malformed exports retain working data. */
  private async refresh(force: boolean): Promise<void> {
    try {
      const executable = await findExistingPapperExecutable();
      if (!executable) return;
      const stat = await fs.stat(executable);
      const fingerprint = `${executable}:${stat.size}:${stat.mtimeMs}`;
      if (!force && fingerprint === this.fingerprint) return;
      this.fingerprint = fingerprint;
      const { stdout } = await executeFile(executable, ["config", "describe", "--format", "json"], {
        windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PAPPER_DISABLE_UPDATE_CHECK: "1" },
      });
      applyConfigurationContract(JSON.parse(stdout));
      this.output.appendLine(`[Configuration] Loaded editor definitions from ${executable}`);
    } catch (error) {
      // Cache failures too: unsupported old CLI versions must not be invoked on every keystroke.
      this.output.appendLine(`[Configuration] Keeping available editor definitions: ${String(error).slice(0, 1000)}`);
    }
  }
}
