import * as vscode from "vscode";

/**
 * Returns this extension's workspace configuration.
 *
 * @returns {vscode.WorkspaceConfiguration}
 */
export function getConfiguration() {
  return vscode.workspace.getConfiguration("pandocManuscriptTools");
}

