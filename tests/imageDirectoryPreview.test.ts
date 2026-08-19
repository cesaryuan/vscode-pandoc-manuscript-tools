import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDirectoryPreviewImageFile } from "../src/imageDirectoryPreview/imageTypes";
import { initializeDirectoryPreviewWebview, type DirectoryPreviewWebview } from "../src/imageDirectoryPreview/webviewInitialization";
import { buildDirectoryPreviewWebviewSecurityMarkup } from "../src/imageDirectoryPreview/webviewSecurity";
import { getShortestMasonryColumnIndex, getStableGalleryAppendRange } from "../src/imageDirectoryPreview/virtualScroll";
import { normalizeFolderKeywords, shouldIncludeDirectoryImages, shouldTraverseDirectory, type DirectoryPreviewFolderFilters } from "../src/imageDirectoryPreview/folderFilters";
import { normalizePreviewRelativePath } from "../src/imageDirectoryPreview/relativePath";
import { clampColumnCount, getColumnCountBounds, getThumbnailSizeForColumns, getWheelAdjustedColumnCount } from "../src/imageDirectoryPreview/thumbnailColumns";
import { getImageAspectRatio, getNaturalImageHeight } from "../src/imageDirectoryPreview/imageSizing";
import { getImageHoverDetails } from "../src/imageDirectoryPreview/imageHoverDetails";

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

/** Verifies ordinary scrolling never causes existing gallery cards to be rebuilt. */
function appendsOnlyNewlyDiscoveredGalleryCards(): void {
  assert.deepEqual(getStableGalleryAppendRange(144, 144), { start: 144, end: 144 });
  assert.deepEqual(getStableGalleryAppendRange(72, 144), { start: 72, end: 144 });
  assert.deepEqual(getStableGalleryAppendRange(200, 144), { start: 0, end: 144 });
}

/** Verifies masonry appends to one stable column instead of rebalancing existing cards. */
function choosesTheCurrentShortestMasonryColumn(): void {
  assert.equal(getShortestMasonryColumnIndex([420, 280, 350]), 1);
  assert.equal(getShortestMasonryColumnIndex([280, 280, 350]), 0);
  assert.equal(getShortestMasonryColumnIndex([]), 0);
}

/** Verifies folder include keywords are case-insensitive and exclusion always wins. */
function filtersDirectoryImagesWithPredictableKeywordPrecedence(): void {
  const filters: DirectoryPreviewFolderFilters = {
    includedFolderKeywords: normalizeFolderKeywords([" Figures ", "supplement", "FIGURES"]),
    excludedFolderKeywords: normalizeFolderKeywords(["draft", "archive"]),
  };

  assert.deepEqual(filters.includedFolderKeywords, ["figures", "supplement"]);
  assert.equal(shouldTraverseDirectory("chapter/figures", filters), true);
  assert.equal(shouldTraverseDirectory("chapter/draft/figures", filters), false);
  assert.equal(shouldIncludeDirectoryImages("chapter/figures", filters), true);
  assert.equal(shouldIncludeDirectoryImages("chapter/supplement/data", filters), true);
  assert.equal(shouldIncludeDirectoryImages("chapter/images", filters), false);
  assert.equal(shouldIncludeDirectoryImages("chapter/archive/figures", filters), false);
}

/** Verifies copied preview paths stay root-relative and cannot escape through parent segments. */
function normalizesSafePreviewRelativePaths(): void {
  assert.equal(normalizePreviewRelativePath("figures\\result.png"), "figures/result.png");
  assert.equal(normalizePreviewRelativePath("figures/result.png"), "figures/result.png");
  assert.equal(normalizePreviewRelativePath("../outside.png"), undefined);
  assert.equal(normalizePreviewRelativePath("C:/outside.png"), undefined);
  assert.equal(normalizePreviewRelativePath("."), undefined);
}

