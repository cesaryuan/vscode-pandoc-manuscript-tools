# Papper Tools

Local VS Code tools for this repository's Pandoc Markdown manuscript syntax.

## Features

- Go to definition for `@sec:*`, `@fig:*`, `@tbl:*`, and `@eq:*` references.
- In a file named `reply_to_reviewers.md`, definitions from the workspace-root `manuscript.md` are also available for navigation, hover summaries, completions, and undefined-reference diagnostics.
- Find all references for Pandoc labels and reference tokens.
- Hover cards for labels, references, display math blocks, and inline math spans with MathJax-rendered SVG previews. Math hovers work in Markdown, MDX, and LaTeX (`.tex`) editors.
- Hover previews for local SVG, EMF, and WMF image references in Markdown/MDX. SVG previews inline local `<image href>` assets before rendering, and EMF/WMF previews are shown through SVG preview sources.
- Optional paragraph translation hovers that show whether Google Translate or Microsoft Translator handled the current translation.
- English comment paragraph translations across code languages, using comment delimiters from built-in or installed language extensions and a small local scan around the mouse. Python triple-quoted text is also supported.
- Optional paragraph-level hover previews for Markdown paragraphs that contain inline math.
- A Pandoc-aware Outline provider that treats `$$ {#eq:label}` as a valid display-math closing delimiter.
- Pandoc-aware heading folding and full section ranges so heading folds and Sticky Scroll remain usable after labeled display math.
- Whole-line highlighting for Pandoc `fenced_divs` blocks, with subtle background colors that alternate by nesting depth.
- Inline highlighting for Pandoc bracketed spans such as `[Get out]{custom-style="Emphatically"}`.
- Inline folding for quoted line annotations such as ``(Line `quoted text`)``; moving the cursor into the code span temporarily reveals the excerpt for editing.
- Inline folding for the attribute block in `[revised text]{custom-style="Revision Char"}` spans; other custom styles remain visible.
- Completion suggestions after `@` using labels found in the current Markdown document.
- Context-aware YAML key and value completions for `style.yml`, including `pandocMetadata`, `reply`, named DOCX styles and inline mappings, with Chinese descriptions.
- Hover help for existing style YAML keys and values, showing Chinese descriptions, configuration paths, value hints and the current configuration.
- Completion and hover help in Markdown/MDX YAML headers, including manuscript metadata, author-list fields and local `papperSettings` overrides.
- Source-element hover buttons for headings, body text, pipe/grid table cells and images, adding missing settings with inline Chinese help to the current document's `papperSettings.docxStyle` header using effective reference DOCX defaults.
- A **Papper: 合并示例配置** text action above style YAML that recursively adds missing example settings while retaining existing values and comments.
- Diagnostics for undefined references and duplicate labels in the current Markdown document.
- Inlay hints for section, display-equation, labeled figure, and labeled table numbers resolved by Papper's processed Pandoc AST.
- A DOCX build button for any saved Markdown file, with each build written to a unique OS temporary directory and opened in Word. The Papper HTML preview button accepts any saved Markdown file when `papper` is on PATH or `uv` is available to install it, and renders its current unsaved changes.
- HTML preview lazily checks the project's local Papper service when first opened. A missing service is started once with `papper build html --start-server`; subsequent refreshes send the editor buffer to `/convert/raw` over HTTP and reuse the warm worker. Separate projects use separate local ports, and a lost connection triggers service recovery. This requires a Papper version that advertises `source_text` support in `/version`.
- An Image Directory Preview opened from a folder's Explorer context menu (`View Images`). It recursively discovers supported images from the selected folder and its subfolders through incremental batches, loads only images near the viewport, and provides Grid, Masonry, and Folder layouts. The `Cols` control changes the number of columns, and `Ctrl` + mouse wheel adjusts it without forcing a right-side editor split.
- Folder layout controls for collapsing or expanding all folder groups, plus Settings for scan depth and for including or excluding folders by case-insensitive path keywords.
- Image-card hover metadata for relative path, natural resolution, creation time, modification time, and file size. Right-click an image to copy the image itself, its workspace-relative or absolute path, or move it to the Recycle Bin after confirmation.

