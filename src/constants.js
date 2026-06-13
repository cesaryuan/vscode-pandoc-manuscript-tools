"use strict";

const EXTENSION_NAME = "Pandoc Manuscript Tools";
const MARKDOWN_SELECTOR = [{ language: "markdown" }];
const BUILD_DOCX_COMMAND = "pandocManuscriptTools.buildDocxAndOpen";
const CAN_BUILD_DOCX_CONTEXT = "pandocManuscriptTools.canBuildDocx";

module.exports = {
  EXTENSION_NAME,
  MARKDOWN_SELECTOR,
  BUILD_DOCX_COMMAND,
  CAN_BUILD_DOCX_CONTEXT,
};
