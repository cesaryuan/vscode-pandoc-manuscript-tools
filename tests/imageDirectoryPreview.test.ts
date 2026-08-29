import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDirectoryPreviewImageFile } from "../src/imageDirectoryPreview/imageTypes";
import { initializeDirectoryPreviewWebview, type DirectoryPreviewWebview } from "../src/imageDirectoryPreview/webviewInitialization";
import { buildDirectoryPreviewWebviewSecurityMarkup } from "../src/imageDirectoryPreview/webviewSecurity";
import { buildFolderVirtualRows, getShortestMasonryColumnIndex, getVirtualWindow } from "../src/imageDirectoryPreview/virtualScroll";
import { normalizeFolderKeywords, shouldIncludeDirectoryImages, shouldTraverseDirectory, type DirectoryPreviewFolderFilters } from "../src/imageDirectoryPreview/folderFilters";
import { getFolderHierarchy } from "../src/imageDirectoryPreview/folderHierarchy";
import { normalizePreviewRelativePath } from "../src/imageDirectoryPreview/relativePath";
import { clampColumnCount, getColumnCountBounds, getThumbnailSizeForColumns, getWheelAdjustedColumnCount } from "../src/imageDirectoryPreview/thumbnailColumns";
import { getImageAspectRatio, getNaturalImageHeight } from "../src/imageDirectoryPreview/imageSizing";
import { getImageHoverDetails } from "../src/imageDirectoryPreview/imageHoverDetails";
import { getNextScannableDirectoryWorkIndex, isDirectoryPaused } from "../src/imageDirectoryPreview/scanScheduling";
import { normalizeDirectoryPreviewScanDepth, shouldScanDirectoryAtDepth } from "../src/imageDirectoryPreview/scanDepth";

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

/** Reproduces a long gallery and verifies only a bounded viewport window stays mounted. */
function boundsTheMountedGalleryWindow(): void {
  const offsets = Array.from({ length: 10_001 }, (_, index) => index * 100);
  const window = getVirtualWindow(offsets, 500_000, 800, 400, 40);

  assert.ok(window.start > 0);
  assert.ok(window.end < 10_000);
  assert.ok(window.end - window.start <= 40);
  assert.equal(window.top, offsets[window.start]);
  assert.equal(window.bottom, offsets.at(-1)! - offsets[window.end]);
}

/** Verifies a virtual folder tree keeps parent-collapse semantics without mounting every descendant. */
function buildsVirtualFolderRowsAroundCollapsedBranches(): void {
  const items = [
    { name: "c.png", folder: "a/bb/ccc", resourceUri: "c" },
    { name: "a.png", folder: "a/bb/aaa", resourceUri: "a" },
    { name: "d.png", folder: "a/bb/ddd", resourceUri: "d" },
    { name: "z.png", folder: "z", resourceUri: "z" },
  ];
  const expanded = buildFolderVirtualRows(items, new Set(), 3);
  const collapsedBb = buildFolderVirtualRows(items, new Set(["a/bb"]), 3);
  const collapsedA = buildFolderVirtualRows(items, new Set(["a"]), 3);

  assert.deepEqual(expanded.folders.map((folder) => folder.path), ["a", "a/bb", "a/bb/ccc", "a/bb/aaa", "a/bb/ddd", "z"]);
  assert.deepEqual(collapsedBb.rows.filter((row) => row.kind === "folder").map((row) => row.folder.path), ["a", "a/bb", "z"]);
  assert.deepEqual(collapsedA.rows.filter((row) => row.kind === "folder").map((row) => row.folder.path), ["a", "z"]);
  assert.deepEqual(collapsedA.rows.filter((row) => row.kind === "cards").flatMap((row) => row.items.map((item) => item.resourceUri)), ["z"]);
}