/** Verifies column counts stay within the current viewport and Ctrl-wheel changes direction predictably. */
function constrainsColumnCountToViewportAndWheelDirection(): void {
  const bounds = getColumnCountBounds(800, 32);
  assert.deepEqual(bounds, { min: 1, max: 7 });
  assert.equal(clampColumnCount(12, bounds), 7);
  assert.equal(clampColumnCount(0, bounds), 1);
  assert.equal(getWheelAdjustedColumnCount(4, -100, bounds), 3);
  assert.equal(getWheelAdjustedColumnCount(4, 100, bounds), 5);
  assert.equal(getWheelAdjustedColumnCount(1, -100, bounds), 1);
  assert.equal(getWheelAdjustedColumnCount(7, 100, bounds), 7);
  assert.equal(getThumbnailSizeForColumns(800, 4, 32), 181);
}

/** Verifies Grid and Folder cards can derive their height from each image's natural ratio. */
function derivesNaturalImageHeightFromAspectRatio(): void {
  assert.equal(getImageAspectRatio(1200, 600), 2);
  assert.equal(getNaturalImageHeight(240, 2), 120);
  assert.equal(getImageAspectRatio(0, 0), 4 / 3);
}

/** Verifies shorter Grid and Folder cards give row-stretch height to their thumbnail rather than captions. */
function givesStretchedGridCardHeightToTheThumbnail(): void {
  const previewSource = readFileSync("src/imageDirectoryPreview/index.ts", "utf8");

  assert.match(previewSource, /\.image-card \{[^}]*display: flex;[^}]*flex-direction: column;/);
  assert.match(previewSource, /\.thumbnail \{[^}]*flex: 1 1 auto;/);
  assert.match(previewSource, /\.caption \{[^}]*flex: 0 0 auto;/);
}

/** Verifies an image hover surface includes the path, decoded resolution, filesystem times, and file size. */
function includesUsefulImageHoverMetadata(): void {
  assert.deepEqual(getImageHoverDetails({
    relativePath: "figures/result.png",
    width: 1600,
    height: 900,
    createdAt: 0,
    modifiedAt: 0,
    size: 1_536,
    filesystemMetadataLoaded: true,
  }), [
    { label: "Path", value: "figures/result.png" },
    { label: "Resolution", value: "1600 × 900 px" },
    { label: "Created", value: "Unavailable" },
    { label: "Modified", value: "Unavailable" },
    { label: "Size", value: "1.5 KB" },
  ]);
}

/** Verifies image cards retain visible spacing, an outer boundary, and a caption separator. */
function givesImageCardsDistinctVisualBoundaries(): void {
  const previewSource = readFileSync("src/imageDirectoryPreview/index.ts", "utf8");

  assert.match(previewSource, /--card-gap: 14px/);
  assert.match(previewSource, /\.image-card \{[^}]*border: 1px solid var\(--vscode-editorWidget-border/);
  assert.match(previewSource, /\.caption \{[^}]*border-top: 1px solid/);
  assert.match(previewSource, /\.image-card:hover \{[^}]*box-shadow:/);
}

test("recognizes images supported by the directory preview", verifiesSupportedDirectoryPreviewImages);
test("rejects unsupported directory-preview files", rejectsUnsupportedDirectoryPreviewFiles);
test("receives the directory preview boot request", deliversBootMessageAfterInstallingDirectoryPreviewListener);
test("loads its bootstrap code from an external CSP-approved script", usesExternalCspApprovedDirectoryPreviewScript);
test("appends only newly discovered cards to the stable gallery", appendsOnlyNewlyDiscoveredGalleryCards);
test("appends masonry cards to the current shortest stable column", choosesTheCurrentShortestMasonryColumn);
test("filters image folders with include and exclude keyword precedence", filtersDirectoryImagesWithPredictableKeywordPrecedence);
test("normalizes only safe root-relative image paths", normalizesSafePreviewRelativePaths);
test("constrains column count to the viewport and maps Ctrl-wheel direction", constrainsColumnCountToViewportAndWheelDirection);
test("derives Grid and Folder image height from the natural aspect ratio", derivesNaturalImageHeightFromAspectRatio);
test("gives stretched Grid and Folder card height to the thumbnail", givesStretchedGridCardHeightToTheThumbnail);
test("includes useful image hover metadata", includesUsefulImageHoverMetadata);
test("gives image cards distinct visual boundaries", givesImageCardsDistinctVisualBoundaries);
