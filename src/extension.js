"use strict";

const cp = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const {
  parsePandocDocument,
  findMathBlockAtPosition,
  findInlineMathAtPosition,
  findTokenAtPosition,
  containsPosition,
} = require("./parser");

const EXTENSION_NAME = "Pandoc Manuscript Tools";
const MARKDOWN_SELECTOR = [{ language: "markdown" }];
const BUILD_DOCX_COMMAND = "pandocManuscriptTools.buildDocxAndOpen";
const CAN_BUILD_DOCX_CONTEXT = "pandocManuscriptTools.canBuildDocx";
const BUILD_SCRIPT_CANDIDATES = ["scripts/build.py", "scripts/build"];
const POSTPROCESS_FEATURE_CANDIDATES = ["scripts/postprocess_docx.py", "scripts/postprocess"];
const MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS = {
  "accents-b-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js"),
  accents: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js"),
  arabic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js"),
  arrows: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js"),
  "braille-d": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js"),
  braille: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js"),
  calligraphic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  cherokee: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js"),
  "cyrillic-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js"),
  cyrillic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js"),
  devanagari: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js"),
  "double-struck": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  fraktur: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  "greek-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js"),
  greek: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js"),
  hebrew: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js"),
  "latin-b": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js"),
  "latin-bi": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js"),
  "latin-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js"),
  latin: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js"),
  marrows: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js"),
  math: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js"),
  "monospace-ex": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js"),
  "monospace-l": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js"),
  monospace: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
  mshapes: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js"),
  "phonetics-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js"),
  phonetics: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js"),
  PUA: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js"),
  "sans-serif-b": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js"),
  "sans-serif-bi": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js"),
  "sans-serif-ex": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js"),
  "sans-serif-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js"),
  "sans-serif-r": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js"),
  "sans-serif": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js"),
  script: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  shapes: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js"),
  "symbols-b-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js"),
  symbols: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js"),
  variants: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js"),
};

/**
 * Activates the local Pandoc Markdown helper extension.
 *
 * @param {vscode.ExtensionContext} context VS Code extension context.
 */
