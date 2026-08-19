/**
 * Builds the CSP and external script tag for the directory-preview Webview.
 *
 * The initial implementation used a large inline bootstrap. Some Webview
 * environments left that script unexecuted, so the preview stayed at its static
 * startup label. Loading the same code from an extension-owned script URI gives
 * the browser an explicit CSP-approved source and makes startup deterministic.
 */

/**
 * Returns the security markup that permits only safe image URLs and the bundled
 * directory-preview script.
 *
 * @param cspSource VS Code-provided resource origin for this Webview.
 * @param scriptUri Extension-owned bundled script URI.
 */
export function buildDirectoryPreviewWebviewSecurityMarkup(cspSource: string, scriptUri: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeAttribute(cspSource)} data: blob:; style-src 'unsafe-inline'; script-src ${escapeAttribute(cspSource)};">
  <script defer src="${escapeAttribute(scriptUri)}"></script>`;
}

/** Escapes a generated URI before it is placed in an HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