## Try It Locally

1. Open this repository folder in VS Code.
2. Run `npm install` once so the MathJax renderer is available.
3. Press `F5` to launch an Extension Development Host.
4. In the Extension Development Host, open the manuscript repository folder.
5. Open `manuscript.md` and try:
   - Ctrl-click `@eq:loss` or `@tbl:results`.
   - Run `Find All References` on `{#eq:loss}`.
   - Hover over an equation block or inline math span such as `$f(x)$` to see the rendered MathJax SVG preview.
   - Hover over an image reference such as `![icon](assets/document-icon.svg)` or `![icon](assets/document-icon.emf)` to see the rendered image preview.
   - Add a Pandoc fenced div such as `::: note` or `:::: {#special .sidebar}` and confirm the block is highlighted in the editor.
   - Add a Pandoc bracketed span such as `[Get out]{custom-style="Emphatically"}` and confirm the span is highlighted inline.
   - Add ``(Line `A quoted manuscript sentence`)`` and confirm the quoted text folds to an ellipsis until the cursor enters the code span.
   - Add `[revised text]{custom-style="Revision Char"}` and confirm only the `{custom-style="Revision Char"}` block folds to an ellipsis.
   - Click the editor-title build button in any saved Markdown file to build and open a temporary DOCX in Word.
   - Check the Outline after `## Mathematical Formulation`.
   - In Explorer, right-click a folder and choose `View Images` to open the recursive image directory preview in the current editor group.
   - In the preview, choose `Grid`, `Masonry`, or `Folder`; use `Cols` or `Ctrl` + mouse wheel to adjust the column count. In `Folder`, use the collapse/expand buttons and the settings button to control scan depth and folder filters.
   - Hover an image card to inspect its path, resolution, timestamps, and file size. Right-click a card to copy its path or delete the file after confirmation.

For build and packaging commands, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Commands

- `Papper Tools: Rebuild Index`
- `Papper Tools: Build DOCX and Open in Word`
- `Papper Tools: Install or Update Papper`
- `Papper Tools: Merge Style Example`
- `View Images` (Explorer folder context menu)

## Style Configuration Editing

Hover over a heading, body text, a pipe/grid table cell, or an image in a local Markdown/MDX document to see only the **Papper: 设置 标题 N / 正文文本 / Table Text / Image Caption 的样式** button. Click the action to read the actual reference defaults, add the corresponding style under the document's YAML `papperSettings.docxStyle`, and jump to it for editing. Newly inserted fields include Chinese descriptions as inline YAML comments; existing values and comments are retained. A missing YAML header is created automatically, the manuscript body is retained, and the edit can be undone in one step. English built-in names already in YAML are reused instead of adding duplicate Chinese aliases. Table captions use their separate `Table Caption` style, and paragraphs in a `custom-style` fenced div use that named style.

On the first click, defaults come from `papper build docx <current-source-snapshot> --export-reference-doc <temporary-path>`, including unsaved YAML overrides, source/project `style.yml`, language/reply settings and `PMT_REFERENCE_DOC`. The export skips manuscript conversion. The extension reads Word style inheritance, document defaults and theme fonts from the exported DOCX, then stores the parsed values in its persistent extension storage. Subsequent actions reuse the cache after normal body edits or extension restarts; hovering never launches Papper. Relevant YAML, style-file, reference-file or Papper executable changes invalidate it. Export requires an installed Papper version supporting `--export-reference-doc`; older versions show an update instruction when clicked instead of substituting guessed defaults.

The source-style feature lives in `src/manuscriptStyle/`. The action fills canonical fields only, preserving existing compatibility aliases such as `fontName` and `font.family`. Mutually exclusive first-line/character/hanging indentation controls are not inserted together. Word-only automatic spacing, automatic/theme colors and minimum line spacing are retained in the reference instead of converted to inaccurate overrides. Maps using YAML anchors or aliases must be expanded before editing so unrelated metadata is not changed indirectly.

