import * as vscode from "vscode";
import { getConfiguration } from "./configuration";
import { collectPandocCrossReferenceNumbers, type CrossReferenceNumber } from "./pandocNumbering";
import { PandocBuildRunner } from "./docxBuild";
import { isBuildableMarkdownDocument, isPandocDocument } from "./vscodeUtils";
import { parsePandocDocument } from "./parser";

type CachedNumberingHints = { version: number; hints: vscode.InlayHint[] };
type RefreshState = { document: vscode.TextDocument; timer?: NodeJS.Timeout; running: boolean; rerun: boolean };

/**
 * Builds PMT's processed AST after edits and exposes its actual cross-reference numbers as inlay hints.
 *
 * The provider only returns hints for the editor version used to produce the AST, so stale numbering is
 * hidden while a new JSON build is pending.
 */
export class NumberingInlayHints implements vscode.InlayHintsProvider, vscode.Disposable {
  private readonly buildRunner: PandocBuildRunner;
  private readonly output: vscode.OutputChannel;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly cache = new Map<string, CachedNumberingHints>();
  private readonly refreshStates = new Map<string, RefreshState>();

  /**
   * Creates the Papper-backed inlay hint provider.
   *
   * @param buildRunner Existing Papper build runner used for temporary JSON AST builds.
   * @param output Extension output channel for failed background builds.
   */
  constructor(buildRunner: PandocBuildRunner, output: vscode.OutputChannel) {
    this.buildRunner = buildRunner;
    this.output = output;
  }

  readonly onDidChangeInlayHints = this.changed.event;

  /**
   * Returns the cached cross-reference numbers for the requested editor range.
   *
   * @param document Open Markdown or MDX document.
   * @param range Requested editor range.
   */
  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!getConfiguration().get("enableNumberInlayHints", true)) {
      return [];
    }

    const uriText = document.uri.toString();
    const cached = this.cache.get(uriText);
    if (!cached || cached.version !== document.version) {
      this.scheduleRefresh(document);
      return [];
    }

    return cached.hints.filter((hint) => range.contains(hint.position));
  }

  /**
   * Schedules one debounced JSON AST build for the current document version.
   *
   * @param document Markdown document to rebuild.
   * @param delayMs Delay before invoking Papper.
   */
  scheduleRefresh(document: vscode.TextDocument, delayMs = 1000): void {
    if (!isBuildableMarkdownDocument(document) || !getConfiguration().get("enableNumberInlayHints", true)) {
      return;
    }

    const uriText = document.uri.toString();
    const cached = this.cache.get(uriText);
    if (cached && cached.version !== document.version) {
      this.cache.delete(uriText);
      this.changed.fire();
    }

    let state = this.refreshStates.get(uriText);
    if (!state) {
      state = { document, running: false, rerun: false };
      this.refreshStates.set(uriText, state);
    }
    state.document = document;

    if (state.running) {
      state.rerun = true;
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state!.timer = undefined;
      void this.refresh(uriText, state!);
    }, delayMs);
  }

  /**
   * Clears cached state after a Markdown document closes.
   *
   * @param document Closed document.
   */
  closeDocument(document: vscode.TextDocument): void {
    const uriText = document.uri.toString();
    const state = this.refreshStates.get(uriText);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.refreshStates.delete(uriText);
    this.cache.delete(uriText);
    this.changed.fire();
  }

  /**
   * Refreshes or clears hints when the feature setting changes.
   */
  refreshOpenDocuments(): void {
    if (!getConfiguration().get("enableNumberInlayHints", true)) {
      for (const state of this.refreshStates.values()) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      this.refreshStates.clear();
      this.cache.clear();
      this.changed.fire();
      return;
    }

    for (const document of vscode.workspace.textDocuments) {
      if (isPandocDocument(document)) {
        this.scheduleRefresh(document, 0);
      }
    }
  }

  /**
   * Stops pending refreshes and releases the provider event emitter.
   */
  dispose(): void {
    for (const state of this.refreshStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.refreshStates.clear();
    this.cache.clear();
    this.changed.dispose();
  }

  /**
   * Runs the AST build and publishes hints only if its source version is still current.
   *
   * @param uriText Stable document URI key.
   * @param state Current refresh state for the document.
   */
  private async refresh(uriText: string, state: RefreshState): Promise<void> {
    if (state.running || this.refreshStates.get(uriText) !== state) {
      return;
    }

    const document = state.document;
    const version = document.version;
    state.running = true;
    state.rerun = false;

    try {
      const ast = await this.buildRunner.buildJsonAstForDocument(document);
      if (this.refreshStates.get(uriText) !== state || state.document.version !== version) {
        state.rerun = this.refreshStates.get(uriText) === state;
        return;
      }

      const numbers = ast ? collectPandocCrossReferenceNumbers(ast, parsePandocDocument(document.getText(), uriText)) : [];
      this.cache.set(uriText, { version, hints: numbers.map(toInlayHint) });
      this.changed.fire();
    } catch (error) {
      if (this.refreshStates.get(uriText) === state && state.document.version === version) {
        this.cache.set(uriText, { version, hints: [] });
        this.changed.fire();
      }
      this.output.appendLine(`[Inlay hints] Could not refresh numbering for ${document.uri.fsPath}: ${String(error)}`);
    } finally {
      state.running = false;
      if (state.rerun && this.refreshStates.get(uriText) === state) {
        state.rerun = false;
        this.scheduleRefresh(state.document, 150);
      }
    }
  }
}

/**
 * Converts one AST-derived number and source position into a VS Code inlay hint.
 *
 * @param number AST-derived number and Markdown source position.
 */
function toInlayHint(number: CrossReferenceNumber): vscode.InlayHint {
  const label = number.kind === "section"
    ? `§ ${number.number}`
    : number.kind === "figure"
      ? `Fig. ${number.number}`
      : number.kind === "table"
        ? `Table ${number.number}`
        : number.number;
  const hint = new vscode.InlayHint(new vscode.Position(number.line, number.character), label);
  hint.paddingLeft = true;
  hint.tooltip = new vscode.MarkdownString(`Number produced by Papper's Pandoc cross-reference build${number.label ? ` for \`${number.label}\`` : ""}.`);
  return hint;
}