/** Verifies the browser controller replaces its mounted window and drives it from scrolling. */
function mountsOnlyTheCurrentVirtualWindow(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");

  assert.match(controllerSource, /getVirtualWindow\(/);
  assert.match(controllerSource, /topSpacer\.style\.height = `\$\{virtualWindow\.top\}px`/);
  assert.match(controllerSource, /bottomSpacer\.style\.height = `\$\{virtualWindow\.bottom\}px`/);
  assert.match(controllerSource, /gallery\.append\(fragment\)/);
  assert.match(controllerSource, /scroll\.addEventListener\("scroll", \(\) => \{[\s\S]*?scheduleScrollWork\(\);/);
}

/** Verifies ordinary virtual-window scrolling does not clear the gallery before inserting rows. */
function reusesMountedRowsDuringScroll(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");
  const renderSource = controllerSource.match(/function renderVirtualGallery\(force = false\): void \{([\s\S]*?)\n  \}/)?.[1] || "";

  assert.match(renderSource, /if \(force\) \{[\s\S]*?clearMountedGallery\(\);/);
  assert.match(renderSource, /existingRows/);
  assert.match(renderSource, /gallery\.append\(fragment\)/);
  assert.doesNotMatch(renderSource, /clearMountedGallery\(\);[\s\S]*?const virtualWindow/);
}

/** Verifies an arriving scan batch updates rows incrementally instead of forcing a gallery teardown. */
function appendsScanBatchesWithoutForcedGalleryRebuild(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");
  const scanSource = controllerSource.match(/if \(message\?\.type !== "scanBatch"\)[\s\S]*?state\.skippedDirectories = Number\(message\.skippedDirectories\) \|\| 0;([\s\S]*?)updateStatus\(\);/)?.[1] || "";

  assert.match(scanSource, /rebuildVirtualRows\(\);\s*renderVirtualGallery\(\);/);
  assert.doesNotMatch(scanSource, /renderVirtualGallery\(true\)/);
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

/** Verifies scan depth retains root images while preventing deeper directory traversal. */
function boundsDirectoryTraversalAtTheConfiguredScanDepth(): void {
  assert.equal(normalizeDirectoryPreviewScanDepth(-1), -1);
  assert.equal(normalizeDirectoryPreviewScanDepth(0), 0);
  assert.equal(normalizeDirectoryPreviewScanDepth(2), 2);
  assert.equal(normalizeDirectoryPreviewScanDepth(1.5), -1);
  assert.equal(normalizeDirectoryPreviewScanDepth(-2), -1);
  assert.equal(shouldScanDirectoryAtDepth("", 0), true);
  assert.equal(shouldScanDirectoryAtDepth("figures", 0), false);
  assert.equal(shouldScanDirectoryAtDepth("figures", 1), true);
  assert.equal(shouldScanDirectoryAtDepth("figures/results", 1), false);
  assert.equal(shouldScanDirectoryAtDepth("figures/results", -1), true);
}

/** Verifies nested image folders expose every ancestor as an independently collapsible tree node. */
function buildsCollapsibleFolderAncestors(): void {
  assert.deepEqual(getFolderHierarchy("a/bb/ccc"), [
    { path: "a", parentPath: undefined, name: "a", depth: 0 },
    { path: "a/bb", parentPath: "a", name: "bb", depth: 1 },
    { path: "a/bb/ccc", parentPath: "a/bb", name: "ccc", depth: 2 },
  ]);
  assert.deepEqual(getFolderHierarchy("a\\bb\\ddd"), [
    { path: "a", parentPath: undefined, name: "a", depth: 0 },
    { path: "a/bb", parentPath: "a", name: "bb", depth: 1 },
    { path: "a/bb/ddd", parentPath: "a/bb", name: "ddd", depth: 2 },
  ]);
  assert.deepEqual(getFolderHierarchy(""), [
    { path: "", parentPath: undefined, name: "Top level", depth: 0 },
  ]);
}

/** Verifies virtual folder rendering keeps disclosure state outside short-lived DOM nodes. */
function rendersCollapsibleVirtualFolderSubtrees(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");
  const previewSource = readFileSync("src/imageDirectoryPreview/index.ts", "utf8");

  assert.match(controllerSource, /buildFolderVirtualRows\(state\.items, collapsedFolders, state\.columns\)/);
  assert.match(controllerSource, /const collapsed = collapsedFolders\.has\(folder\.path\)/);
  assert.match(controllerSource, /setFolderCollapsed\(folder, !collapsedFolders\.has\(folder\)\)/);
  assert.match(previewSource, /#gallery\.layout-folders \.folder-group/);
}

/** Reproduces a collapsed large branch: only that branch and its descendants stop scanning. */
function skipsCollapsedFolderBranchesUntilTheyReopen(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");
  const hostSource = readFileSync("src/imageDirectoryPreview/index.ts", "utf8");
  const pausedFolders = new Set(["a"]);

  assert.equal(isDirectoryPaused("a", pausedFolders), true);
  assert.equal(isDirectoryPaused("a/0001", pausedFolders), true);
  assert.equal(isDirectoryPaused("a/0001/nested", pausedFolders), true);
  assert.equal(isDirectoryPaused("b/0001", pausedFolders), false);
  assert.equal(isDirectoryPaused("", pausedFolders), false);
  assert.match(controllerSource, /type: "setCollapsedFolders",[\s\S]*?collapsedFolders:/);
  assert.match(hostSource, /message\.type === "setCollapsedFolders"/);
  assert.match(hostSource, /this\.scanner\.setPausedFolders\(collapsedFolders, resumedFolders\)/);
}

/** Reproduces reopening A after B is collapsed: the resumed A work must beat unrelated queued work. */
function prioritizesAnExplicitlyReopenedFolder(): void {
  const pendingDirectories = [
    { relativePath: "" },
    { relativePath: "a/0100" },
    { relativePath: "a/0101" },
    { relativePath: "b/0100" },
  ];

  assert.equal(getNextScannableDirectoryWorkIndex(pendingDirectories, new Set(["b"]), new Set(["a"])), 1);
  assert.equal(getNextScannableDirectoryWorkIndex(pendingDirectories, new Set(["a", "b"]), new Set(["a"])), 0);
}

/** Verifies discovery advances only from a user scroll/wheel action after the initial bounded batch. */
function scansMoreImagesOnlyWhenTheUserScrolls(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");

  assert.match(controllerSource, /function requestMoreIfNeeded\(\): void/);
  assert.match(controllerSource, /scroll\.addEventListener\("scroll", \(\) => \{[\s\S]*?scheduleScrollWork\(\);/);
  assert.match(controllerSource, /if \(!event\.ctrlKey\) \{[\s\S]*?scheduleScrollWork\(\);\s*return;/);
  assert.doesNotMatch(controllerSource, /scheduleBackgroundScan/);
  assert.doesNotMatch(controllerSource, /backgroundScanTimer/);
}

/** Verifies scan progress does not alternate its label while one user-triggered batch is in flight. */
function keepsScrollTriggeredScanStatusTextStable(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");
  const updateStatusSource = controllerSource.match(/function updateStatus\(\): void \{([\s\S]*?)\n  \}/)?.[1] || "";

  assert.doesNotMatch(updateStatusSource, /if \(state\.loading\)/);
  assert.match(updateStatusSource, /if \(state\.hasMore\) \{\s*status\.textContent = `\$\{state\.items\.length\} found · scroll to discover more`;/);
}

/** Reproduces an opening tree whose first bounded directory batches contain no images. */
function prefetchesOnlyEnoughEmptyOpeningBatchesToRenderTheFirstImages(): void {
  const controllerSource = readFileSync("src/imageDirectoryPreview/webview.ts", "utf8");

  assert.match(controllerSource, /const MAX_INITIAL_EMPTY_SCAN_REQUESTS = 3;/);
  assert.match(controllerSource, /!state\.items\.length[\s\S]*?state\.initialEmptyScanRequests < MAX_INITIAL_EMPTY_SCAN_REQUESTS[\s\S]*?requestNextPage\(\);/);
  assert.doesNotMatch(controllerSource, /setInterval\(/);
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

/** Verifies opening or reusing a preview does not force a right-side editor split. */
function opensDirectoryPreviewInTheCurrentEditorGroup(): void {
  const previewSource = readFileSync("src/imageDirectoryPreview/index.ts", "utf8");

  assert.match(previewSource, /IMAGE_DIRECTORY_PREVIEW_VIEW_TYPE,[\s\S]*?vscode\.ViewColumn\.Active,/);
  assert.match(previewSource, /existing\.panel\.reveal\(\);/);
  assert.doesNotMatch(previewSource, /ViewColumn\.Beside/);
}

test("recognizes images supported by the directory preview", verifiesSupportedDirectoryPreviewImages);
test("rejects unsupported directory-preview files", rejectsUnsupportedDirectoryPreviewFiles);
test("receives the directory preview boot request", deliversBootMessageAfterInstallingDirectoryPreviewListener);
test("loads its bootstrap code from an external CSP-approved script", usesExternalCspApprovedDirectoryPreviewScript);
test("keeps only a bounded gallery window mounted", boundsTheMountedGalleryWindow);
test("builds virtual folder rows while preserving parent collapse", buildsVirtualFolderRowsAroundCollapsedBranches);
test("mounts only the current virtual gallery window", mountsOnlyTheCurrentVirtualWindow);
test("reuses mounted rows during virtual scrolling", reusesMountedRowsDuringScroll);
test("appends scan batches without forcing a gallery rebuild", appendsScanBatchesWithoutForcedGalleryRebuild);
test("appends masonry cards to the current shortest stable column", choosesTheCurrentShortestMasonryColumn);
test("filters image folders with include and exclude keyword precedence", filtersDirectoryImagesWithPredictableKeywordPrecedence);
test("bounds directory traversal at the configured scan depth", boundsDirectoryTraversalAtTheConfiguredScanDepth);
test("builds a collapsible hierarchy for nested image folders", buildsCollapsibleFolderAncestors);
test("renders virtual folder subtrees behind their parent toggle", rendersCollapsibleVirtualFolderSubtrees);
test("skips a collapsed folder branch until it is reopened", skipsCollapsedFolderBranchesUntilTheyReopen);
test("prioritizes a folder explicitly reopened by the user", prioritizesAnExplicitlyReopenedFolder);
test("scans more directory images only while the user scrolls", scansMoreImagesOnlyWhenTheUserScrolls);
test("keeps scroll-triggered scan status text stable", keepsScrollTriggeredScanStatusTextStable);
test("prefetches only enough empty opening batches to render the first images", prefetchesOnlyEnoughEmptyOpeningBatchesToRenderTheFirstImages);
test("normalizes only safe root-relative image paths", normalizesSafePreviewRelativePaths);
test("constrains column count to the viewport and maps Ctrl-wheel direction", constrainsColumnCountToViewportAndWheelDirection);
test("derives Grid and Folder image height from the natural aspect ratio", derivesNaturalImageHeightFromAspectRatio);
test("gives stretched Grid and Folder card height to the thumbnail", givesStretchedGridCardHeightToTheThumbnail);
test("includes useful image hover metadata", includesUsefulImageHoverMetadata);
test("gives image cards distinct visual boundaries", givesImageCardsDistinctVisualBoundaries);
test("opens the directory preview in the current editor group", opensDirectoryPreviewInTheCurrentEditorGroup);