function activate(context) {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection("pandoc-manuscript-tools");
  const index = new PandocWorkspaceIndex(output);
  const mathRenderer = new MathJaxRenderer(output);
  const buildRunner = new PandocBuildRunner(output);

  output.appendLine("Activated Pandoc Manuscript Tools.");

  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(MARKDOWN_SELECTOR, new PandocDefinitionProvider(index)));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(MARKDOWN_SELECTOR, new PandocReferenceProvider(index)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(MARKDOWN_SELECTOR, new PandocHoverProvider(index, mathRenderer)));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(MARKDOWN_SELECTOR, new PandocDocumentSymbolProvider(index), { label: EXTENSION_NAME }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(MARKDOWN_SELECTOR, new PandocCompletionProvider(index), "@", ":"));
  context.subscriptions.push({ dispose: () => mathRenderer.dispose() });

  context.subscriptions.push(vscode.commands.registerCommand("pandocManuscriptTools.rebuildIndex", async () => {
    await index.refreshWorkspace();
    updateDiagnosticsForOpenDocuments(index, diagnostics);
    vscode.window.showInformationMessage("Pandoc Manuscript Tools index rebuilt.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand(BUILD_DOCX_COMMAND, async () => {
    await buildRunner.buildActiveMarkdownDocx();
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void buildRunner.refreshContext();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void buildRunner.refreshContext();
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
    if (isMarkdownDocument(document)) {
      index.updateDocument(document);
      updateDiagnostics(document, index, diagnostics);
      void buildRunner.refreshContext();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (isMarkdownDocument(event.document)) {
      index.updateDocument(event.document);
      updateDiagnostics(event.document, index, diagnostics);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (isMarkdownDocument(document)) {
      index.updateDocument(document);
      await index.refreshWorkspace();
      updateDiagnosticsForOpenDocuments(index, diagnostics);
    }
  }));

  void index.refreshWorkspace().then(() => updateDiagnosticsForOpenDocuments(index, diagnostics));
  void buildRunner.refreshContext();
}

/**
 * Deactivates the extension.
 */
function deactivate() {}

class PandocWorkspaceIndex {
  /**
   * Creates a workspace-wide Markdown index.
   *
   * @param {vscode.OutputChannel} output Output channel for useful diagnostics.
   */
  constructor(output) {
    this.output = output;
    this.documents = new Map();
  }

  /**
   * Refreshes Markdown files from the workspace.
   *
   * Open documents are parsed from their editor buffer so unsaved label edits are
   * still visible to definitions, references, hovers, and diagnostics.
   *
   * @returns {Promise<void>}
   */
  async refreshWorkspace() {
    const includeWorkspace = getConfiguration().get("includeWorkspaceReferences", true);
    const openMarkdownDocuments = vscode.workspace.textDocuments.filter(isMarkdownDocument);

    for (const document of openMarkdownDocuments) {
      this.updateDocument(document);
    }

    if (!includeWorkspace) {
      this.output.appendLine(`Indexed ${openMarkdownDocuments.length} open Markdown document(s).`);
      return;
    }

    try {
      const files = await vscode.workspace.findFiles("**/*.md", "**/{.git,node_modules,output,tmp}/**", 1000);
      for (const uri of files) {
        const openDocument = openMarkdownDocuments.find((document) => document.uri.toString() === uri.toString());
        if (openDocument) {
          continue;
        }
        await this.updateUri(uri);
      }
      this.output.appendLine(`Indexed ${this.documents.size} Markdown document(s).`);
    } catch (error) {
      this.output.appendLine(`Failed to refresh Markdown index: ${String(error)}`);
    }
  }

  /**
   * Parses and caches an open text document.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {ParsedCacheEntry}
   */
  updateDocument(document) {
    const uriText = document.uri.toString();
    const existing = this.documents.get(uriText);
    if (existing && existing.version === document.version) {
      return existing;
    }

    const parsed = parsePandocDocument(document.getText(), uriText);
    const entry = { uri: document.uri, version: document.version, parsed };
    this.documents.set(uriText, entry);
    return entry;
  }

  /**
   * Reads, parses, and caches a Markdown file URI.
   *
   * @param {vscode.Uri} uri Markdown file URI.
   * @returns {Promise<ParsedCacheEntry | undefined>}
   */
  async updateUri(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parsePandocDocument(text, uri.toString());
      const entry = { uri, version: undefined, parsed };
      this.documents.set(uri.toString(), entry);
      return entry;
    } catch (error) {
      this.output.appendLine(`Failed to index ${uri.fsPath}: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Returns the cached parse for a document, parsing it if needed.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {import("./parser").ParsedPandocDocument}
   */
  getParsedDocument(document) {
    return this.updateDocument(document).parsed;
  }

  /**
   * Finds all definitions for a Pandoc label.
   *
   * @param {string} label Pandoc label.
   * @returns {import("./parser").LabelEntry[]}
   */
  getDefinitions(label) {
    return this.getAllEntriesByLabel("labels", label);
  }

  /**
   * Finds all references for a Pandoc label.
   *
   * @param {string} label Pandoc label.
   * @returns {import("./parser").ReferenceEntry[]}
   */
  getReferences(label) {
    return this.getAllEntriesByLabel("references", label);
  }

  /**
   * Returns all labels currently known to the index.
   *
   * @returns {import("./parser").LabelEntry[]}
   */
  getAllLabels() {
    return Array.from(this.documents.values()).flatMap((entry) => entry.parsed.labels);
  }

  /**
   * Returns entries of a given parsed collection matching one label.
   *
   * @param {"labels" | "references"} collection Parsed collection name.
   * @param {string} label Pandoc label.
   * @returns {Array<import("./parser").LabelEntry | import("./parser").ReferenceEntry>}
   */
  getAllEntriesByLabel(collection, label) {
    const entries = [];
    for (const cached of this.documents.values()) {
      entries.push(...cached.parsed[collection].filter((entry) => entry.label === label));
    }
    return entries;
  }

  /**
   * Returns a map from label to all matching definitions.
   *
   * @returns {Map<string, import("./parser").LabelEntry[]>}
   */
  getDefinitionMap() {
    const map = new Map();
    for (const label of this.getAllLabels()) {
      if (!map.has(label.label)) {
        map.set(label.label, []);
      }
      map.get(label.label).push(label);
    }
    return map;
  }
}

class PandocBuildRunner {
  /**
   * Creates the DOCX build runner used by the editor-title command.
   *
   * @param {vscode.OutputChannel} output Output channel for build logs.
   */
  constructor(output) {
    this.output = output;
    this.contextRefreshId = 0;
  }

  /**
   * Recomputes whether the active editor should show the DOCX build button.
   *
   * @returns {Promise<void>}
   */
  async refreshContext() {
    const refreshId = this.contextRefreshId + 1;
    this.contextRefreshId = refreshId;

    const canBuild = await this.canBuildActiveDocument();
    if (refreshId !== this.contextRefreshId) {
      return;
    }

    await vscode.commands.executeCommand("setContext", CAN_BUILD_DOCX_CONTEXT, canBuild);
  }

  /**
   * Returns whether the current editor is a buildable manuscript Markdown file.
   *
   * @returns {Promise<boolean>}
   */
  async canBuildActiveDocument() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      return false;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    if (!project) {
      return false;
    }

    return isUvAvailable();
  }

  /**
   * Builds the active Markdown file as DOCX and opens the result externally.
   *
   * The button is hidden unless these checks pass, but command-palette calls can
   * still reach this path, so the user gets a precise reason instead of silence.
   *
   * @returns {Promise<void>}
   */
  async buildActiveMarkdownDocx() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBuildableMarkdownDocument(editor.document)) {
      vscode.window.showWarningMessage("Open a saved Markdown file before building DOCX.");
      return;
    }

    const project = await findPandocManuscriptProject(editor.document.uri);
    if (!project) {
      vscode.window.showWarningMessage("This Markdown file is not inside a Pandoc manuscript template project.");
      await this.refreshContext();
      return;
    }

    if (!(await isUvAvailable())) {
      vscode.window.showErrorMessage("Cannot build DOCX because `uv` is not available on PATH.");
      await this.refreshContext();
      return;
    }

    const docxUri = getExpectedDocxUri(project.rootUri, editor.document.uri);
    if (await isFileLockedForOverwrite(docxUri)) {
      const message = getCloseDocxBeforeBuildMessage(path.basename(docxUri.fsPath));
      this.output.appendLine(`[DOCX] Target DOCX is already open or not writable: ${docxUri.fsPath}`);
      await vscode.window.showWarningMessage(message, { modal: true });
      return;
    }

    const saved = await editor.document.save();
    if (!saved) {
      vscode.window.showWarningMessage("The Markdown file must be saved before building DOCX.");
      return;
    }

    await this.runDocxBuild(project, editor.document);
    await this.refreshContext();
  }

  /**
   * Runs `uv run scripts/build... docx <current-file>` and opens the output DOCX.
   *
   * @param {PandocManuscriptProject} project Detected manuscript project root.
   * @param {vscode.TextDocument} document Markdown document to build.
   * @returns {Promise<void>}
   */
  async runDocxBuild(project, document) {
    const markdownRelativePath = path.relative(project.rootUri.fsPath, document.uri.fsPath);
    const docxUri = getExpectedDocxUri(project.rootUri, document.uri);
    const args = ["run", project.buildScript, "docx", markdownRelativePath];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`[DOCX] Building ${markdownRelativePath}`);
    this.output.appendLine(`[DOCX] Working directory: ${project.rootUri.fsPath}`);
    this.output.appendLine(`[DOCX] Command: uv ${args.join(" ")}`);

    try {
      await runProcess("uv", args, { cwd: project.rootUri.fsPath, output: this.output });
      if (!(await pathExists(docxUri))) {
        throw new Error(`Build finished, but the expected DOCX was not found: ${docxUri.fsPath}`);
      }

      const opened = await vscode.env.openExternal(docxUri);
      if (!opened) {
        throw new Error(`VS Code could not open the DOCX with an external application: ${docxUri.fsPath}`);
      }

      this.output.appendLine(`[DOCX] Opened ${docxUri.fsPath}`);
      vscode.window.setStatusBarMessage(`$(check) Built and opened ${path.basename(docxUri.fsPath)}.`, 5000);
    } catch (error) {
      const message = `Failed to build DOCX: ${String(error.message || error)}`;
      this.output.appendLine(`[DOCX] ${message}`);
      vscode.window.showErrorMessage(message);
    }
  }
}

class PandocDefinitionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides go-to-definition for Pandoc cross references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.LocationLink[] | undefined}
   */
  provideDefinition(document, position) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    return this.index.getDefinitions(token.entry.label).map((definition) => toLocationLink(definition, token.entry));
  }
}

class PandocReferenceProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides find-all-references for Pandoc labels and references.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @param {{includeDeclaration: boolean}} options Reference options.
   * @returns {vscode.Location[] | undefined}
   */
  provideReferences(document, position, options) {
    const token = getTokenAtDocumentPosition(this.index, document, position);
    if (!token) {
      return undefined;
    }

    const locations = this.index.getReferences(token.entry.label).map(toLocation);
    if (options.includeDeclaration) {
      locations.unshift(...this.index.getDefinitions(token.entry.label).map(toLocation));
    }
    return locations;
  }
}

class PandocHoverProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
   */
  constructor(index, mathRenderer) {
    this.index = index;
    this.mathRenderer = mathRenderer;
  }

  /**
   * Provides label, reference, and math-block hover information.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {Promise<vscode.Hover | undefined>}
   */
  async provideHover(document, position) {
    const parsed = this.index.getParsedDocument(document);
    const plainPosition = toPlainPosition(position);
    const token = findTokenAtPosition(parsed, plainPosition);
    if (token) {
      const labeledMathBlock = findMathBlockForEquationLabelHover(parsed, token, plainPosition);
      if (labeledMathBlock) {
        // Pandoc-crossref puts equation labels on the closing delimiter, so the
        // token hover must opt into the formula preview before the generic label
        // hover short-circuits it.
        return new vscode.Hover(await buildMathHover(labeledMathBlock, this.index, this.mathRenderer), toRange(token.entry.fullRange));
      }
      return new vscode.Hover(buildLabelHover(token.entry, this.index, token.type), toRange(token.entry.fullRange));
    }

    const mathBlock = findMathBlockAtPosition(parsed, plainPosition);
    if (mathBlock) {
      // Math-block hovers should shade the whole display equation; label hovers
      // are handled above so `{#eq:...}` still keeps its tighter range.
      return new vscode.Hover(await buildMathHover(mathBlock, this.index, this.mathRenderer), toRange(mathBlock.range));
    }

    const inlineMath = findInlineMathAtPosition(parsed, plainPosition);
    if (inlineMath) {
      return new vscode.Hover(await buildInlineMathHover(inlineMath, this.mathRenderer), toRange(inlineMath.fullRange));
    }

    return undefined;
  }
}

/**
 * Finds the display equation associated with an equation-definition label hover.
 *
 * Only labels parsed from math delimiters should use the formula preview here;
 * cross-reference hovers such as `@eq:linear` still need the generic label
 * summary instead of rendering the target equation inline.
 *
 * @param {import("./parser").ParsedPandocDocument} parsed Parsed document.
 * @param {{type: string, entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry}} token Token under the cursor.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {import("./parser").MathBlockEntry | undefined}
 */
function findMathBlockForEquationLabelHover(parsed, token, position) {
  if (token.type !== "label" || token.entry.prefix !== "eq" || token.entry.source !== "math") {
    return undefined;
  }

  const mathBlock = findMathBlockAtPosition(parsed, position);
  if (!mathBlock || mathBlock.label !== token.entry.label) {
    return undefined;
  }

  return mathBlock;
}

class PandocDocumentSymbolProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides a Pandoc-aware outline that is not confused by `$$ {#eq:...}`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @returns {vscode.DocumentSymbol[]}
   */
  provideDocumentSymbols(document) {
    const parsed = this.index.getParsedDocument(document);
    const headingSymbols = buildHeadingTree(parsed.headings);
    if (getConfiguration().get("includeLabelSymbols", true)) {
      addLabelSymbols(parsed.labels, headingSymbols);
    }
    return headingSymbols;
  }
}

class PandocCompletionProvider {
  /**
   * @param {PandocWorkspaceIndex} index Workspace index.
   */
  constructor(index) {
    this.index = index;
  }

  /**
   * Provides label completions after `@`.
   *
   * @param {vscode.TextDocument} document Markdown document.
   * @param {vscode.Position} position Cursor position.
   * @returns {vscode.CompletionItem[] | undefined}
   */
  provideCompletionItems(document, position) {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = linePrefix.match(/@([A-Za-z0-9_:.~-]*)$/);
    if (!match) {
      return undefined;
    }

    const replacementStart = position.translate(0, -match[1].length);
    const replacementRange = new vscode.Range(replacementStart, position);
    const seen = new Set();

    return this.index.getAllLabels()
      .filter((entry) => !seen.has(entry.label) && seen.add(entry.label))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((entry) => {
        const item = new vscode.CompletionItem(entry.label, vscode.CompletionItemKind.Reference);
        item.insertText = entry.label;
        item.detail = entry.kind;
        item.documentation = entry.preview;
        item.range = replacementRange;
        return item;
      });
  }
}

/**
 * Builds a hover body for a label or cross-reference token.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Label or reference entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {string} tokenType Parsed token type, for example `label` or `reference`.
 * @returns {vscode.MarkdownString}
 */
function buildLabelHover(entry, index, tokenType) {
  const definitions = index.getDefinitions(entry.label);
  const references = index.getReferences(entry.label);
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${entry.kind}** \`${entry.label}\`\n\n`);
  markdown.appendMarkdown(`Definitions: **${definitions.length}**  \n`);
  markdown.appendMarkdown(`References: **${references.length}**`);

  if (definitions.length === 0) {
    markdown.appendMarkdown("\n\n$(warning) No definition found for this Pandoc cross reference.");
  } else if (definitions.length > 1) {
    markdown.appendMarkdown("\n\n$(warning) Duplicate definitions were found for this label.");
  } else if (!isDefinitionHover(tokenType)) {
    markdown.appendMarkdown(`\n\nDefined at \`${definitions[0].preview}\``);
  }

  return markdown;
}

/**
 * Returns whether a hover is on a label definition itself.
 *
 * Definitions are already at their own location, so repeating the current line
 * as "Defined at" makes the hover noisy without adding navigation value.
 *
 * @param {string} tokenType Parsed token type.
 * @returns {boolean}
 */
function isDefinitionHover(tokenType) {
  return tokenType === "label";
}

/**
 * Builds a hover body for display math blocks with a rendered SVG preview.
 *
 * @param {import("./parser").MathBlockEntry} mathBlock Math block entry.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<vscode.MarkdownString>}
 */
async function buildMathHover(mathBlock, index, mathRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  const label = mathBlock.label || "unlabeled equation";
  const referenceCount = mathBlock.label ? index.getReferences(mathBlock.label).length : 0;

  markdown.appendMarkdown(`**Equation** \`${label}\``);
  if (mathBlock.label) {
    markdown.appendMarkdown(`  \nReferences: **${referenceCount}**`);
  }

  if (mathBlock.tex) {
    const renderedSvg = await mathRenderer.renderToDataUri(mathBlock.tex, true);
    if (renderedSvg) {
      markdown.appendMarkdown(`\n\n![Rendered equation preview](${renderedSvg})\n\n`);
    } else {
      appendMathJaxUnavailableMessage(markdown);
    }
    markdown.appendCodeblock(mathBlock.tex, "tex");
  }

  return markdown;
}

/**
 * Builds a hover body for inline TeX math spans.
 *
 * @param {import("./parser").InlineMathEntry} inlineMath Inline math entry.
 * @param {MathJaxRenderer} mathRenderer MathJax SVG renderer.
 * @returns {Promise<vscode.MarkdownString>}
 */
async function buildInlineMathHover(inlineMath, mathRenderer) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown("**Inline math**");

  const renderedSvg = await mathRenderer.renderToDataUri(inlineMath.tex, false);
  if (renderedSvg) {
    markdown.appendMarkdown(`\n\n![Rendered inline equation preview](${renderedSvg})\n\n`);
  } else {
    appendMathJaxUnavailableMessage(markdown);
  }

  markdown.appendCodeblock(inlineMath.tex, "tex");
  return markdown;
}

