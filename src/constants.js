"use strict";

const EXTENSION_NAME = "Pandoc Manuscript Tools";
const PANDOC_SELECTOR = [{ language: "markdown" }, { language: "mdx" }];
const MATH_HOVER_SELECTOR = [...PANDOC_SELECTOR, { language: "latex" }];
const BUILD_DOCX_COMMAND = "pandocManuscriptTools.buildDocxAndOpen";
const CAN_BUILD_DOCX_CONTEXT = "pandocManuscriptTools.canBuildDocx";

module.exports = {
  EXTENSION_NAME,
  PANDOC_SELECTOR,
  MATH_HOVER_SELECTOR,
  BUILD_DOCX_COMMAND,
  CAN_BUILD_DOCX_CONTEXT,
};