Open `style.yml`, `style.yaml`, `style-project.yml` or `style-project.yaml` in a YAML editor. Type a configuration key, or press `Ctrl+Space`, to see Papper settings with Chinese descriptions. Value suggestions include booleans, MathType backends, line numbering, table autofit and DOCX text formatting. Nested suggestions follow `pandocMetadata`, `reply`, named `docxStyle` entries and their font, indentation and paragraph-spacing blocks. Arbitrary Word style names are supported. Existing keys, including configuration aliases, are omitted from new-key suggestions.

Hover over an existing field name or value to view its Chinese description, full configuration path, value hints and current configuration. Hover help follows nested blocks, inline mappings, configuration aliases and custom Word style names. Comments and unknown fields do not show Papper configuration help. This uses VS Code's normal editor hover and requires `editor.hover.enabled` to be enabled.

The same completion and hover help is available in the leading YAML header of Markdown/MDX documents, including unsaved buffers. Top-level suggestions cover manuscript metadata (`title`, `authors`, `abstract`, `keywords`, `bibliography`, `reply`), Pandoc cross-reference/citation settings and LaTeX class settings. Author mappings inside `authors` or `author` lists have their own field suggestions. Put local formatting/build overrides under `papperSettings` (or `papper-settings`); this block supports the same nested configuration as `style.yml`, including `reply.docxStyle` and `pandocMetadata`. Top-level `reply` denotes the manuscript path for reviewer replies. Header language help accepts `---` or `...` as a closing delimiter and remains available before that delimiter is typed. YAML examples in body code fences do not receive header configuration help.

Click **Papper: 合并示例配置** above the first line to merge the bundled Papper project starter into the current editor buffer. This action requires VS Code's `editor.codeLens` setting to be enabled; the same action is available as `Papper Tools: Merge Style Example` in the Command Palette. The starter is bundled from Papper's `template/style-project.yml`, so editing does not require Papper to be installed or its repository to be available.

The merge adds missing settings recursively. Existing values, including `false`, `null`, arrays and scalar font overrides, take priority. Commented optional examples remain comments and are not enabled. Existing comments and YAML anchors are retained, although YAML indentation and spacing may be normalized. The edit is not automatically saved and can be reversed with one Undo. Applying the same starter again makes no changes. Invalid YAML, duplicate keys, multiple YAML documents and a non-mapping root are rejected before editing.

## Settings

- `pandocManuscriptTools.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocManuscriptTools.enableNumberInlayHints`: show processed cross-reference numbers after a short editing pause. Hints are generated from the current buffer through `papper build json`; this background feature uses an installed Papper executable and does not install one automatically.
- `pandocManuscriptTools.includeWorkspaceReferences`: preload workspace Markdown files for the index cache; reference lookups stay scoped to the active document except for the built-in `reply_to_reviewers.md` → `manuscript.md` definition link.
- `pandocManuscriptTools.includeLabelSymbols`: show equation, figure, and table labels in the Outline.
- `pandocManuscriptTools.highlightFencedDivs`: highlight Pandoc `fenced_divs` blocks with whole-line background colors.
- `pandocManuscriptTools.highlightBracketedSpans`: highlight Pandoc bracketed spans with inline background colors.
- `pandocManuscriptTools.foldLineExcerptCodeSpans`: fold the quoted code span in annotations such as ``(Line `quoted text`)`` until the cursor enters it.
- `pandocManuscriptTools.foldRevisionCharSpanAttributes`: fold `{...}` only when the span's `custom-style` value is exactly `Revision Char`.
- `pandocManuscriptTools.enableInlineMathParagraphHover`: show a paragraph-level hover preview for Markdown paragraphs that contain inline math.
- `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters`: maximum paragraph length, in characters, that can show an inline-math paragraph hover preview.
- `pandocManuscriptTools.enableParagraphHoverTranslation`: show a translation for eligible English Markdown paragraphs and code comments, using Google Translate when available and Microsoft Translator as a fallback.
- `pandocManuscriptTools.paragraphHoverTranslationMaxCharacters`: maximum English paragraph length, in characters, that can request a paragraph hover translation.
- `pandocManuscriptTools.paragraphHoverTranslationTargetLanguage`: target language code for paragraph hover translations, for example `zh` or `zh-TW`.
- `pandocManuscriptTools.debugParagraphHoverTranslation`: log complete translation requests and responses for debugging. Defaults to `false`; normal logs show the engine, character counts, timing, and failures.
- `pandocManuscriptTools.imageDirectoryPreviewScanDepth`: maximum subfolder depth for Image Directory Preview. `-1` (default) scans all nested folders, `0` scans only the selected folder, and a positive integer scans that many subfolder levels.
- `pandocManuscriptTools.imageDirectoryPreviewIncludedFolderKeywords`: optional case-insensitive keywords; when set, only image folders whose root-relative path contains one of these keywords are included.
- `pandocManuscriptTools.imageDirectoryPreviewExcludedFolderKeywords`: optional case-insensitive keywords; matching folders are skipped, and exclusion takes precedence over inclusion.