/**
 * Adds the MathJax fallback message shown when a hover preview cannot render.
 *
 * @param {vscode.MarkdownString} markdown Hover markdown being built.
 */
function appendMathJaxUnavailableMessage(markdown) {
  markdown.appendMarkdown("\n\n$(warning) MathJax preview could not render. See the Pandoc Manuscript Tools output for the TeX source and error details.\n\n");
}

class MathJaxRenderer {
  /**
   * Creates a lazy MathJax renderer for hover previews.
   *
   * @param {vscode.OutputChannel} output Output channel for render failures.
   */
  constructor(output) {
    this.output = output;
    this.readyPromise = undefined;
    this.svgCache = new Map();
    this.loadFailure = undefined;
  }

  /**
   * Converts TeX into a data URI containing a standalone SVG image.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToDataUri(tex, display) {
    const svg = await this.renderToSvg(tex, display);
    if (!svg) {
      return undefined;
    }
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }

  /**
   * Converts TeX into SVG and caches the result by source text and mode.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToSvg(tex, display) {
    const trimmedTex = tex.trim();
    if (!trimmedTex) {
      return undefined;
    }

    const cacheKey = `${display ? "display" : "inline"}:${trimmedTex}`;
    if (!this.svgCache.has(cacheKey)) {
      this.svgCache.set(cacheKey, this.renderToSvgUncached(trimmedTex, display));
    }

    return this.svgCache.get(cacheKey);
  }

  /**
   * Converts TeX into SVG without consulting the cache.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToSvgUncached(tex, display) {
    try {
      const renderer = await this.ensureMathJax();
      if (!renderer) {
        return undefined;
      }

      const node = await renderer.html.convertPromise(tex, {
        display,
        em: 16,
        ex: 8,
        containerWidth: 80 * 16,
      });
      const adaptor = renderer.adaptor;
      const svgNodes = adaptor.tags(node, "svg");
      if (svgNodes.length !== 1) {
        this.output.appendLine(`MathJax returned ${svgNodes.length} SVG fragment(s) for equation ${formatTexForLog(tex)}; expected one complete preview.`);
        return undefined;
      }

      const svg = svgNodes[0];
      if (!svg) {
        this.output.appendLine(`MathJax did not return an SVG for equation: ${formatTexForLog(tex)}`);
        return undefined;
      }

      const serializedSvg = adaptor.serializeXML(svg);
      const renderError = getMathJaxSvgError(serializedSvg);
      if (renderError) {
        this.output.appendLine(`MathJax rendered an error for equation ${formatTexForLog(tex)}: ${renderError}`);
        return undefined;
      }

      return makeSvgHoverFriendly(serializedSvg);
    } catch (error) {
      this.output.appendLine(`MathJax failed to render equation ${formatTexForLog(tex)}: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Loads the direct MathJax TeX-to-SVG renderer once.
   *
   * The extension uses static require calls inside the lazy loader so esbuild
   * can bundle MathJax without invoking the component loader's SRE path probes.
   *
   * @returns {Promise<{adaptor: any, html: any} | undefined>}
   */
  async ensureMathJax() {
    if (this.loadFailure) {
      return undefined;
    }

    if (!this.readyPromise) {
      this.readyPromise = this.loadMathJax();
    }

    try {
      return await this.readyPromise;
    } catch (error) {
      this.loadFailure = error;
      this.output.appendLine(`MathJax is unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Initializes MathJax's direct Node API for TeX-to-SVG rendering.
   *
   * @returns {Promise<{adaptor: any, html: any}>}
   */
  async loadMathJax() {
    require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
    require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
    // \boldsymbol lives in a separate TeX package, so preload it explicitly for common ML notation.
    require("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js");
    require("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js");

    const { mathjax } = require("@mathjax/src/js/mathjax.js");
    const { TeX } = require("@mathjax/src/js/input/tex.js");
    const { SVG } = require("@mathjax/src/js/output/svg.js");
    const { liteAdaptor } = require("@mathjax/src/js/adaptors/liteAdaptor.js");
    const { RegisterHTMLHandler } = require("@mathjax/src/js/handlers/html.js");
    configureMathJaxAsyncLoad(mathjax);

    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ["base", "ams", "boldsymbol", "newcommand"] });
    const svg = new SVG({
      fontCache: "none",
      // VS Code hovers need a single data URI image; MathJax v4 inline
      // linebreaking otherwise returns multiple sibling SVG fragments.
      linebreaks: { inline: false },
    });
    const html = mathjax.document("", { InputJax: tex, OutputJax: svg });

    this.output.appendLine("MathJax direct TeX-to-SVG renderer loaded.");
    return { adaptor, html };
  }

  /**
   * Releases renderer references held by the hover provider.
   */
  dispose() {
    this.readyPromise = undefined;
    if (this.svgCache) {
      this.svgCache.clear();
    }
  }
}

/**
 * Registers bundled dynamic loaders for MathJax v4 SVG font chunks.
 *
 * VSIX packaging excludes node_modules, so the common \mathcal path must resolve
 * through literal require calls that esbuild can include in dist/extension.js.
 *
 * @param {any} mathjax MathJax direct API namespace.
 */
function configureMathJaxAsyncLoad(mathjax) {
  mathjax.asyncLoad = loadBundledMathJaxDynamicModule;
  mathjax.asyncIsSynchronous = true;
}

/**
 * Loads dynamic MathJax modules, keeping known NewCM SVG chunks bundled.
 *
 * @param {string} name Module name requested by MathJax.
 * @returns {any}
 */
function loadBundledMathJaxDynamicModule(name) {
  const normalizedName = name.replace(/\\/g, "/");
  const dynamicChunkMatch = normalizedName.match(/@mathjax\/mathjax-newcm-font\/js\/svg\/dynamic\/([^/]+)\.js$/);
  if (dynamicChunkMatch && MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS[dynamicChunkMatch[1]]) {
    return MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS[dynamicChunkMatch[1]]();
  }
  return require(name);
}

/**
 * Extracts MathJax's SVG-level render error when conversion produced merror.
 *
 * MathJax can return an SVG containing an error node instead of throwing; the
 * hover should treat that as a failed preview so the output channel has details.
 *
 * @param {string} svg Serialized MathJax SVG.
 * @returns {string | undefined}
 */
function getMathJaxSvgError(svg) {
  const match = svg.match(/\bdata-mjx-error="([^"]+)"/);
  return match ? decodeHtmlAttribute(match[1]) : undefined;
}

/**
 * Decodes the small set of HTML entities expected inside SVG attributes.
 *
 * @param {string} value Attribute value.
 * @returns {string}
 */
function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Formats TeX compactly for one-line output-channel diagnostics.
 *
 * @param {string} tex TeX source.
 * @returns {string}
 */
function formatTexForLog(tex) {
  const compactTex = tex.replace(/\s+/g, " ").trim();
  const truncatedTex = compactTex.length > 160 ? `${compactTex.slice(0, 157)}...` : compactTex;
  return `"${truncatedTex}"`;
}

/**
 * Makes a MathJax SVG fit inside hover images without clipping.
 *
 * @param {string} svg Raw MathJax SVG.
 * @returns {string}
 */
function makeSvgHoverFriendly(svg) {
  const sizedSvg = setSvgPixelSize(svg, 720);
  const hoverStyle = "background:transparent;";
  if (/<svg\b[^>]*\sstyle="/.test(sizedSvg)) {
    return sizedSvg.replace(/(<svg\b[^>]*\sstyle=")/, `$1${hoverStyle}`);
  }
  return sizedSvg.replace("<svg ", `<svg style="${hoverStyle}" `);
}

/**
 * Converts MathJax's ex-based dimensions into capped pixel dimensions.
 *
 * VS Code hover images can crop very wide SVGs; using the viewBox lets the
 * preview scale down while preserving the complete formula.
 *
 * @param {string} svg Raw MathJax SVG.
 * @param {number} maxWidthPx Maximum rendered width.
 * @returns {string}
 */
function setSvgPixelSize(svg, maxWidthPx) {
  const viewBoxMatch = svg.match(/\bviewBox="(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!viewBoxMatch) {
    return svg;
  }

  const viewBoxWidth = Number(viewBoxMatch[3]);
  const viewBoxHeight = Number(viewBoxMatch[4]);
  if (!Number.isFinite(viewBoxWidth) || !Number.isFinite(viewBoxHeight) || viewBoxWidth <= 0 || viewBoxHeight <= 0) {
    return svg;
  }

  const naturalWidthPx = Math.ceil((viewBoxWidth / 1000) * 16);
  const naturalHeightPx = Math.ceil((viewBoxHeight / 1000) * 16);
  const widthPx = Math.min(naturalWidthPx, maxWidthPx);
  const heightPx = Math.max(1, Math.ceil(naturalHeightPx * (widthPx / naturalWidthPx)));

  return upsertSvgAttribute(upsertSvgAttribute(svg, "width", `${widthPx}px`), "height", `${heightPx}px`);
}

/**
 * Adds or replaces an attribute on the root SVG element.
 *
 * @param {string} svg Raw SVG.
 * @param {string} attribute Attribute name.
 * @param {string} value Attribute value.
 * @returns {string}
 */
function upsertSvgAttribute(svg, attribute, value) {
  const pattern = new RegExp(`(<svg\\b[^>]*\\s)${attribute}="[^"]*"`);
  if (pattern.test(svg)) {
    return svg.replace(pattern, `$1${attribute}="${value}"`);
  }
  return svg.replace("<svg ", `<svg ${attribute}="${value}" `);
}

/**
 * Builds a nested heading tree for VS Code's Outline view.
 *
 * @param {import("./parser").HeadingEntry[]} headings Parsed headings.
 * @returns {vscode.DocumentSymbol[]}
 */
function buildHeadingTree(headings) {
  const roots = [];
  const stack = [];

  for (const heading of headings) {
    const symbol = new vscode.DocumentSymbol(
      formatHeadingSymbolName(heading),
      heading.label || "",
      vscode.SymbolKind.String,
      toRange(heading.range),
      toRange(heading.selectionRange),
    );

    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(symbol);
    } else {
      stack[stack.length - 1].symbol.children.push(symbol);
    }

    stack.push({ level: heading.level, symbol });
  }

  return roots;
}

/**
 * Formats a heading for Outline with its Markdown marker preserved.
 *
 * VS Code merges our symbols with the built-in Markdown provider, so keeping the
 * marker here makes the Pandoc-aware outline easy to distinguish from the built-in one.
 *
 * @param {import("./parser").HeadingEntry} heading Parsed heading.
 * @returns {string}
 */
function formatHeadingSymbolName(heading) {
  return `${"#".repeat(heading.level)} ${heading.title}`;
}

/**
 * Adds figure, table, and equation labels below their nearest heading symbol.
 *
 * @param {import("./parser").LabelEntry[]} labels Parsed label definitions.
 * @param {vscode.DocumentSymbol[]} headingSymbols Heading symbols.
 */
function addLabelSymbols(labels, headingSymbols) {
  const nonSectionLabels = labels.filter((entry) => entry.prefix !== "sec");
  const headingCandidates = flattenDocumentSymbols(headingSymbols);
  const labelSymbols = new Map(nonSectionLabels.map((label) => [label, createLabelSymbol(label)]));

  for (const label of nonSectionLabels) {
    const symbol = labelSymbols.get(label);
    const parentLabel = findNearestContainerLabel(nonSectionLabels, label);
    const parent = parentLabel ? labelSymbols.get(parentLabel) : findNearestHeadingSymbol(headingCandidates, label.line);

    if (parent) {
      parent.children.push(symbol);
    } else {
      headingSymbols.push(symbol);
    }
  }
}

/**
 * Creates a VS Code symbol for one parsed label definition.
 *
 * @param {import("./parser").LabelEntry} label Parsed label definition.
 * @returns {vscode.DocumentSymbol}
 */
function createLabelSymbol(label) {
  return new vscode.DocumentSymbol(
    label.label,
    label.kind,
    toSymbolKind(label.prefix),
    toRange(label.fullRange),
    toRange(label.range),
  );
}

/**
 * Flattens the heading tree before labels are inserted into it.
 *
 * @param {vscode.DocumentSymbol[]} symbols Heading symbols.
 * @returns {vscode.DocumentSymbol[]}
 */
function flattenDocumentSymbols(symbols) {
  const flattened = [];
  for (const symbol of symbols) {
    flattened.push(symbol, ...flattenDocumentSymbols(symbol.children));
  }
  return flattened;
}

/**
 * Finds the innermost heading symbol preceding a line.
 *
 * @param {vscode.DocumentSymbol[]} symbols Flat candidate heading symbols.
 * @param {number} line Target line.
 * @returns {vscode.DocumentSymbol | undefined}
 */
function findNearestHeadingSymbol(symbols, line) {
  let nearest;
  for (const symbol of symbols) {
    const symbolLine = symbol.selectionRange.start.line;
    if (symbolLine <= line) {
      nearest = symbol;
    }
  }
  return nearest;
}

/**
 * Finds the nearest div label that contains another label.
 *
 * This is the subfigure special case: only labels created from HTML div ids act
 * as outline containers, so ordinary image/table labels stay as siblings.
 *
 * @param {import("./parser").LabelEntry[]} labels Candidate labels.
 * @param {import("./parser").LabelEntry} child Child label.
 * @returns {import("./parser").LabelEntry | undefined}
 */
function findNearestContainerLabel(labels, child) {
  let nearest;
  for (const candidate of labels) {
    if (candidate === child || !candidate.containerRange) {
      continue;
    }
    if (!containsPosition(candidate.containerRange, { line: child.line, character: child.character })) {
      continue;
    }
    if (!nearest || isRangeStartAfter(candidate.containerRange, nearest.containerRange)) {
      nearest = candidate;
    }
  }
  return nearest;
}

/**
 * Checks whether one parser range starts after another range.
 *
 * @param {import("./parser").PlainRange} left Left range.
 * @param {import("./parser").PlainRange} right Right range.
 * @returns {boolean}
 */
function isRangeStartAfter(left, right) {
  if (left.start.line !== right.start.line) {
    return left.start.line > right.start.line;
  }
  return left.start.character > right.start.character;
}

/**
 * Updates diagnostics for all open Markdown documents.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnosticsForOpenDocuments(index, diagnostics) {
  for (const document of vscode.workspace.textDocuments) {
    if (isMarkdownDocument(document)) {
      updateDiagnostics(document, index, diagnostics);
    }
  }
}

/**
 * Updates diagnostics for one Markdown document.
 *
 * @param {vscode.TextDocument} document Markdown document.
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.DiagnosticCollection} diagnostics Diagnostic collection.
 */
function updateDiagnostics(document, index, diagnostics) {
  if (!getConfiguration().get("enableDiagnostics", true)) {
    diagnostics.delete(document.uri);
    return;
  }

  const parsed = index.getParsedDocument(document);
  const definitionMap = index.getDefinitionMap();
  const documentDiagnostics = [];

  for (const reference of parsed.references) {
    if (!definitionMap.has(reference.label)) {
      const diagnostic = new vscode.Diagnostic(
        toRange(reference.fullRange),
        `Undefined Pandoc cross reference: ${reference.label}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  for (const label of parsed.labels) {
    const definitions = definitionMap.get(label.label) || [];
    if (definitions.length > 1) {
      const diagnostic = new vscode.Diagnostic(
        toRange(label.fullRange),
        `Duplicate Pandoc label: ${label.label}`,
        vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = EXTENSION_NAME;
      documentDiagnostics.push(diagnostic);
    }
  }

  diagnostics.set(document.uri, documentDiagnostics);
}

/**
 * Returns the token at a document position.
 *
 * @param {PandocWorkspaceIndex} index Workspace index.
 * @param {vscode.TextDocument} document Markdown document.
 * @param {vscode.Position} position Cursor position.
 * @returns {{type: string, entry: import("./parser").LabelEntry | import("./parser").ReferenceEntry} | undefined}
 */
function getTokenAtDocumentPosition(index, document, position) {
  const parsed = index.getParsedDocument(document);
  return findTokenAtPosition(parsed, toPlainPosition(position));
}

/**
 * Converts a plain parser range into a VS Code range.
 *
 * @param {import("./parser").PlainRange} range Plain parser range.
 * @returns {vscode.Range}
 */
function toRange(range) {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

/**
 * Converts a parser entry to a VS Code location.
 *
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} entry Parsed entry.
 * @returns {vscode.Location}
 */
function toLocation(entry) {
  return new vscode.Location(vscode.Uri.parse(entry.uriText), toRange(entry.range));
}

/**
 * Converts a definition target into a VS Code location link.
 *
 * The origin range must cover the full Pandoc token; otherwise Ctrl-hover
 * falls back to VS Code word ranges and underlines only `sec` or `results`.
 *
 * @param {import("./parser").LabelEntry} target Definition target entry.
 * @param {import("./parser").LabelEntry | import("./parser").ReferenceEntry} origin Origin token under the cursor.
 * @returns {vscode.LocationLink}
 */
function toLocationLink(target, origin) {
  return {
    originSelectionRange: toRange(origin.fullRange),
    targetUri: vscode.Uri.parse(target.uriText),
    targetRange: toRange(target.fullRange),
    targetSelectionRange: toRange(target.range),
  };
}

/**
 * Converts a VS Code position into a serializable parser position.
 *
 * @param {vscode.Position} position VS Code position.
 * @returns {{line: number, character: number}}
 */
function toPlainPosition(position) {
  return { line: position.line, character: position.character };
}

/**
 * Returns a VS Code symbol kind for a Pandoc label prefix.
 *
 * @param {string} prefix Pandoc label prefix.
 * @returns {vscode.SymbolKind}
 */
function toSymbolKind(prefix) {
  if (prefix === "eq") {
    return vscode.SymbolKind.Number;
  }
  if (prefix === "fig") {
    return vscode.SymbolKind.Object;
  }
  if (prefix === "tbl") {
    return vscode.SymbolKind.Array;
  }
  return vscode.SymbolKind.String;
}

/**
 * Checks whether a document is a Markdown document.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isMarkdownDocument(document) {
  return document.languageId === "markdown" && (document.uri.scheme === "file" || document.uri.scheme === "untitled");
}

/**
 * Checks whether a Markdown document can be passed to the project build script.
 *
 * Untitled Markdown is useful for language features, but the DOCX build needs
 * a concrete file path so the build script can derive the output filename.
 *
 * @param {vscode.TextDocument} document Text document.
 * @returns {boolean}
 */
function isBuildableMarkdownDocument(document) {
  return document.languageId === "markdown" && document.uri.scheme === "file";
}

/**
 * Finds the manuscript template project root for a Markdown file.
 *
 * @param {vscode.Uri} markdownUri Markdown file URI.
 * @returns {Promise<PandocManuscriptProject | undefined>}
 */
async function findPandocManuscriptProject(markdownUri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(markdownUri);
  const stopAtPath = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
  let currentPath = path.dirname(markdownUri.fsPath);

  while (true) {
    const project = await readPandocManuscriptProject(vscode.Uri.file(currentPath));
    if (project) {
      return project;
    }

    if (stopAtPath && isSameFsPath(currentPath, stopAtPath)) {
      return undefined;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

/**
 * Returns manuscript project metadata when a directory has the required layout.
 *
 * These features intentionally match the local template's DOCX path: a build
 * script, the Python post-processing pipeline, and Pandoc DOCX defaults.
 *
 * @param {vscode.Uri} rootUri Candidate project root.
 * @returns {Promise<PandocManuscriptProject | undefined>}
 */
async function readPandocManuscriptProject(rootUri) {
  const buildScript = await firstExistingRelativePath(rootUri, BUILD_SCRIPT_CANDIDATES);
  if (!buildScript) {
    return undefined;
  }

  if (!(await firstExistingRelativePath(rootUri, POSTPROCESS_FEATURE_CANDIDATES))) {
    return undefined;
  }

  if (!(await pathExists(vscode.Uri.joinPath(rootUri, "pandoc")))) {
    return undefined;
  }

  if (!(await pathExists(vscode.Uri.joinPath(rootUri, "pandoc", "pandoc-docx.yml")))) {
    return undefined;
  }

  return { rootUri, buildScript };
}

/**
 * Returns the first existing project-relative path from a candidate list.
 *
 * @param {vscode.Uri} rootUri Candidate project root.
 * @param {string[]} relativePaths Project-relative path candidates.
 * @returns {Promise<string | undefined>}
 */
async function firstExistingRelativePath(rootUri, relativePaths) {
  for (const relativePath of relativePaths) {
    const parts = relativePath.split("/");
    if (await pathExists(vscode.Uri.joinPath(rootUri, ...parts))) {
      return relativePath;
    }
  }
  return undefined;
}

/**
 * Checks whether a file or directory exists.
 *
 * @param {vscode.Uri} uri File or directory URI.
 * @returns {Promise<boolean>}
 */
async function pathExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether an existing output file is likely locked by Word.
 *
 * The build overwrites and post-processes the DOCX in place. On Windows, Word
 * usually denies a read/write open while the document is open, so this catches
 * the common failure before Pandoc spends time rebuilding the manuscript.
 *
 * @param {vscode.Uri} uri Target DOCX URI.
 * @returns {Promise<boolean>}
 */
async function isFileLockedForOverwrite(uri) {
  if (!(await pathExists(uri))) {
    return false;
  }

  let handle;
  try {
    handle = await fs.open(uri.fsPath, "r+");
    return false;
  } catch (error) {
    return isFileLockError(error);
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

/**
 * Returns whether a filesystem error indicates a file lock or write denial.
 *
 * @param {any} error Filesystem error.
 * @returns {boolean}
 */
function isFileLockError(error) {
  return Boolean(error && ["EBUSY", "EPERM", "EACCES"].includes(error.code));
}

/**
 * Returns the modal warning text for a locked DOCX output file.
 *
 * @param {string} fileName DOCX filename.
 * @returns {string}
 */
function getCloseDocxBeforeBuildMessage(fileName) {
  if (isChineseVscodeLanguage()) {
    return `目标 Word 文件 ${fileName} 已经打开或无法写入。请先在 Word 中关闭它，然后再重新编译。`;
  }
  return `The target Word file ${fileName} is already open or not writable. Close it in Word, then try building again.`;
}

/**
 * Checks whether VS Code is currently using a Chinese UI locale.
 *
 * @returns {boolean}
 */
function isChineseVscodeLanguage() {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

/**
 * Returns the DOCX path produced by scripts/build.py for a Markdown input file.
 *
 * @param {vscode.Uri} rootUri Project root URI.
 * @param {vscode.Uri} markdownUri Markdown file URI.
 * @returns {vscode.Uri}
 */
function getExpectedDocxUri(rootUri, markdownUri) {
  const outputName = `${path.parse(markdownUri.fsPath).name}.docx`;
  return vscode.Uri.file(path.join(rootUri.fsPath, "output", "docx", outputName));
}

/**
 * Checks whether `uv` can be executed from the VS Code extension host.
 *
 * @returns {Promise<boolean>}
 */
async function isUvAvailable() {
  try {
    await runProcess("uv", ["--version"], {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a child process and optionally streams output to the extension channel.
 *
 * @param {string} command Command executable.
 * @param {string[]} args Command arguments.
 * @param {{cwd?: string, output?: vscode.OutputChannel}} options Process options.
 * @returns {Promise<void>}
 */
function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    if (options.output) {
      child.stdout.on("data", (chunk) => options.output.append(chunk.toString()));
      child.stderr.on("data", (chunk) => options.output.append(chunk.toString()));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Compares filesystem paths with Windows casing rules.
 *
 * @param {string} left Left path.
 * @param {string} right Right path.
 * @returns {boolean}
 */
function isSameFsPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

/**
 * Returns this extension's workspace configuration.
 *
 * @returns {vscode.WorkspaceConfiguration}
 */
function getConfiguration() {
  return vscode.workspace.getConfiguration("pandocManuscriptTools");
}

module.exports = {
  activate,
  deactivate,
};

/**
 * @typedef {{uri: vscode.Uri, version?: number, parsed: import("./parser").ParsedPandocDocument}} ParsedCacheEntry
 * @typedef {{rootUri: vscode.Uri, buildScript: string}} PandocManuscriptProject
 */
