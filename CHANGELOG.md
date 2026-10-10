# Changelog

All notable changes to Papper Tools are documented in this file.

## Unreleased

### Added

- Extend configuration completion and hover help to leading Markdown/MDX YAML headers, including manuscript metadata, author lists and `papperSettings` overrides.
- Add source-element style hover buttons that fill missing heading, body, table-text and image-caption settings with inline descriptions in the current Markdown YAML header, using actual reference DOCX defaults with persistent caching and preservation of existing overrides.
- Add extra style actions for Pandoc spans and fenced Divs with `custom-style`, including nested elements; span actions use character-style defaults and omit paragraph-only settings while retaining contextual inheritance.
- Show source style actions in one row with a shared `Papper:` prefix; styles absent from the reference DOCX inherit actual body defaults, filtered to supported character fields for spans.

- Show Papper configuration hover help for existing style YAML fields and values, including nested styles, aliases and inline mappings.
- Add context-aware Papper style YAML completions and a top-of-editor CodeLens action that merges the bundled example without overwriting existing values or enabling commented settings.
- Translate nearby English code comment paragraphs using built-in and installed language extensions' comment delimiters, without querying language servers or parsing whole documents.
- Support standalone and trailing line comments, block comment paragraphs, and Python triple-quoted text, including short English comments.

### Changed

- Simplify YAML configuration hover help to descriptions and value hints.
- Check for uv-managed Papper updates every three hours instead of daily.
- Use existing label/reference maps for document lookups and diagnostics.
- Bound image and translation caches by recency and retained character count, and discard superseded image versions.
- Log translation timing and character counts by default; full text requires `debugParagraphHoverTranslation`.

### Fixed

- Keep the latest HTML preview request when switching documents, and reject obsolete results after asynchronous resource processing or panel disposal.
- Refresh expired Microsoft translation tokens and retry rejected authorization once.
- Decode local HTML resource paths while preserving query strings, fragments, and attribute escaping.
- Remove deleted manuscript definition sources from the index and refresh reviewer diagnostics after external file changes.
- Respect code-fence length and closing-line boundaries in both Pandoc parsing and fenced-div highlighting.
- Open DOCX files with Chinese and other Unicode Windows paths through the native file association, avoiding encoded file-URI launch failures.
- Show display-math hover previews for same-line `$$...$$` formulas, including trailing equation labels, while ignoring literal code and escaped delimiters.

## 0.3.0 - 2026-07-06

### Added

- Add hover previews for local SVG, EMF, and WMF image references in Markdown and MDX files.
- Add a side-preview command and read-only metafile preview editor for SVG, EMF, and WMF files.
- Support inline-SVG preview rendering for SVG assets, including local nested `<image href>` references, and keep WMF previews on the same inline-SVG display path.
- Render WMF previews through the bundled libemf2svg WASM renderer instead of the older PNG wrapper path.
- Support paragraph translation hovers inside standalone HTML comment blocks.
- Highlight Pandoc `fenced_divs` blocks in Markdown editors with subtle nesting-aware whole-line backgrounds.
- Highlight Pandoc bracketed spans such as `[Get out]{custom-style="Emphatically"}` with subtle inline backgrounds.

### Fixed

- Scale converted EMF and WMF SVG previews as a complete rendered image so shadows and other SVG effects stay aligned while zooming.

## 0.2.0 - 2026-06-13

### Added

- Show the actual Google Translate or Microsoft Translator engine used in paragraph translation hovers.
- Add an opt-in `pandocManuscriptTools.enableInlineMathParagraphHover` setting that shows a paragraph-level hover preview for Markdown paragraphs containing inline math.
- Add `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters` to suppress paragraph-level inline math hover previews for long paragraphs.
- Add opt-in Chinese translations for short English paragraph hovers.
- Fall back to Microsoft Translator for paragraph hover translations when Google Translate is unavailable at startup.
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
