/** Minimal Webview surface needed to safely install the directory-preview message handler. */
export type DirectoryPreviewWebview<Message> = {
  html: string;
  onDidReceiveMessage(listener: (message: Message) => void): { dispose(): void };
};

/**
 * Subscribes to Webview messages before assigning bootstrapping HTML.
 *
 * The directory-preview script sends its first `nextPage` message immediately
 * while evaluating. Registering first prevents that request from being lost
 * during Webview startup, which otherwise leaves the page at its initial state.
 *
 * @param webview Webview that receives the initial scan request.
 * @param html Initial Webview document.
 * @param listener Handler for Webview messages.
 */
export function initializeDirectoryPreviewWebview<Message>(
  webview: DirectoryPreviewWebview<Message>,
  html: string,
  listener: (message: Message) => void,
): { dispose(): void } {
  const disposable = webview.onDidReceiveMessage(listener);
  webview.html = html;
  return disposable;
}
