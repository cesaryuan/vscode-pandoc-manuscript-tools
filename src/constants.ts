export const EXTENSION_NAME = "Pandoc Manuscript Tools";
export const PANDOC_SELECTOR = [{ language: "markdown" }, { language: "mdx" }];
export const MATH_HOVER_SELECTOR = [...PANDOC_SELECTOR, { language: "latex" }];
export const BUILD_DOCX_COMMAND = "pandocManuscriptTools.buildDocxAndOpen";
export const CAN_BUILD_DOCX_CONTEXT = "pandocManuscriptTools.canBuildDocx";
export const OPEN_IMAGE_PREVIEW_COMMAND = "pandocManuscriptTools.openImagePreviewToSide";
export const METAFILE_PREVIEW_EDITOR_VIEW_TYPE = "pandocManuscriptTools.metafilePreviewEditor";

