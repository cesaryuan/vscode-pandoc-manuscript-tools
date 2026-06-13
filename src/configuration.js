"use strict";

const vscode = require("vscode");

/**
 * Returns this extension's workspace configuration.
 *
 * @returns {vscode.WorkspaceConfiguration}
 */
function getConfiguration() {
  return vscode.workspace.getConfiguration("pandocManuscriptTools");
}

module.exports = {
  getConfiguration,
};