## Notes

This extension is intentionally a small language-service layer rather than a full Markdown parser. It scans the Pandoc-crossref syntax used by this manuscript template and avoids code fences and YAML front matter to reduce false positives.

The math hover uses MathJax's Node component loader to convert TeX into SVG and embeds the SVG as a hover image. Raw TeX is shown only as a fallback when rendering fails. Display math and inline math are rendered separately, and inline math is not treated as a cross-reference source. Paragraph-level inline math hovers are disabled by default because they produce larger hover cards. Paragraph translations may make network requests; the extension probes Google Translate on startup, falls back to Microsoft Translator if Google is unavailable, and shows the engine used for each translated hover. If the preview is unavailable, run `npm install` in this folder and reload the Extension Development Host.

Code comment translation reads at most 30 lines before and after the hovered line. It loads and caches only the language extension's comment-delimiter configuration, without loading full grammars, parsing the entire document, or querying LSP/semantic tokens. Continuous standalone line comments are joined; blank lines or empty comments split paragraphs. Block comments are split by blank content lines, and documentation `*` prefixes are removed. Trailing comments translate only when the mouse is over the comment. Python triple-quoted strings and comment-shaped text inside ordinary strings are intentionally eligible. Short comments such as `Cache the result` are accepted. The existing translation toggle, target language, and character limit apply to both Markdown paragraphs and code comments.

This local scan is deliberately approximate. Block openers outside the scan window, nested block comments, and embedded languages can need more context than the scan provides. Paragraphs cut off by the window are suppressed rather than partially translated. Language support follows the comment configuration exposed by installed extensions; languages without such configuration may not have comment translations. Markdown/MDX keep their existing paragraph translation hovers.

Number inlay hints come from the AST generated by Papper's JSON build, so they follow the manuscript's active `pandoc-crossref` settings. Section hints use the processed heading number; figure and table hints require a source label so the AST can be mapped back to the Markdown line. A new AST is built from the current editor buffer after a short debounce, and hints from older document versions are hidden while the refreshed build is pending.

JSON builds keep temporary Markdown mirrors in the OS temporary directory. HTML previews send the editor buffer directly to Papper's service and keep server intermediates outside the manuscript project.

Image hovers resolve local Markdown and HTML image references for `.svg`, `.emf`, and `.wmf` files. SVG previews are embedded as self-contained data URIs so nested local `<image href>` references can use relative paths, absolute paths, or `file://` URLs. EMF and WMF previews use the bundled libemf2svg renderer and are returned as SVG so hover and side-preview rendering use the same inline-SVG display path. Metafile previews may differ from Windows GDI for complex clipping, raster operations, gradients, or unavailable fonts.

In an SVG diff, reopen the editor with **SVG Preview**, then click **Highlight changed areas** in the preview toolbar. The button outlines changed SVG elements on each available side; click it again to hide the outlines. The comparison uses the two SVG revisions and ignores XML whitespace, so it does not require VS Code's proposed text diff API. Changes to shared definitions or styles may outline a larger area because their visual effects can extend beyond one element.

