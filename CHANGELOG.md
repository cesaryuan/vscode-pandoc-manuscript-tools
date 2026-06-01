# Changelog

All notable changes to Pandoc Manuscript Tools are documented in this file.

## 0.0.5 - 2026-06-01

### Added

- Added an editor-title button that appears for saved Markdown files in a detected Pandoc manuscript template project when `uv` is available, then runs the DOCX build and opens the generated Word file.

## 0.0.4 - 2026-06-01

### Fixed

- Fixed MathJax hover preview initialization in the Extension Development Host by loading the liteDOM adaptor through MathJax's component loader.
- Made MathJax hover preview SVG backgrounds transparent.
