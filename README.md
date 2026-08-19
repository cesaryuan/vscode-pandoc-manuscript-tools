# Pandoc Manuscript Tools

Local VS Code tools for this repository's Pandoc Markdown manuscript syntax.

## Features

- Go to definition for `@sec:*`, `@fig:*`, `@tbl:*`, and `@eq:*` references.
- In a file named `reply_to_reviewers.md`, definitions from the workspace-root `manuscript.md` are also available for navigation, hover summaries, completions, and undefined-reference diagnostics.
- Find all references for Pandoc labels and reference tokens.
- Hover cards for labels, references, display math blocks, and inline math spans with MathJax-rendered SVG previews. Math hovers work in Markdown, MDX, and LaTeX (`.tex`) editors.
- Hover previews for local SVG, EMF, and WMF image references in Markdown/MDX. SVG previews inline local `<image href>` assets before rendering, and EMF/WMF previews are shown through SVG preview sources.
- Optional paragraph translation hovers that show whether Google Translate or Microsoft Translator handled the current translation.
- Optional paragraph-level hover previews for Markdown paragraphs that contain inline math.
- A Pandoc-aware Outline provider that treats `$$ {#eq:label}` as a valid display-math closing delimiter.
- Pandoc-aware heading folding and full section ranges so heading folds and Sticky Scroll remain usable after labeled display math.
- Whole-line highlighting for Pandoc `fenced_divs` blocks, with subtle background colors that alternate by nesting depth.
- Inline highlighting for Pandoc bracketed spans such as `[Get out]{custom-style="Emphatically"}`.
- Inline folding for quoted line annotations such as ``(Line `quoted text`)``; moving the cursor into the code span temporarily reveals the excerpt for editing.
- Inline folding for the attribute block in `[revised text]{custom-style="Revision Char"}` spans; other custom styles remain visible.
- Completion suggestions after `@` using labels found in the current Markdown document.
- Diagnostics for undefined references and duplicate labels in the current Markdown document.
- A DOCX build button in the editor title for saved Markdown files inside a detected Pandoc manuscript template project when `uv` is installed.
- An Image Directory Preview opened from a folder's Explorer context menu (`View Images`). It recursively discovers supported images from the selected folder and its subfolders through incremental batches, loads only images near the viewport, and provides Grid, Masonry, and Folder layouts. The `Cols` control changes the number of columns, and `Ctrl` + mouse wheel adjusts it without forcing a right-side editor split.
- Folder layout controls for collapsing or expanding all folder groups, plus Settings for including or excluding folders by case-insensitive path keywords.
- Image-card hover metadata for relative path, natural resolution, creation time, modification time, and file size. Right-click an image to copy its root-relative path, or move it to the Recycle Bin after confirmation.

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
   - Click the editor-title build button in `manuscript.md` to run the DOCX build and open `output/docx/manuscript.docx`.
   - Check the Outline after `## Mathematical Formulation`.
   - In Explorer, right-click a folder and choose `View Images` to open the recursive image directory preview in the current editor group.
   - In the preview, choose `Grid`, `Masonry`, or `Folder`; use `Cols` or `Ctrl` + mouse wheel to adjust the column count. In `Folder`, use the collapse/expand buttons and the settings button to control folder filters.
   - Hover an image card to inspect its path, resolution, timestamps, and file size. Right-click a card to copy its path or delete the file after confirmation.

For build and packaging commands, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Commands

- `Pandoc Manuscript Tools: Rebuild Index`
- `Pandoc Manuscript Tools: Build DOCX and Open in Word`
- `View Images` (Explorer folder context menu)

## Settings

- `pandocManuscriptTools.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocManuscriptTools.includeWorkspaceReferences`: preload workspace Markdown files for the index cache; reference lookups stay scoped to the active document except for the built-in `reply_to_reviewers.md` → `manuscript.md` definition link.
- `pandocManuscriptTools.includeLabelSymbols`: show equation, figure, and table labels in the Outline.
- `pandocManuscriptTools.highlightFencedDivs`: highlight Pandoc `fenced_divs` blocks with whole-line background colors.
- `pandocManuscriptTools.highlightBracketedSpans`: highlight Pandoc bracketed spans with inline background colors.
- `pandocManuscriptTools.foldLineExcerptCodeSpans`: fold the quoted code span in annotations such as ``(Line `quoted text`)`` until the cursor enters it.
- `pandocManuscriptTools.foldRevisionCharSpanAttributes`: fold `{...}` only when the span's `custom-style` value is exactly `Revision Char`.
- `pandocManuscriptTools.enableInlineMathParagraphHover`: show a paragraph-level hover preview for Markdown paragraphs that contain inline math.
- `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters`: maximum paragraph length, in characters, that can show an inline-math paragraph hover preview.
- `pandocManuscriptTools.enableParagraphHoverTranslation`: show a translation for eligible English paragraph hovers, using Google Translate when available and Microsoft Translator as a fallback.
- `pandocManuscriptTools.paragraphHoverTranslationMaxCharacters`: maximum English paragraph length, in characters, that can request a paragraph hover translation.
- `pandocManuscriptTools.paragraphHoverTranslationTargetLanguage`: target language code for paragraph hover translations, for example `zh` or `zh-TW`.
- `pandocManuscriptTools.imageDirectoryPreviewIncludedFolderKeywords`: optional case-insensitive keywords; when set, only image folders whose root-relative path contains one of these keywords are included.
- `pandocManuscriptTools.imageDirectoryPreviewExcludedFolderKeywords`: optional case-insensitive keywords; matching folders are skipped, and exclusion takes precedence over inclusion.

## Notes

This extension is intentionally a small language-service layer rather than a full Markdown parser. It scans the Pandoc-crossref syntax used by this manuscript template and avoids code fences and YAML front matter to reduce false positives.

The math hover uses MathJax's Node component loader to convert TeX into SVG and embeds the SVG as a hover image. Raw TeX is shown only as a fallback when rendering fails. Display math and inline math are rendered separately, and inline math is not treated as a cross-reference source. Paragraph-level inline math hovers are disabled by default because they produce larger hover cards. Paragraph translations may make network requests; the extension probes Google Translate on startup, falls back to Microsoft Translator if Google is unavailable, and shows the engine used for each translated hover. If the preview is unavailable, run `npm install` in this folder and reload the Extension Development Host.

Image hovers resolve local Markdown and HTML image references for `.svg`, `.emf`, and `.wmf` files. SVG previews are embedded as self-contained data URIs so nested local `<image href>` references can use relative paths, absolute paths, or `file://` URLs. EMF and WMF previews use the bundled libemf2svg renderer and are returned as SVG so hover and side-preview rendering use the same inline-SVG display path. Metafile previews may differ from Windows GDI for complex clipping, raster operations, gradients, or unavailable fonts.

The DOCX build button is shown only when the active saved Markdown file belongs to a workspace folder that looks like this Pandoc manuscript template: it has `scripts/build.py` or `scripts/build`, the DOCX post-processing scripts, and `pandoc/pandoc-docx.yml`. The command runs `uv run <build-script> docx <markdown-file>` from the detected project root, then opens the generated file from `output/docx/`.
