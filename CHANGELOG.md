# Changelog

All notable changes to Pandoc Manuscript Tools are documented in this file.

## 0.0.5 - 2026-06-01

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
