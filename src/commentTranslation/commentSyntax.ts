import * as vscode from "vscode";
// The UMD entry wraps require calls that esbuild cannot resolve, breaking bundled Extension Host activation.
import { parse, type ParseError } from "jsonc-parser/lib/esm/main";
import type { CommentSyntax } from "./commentParagraph";

/** Caches the small comment-delimiter configurations contributed by installed language extensions. */
export class CommentSyntaxRegistry implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<CommentSyntax>>();
  private readonly extensionChanges: vscode.Disposable;

  /** Invalidates syntax metadata when extensions are added or removed without activating their language servers. */
  constructor(private readonly output: vscode.OutputChannel) {
    this.extensionChanges = vscode.extensions.onDidChange(() => this.cache.clear());
  }

  /** Loads a language's comment delimiters once, sharing concurrent hover requests. */
  get(languageId: string): Promise<CommentSyntax> {
    if (!this.cache.has(languageId)) {
      this.cache.set(languageId, this.load(languageId));
    }
    return this.cache.get(languageId)!;
  }

  /** Reads only language configuration JSON/JSONC, never full grammars or document contents. */
  private async load(languageId: string): Promise<CommentSyntax> {
    const syntax: CommentSyntax = { lineComments: [], blockComments: [] };
    for (const extension of vscode.extensions.all) {
      const languages = extension.packageJSON.contributes?.languages;
      if (!Array.isArray(languages)) {
        continue;
      }
      for (const language of languages) {
        if (language.id !== languageId || typeof language.configuration !== "string") {
          continue;
        }
        try {
          const uri = vscode.Uri.joinPath(extension.extensionUri, language.configuration);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const errors: ParseError[] = [];
          const config = parse(Buffer.from(bytes).toString("utf8"), errors, { allowTrailingComma: true });
          if (errors.length) {
            throw new Error(`Invalid language configuration JSON (${errors[0].error})`);
          }
          const comments = config?.comments;
          if (typeof comments?.lineComment === "string" && comments.lineComment) {
            syntax.lineComments.push(comments.lineComment);
          }
          const block = comments?.blockComment;
          if (Array.isArray(block) && block.length === 2 && block.every((value) => typeof value === "string" && value)) {
            syntax.blockComments.push([block[0], block[1]]);
          }
        } catch (error) {
          this.output.appendLine(`Could not read comment syntax for ${languageId} from ${extension.id}: ${String(error)}`);
        }
      }
    }
    // These comment forms are useful for translation but are not always in the language's toggle-comment configuration.
    if (languageId === "python") {
      syntax.lineComments.push("#");
      syntax.blockComments.push(['"""', '"""'], ["'''", "'''"]);
    } else if (languageId === "php") {
      syntax.lineComments.push("#", "//");
    } else if (languageId === "lua") {
      syntax.lineComments.push("--");
      syntax.blockComments.push(["--[[", "]]"], ["--[=[", "]=]"], ["--[==[", "]==]"]);
    }
    syntax.lineComments = [...new Set(syntax.lineComments)];
    syntax.blockComments = syntax.blockComments.filter((pair, index, pairs) =>
      pairs.findIndex(([open, close]) => open === pair[0] && close === pair[1]) === index);
    return syntax;
  }

  /** Releases extension notifications and cached delimiter metadata. */
  dispose(): void {
    this.extensionChanges.dispose();
    this.cache.clear();
  }
}
