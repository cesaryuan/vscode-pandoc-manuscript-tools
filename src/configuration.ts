import * as vscode from "vscode";

/**
 * Returns this extension's workspace configuration.
 *
 */
export function getConfiguration() {
  return vscode.workspace.getConfiguration("pandocManuscriptTools");
}

