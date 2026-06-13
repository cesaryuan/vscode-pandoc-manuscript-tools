# Changelog

All notable changes to Pandoc Manuscript Tools are documented in this file.

## 0.2.0 - 2026-06-13

### Added

- Add an opt-in `pandocManuscriptTools.enableInlineMathParagraphHover` setting that shows a paragraph-level hover preview for Markdown paragraphs containing inline math.
- Add `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters` to suppress paragraph-level inline math hover previews for long paragraphs.
- Add opt-in Google Translate-powered Chinese translations for short English paragraph hovers.
- Render inline math spans that remain in translated paragraph hover previews.

### Fixed

- Render MathJax hover previews for formulas with stretchy operators such as `\xleftarrow` by ignoring nested SVG fragments inside the complete preview.
- Scope Pandoc label definitions, references, completions, hover counts, and diagnostics to the active Markdown document so multiple open manuscripts do not share duplicate-label or reference statistics.

## 0.1.0 - 2026-06-01

### Added

- Add DOCX build button and functionality for Markdown files in Pandoc projects

### Changed

- Open DOCX build outputs from remote workspaces through a forwarded one-shot download URL so local Word can fetch and open the generated file.

### Fixed

- Use Word's read-only URL open mode and support HTTP `OPTIONS`, minimal WebDAV `PROPFIND`, and byte-range requests for forwarded remote DOCX downloads, improving SSH Remote compatibility.

## 0.0.6 - 2026-06-01

### Changed

- Expanded bundled MathJax newcm SVG dynamic module loading from the previously handled font chunks to all known newcm SVG dynamic chunks, so bundled hover previews can render formulas that need additional alphabets, symbols, arrows, and variant glyphs.
- Kept the Markdown profiling script aligned with the extension's bundled MathJax dynamic font loading path, so profile runs exercise the same fallback behavior as runtime hovers.

## 0.0.5 - 2026-06-01

### Added

- Added an editor-title button that appears for saved Markdown files in a detected Pandoc manuscript template project when `uv` is available, then runs the DOCX build and opens the generated Word file.
- 
### Changed

- Switched math hover rendering to MathJax's direct Node API so bundled VSIX builds can render previews without relying on the component loader startup path.
- Updated the Markdown profiling script to use the same MathJax renderer setup as the extension, keeping hover timing and bundled-font checks aligned with runtime behavior.

### Fixed

- Improved MathJax hover failures by logging the TeX source and SVG-level render errors when MathJax returns an error fragment instead of a usable preview.
- Kept wide inline formulas as a single hover image by disabling inline SVG linebreaking during MathJax rendering.
- Show the rendered equation preview when hovering Pandoc-crossref equation labels on display math delimiters, such as `{#eq:linear}`.

## 0.0.4 - 2026-06-01

### Fixed

- Fixed MathJax hover preview initialization in the Extension Development Host by loading the liteDOM adaptor through MathJax's component loader.
- Made MathJax hover preview SVG backgrounds transparent.
