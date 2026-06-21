# Pandoc Manuscript Tools

Local VS Code tools for this repository's Pandoc Markdown manuscript syntax.

## Features

- Go to definition for `@sec:*`, `@fig:*`, `@tbl:*`, and `@eq:*` references.
- Find all references for Pandoc labels and reference tokens.
- Hover cards for labels, references, display math blocks, and inline math spans with MathJax-rendered SVG previews.
- Optional paragraph translation hovers that show whether Google Translate or Microsoft Translator handled the current translation.
- Optional paragraph-level hover previews for Markdown paragraphs that contain inline math.
- A Pandoc-aware Outline provider that treats `$$ {#eq:label}` as a valid display-math closing delimiter.
- Whole-line highlighting for Pandoc `fenced_divs` blocks, with subtle background colors and left borders that alternate by nesting depth.
- Completion suggestions after `@` using labels found in the current Markdown document.
- Diagnostics for undefined references and duplicate labels in the current Markdown document.
- A DOCX build button in the editor title for saved Markdown files inside a detected Pandoc manuscript template project when `uv` is installed.

## Try It Locally

1. Open this repository folder in VS Code.
2. Run `npm install` once so the MathJax renderer is available.
3. Press `F5` to launch an Extension Development Host.
4. In the Extension Development Host, open the manuscript repository folder.
5. Open `manuscript.md` and try:
   - Ctrl-click `@eq:loss` or `@tbl:results`.
   - Run `Find All References` on `{#eq:loss}`.
   - Hover over an equation block or inline math span such as `$f(x)$` to see the rendered MathJax SVG preview.
   - Add a Pandoc fenced div such as `::: note` or `:::: {#special .sidebar}` and confirm the block is highlighted in the editor.
   - Click the editor-title build button in `manuscript.md` to run the DOCX build and open `output/docx/manuscript.docx`.
   - Check the Outline after `## Mathematical Formulation`.

For build and packaging commands, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Commands

- `Pandoc Manuscript Tools: Rebuild Index`
- `Pandoc Manuscript Tools: Build DOCX and Open in Word`

## Settings

- `pandocManuscriptTools.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocManuscriptTools.includeWorkspaceReferences`: preload workspace Markdown files for the index cache; reference lookups stay scoped to the active document.
- `pandocManuscriptTools.includeLabelSymbols`: show equation, figure, and table labels in the Outline.
- `pandocManuscriptTools.highlightFencedDivs`: highlight Pandoc `fenced_divs` blocks with whole-line background colors and left borders.
- `pandocManuscriptTools.enableInlineMathParagraphHover`: show a paragraph-level hover preview for Markdown paragraphs that contain inline math.
- `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters`: maximum paragraph length, in characters, that can show an inline-math paragraph hover preview.
- `pandocManuscriptTools.enableParagraphHoverTranslation`: show a translation for eligible English paragraph hovers, using Google Translate when available and Microsoft Translator as a fallback.
- `pandocManuscriptTools.paragraphHoverTranslationMaxCharacters`: maximum English paragraph length, in characters, that can request a paragraph hover translation.
- `pandocManuscriptTools.paragraphHoverTranslationTargetLanguage`: target language code for paragraph hover translations, for example `zh` or `zh-TW`.

## Notes

This extension is intentionally a small language-service layer rather than a full Markdown parser. It scans the Pandoc-crossref syntax used by this manuscript template and avoids code fences and YAML front matter to reduce false positives.

The math hover uses MathJax's Node component loader to convert TeX into SVG and embeds the SVG as a hover image. Raw TeX is shown only as a fallback when rendering fails. Display math and inline math are rendered separately, and inline math is not treated as a cross-reference source. Paragraph-level inline math hovers are disabled by default because they produce larger hover cards. Paragraph translations may make network requests; the extension probes Google Translate on startup, falls back to Microsoft Translator if Google is unavailable, and shows the engine used for each translated hover. If the preview is unavailable, run `npm install` in this folder and reload the Extension Development Host.

The DOCX build button is shown only when the active saved Markdown file belongs to a workspace folder that looks like this Pandoc manuscript template: it has `scripts/build.py` or `scripts/build`, the DOCX post-processing scripts, and `pandoc/pandoc-docx.yml`. The command runs `uv run <build-script> docx <markdown-file>` from the detected project root, then opens the generated file from `output/docx/`.
