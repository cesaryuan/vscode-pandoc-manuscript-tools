import assert from "node:assert/strict";
import test from "node:test";
import { isDirectoryPreviewImageFile } from "../src/imageDirectoryPreview/imageTypes";
import { initializeDirectoryPreviewWebview, type DirectoryPreviewWebview } from "../src/imageDirectoryPreview/webviewInitialization";
import { buildDirectoryPreviewWebviewSecurityMarkup } from "../src/imageDirectoryPreview/webviewSecurity";

/** Verifies the directory scanner accepts browser-previewable image extensions case-insensitively. */
function verifiesSupportedDirectoryPreviewImages(): void {
  assert.equal(isDirectoryPreviewImageFile("figure.PNG"), true);
  assert.equal(isDirectoryPreviewImageFile("diagram.SvG"), true);
  assert.equal(isDirectoryPreviewImageFile("photo.jpeg"), true);
  assert.equal(isDirectoryPreviewImageFile("preview.avif"), true);
}

/** Verifies the directory scanner does not pass arbitrary files to Webview image loading. */
function rejectsUnsupportedDirectoryPreviewFiles(): void {
  assert.equal(isDirectoryPreviewImageFile("notes.md"), false);
  assert.equal(isDirectoryPreviewImageFile("figure.emf"), false);
  assert.equal(isDirectoryPreviewImageFile("archive.png.bak"), false);
}

/** Verifies a first Webview scan request is delivered while its HTML evaluates. */
function deliversBootMessageAfterInstallingDirectoryPreviewListener(): void {
  type Message = { type: string };
  let listener: ((message: Message) => void) | undefined;
  const webview: DirectoryPreviewWebview<Message> = {
    get html(): string {
      return "";
    },
    set html(_value: string) {
      // This simulates the directory page posting `nextPage` during initial script evaluation.
      listener?.({ type: "nextPage" });
    },
    onDidReceiveMessage(nextListener: (message: Message) => void) {
      listener = nextListener;
      return {
        dispose(): void {
          listener = undefined;
        },
      };
    },
  };
  const receivedMessages: string[] = [];

  initializeDirectoryPreviewWebview(webview, "<script>postMessage()</script>", (message) => receivedMessages.push(message.type));

  assert.deepEqual(receivedMessages, ["nextPage"]);
}

/** Verifies the directory preview loads its boot code from a CSP-approved external file. */
function usesExternalCspApprovedDirectoryPreviewScript(): void {
  const markup = buildDirectoryPreviewWebviewSecurityMarkup("vscode-webview://test-source", "vscode-webview://test-source/dist/image-directory-preview.js");

  assert.match(markup, /script-src vscode-webview:\/\/test-source/);
  assert.match(markup, /<script defer src="vscode-webview:\/\/test-source\/dist\/image-directory-preview\.js"><\/script>/);
  assert.doesNotMatch(markup, /<script>\s*\(\(\) =>/);
}

test("recognizes images supported by the directory preview", verifiesSupportedDirectoryPreviewImages);
test("rejects unsupported directory-preview files", rejectsUnsupportedDirectoryPreviewFiles);
test("receives the directory preview boot request", deliversBootMessageAfterInstallingDirectoryPreviewListener);
test("loads its bootstrap code from an external CSP-approved script", usesExternalCspApprovedDirectoryPreviewScript);
