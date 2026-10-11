import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { findExistingPapperExecutable, findPandocManuscriptProject, preparePapperEnvironment, runProcess } from "../papperBuildUtils";
import { isBuildableMarkdownDocument } from "../vscodeUtils";
import { prepareReferenceSource } from "./sourceReferences";
import { collectRenderedReferences, type ReferenceHint } from "./references";

export type InlayBuildResult = { ast: unknown; references: ReferenceHint[] };

/** Builds one processed AST for definition numbers and reference text, without changing the editor buffer. */
export class InlayHintBuilder {
  /** Uses the shared output channel to report background build timing and cleanup failures. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Builds a temporary marked snapshot using an installed Papper; background refreshes never install tools. */
  async build(document: vscode.TextDocument): Promise<InlayBuildResult | undefined> {
    if (!isBuildableMarkdownDocument(document)) return undefined;
    const project = await findPandocManuscriptProject(document.uri);
    const executable = await findExistingPapperExecutable();
    if (!executable) return undefined;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-inlay-"));
    const markdownPath = path.join(directory, path.basename(document.uri.fsPath));
    const astPath = path.join(directory, "ast.json");
    try {
      const prepared = prepareReferenceSource(document.getText());
      await fs.writeFile(markdownPath, prepared.markdown, "utf8");
      const environment = await preparePapperEnvironment(executable);
      const started = Date.now();
      this.output.appendLine(`[Inlay hints][timing] Papper JSON build started: ${path.basename(document.uri.fsPath)} version=${document.version}`);
      try {
        await runProcess(executable, ["build", "json", markdownPath, "--output-file", astPath], {
          cwd: project.rootUri.fsPath, env: environment.env,
        });
      } finally {
        this.output.appendLine(`[Inlay hints][timing] Papper JSON build ended: ${path.basename(document.uri.fsPath)} version=${document.version} duration=${Date.now() - started} ms`);
      }
      const ast: unknown = JSON.parse(await fs.readFile(astPath, "utf8"));
      return { ast, references: collectRenderedReferences(ast, prepared.references) };
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch((error) => {
        this.output.appendLine(`[Inlay hints] Could not remove temporary build directory: ${String(error)}`);
      });
    }
  }
}
