# Pandoc Crossref Helper

Local VS Code helpers for this repository's Pandoc Markdown manuscript syntax.

## Features

- Go to definition for `@sec:*`, `@fig:*`, `@tbl:*`, and `@eq:*` references.
- Find all references for Pandoc labels and reference tokens.
- Hover cards for labels, references, and display math blocks.
- A Pandoc-aware Outline provider that treats `$$ {#eq:label}` as a valid display-math closing delimiter.
- Completion suggestions after `@` using labels found in Markdown files.
- Diagnostics for undefined references and duplicate labels.

## Try It Locally

1. Open this `vscode-pandoc-crossref-helper` folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the Extension Development Host, open the manuscript repository folder.
4. Open `manuscript.md` and try:
   - Ctrl-click `@eq:loss` or `@tbl:results`.
   - Run `Find All References` on `{#eq:loss}`.
   - Hover over an equation block.
   - Check the Outline after `## Mathematical Formulation`.

## Commands

- `Pandoc Crossref Helper: Rebuild Index`

## Settings

- `pandocCrossrefHelper.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocCrossrefHelper.includeWorkspaceReferences`: index all workspace Markdown files, not just open documents.
- `pandocCrossrefHelper.includeLabelSymbols`: show equation, figure, and table labels in the Outline.

## Notes

This extension is intentionally a small language-service layer rather than a full Markdown parser. It scans the Pandoc-crossref syntax used by this manuscript template and avoids code fences and YAML front matter to reduce false positives.

The math hover first emits Markdown math plus a TeX fallback. If your VS Code build or theme does not render math inside hovers, the next step is to add a MathJax SVG renderer and embed the generated SVG in the hover.