The **Synchronize zoom** button in the SVG diff preview links both panes at the current pane's zoom level and scroll position. Zoom in, zoom out, actual size, fit to window, Ctrl+mouse wheel, both scrollbars, and drag-to-pan then move both sides together. Click the button again to let each side zoom and scroll independently.

If installation through the CERNET mirror fails, the extension retries `uv tool install papper` once without a custom index.

Run **Papper Tools: Install or Update Papper** from the Command Palette (`Ctrl+Shift+P`) to install Papper with uv when it is missing or update the uv-managed Papper installation. The command is available without an open Markdown file and requires `uv` on PATH. Progress appears in a notification and the **Papper Tools** output channel. On Simplified Chinese systems in UTC+8, the command first uses the CERNET PyPI mirror and falls back to the normal index if the mirror fails. If the active Papper executable is managed by another package manager, the command asks you to update it with that manager.

The DOCX build button and Command Palette entry are available for any saved Markdown file, without requiring `style.yml` or checking tool availability before showing the action. DOCX builds and HTML service startup use `papper` directly when it is available on PATH. If it is missing, the extension reuses an existing uv tool installation or runs `uv tool install papper` once, then invokes the installed executable directly. When the system locale is Simplified Chinese and the timezone is UTC+8, that first install uses the CERNET PyPI mirror. The extension checks uv-managed Papper for updates 60 seconds after activation and then every three hours, skipping attempts when the previous check was less than three hours ago; if it is outdated, it asks before running `uv tool upgrade papper`. Papper installed through another package manager is left to that manager. The DOCX command saves the source and runs `papper build docx <markdown-file> --output-file <temporary-directory>/<source-name>.docx` from the detected project root, or from the Markdown file's directory if no project is detected. Each build gets its own `pmt-docx-*` directory under the OS temporary directory, so rebuilding does not overwrite a document already open in Word. The extension logs the output path and retains the temporary DOCX for Word to open and edit; use Word's Save As to keep a permanent copy. If neither Papper nor uv is available, invoking the action reports the missing tools.

The HTML preview button accepts any saved Markdown file without requiring `style.yml` and opens a side Webview beside the Markdown editor. On first use it reads `~/.papper/projects/<project-id>/work/rust-v1/server-state.json` (Rust) or `pandoc-server.json` (legacy) and checks `/version` for the matching project and editor-text support. `PAPPER_HOME` overrides the managed root when set. If needed, it runs `papper build html <temporary-markdown-file> --start-server --server-port <available-port> --output-file <temporary-html-file>` once and verifies the requested HTTP endpoint. Papper must support service startup with Markdown outside the working-directory project. The empty startup source keeps an invalid or outdated disk version from blocking the current editor buffer; both startup files are removed afterwards. Debounced refreshes send `{"path":"<source-file>","text":"<editor-buffer>"}` to `/convert/raw` and update the existing Webview with the returned HTML. Project services remain available when the preview closes, and each project uses its own port. Preview builds use the detected Papper project root when available, the containing workspace folder otherwise, or the Markdown file's directory outside a workspace. Source and preview scrolling are synchronized proportionally. Double-click an image in the Papper preview to open an image-only preview box; use its controls or mouse wheel to zoom that image, drag it after enlarging, and press `Esc` to close.

Editor-to-preview synchronization follows viewport scrolling and settled mouse/keyboard cursor navigation. Drag selection, selection expansion, and typing/deleting/replacing text do not request synchronization. Mouse navigation waits 120 ms for selection events to settle; keyboard navigation updates at 60 ms intervals during continuous input. Viewport scrolling is forwarded on the next event-loop turn, coalesced per browser animation frame, and interpolated between source/block anchors to avoid paragraph-sized jumps. An existing selection does not prevent subsequent wheel scrolling from synchronizing. VS Code's public events do not identify the physical wheel or specific key, so scrollbar scrolling and other keyboard cursor navigation (such as Home/End) also synchronize.
