# Pandoc Manuscript Tools

Local VS Code tools for this repository's Pandoc Markdown manuscript syntax.

## Features

- Go to definition for `@sec:*`, `@fig:*`, `@tbl:*`, and `@eq:*` references.
- Find all references for Pandoc labels and reference tokens.
- Hover cards for labels, references, display math blocks, and inline math spans with MathJax-rendered SVG previews.
- A Pandoc-aware Outline provider that treats `$$ {#eq:label}` as a valid display-math closing delimiter.
- Completion suggestions after `@` using labels found in Markdown files.
- Diagnostics for undefined references and duplicate labels.
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
   - Click the editor-title build button in `manuscript.md` to run the DOCX build and open `output/docx/manuscript.docx`.
   - Check the Outline after `## Mathematical Formulation`.

For build and packaging commands, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Commands

- `Pandoc Manuscript Tools: Rebuild Index`
- `Pandoc Manuscript Tools: Build DOCX and Open in Word`

## Settings

- `pandocManuscriptTools.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocManuscriptTools.includeWorkspaceReferences`: index all workspace Markdown files, not just open documents.
- `pandocManuscriptTools.includeLabelSymbols`: show equation, figure, and table labels in the Outline.

## Notes

This extension is intentionally a small language-service layer rather than a full Markdown parser. It scans the Pandoc-crossref syntax used by this manuscript template and avoids code fences and YAML front matter to reduce false positives.

The math hover uses MathJax's Node component loader to convert TeX into SVG, embeds the SVG as a hover image, and keeps the TeX source as a fallback. Display math and inline math are rendered separately, and inline math is not treated as a cross-reference source. If the preview is unavailable, run `npm install` in this folder and reload the Extension Development Host.

The DOCX build button is shown only when the active saved Markdown file belongs to a workspace folder that looks like this Pandoc manuscript template: it has `scripts/build.py` or `scripts/build`, the DOCX post-processing scripts, and `pandoc/pandoc-docx.yml`. The command runs `uv run <build-script> docx <markdown-file>` from the detected project root, then opens the generated file from `output/docx/`.
