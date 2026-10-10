import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { readReferenceStyles, findReferenceStyle, type ReferenceStyle } from "./referenceStyles";
import { addManuscriptStyle, getManuscriptStyleTargets, getYamlHeader, type StyleTarget } from "./document";
import { findPandocManuscriptProject, findExistingPapperExecutable, preparePapperEnvironment, runProcess } from "../papperBuildUtils";

export const SET_MANUSCRIPT_STYLE_COMMAND = "pandocManuscriptTools.setManuscriptStyle";
type CacheRecord = { fingerprint: string; styles: ReferenceStyle[] };
// Older persisted results omitted character styles and their type information.
const CACHE_VERSION = "reference-styles-v2";

/** Caches effective reference formatting per document and deduplicates simultaneous first exports. */
export class ReferenceStyleCache {
  private readonly memory = new Map<string, CacheRecord>();
  private readonly pending = new Map<string, Promise<ReferenceStyle[]>>();
  private readonly failures = new Map<string, Error>();

  /** Stores persistent JSON in extension storage rather than adding generated files to the project. */
  constructor(private readonly storage: string, private readonly output: vscode.OutputChannel) {}

  /** Fingerprints only formatting inputs, so ordinary body edits never invoke Papper again. */
  private async inputs(document: vscode.TextDocument) {
    const text = document.getText();
    const header = getYamlHeader(text)?.content ?? "";
    const project = await findPandocManuscriptProject(document.uri);
    const root = project?.rootUri.fsPath ?? path.dirname(document.uri.fsPath);
    const executable = await findExistingPapperExecutable();
    if (!executable) throw new Error("未找到 Papper，请先执行 Papper Tools: Install or Update Papper");
    const styles = process.env.PMT_STYLE_FILE ? [path.resolve(root, process.env.PMT_STYLE_FILE)]
      : [...new Set([path.join(path.dirname(document.uri.fsPath), "style.yml"), path.join(root, "style.yml")])];
    const reference = process.env.PMT_REFERENCE_DOC ? path.resolve(root, process.env.PMT_REFERENCE_DOC) : undefined;
    const hash = createHash("sha256").update(CACHE_VERSION).update(document.uri.toString()).update(root).update(header);
    for (const file of [...styles, executable, ...(reference ? [reference] : [])]) {
      hash.update(file);
      try {
        if (styles.includes(file)) hash.update(await fs.readFile(file));
        else {
          const stat = await fs.stat(file);
          hash.update(`${stat.size}:${stat.mtimeMs}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        hash.update("missing");
      }
    }
    // Packaged resource locations may be selected through PMT_* without changing the launcher.
    for (const [key, value] of Object.entries(process.env).filter(([key]) => key.startsWith("PMT_")).sort()) hash.update(`${key}=${value}`);
    return { text, root, executable, fingerprint: hash.digest("hex") };
  }

  /** Loads a persisted result, exports once on a miss, and permits explicit retries after failure. */
  async get(document: vscode.TextDocument, retry = false): Promise<ReferenceStyle[]> {
    const inputs = await this.inputs(document);
    const uri = document.uri.toString();
    if (this.memory.get(uri)?.fingerprint === inputs.fingerprint) return this.memory.get(uri).styles;
    if (!retry && this.failures.has(inputs.fingerprint)) throw this.failures.get(inputs.fingerprint);
    const running = this.pending.get(inputs.fingerprint);
    if (running) return running;
    const task = this.load(document, inputs).then((styles) => {
      this.failures.delete(inputs.fingerprint);
      this.memory.set(uri, { fingerprint: inputs.fingerprint, styles });
      return styles;
    }).catch((error: Error) => {
      // Failed exports stay cached until an explicit action retries or the formatting inputs change.
      this.failures.set(inputs.fingerprint, error);
      this.output.appendLine(`[Styles] Reference export failed: ${String(error)}`);
      throw error;
    }).finally(() => this.pending.delete(inputs.fingerprint));
    this.pending.set(inputs.fingerprint, task);
    return task;
  }

  /** Exports an unsaved snapshot beside its source so Papper discovers the same style files and reply paths. */
  private async load(document: vscode.TextDocument, inputs: { text: string; root: string; executable: string; fingerprint: string }): Promise<ReferenceStyle[]> {
    const cachePath = path.join(this.storage, `${createHash("sha256").update(document.uri.toString()).digest("hex")}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as CacheRecord;
      if (cached.fingerprint === inputs.fingerprint && Array.isArray(cached.styles) && cached.styles.length
        && cached.styles.every((style) => typeof style.name === "string" && typeof style.id === "string"
          && ["paragraph", "character"].includes(style.type) && style.values && style.notes)) {
        this.output.appendLine(`[Styles] Loaded cached reference styles: ${document.uri.fsPath}`);
        return cached.styles;
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.output.appendLine(`[Styles] Ignoring unreadable cache: ${String(error)}`);
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-reference-style-"));
    const snapshot = path.join(path.dirname(document.uri.fsPath), `.pmt-style-${randomUUID()}.md`);
    try {
      await fs.writeFile(snapshot, inputs.text, { encoding: "utf8", flag: "wx" });
      const exported = path.join(directory, "reference.docx");
      const environment = await preparePapperEnvironment(inputs.executable);
      const args = ["build", "docx", snapshot, "--export-reference-doc", exported];
      this.output.appendLine(`[Styles] Exporting effective reference: ${document.uri.fsPath}`);
      try {
        await runProcess(inputs.executable, args, { cwd: inputs.root, env: environment.env, output: this.output });
      } catch (error) {
        if (/unexpected argument.*export-reference-doc|unrecognized.*export-reference-doc/i.test(String(error))) {
          throw new Error("当前 Papper 不支持 --export-reference-doc，请执行 Papper Tools: Install or Update Papper 后重试");
        }
        throw error;
      }
      const styles = readReferenceStyles(await fs.readFile(exported));
      if (!styles.length) throw new Error("导出的 reference DOCX 中没有段落或字符样式");
      try {
        await fs.mkdir(this.storage, { recursive: true });
        const temporaryCache = `${cachePath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporaryCache, JSON.stringify({ fingerprint: inputs.fingerprint, styles } satisfies CacheRecord));
          await fs.rename(temporaryCache, cachePath);
        } finally {
          await fs.rm(temporaryCache, { force: true });
        }
      } catch (error) {
        // A read-only/full storage directory should not prevent the current in-memory style edit.
        this.output.appendLine(`[Styles] Could not persist reference styles: ${String(error)}`);
      }
      this.output.appendLine(`[Styles] Cached ${styles.length} text styles: ${document.uri.fsPath}`);
      return styles;
    } finally {
      await fs.rm(snapshot, { force: true }).catch((error) => this.output.appendLine(`[Styles] Snapshot cleanup failed: ${String(error)}`));
      await fs.rm(directory, { recursive: true, force: true }).catch((error) => this.output.appendLine(`[Styles] Export cleanup failed: ${String(error)}`));
    }
  }
}

/** Escapes custom style names so they cannot inject links or formatting into the hover action. */
function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/\r?\n/g, " ");
}

/** Provides independently composable style hovers alongside translation, images and math. */
export class ManuscriptStyleController implements vscode.HoverProvider {
  private readonly targets = new WeakMap<vscode.TextDocument, { version: number; entries: StyleTarget[] }>();
  private readonly cache: ReferenceStyleCache;

  /** Keeps reference export and caching available for explicit style actions. */
  constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.cache = new ReferenceStyleCache(path.join(context.globalStorageUri.fsPath, CACHE_VERSION), output);
  }

  /** Shows only the trusted style action; hovering never exports or reads the reference DOCX. */
  provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | undefined {
    if (document.uri.scheme !== "file") return undefined;
    let targets = this.targets.get(document);
    try {
      if (!targets || targets.version !== document.version) {
        targets = { version: document.version, entries: getManuscriptStyleTargets(document.getText()) };
        this.targets.set(document, targets);
      }
    } catch { return undefined; } // Incomplete YAML should remain editable without background errors.
    const matching = targets.entries.filter((entry) => position.line >= entry.line && position.line <= entry.endLine
      && (position.line !== entry.line || position.character >= entry.startCharacter)
      && (position.line !== entry.endLine || position.character <= entry.endCharacter));
    if (!matching.length || token.isCancellationRequested) return undefined;
    const base = [...matching].reverse().find((entry) => !entry.custom);
    const actions = [...(base ? [base] : []), ...matching.filter((entry) => entry.custom)];
    const unique = actions.filter((entry, index) => actions.findIndex((candidate) => candidate.name === entry.name && candidate.type === entry.type) === index);
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: [SET_MANUSCRIPT_STYLE_COMMAND] };
    markdown.appendMarkdown("Papper: ");
    for (const [index, target] of unique.entries()) {
      const args = encodeURIComponent(JSON.stringify(target.custom ? [document.uri.toString(), target.name, target.type] : [document.uri.toString(), target.name]));
      if (index) markdown.appendMarkdown(" | ");
      markdown.appendMarkdown(`[设置 ${escapeMarkdownText(target.name)} 的样式](command:${SET_MANUSCRIPT_STYLE_COMMAND}?${args})`);
    }
    // Restrict the hover to the intersection so an inline action disappears when the mouse leaves its span.
    const startLine = Math.max(...unique.map((entry) => entry.line));
    const endLine = Math.min(...unique.map((entry) => entry.endLine));
    const startCharacter = Math.max(...unique.filter((entry) => entry.line === startLine).map((entry) => entry.startCharacter));
    const endCharacter = Math.min(...unique.filter((entry) => entry.endLine === endLine).map((entry) => entry.endCharacter));
    return new vscode.Hover(markdown, new vscode.Range(startLine, startCharacter, endLine, endCharacter));
  }

  /** Inserts the clicked element's effective defaults in a single undoable frontmatter edit. */
  async setStyle(uriText: unknown, requested: unknown, type: unknown = "paragraph"): Promise<void> {
    try {
      if (typeof uriText !== "string" || typeof requested !== "string" || requested.length > 200) throw new Error("无效的样式设置请求");
      if (type !== "paragraph" && type !== "character") throw new Error("无效的样式类型");
      const uri = vscode.Uri.parse(uriText);
      if (uri.scheme !== "file") throw new Error("样式设置仅支持本地 Markdown 文档");
      const document = await vscode.workspace.openTextDocument(uri);
      if (!["markdown", "mdx"].includes(document.languageId)) throw new Error("请在 Markdown 文档中设置样式");
      const originalHeader = getYamlHeader(document.getText())?.content;
      const styles = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在读取 ${requested} 的实际样式` },
        /** Retries export failures only after the user explicitly clicks the style action. */
        () => this.cache.get(document, true));
      if (originalHeader !== getYamlHeader(document.getText())?.content) throw new Error("读取期间 YAML header 已改变，请重新点击样式按钮");
      // Missing custom styles use effective body defaults; character actions filter out paragraph-only properties below.
      const style = findReferenceStyle(styles, requested, type)
        ?? findReferenceStyle(styles, "正文文本") ?? findReferenceStyle(styles, "正文");
      if (!style) throw new Error("当前 reference DOCX 缺少正文默认样式，无法读取继承配置");
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      if (originalHeader !== getYamlHeader(document.getText())?.content) throw new Error("读取期间 YAML header 已改变，请重新点击样式按钮");
      const before = document.getText();
      const result = addManuscriptStyle(before, requested, style.values, type);
      const updatedHeader = getYamlHeader(result.text);
      if (before !== result.text) {
        const oldHeader = getYamlHeader(before);
        // Replace only YAML contents so source selections/body line endings are not rewritten.
        const range = oldHeader ? new vscode.Range(document.positionAt(oldHeader.start), document.positionAt(oldHeader.end))
          : new vscode.Range(document.positionAt(before.startsWith("\uFEFF") ? 1 : 0), document.positionAt(before.startsWith("\uFEFF") ? 1 : 0));
        const replacement = oldHeader ? updatedHeader.content
          : result.text.slice(before.startsWith("\uFEFF") ? 1 : 0, result.text.length - before.replace(/^\uFEFF/, "").length);
        const applied = await editor.edit(
          /** Adds only the frontmatter as one Undo operation. */
          (edit) => edit.replace(range, replacement), { undoStopBefore: true, undoStopAfter: true });
        if (!applied) throw new Error("VS Code 拒绝了 YAML header 编辑");
        this.output.appendLine(`[Styles] Added missing ${result.styleName} settings: ${document.uri.fsPath}`);
      }
      const source = document.getText();
      const offset = source.indexOf(result.styleName, getYamlHeader(source).start);
      editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset + result.styleName.length));
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      this.output.appendLine(`[Styles] Could not set manuscript style: ${String(error)}`);
      void vscode.window.showErrorMessage(`设置样式失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
