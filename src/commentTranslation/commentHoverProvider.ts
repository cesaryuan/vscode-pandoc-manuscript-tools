import * as vscode from "vscode";
import { getConfiguration } from "../configuration";
import { CommentParagraphScanner, isTranslatableCommentText } from "./commentParagraph";
import { CommentSyntaxRegistry } from "./commentSyntax";
import type { ParagraphTranslator } from "../paragraphTranslator";
import { toRange } from "../vscodeUtils";

/** Translates nearby English comment paragraphs independently of Markdown and language servers. */
export class CommentHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private readonly syntax: CommentSyntaxRegistry;

  /** Shares the existing translator and caches language delimiter metadata. */
  constructor(private readonly translator: ParagraphTranslator, private readonly output: vscode.OutputChannel) {
    this.syntax = new CommentSyntaxRegistry(output);
  }

  /** Scans a bounded local window only when translation is enabled and returns escaped hover text. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    // Markdown/MDX retain their existing paragraph hover, avoiding duplicate translation requests and cards.
    if (document.languageId === "markdown" || document.languageId === "mdx"
      || token.isCancellationRequested || !getConfiguration().get("enableParagraphHoverTranslation", false)) {
      return undefined;
    }
    const version = document.version;
    try {
      const syntax = await this.syntax.get(document.languageId);
      if (token.isCancellationRequested || document.version !== version || document.isClosed
        || (!syntax.lineComments.length && !syntax.blockComments.length)) {
        return undefined;
      }
      const paragraph = new CommentParagraphScanner(document, position, syntax).find();
      const maxCharacters = getConfiguration().get("paragraphHoverTranslationMaxCharacters", 5000);
      if (!paragraph || !isTranslatableCommentText(paragraph.text, maxCharacters)) {
        return undefined;
      }
      // The existing backends accept HTML: escape generics and tags so code-shaped prose stays visible.
      const source = paragraph.text.replace(/\s*\n\s*/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const translation = await this.translator.translateText(source);
      if (!translation?.text || token.isCancellationRequested || document.version !== version || document.isClosed) {
        return undefined;
      }
      const markdown = new vscode.MarkdownString();
      const engine = translation.engine === "google" ? "Google Translate" : "Microsoft Translator";
      markdown.appendMarkdown(`**Comment translation** (${engine})\n\n`);
      markdown.appendText(translation.text);
      return new vscode.Hover(markdown, toRange(paragraph.range));
    } catch (error) {
      this.output.appendLine(`Comment translation hover failed at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}: ${String(error)}`);
      return undefined;
    }
  }

  /** Releases cached syntax configuration and extension-change subscriptions. */
  dispose(): void {
    this.syntax.dispose();
  }
}
