/*
 * Browser-side controller for the directory image-preview Webview.
 *
 * This is bundled as dist/image-directory-preview.js and loaded through a
 * Webview resource URI. Keeping it outside the HTML document avoids depending
 * on inline-script execution and lets the page use a restrictive CSP. It keeps
 * discovered image metadata in memory while mounting only a bounded set of
 * rows around the viewport. Spacer heights preserve scrolling as old cards and
 * folder headers are removed from the DOM.
 */

import { buildFolderVirtualRows, getShortestMasonryColumnIndex, getVirtualWindow } from "./virtualScroll";
import { clampColumnCount, DIRECTORY_PREVIEW_GAP_PX, getColumnCountBounds, getThumbnailSizeForColumns, getWheelAdjustedColumnCount } from "./thumbnailColumns";
import { getImageAspectRatio } from "./imageSizing";
import { getImageHoverDetails } from "./imageHoverDetails";
import type { FolderHierarchyNode } from "./folderHierarchy";

type DirectoryImage = {
  name: string;
  folder: string;
  resourceUri: string;
  src: string;
};

type ScanBatchMessage = {
  type: "scanBatch";
  items?: DirectoryImage[];
  hasMore?: boolean;
  skippedDirectories?: number;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type ImageFileMetadata = {
  createdAt?: number;
  modifiedAt?: number;
  size?: number;
};

type GalleryVirtualRow =
  | { key: string; kind: "cards"; folder?: FolderHierarchyNode; items: DirectoryImage[] }
  | { key: string; kind: "masonry"; items: DirectoryImage[] }
  | { key: string; kind: "folder"; folder: FolderHierarchyNode };

type WebviewMessage = ScanBatchMessage
  | { type: "reset" }
  | { type: "folderFilters"; includedFolderKeywords?: string[]; excludedFolderKeywords?: string[]; scanDepth?: number }
  | { type: "notice"; text?: string }
  | { type: "imageDeleted"; resourceUri?: string }
  | { type: "imageMetadata"; resourceUri?: string; createdAt?: number; modifiedAt?: number; size?: number };

type VsCodeApi = {
  postMessage(message: {
    type: string;
    resourceUri?: string;
    includedFolderKeywords?: string[];
    excludedFolderKeywords?: string[];
    scanDepth?: number;
    collapsedFolders?: string[];
    resumedFolders?: string[];
  }): void;
  getState(): { layout?: string; columns?: number; thumbnailSize?: number } | undefined;
  setState(state: { layout: string; columns: number }): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const IMAGE_LOAD_MARGIN_PX = 1_600;
const SCAN_PREFETCH_MARGIN_PX = 1_200;
const SCROLL_IDLE_DELAY_MS = 140;
const FOLDER_SCAN_SYNC_DELAY_MS = 40;
const MAX_INITIAL_EMPTY_SCAN_REQUESTS = 3;
const GALLERY_HORIZONTAL_INSET_PX = 32;
const VIRTUAL_OVERSCAN_PX = 1_600;
const MAX_MOUNTED_VIRTUAL_ROWS = 120;
const MASONRY_ITEMS_PER_COLUMN = 6;
const FOLDER_INDENT_PX = 30;
const CARD_CAPTION_HEIGHT_PX = 43;
const HOVER_DETAILS_GAP_PX = 10;
const HOVER_DETAILS_MAX_WIDTH_PX = 320;
const HOVER_DETAILS_VIEWPORT_MARGIN_PX = 8;

/** Runs the directory-preview browser controller once the external script loads. */
function startDirectoryPreview(): void {
  const status = getRequiredElement<HTMLSpanElement>("status");
  const vscode = acquireVsCodeApi();
  const scroll = getRequiredElement<HTMLElement>("scroll");
  const gallery = getRequiredElement<HTMLElement>("gallery");
  const topSpacer = getRequiredElement<HTMLElement>("top-spacer");
  const bottomSpacer = getRequiredElement<HTMLElement>("bottom-spacer");
  const layoutControl = getRequiredElement<HTMLSelectElement>("layout");
  const columnControl = getRequiredElement<HTMLInputElement>("column-count");
  const columnValue = getRequiredElement<HTMLOutputElement>("column-value");
  const continueScan = getRequiredElement<HTMLButtonElement>("continue-scan");
  const rescan = getRequiredElement<HTMLButtonElement>("rescan");
  const collapseFolders = getRequiredElement<HTMLButtonElement>("collapse-folders");
  const expandFolders = getRequiredElement<HTMLButtonElement>("expand-folders");
  const settingsButton = getRequiredElement<HTMLButtonElement>("settings");
  const settingsDialog = getRequiredElement<HTMLDialogElement>("directory-settings");
  const scanDepthInput = getRequiredElement<HTMLInputElement>("scan-depth");
  const includedFoldersInput = getRequiredElement<HTMLTextAreaElement>("included-folder-keywords");
  const excludedFoldersInput = getRequiredElement<HTMLTextAreaElement>("excluded-folder-keywords");
  const applySettings = getRequiredElement<HTMLButtonElement>("apply-settings");
  const closeSettings = getRequiredElement<HTMLButtonElement>("close-settings");
  const contextMenu = getRequiredElement<HTMLElement>("image-context-menu");
  const copyRelativePath = getRequiredElement<HTMLButtonElement>("copy-relative-path");
  const deleteImage = getRequiredElement<HTMLButtonElement>("delete-image");
  const notice = getRequiredElement<HTMLElement>("notice");
  const saved = vscode.getState() || {};
  const state = {
    items: [] as DirectoryImage[],
    hasMore: true,
    loading: false,
    initialEmptyScanRequests: 0,
    skippedDirectories: 0,
    layout: saved.layout || "grid",
    columns: Number(saved.columns) || 4,
    thumbnailSize: Number(saved.thumbnailSize) || 180,
    renderedStart: -1,
    renderedEnd: -1,
    renderFrame: 0,
    measureFrame: 0,
    scrolling: false,
    scrollIdleTimer: 0,
    folderScanSyncTimer: 0,
    collapseNewFolders: false,
    contextResourceUri: "",
    noticeTimer: 0,
  };
  const cardsByResourceUri = new Map<string, HTMLButtonElement>();
  const collapsedFolders = new Set<string>();
  const resumedFolders = new Set<string>();
  const knownFolders = new Map<string, FolderHierarchyNode>();
  const knownAspectRatios = new Map<string, number>();
  const knownImageDimensions = new Map<string, ImageDimensions>();
  const imageFileMetadata = new Map<string, ImageFileMetadata>();
  const requestedImageMetadata = new Set<string>();
  const resolvedImageMetadata = new Set<string>();
  const measuredRowHeights = new Map<string, number>();
  let virtualRows: GalleryVirtualRow[] = [];
  let virtualRowOffsets: number[] = [0];
  const imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const image = entry.target;
      if (!(image instanceof HTMLImageElement)) {
        continue;
      }
      if (entry.isIntersecting) {
        const source = image.dataset.src;
        if (source && !image.hasAttribute("src") && image.dataset.failed !== "true") {
          image.src = source;
        }
      } else if (image.hasAttribute("src")) {
        // Removing far-away sources releases decoded bitmaps while the stable
        // card skeleton retains its exact place in the layout.
        image.removeAttribute("src");
      }
    }
  }, { root: scroll, rootMargin: `${IMAGE_LOAD_MARGIN_PX}px 0px` });

  /** Persists only UI preferences; image metadata stays in the extension-host scan session. */
  function persistPreferences(): void {
    vscode.setState({ layout: state.layout, columns: state.columns });
  }

  /** Returns the current column-count interval based on the full scroll viewport width. */
  function getCurrentColumnCountBounds(): ReturnType<typeof getColumnCountBounds> {
    const viewportWidth = scroll.clientWidth || window.innerWidth;
    return getColumnCountBounds(viewportWidth, GALLERY_HORIZONTAL_INSET_PX);
  }

  /** Applies a layout and column-count change without requesting or loading every image. */
  function applyPreferences(): void {
    const bounds = getCurrentColumnCountBounds();
    state.columns = clampColumnCount(state.columns, bounds);
    const viewportWidth = scroll.clientWidth || window.innerWidth;
    state.thumbnailSize = getThumbnailSizeForColumns(viewportWidth, state.columns, GALLERY_HORIZONTAL_INSET_PX);
    document.documentElement.style.setProperty("--thumbnail-size", `${state.thumbnailSize}px`);
    // The virtual row builder groups exactly this many cards, so CSS must not
    // independently choose a smaller auto-fill track count and split a row.
    document.documentElement.style.setProperty("--gallery-columns", String(state.columns));
    layoutControl.value = state.layout;
    columnControl.min = String(bounds.min);
    columnControl.max = String(bounds.max);
    columnControl.value = String(state.columns);
    columnValue.textContent = `${state.columns}`;
    updateFolderControls();
    persistPreferences();
  }

  /** Applies a column-count request and rebuilds virtual row estimates around the current anchor. */
  function updateColumnCount(requestedColumns: number): void {
    const anchor = captureVisualAnchor();
    state.columns = requestedColumns;
    applyPreferences();
    measuredRowHeights.clear();
    rebuildVirtualRows();
    renderVirtualGallery(true);
    if (anchor) {
      requestAnimationFrame(() => restoreVisualAnchor(anchor));
    }
  }

  /** Shows global folder actions only when the folder-group layout is active. */
  function updateFolderControls(): void {
    const usesFolderLayout = state.layout === "folders";
    collapseFolders.hidden = !usesFolderLayout;
    expandFolders.hidden = !usesFolderLayout;
  }

  /** Returns the clamped thumbnail height used by a masonry card. */
  function getMasonryThumbnailHeight(aspectRatio: number): number {
    const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 4 / 3;
    return Math.max(state.thumbnailSize * 0.6, Math.min(state.thumbnailSize / ratio, state.thumbnailSize * 2.2));
  }

  /** Estimates a masonry card height without forcing browser layout. */
  function getMasonryCardHeight(aspectRatio: number): number {
    return getMasonryThumbnailHeight(aspectRatio) + CARD_CAPTION_HEIGHT_PX + DIRECTORY_PREVIEW_GAP_PX;
  }

  /** Creates one stable card whose bitmap is loaded only near the viewport. */
  function createCard(item: DirectoryImage): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "image-card";
    card.dataset.resourceUri = item.resourceUri;
    card.dataset.relativePath = item.folder ? `${item.folder}/${item.name}` : item.name;
    const knownAspectRatio = knownAspectRatios.get(item.resourceUri);
    if (knownAspectRatio) {
      applyCardAspectRatio(card, knownAspectRatio);
    }
    const thumbnail = document.createElement("span");
    thumbnail.className = "thumbnail";
    const image = document.createElement("img");
    image.dataset.src = item.src;
    image.alt = item.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => {
      card.classList.remove("is-failed");
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        const aspectRatio = getImageAspectRatio(image.naturalWidth, image.naturalHeight);
        knownAspectRatios.set(item.resourceUri, aspectRatio);
        knownImageDimensions.set(item.resourceUri, { width: image.naturalWidth, height: image.naturalHeight });
        applyCardAspectRatio(card, aspectRatio);
        updateImageHoverDetails(card);
        scheduleVirtualRowMeasurement();
      }
    });
    image.addEventListener("error", () => {
      image.dataset.failed = "true";
      card.classList.add("is-failed");
    }, { once: true });
    thumbnail.append(image);
    const caption = document.createElement("span");
    caption.className = "caption";
    caption.textContent = item.name;
    const hoverDetails = document.createElement("span");
    hoverDetails.className = "hover-details";
    hoverDetails.setAttribute("aria-hidden", "true");
    card.append(thumbnail, caption, hoverDetails);
    cardsByResourceUri.set(item.resourceUri, card);
    updateImageHoverDetails(card);
    imageObserver.observe(image);
    return card;
  }

  /** Applies a decoded image ratio to Grid and Folder cards without affecting the Masonry height policy. */
  function applyCardAspectRatio(card: HTMLButtonElement, aspectRatio: number): void {
    card.style.setProperty("--image-aspect-ratio", String(aspectRatio));
    card.style.setProperty("--masonry-thumbnail-height", `${getMasonryThumbnailHeight(aspectRatio)}px`);
  }

  /** Renders cached decoded and filesystem data into a card's compact hover-only detail surface. */
  function updateImageHoverDetails(card: HTMLButtonElement): void {
    const resourceUri = card.dataset.resourceUri;
    const relativePath = card.dataset.relativePath;
    const details = card.querySelector<HTMLElement>(".hover-details");
    if (!resourceUri || !relativePath || !details) {
      return;
    }
    const dimensions = knownImageDimensions.get(resourceUri);
    const filesystemMetadata = imageFileMetadata.get(resourceUri);
    const fragment = document.createDocumentFragment();
    for (const detail of getImageHoverDetails({
      relativePath,
      width: dimensions?.width,
      height: dimensions?.height,
      createdAt: filesystemMetadata?.createdAt,
      modifiedAt: filesystemMetadata?.modifiedAt,
      size: filesystemMetadata?.size,
      filesystemMetadataLoaded: resolvedImageMetadata.has(resourceUri),
    })) {
      const line = document.createElement("span");
      line.className = "hover-detail";
      const label = document.createElement("span");
      label.className = "hover-detail-label";
      label.textContent = detail.label;
      const value = document.createElement("span");
      value.className = "hover-detail-value";
      value.textContent = detail.value;
      line.append(label, value);
      fragment.append(line);
    }
    details.replaceChildren(fragment);
  }

  /** Positions metadata in the larger viewport-side space without covering its source card. */
  function positionHoverDetails(card: HTMLButtonElement): void {
    const details = card.querySelector<HTMLElement>(".hover-details");
    if (!details) {
      return;
    }
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const cardBounds = card.getBoundingClientRect();
    const leftSpace = Math.max(0, cardBounds.left - HOVER_DETAILS_VIEWPORT_MARGIN_PX);
    const rightSpace = Math.max(0, viewportWidth - cardBounds.right - HOVER_DETAILS_VIEWPORT_MARGIN_PX);
    const showOnRight = rightSpace >= leftSpace;
    const availableWidth = Math.max(0, (showOnRight ? rightSpace : leftSpace) - HOVER_DETAILS_GAP_PX);
    const detailWidth = Math.min(HOVER_DETAILS_MAX_WIDTH_PX, availableWidth);
    const left = showOnRight
      ? cardBounds.right + HOVER_DETAILS_GAP_PX
      : cardBounds.left - HOVER_DETAILS_GAP_PX - detailWidth;
    const top = Math.max(
      HOVER_DETAILS_VIEWPORT_MARGIN_PX,
      Math.min(cardBounds.top, viewportHeight - HOVER_DETAILS_VIEWPORT_MARGIN_PX),
    );
    details.style.setProperty("--hover-details-left", `${left}px`);
    details.style.setProperty("--hover-details-top", `${top}px`);
    details.style.setProperty("--hover-details-width", `${detailWidth}px`);
  }

  /** Requests filesystem metadata once per card, keeping large directory scans free of per-image stat calls. */
  function requestImageMetadata(resourceUri: string): void {
    if (requestedImageMetadata.has(resourceUri)) {
      return;
    }
    requestedImageMetadata.add(resourceUri);
    vscode.postMessage({ type: "requestImageMetadata", resourceUri });
  }

  /** Estimates one Grid or Folder card row before that row has been measured. */
  function estimateCardRowHeight(items: readonly DirectoryImage[]): number {
    let tallestCard = state.thumbnailSize + CARD_CAPTION_HEIGHT_PX;
    for (const item of items) {
      const aspectRatio = knownAspectRatios.get(item.resourceUri) || 1;
      tallestCard = Math.max(tallestCard, state.thumbnailSize / aspectRatio + CARD_CAPTION_HEIGHT_PX);
    }
    return tallestCard + DIRECTORY_PREVIEW_GAP_PX;
  }

  /** Estimates one independently balanced Masonry block before browser measurement. */
  function estimateMasonryRowHeight(items: readonly DirectoryImage[]): number {
    const heights = Array.from({ length: state.columns }, () => 0);
    const cardCounts = Array.from({ length: state.columns }, () => 0);
    for (const item of items) {
      const columnIndex = getShortestMasonryColumnIndex(heights);
      const aspectRatio = knownAspectRatios.get(item.resourceUri) || 4 / 3;
      if (cardCounts[columnIndex]) {
        heights[columnIndex] += DIRECTORY_PREVIEW_GAP_PX;
      }
      heights[columnIndex] += getMasonryCardHeight(aspectRatio) - DIRECTORY_PREVIEW_GAP_PX;
      cardCounts[columnIndex] += 1;
    }
    return Math.max(...heights, 0) + DIRECTORY_PREVIEW_GAP_PX;
  }

  /** Returns the cached or conservative height of one virtual row. */
  function getVirtualRowHeight(row: GalleryVirtualRow): number {
    const measured = measuredRowHeights.get(row.key);
    if (measured !== undefined) {
      return measured;
    }
    if (row.kind === "folder") {
      return 48;
    }
    if (row.kind === "masonry") {
      return estimateMasonryRowHeight(row.items);
    }
    return estimateCardRowHeight(row.items);
  }

  /** Recomputes prefix offsets after row data or measured heights change. */
  function rebuildVirtualOffsets(): void {
    virtualRowOffsets = [0];
    for (const row of virtualRows) {
      virtualRowOffsets.push(virtualRowOffsets.at(-1)! + getVirtualRowHeight(row));
    }
  }

  /** Rebuilds lightweight row metadata without creating any browser nodes. */
  function rebuildVirtualRows(): void {
    knownFolders.clear();
    if (state.layout === "folders") {
      let folderLayout = buildFolderVirtualRows(state.items, collapsedFolders, state.columns);
      let addedCollapsedFolder = false;
      for (const folder of folderLayout.folders) {
        knownFolders.set(folder.path, folder);
        if (state.collapseNewFolders && !collapsedFolders.has(folder.path)) {
          collapsedFolders.add(folder.path);
          addedCollapsedFolder = true;
        }
      }
      if (addedCollapsedFolder) {
        folderLayout = buildFolderVirtualRows(state.items, collapsedFolders, state.columns);
      }
      virtualRows = folderLayout.rows;
    } else {
      const itemsPerRow = state.layout === "masonry"
        ? Math.max(1, state.columns * MASONRY_ITEMS_PER_COLUMN)
        : Math.max(1, state.columns);
      virtualRows = [];
      for (let start = 0; start < state.items.length; start += itemsPerRow) {
        const items = state.items.slice(start, start + itemsPerRow);
        if (state.layout === "masonry") {
          virtualRows.push({ key: `masonry:${start}:${items[0]?.resourceUri ?? start}:${items.at(-1)?.resourceUri ?? start}:${items.length}`, kind: "masonry", items });
        } else {
          virtualRows.push({ key: `cards:${start}:${items[0]?.resourceUri ?? start}:${items.at(-1)?.resourceUri ?? start}:${items.length}`, kind: "cards", items });
        }
      }
    }
    rebuildVirtualOffsets();
    state.renderedStart = -1;
    state.renderedEnd = -1;
  }

  /** Disconnects transient images and clears maps that refer only to mounted nodes. */
  function clearMountedGallery(): void {
    imageObserver.disconnect();
    cardsByResourceUri.clear();
    gallery.replaceChildren();
  }

  /** Removes one virtual row and unregisters only the cards that leave the DOM window. */
  function removeMountedRow(row: HTMLElement): void {
    for (const image of row.querySelectorAll<HTMLImageElement>("img")) {
      imageObserver.unobserve(image);
    }
    for (const card of row.querySelectorAll<HTMLButtonElement>(".image-card")) {
      const resourceUri = card.dataset.resourceUri;
      if (resourceUri) {
        cardsByResourceUri.delete(resourceUri);
      }
    }
    row.remove();
  }

  /** Creates a normal Grid or indented Folder card row. */
  function createCardRow(row: Extract<GalleryVirtualRow, { kind: "cards" }>): HTMLElement {
    const element = document.createElement("div");
    element.className = row.folder ? "virtual-row virtual-card-row folder-grid" : "virtual-row virtual-card-row";
    element.dataset.virtualRowKey = row.key;
    if (row.folder) {
      element.style.paddingLeft = `${row.folder.depth * FOLDER_INDENT_PX}px`;
    }
    for (const item of row.items) {
      element.append(createCard(item));
    }
    return element;
  }

  /** Creates one bounded Masonry block with deterministic shortest-column placement. */
  function createMasonryRow(row: Extract<GalleryVirtualRow, { kind: "masonry" }>): HTMLElement {
    const element = document.createElement("div");
    element.className = "virtual-row virtual-masonry-row";
    element.dataset.virtualRowKey = row.key;
    const columns = Array.from({ length: state.columns }, () => {
      const column = document.createElement("div");
      column.className = "masonry-column";
      element.append(column);
      return column;
    });
    const heights = Array.from({ length: state.columns }, () => 0);
    for (const item of row.items) {
      const columnIndex = getShortestMasonryColumnIndex(heights);
      const aspectRatio = knownAspectRatios.get(item.resourceUri) || 4 / 3;
      columns[columnIndex].append(createCard(item));
      heights[columnIndex] += getMasonryCardHeight(aspectRatio);
    }
    return element;
  }

  /** Creates one short-lived folder header whose collapse state lives outside the DOM. */
  function createFolderRow(row: Extract<GalleryVirtualRow, { kind: "folder" }>): HTMLElement {
    const folder = row.folder;
    const collapsed = collapsedFolders.has(folder.path);
    const group = document.createElement("section");
    group.className = `virtual-row folder-group${collapsed ? " is-collapsed" : ""}`;
    group.dataset.folder = folder.path;
    group.dataset.depth = String(folder.depth);
    group.dataset.virtualRowKey = row.key;
    group.style.paddingLeft = `${folder.depth * FOLDER_INDENT_PX}px`;
    group.style.setProperty("--folder-guide-offset", `${folder.depth * FOLDER_INDENT_PX}px`);
    const heading = document.createElement("h2");
    heading.className = "folder-heading";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    toggle.dataset.folder = folder.path;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", folder.path ? `Folder ${folder.path}` : "Top-level images");
    toggle.title = `${collapsed ? "Expand" : "Collapse"} ${folder.path || folder.name}`;
    const disclosure = document.createElement("span");
    disclosure.className = "folder-disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "folder-icon";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = folder.name;
    toggle.append(disclosure, icon, name);
    heading.append(toggle);
    group.append(heading);
    return group;
  }

  /** Mounts one virtual row according to the active layout. */
  function createVirtualRow(row: GalleryVirtualRow): HTMLElement {
    if (row.kind === "folder") {
      return createFolderRow(row);
    }
    if (row.kind === "masonry") {
      return createMasonryRow(row);
    }
    return createCardRow(row);
  }

  /** Replaces the DOM with only the rows near the viewport and maintains spacer heights. */
  function renderVirtualGallery(force = false): void {
    const virtualWindow = getVirtualWindow(
      virtualRowOffsets,
      scroll.scrollTop,
      scroll.clientHeight || window.innerHeight,
      VIRTUAL_OVERSCAN_PX,
      MAX_MOUNTED_VIRTUAL_ROWS,
    );
    if (!force && virtualWindow.start === state.renderedStart && virtualWindow.end === state.renderedEnd) {
      return;
    }
    if (force) {
      clearMountedGallery();
    }
    gallery.className = `layout-${state.layout}`;
    topSpacer.style.height = `${virtualWindow.top}px`;
    bottomSpacer.style.height = `${virtualWindow.bottom}px`;
    const existingRows = new Map<string, HTMLElement>();
    for (const row of gallery.querySelectorAll<HTMLElement>("[data-virtual-row-key]")) {
      const key = row.dataset.virtualRowKey;
      if (key) {
        existingRows.set(key, row);
      }
    }
    const nextKeys = new Set(virtualRows.slice(virtualWindow.start, virtualWindow.end).map((row) => row.key));
    for (const [key, row] of existingRows) {
      if (!nextKeys.has(key)) {
        removeMountedRow(row);
        existingRows.delete(key);
      }
    }
    const fragment = document.createDocumentFragment();
    for (const row of virtualRows.slice(virtualWindow.start, virtualWindow.end)) {
      fragment.append(existingRows.get(row.key) || createVirtualRow(row));
    }
    // Append moves reused rows into order without exposing an intermediate empty gallery.
    gallery.append(fragment);
    state.renderedStart = virtualWindow.start;
    state.renderedEnd = virtualWindow.end;
    scheduleVirtualRowMeasurement();
  }

  /** Measures mounted rows after layout settles and corrects spacer estimates without moving the visible window. */
  function scheduleVirtualRowMeasurement(): void {
    if (state.measureFrame || state.scrolling) {
      return;
    }
    state.measureFrame = requestAnimationFrame(() => {
      state.measureFrame = 0;
      const oldTop = virtualRowOffsets[state.renderedStart] ?? 0;
      let changed = false;
      for (const element of gallery.querySelectorAll<HTMLElement>("[data-virtual-row-key]")) {
        const key = element.dataset.virtualRowKey;
        const height = element.getBoundingClientRect().height;
        if (key && height > 0 && Math.abs((measuredRowHeights.get(key) ?? 0) - height) > 0.5) {
          measuredRowHeights.set(key, height);
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      rebuildVirtualOffsets();
      const newTop = virtualRowOffsets[state.renderedStart] ?? 0;
      const renderedBottom = virtualRowOffsets[state.renderedEnd] ?? newTop;
      topSpacer.style.height = `${newTop}px`;
      bottomSpacer.style.height = `${Math.max(0, virtualRowOffsets.at(-1)! - renderedBottom)}px`;
      if (state.renderedStart > 0 && Math.abs(newTop - oldTop) > 0.5) {
        scroll.scrollTop += newTop - oldTop;
      }
    });
  }

  /** Coalesces folder disclosure changes before telling the scanner which branches to pause. */
  function scheduleFolderScanSync(): void {
    if (state.folderScanSyncTimer) {
      return;
    }
    state.folderScanSyncTimer = window.setTimeout(() => {
      state.folderScanSyncTimer = 0;
      // The selected root itself is visual-only: pause only actual descendant folder branches.
      const nextResumedFolders = [...resumedFolders].filter((folder) => folder.length > 0 && !collapsedFolders.has(folder));
      resumedFolders.clear();
      vscode.postMessage({
        type: "setCollapsedFolders",
        collapsedFolders: [...collapsedFolders].filter(Boolean),
        resumedFolders: nextResumedFolders,
      });
    }, FOLDER_SCAN_SYNC_DELAY_MS);
  }

  /** Changes one folder disclosure state and rebuilds only the bounded virtual window. */
  function setFolderCollapsed(folder: string, collapsed: boolean): void {
    const wasCollapsed = collapsedFolders.has(folder);
    if (wasCollapsed === collapsed) {
      return;
    }
    if (collapsed) {
      collapsedFolders.add(folder);
      resumedFolders.delete(folder);
    } else {
      collapsedFolders.delete(folder);
      if (folder) {
        resumedFolders.add(folder);
      }
    }
    scheduleFolderScanSync();
    rebuildVirtualRows();
    renderVirtualGallery(true);
  }

  /** Collapses or expands every discovered folder while keeping DOM size bounded. */
  function setAllFoldersCollapsed(collapsed: boolean): void {
    state.collapseNewFolders = collapsed;
    for (const folder of knownFolders.keys()) {
      if (collapsed) {
        collapsedFolders.add(folder);
        resumedFolders.delete(folder);
      } else {
        collapsedFolders.delete(folder);
        if (folder) {
          resumedFolders.add(folder);
        }
      }
    }
    scheduleFolderScanSync();
    rebuildVirtualRows();
    renderVirtualGallery(true);
  }

  /** Captures the first card intersecting the visible scroll viewport. */
  function captureVisualAnchor(): { resourceUri: string; offsetTop: number } | undefined {
    const scrollRect = scroll.getBoundingClientRect();
    for (const card of gallery.querySelectorAll<HTMLButtonElement>(".image-card")) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > scrollRect.top && rect.top < scrollRect.bottom && card.dataset.resourceUri) {
        return { resourceUri: card.dataset.resourceUri, offsetTop: rect.top - scrollRect.top };
      }
    }
    return undefined;
  }

  /** Restores a captured visual card after masonry heights settle. */
  function restoreVisualAnchor(anchor: { resourceUri: string; offsetTop: number }): void {
    if (state.scrolling) {
      return;
    }
    const card = cardsByResourceUri.get(anchor.resourceUri);
    if (!card?.isConnected) {
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    const nextOffsetTop = card.getBoundingClientRect().top - scrollRect.top;
    const correction = nextOffsetTop - anchor.offsetTop;
    if (Math.abs(correction) > 0.5) {
      scroll.scrollTop += correction;
    }
  }

  /** Displays a short local confirmation without interrupting scrolling. */
  function showNotice(text: string): void {
    notice.textContent = text;
    notice.hidden = false;
    window.clearTimeout(state.noticeTimer);
    state.noticeTimer = window.setTimeout(() => {
      notice.hidden = true;
    }, 2_800);
  }

  /** Splits a comma or newline separated settings field into trimmed keywords. */
  function splitFolderKeywords(value: string): string[] {
    return value.split(/[\n,;]/).map((keyword) => keyword.trim()).filter(Boolean);
  }

  /** Opens a compact card context menu within the current Webview viewport. */
  function showImageContextMenu(resourceUri: string, clientX: number, clientY: number): void {
    state.contextResourceUri = resourceUri;
    contextMenu.hidden = false;
    const margin = 8;
    const rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = `${Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin))}px`;
    contextMenu.style.top = `${Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin))}px`;
  }

  /** Clears the active card context menu selection. */
  function hideImageContextMenu(): void {
    contextMenu.hidden = true;
    state.contextResourceUri = "";
  }

  /** Requests the next filesystem batch only when the viewport nears the discovered gallery end. */
  function requestMoreIfNeeded(): void {
    const remainingDistance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
    if (state.hasMore && !state.loading && remainingDistance <= SCAN_PREFETCH_MARGIN_PX) {
      requestNextPage();
    }
  }

  /** Requests one bounded extension-host scan batch. */
  function requestNextPage(): void {
    if (state.loading || !state.hasMore) {
      return;
    }
    state.loading = true;
    updateStatus();
    vscode.postMessage({ type: "nextPage" });
  }

  /** Coalesces virtual-window replacement and scan-prefetch work to one animation frame. */
  function scheduleScrollWork(): void {
    if (state.renderFrame) {
      return;
    }
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0;
      renderVirtualGallery();
      requestMoreIfNeeded();
    });
  }

  /** Shows discovery progress without claiming an incomplete scan is a final count. */
  function updateStatus(): void {
    // Keep one status label while scan work remains so a user-triggered batch does not flicker the toolbar.
    if (state.hasMore) {
      status.textContent = `${state.items.length} found · scroll to discover more`;
    } else if (state.skippedDirectories) {
      status.textContent = `${state.items.length} images · ${state.skippedDirectories} folders unavailable`;
    } else {
      status.textContent = `${state.items.length} images`;
    }
    // Scrolling, not an always-running background loop, unlocks the next bounded batch.
    continueScan.hidden = true;
    continueScan.disabled = state.loading || !state.hasMore;
  }

  /** Clears client metadata after a user-requested scan restart. */
  function resetScan(): void {
    imageObserver.disconnect();
    state.items = [];
    state.hasMore = true;
    state.loading = false;
    state.initialEmptyScanRequests = 0;
    state.skippedDirectories = 0;
    state.renderedStart = -1;
    state.renderedEnd = -1;
    clearMountedGallery();
    knownFolders.clear();
    resumedFolders.clear();
    measuredRowHeights.clear();
    virtualRows = [];
    virtualRowOffsets = [0];
    cancelAnimationFrame(state.measureFrame);
    state.measureFrame = 0;
    window.clearTimeout(state.folderScanSyncTimer);
    state.folderScanSyncTimer = 0;
    scroll.scrollTop = 0;
    gallery.replaceChildren();
    topSpacer.style.height = "0px";
    bottomSpacer.style.height = "0px";
    updateStatus();
  }

  layoutControl.addEventListener("change", () => {
    const anchor = captureVisualAnchor();
    state.layout = layoutControl.value;
    applyPreferences();
    measuredRowHeights.clear();
    rebuildVirtualRows();
    renderVirtualGallery(true);
    if (anchor) {
      requestAnimationFrame(() => restoreVisualAnchor(anchor));
    }
  });
  columnControl.addEventListener("input", () => {
    updateColumnCount(Number(columnControl.value));
  });
  collapseFolders.addEventListener("click", () => setAllFoldersCollapsed(true));
  expandFolders.addEventListener("click", () => setAllFoldersCollapsed(false));
  settingsButton.addEventListener("click", () => settingsDialog.showModal());
  closeSettings.addEventListener("click", () => settingsDialog.close());
  applySettings.addEventListener("click", () => {
    if (!scanDepthInput.reportValidity()) {
      return;
    }
    vscode.postMessage({
      type: "updateFolderFilters",
      includedFolderKeywords: splitFolderKeywords(includedFoldersInput.value),
      excludedFolderKeywords: splitFolderKeywords(excludedFoldersInput.value),
      scanDepth: Number(scanDepthInput.value),
    });
    settingsDialog.close();
  });
  continueScan.addEventListener("click", () => requestNextPage());
  rescan.addEventListener("click", () => vscode.postMessage({ type: "rescan" }));
  scroll.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) {
      // A wheel gesture can be the only scroll signal when the initial short gallery does not overflow yet.
      scheduleScrollWork();
      return;
    }
    // Ctrl-wheel is reserved for thumbnail resizing; prevent Webview zoom while
    // keeping ordinary wheel scrolling unchanged.
    event.preventDefault();
    const bounds = getCurrentColumnCountBounds();
    const nextColumns = getWheelAdjustedColumnCount(state.columns, event.deltaY, bounds);
    if (nextColumns !== state.columns) {
      updateColumnCount(nextColumns);
    }
  }, { passive: false });
  scroll.addEventListener("scroll", () => {
    state.scrolling = true;
    window.clearTimeout(state.scrollIdleTimer);
    state.scrollIdleTimer = window.setTimeout(() => {
      state.scrolling = false;
      scheduleVirtualRowMeasurement();
    }, SCROLL_IDLE_DELAY_MS);
    scheduleScrollWork();
  }, { passive: true });
  gallery.addEventListener("pointerover", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    if (card?.dataset.resourceUri) {
      positionHoverDetails(card);
      requestImageMetadata(card.dataset.resourceUri);
    }
  });
  gallery.addEventListener("focusin", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    if (card) {
      positionHoverDetails(card);
    }
  });
  gallery.addEventListener("click", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    const folderToggle = target instanceof Element ? target.closest<HTMLButtonElement>(".folder-toggle") : undefined;
    const folder = folderToggle?.dataset.folder;
    if (folder !== undefined) {
      state.collapseNewFolders = false;
      setFolderCollapsed(folder, !collapsedFolders.has(folder));
      return;
    }
    if (card?.dataset.resourceUri) {
      vscode.postMessage({ type: "openImage", resourceUri: card.dataset.resourceUri });
    }
  });
  gallery.addEventListener("contextmenu", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    if (!card?.dataset.resourceUri) {
      return;
    }
    event.preventDefault();
    showImageContextMenu(card.dataset.resourceUri, event.clientX, event.clientY);
  });
  copyRelativePath.addEventListener("click", () => {
    if (state.contextResourceUri) {
      vscode.postMessage({ type: "copyRelativePath", resourceUri: state.contextResourceUri });
    }
    hideImageContextMenu();
  });
  deleteImage.addEventListener("click", () => {
    if (state.contextResourceUri) {
      vscode.postMessage({ type: "deleteImage", resourceUri: state.contextResourceUri });
    }
    hideImageContextMenu();
  });
  window.addEventListener("pointerdown", (event) => {
    if (!contextMenu.hidden && event.target instanceof Node && !contextMenu.contains(event.target)) {
      hideImageContextMenu();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideImageContextMenu();
    }
  });
  window.addEventListener("resize", () => {
    updateColumnCount(state.columns);
  });
  window.addEventListener("message", (event: MessageEvent<WebviewMessage>) => {
    const message = event.data;
    if (message?.type === "reset") {
      resetScan();
      return;
    }
    if (message?.type === "folderFilters") {
      includedFoldersInput.value = (message.includedFolderKeywords || []).join("\n");
      excludedFoldersInput.value = (message.excludedFolderKeywords || []).join("\n");
      const scanDepth = Number(message.scanDepth);
      scanDepthInput.value = Number.isInteger(scanDepth) && scanDepth >= -1 ? String(scanDepth) : "-1";
      return;
    }
    if (message?.type === "notice" && message.text) {
      showNotice(message.text);
      return;
    }
    if (message?.type === "imageMetadata" && message.resourceUri) {
      imageFileMetadata.set(message.resourceUri, {
        createdAt: message.createdAt,
        modifiedAt: message.modifiedAt,
        size: message.size,
      });
      resolvedImageMetadata.add(message.resourceUri);
      const card = cardsByResourceUri.get(message.resourceUri);
      if (card) {
        updateImageHoverDetails(card);
      }
      return;
    }
    if (message?.type === "imageDeleted" && message.resourceUri) {
      const anchor = captureVisualAnchor();
      state.items = state.items.filter((item) => item.resourceUri !== message.resourceUri);
      knownAspectRatios.delete(message.resourceUri);
      knownImageDimensions.delete(message.resourceUri);
      imageFileMetadata.delete(message.resourceUri);
      requestedImageMetadata.delete(message.resourceUri);
      resolvedImageMetadata.delete(message.resourceUri);
      measuredRowHeights.clear();
      rebuildVirtualRows();
      renderVirtualGallery(true);
      updateStatus();
      showNotice("Image moved to the Recycle Bin");
      if (anchor && anchor.resourceUri !== message.resourceUri) {
        requestAnimationFrame(() => restoreVisualAnchor(anchor));
      }
      return;
    }
    if (message?.type !== "scanBatch") {
      return;
    }
    state.loading = false;
    state.items.push(...(message.items || []));
    state.hasMore = Boolean(message.hasMore);
    state.skippedDirectories = Number(message.skippedDirectories) || 0;
    rebuildVirtualRows();
    renderVirtualGallery();
    updateStatus();
    // Some roots need several directory-only batches before the first image. Prefetch only that
    // opening gap, then return to strictly user-driven scroll scanning to keep discovery bounded.
    if (!state.items.length && state.hasMore && state.initialEmptyScanRequests < MAX_INITIAL_EMPTY_SCAN_REQUESTS) {
      state.initialEmptyScanRequests += 1;
      requestNextPage();
    }
    if (!state.hasMore && !state.items.length) {
      gallery.innerHTML = '<p class="empty">No supported image files were found in this directory.</p>';
    }
  });

  applyPreferences();
  rebuildVirtualRows();
  renderVirtualGallery();
  status.textContent = "Connecting to directory scanner…";
  vscode.postMessage({ type: "ready" });
}

/** Returns an element with a useful error if the generated Webview markup is out of sync. */
function getRequiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Directory preview is missing its #${id} element.`);
  }
  return element as ElementType;
}

try {
  startDirectoryPreview();
} catch (error) {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Directory preview startup failed. See Webview Developer Tools.";
  }
  console.error("Directory image preview startup failed", error);
}
