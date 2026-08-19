/*
 * Browser-side controller for the directory image-preview Webview.
 *
 * This is bundled as dist/image-directory-preview.js and loaded through a
 * Webview resource URI. Keeping it outside the HTML document avoids depending
 * on inline-script execution and lets the page use a restrictive CSP. It keeps
 * discovered image metadata in stable card skeletons, while only images near
 * the viewport receive a src. Stable cards keep scrolling continuous and the
 * bounded source window limits decoded bitmap pressure.
 */

import { getShortestMasonryColumnIndex, getStableGalleryAppendRange } from "./virtualScroll";
import { clampColumnCount, getColumnCountBounds, getThumbnailSizeForColumns, getWheelAdjustedColumnCount } from "./thumbnailColumns";
import { getImageAspectRatio } from "./imageSizing";
import { getImageHoverDetails } from "./imageHoverDetails";

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

type WebviewMessage = ScanBatchMessage
  | { type: "reset" }
  | { type: "folderFilters"; includedFolderKeywords?: string[]; excludedFolderKeywords?: string[] }
  | { type: "notice"; text?: string }
  | { type: "imageDeleted"; resourceUri?: string }
  | { type: "imageMetadata"; resourceUri?: string; createdAt?: number; modifiedAt?: number; size?: number };

type VsCodeApi = {
  postMessage(message: {
    type: string;
    resourceUri?: string;
    includedFolderKeywords?: string[];
    excludedFolderKeywords?: string[];
  }): void;
  getState(): { layout?: string; columns?: number; thumbnailSize?: number } | undefined;
  setState(state: { layout: string; columns: number }): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const IMAGE_LOAD_MARGIN_PX = 1_600;
const SCAN_PREFETCH_MARGIN_PX = 1_200;
const SCROLL_IDLE_DELAY_MS = 140;
const GALLERY_HORIZONTAL_INSET_PX = 32;

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
    skippedDirectories: 0,
    automaticScanRequests: 0,
    userHasScrolled: false,
    layout: saved.layout || "grid",
    columns: Number(saved.columns) || 4,
    thumbnailSize: Number(saved.thumbnailSize) || 180,
    renderedItemCount: 0,
    renderFrame: 0,
    scrolling: false,
    scrollIdleTimer: 0,
    masonryUpdateFrame: 0,
    collapseNewFolders: false,
    contextResourceUri: "",
    noticeTimer: 0,
  };
  const cardsByResourceUri = new Map<string, HTMLButtonElement>();
  const folderGrids = new Map<string, HTMLElement>();
  const folderGroups = new Map<string, HTMLElement>();
  const collapsedFolders = new Set<string>();
  const knownAspectRatios = new Map<string, number>();
  const knownImageDimensions = new Map<string, ImageDimensions>();
  const imageFileMetadata = new Map<string, ImageFileMetadata>();
  const requestedImageMetadata = new Set<string>();
  const resolvedImageMetadata = new Set<string>();
  const pendingMasonryRatios = new Map<HTMLButtonElement, number>();
  let masonryColumns: HTMLElement[] = [];
  let masonryColumnHeights: number[] = [];
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
    layoutControl.value = state.layout;
    columnControl.min = String(bounds.min);
    columnControl.max = String(bounds.max);
    columnControl.value = String(state.columns);
    columnValue.textContent = `${state.columns}`;
    updateFolderControls();
    persistPreferences();
  }

  /** Applies a column-count request while preserving the current visual anchor and masonry stability. */
  function updateColumnCount(requestedColumns: number): void {
    const anchor = captureVisualAnchor();
    state.columns = requestedColumns;
    applyPreferences();
    if (state.layout === "masonry") {
      if (masonryColumns.length !== getMasonryColumnCount()) {
        renderStableGallery(true);
      } else {
        recalculateMasonryColumnHeights();
      }
    }
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

  /** Returns the user-selected stable masonry column count for the current viewport. */
  function getMasonryColumnCount(): number {
    return state.columns;
  }

  /** Returns the clamped thumbnail height used by a masonry card. */
  function getMasonryThumbnailHeight(aspectRatio: number): number {
    const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 4 / 3;
    return Math.max(state.thumbnailSize * 0.6, Math.min(state.thumbnailSize / ratio, state.thumbnailSize * 2.2));
  }

  /** Estimates a masonry card height without forcing browser layout. */
  function getMasonryCardHeight(aspectRatio: number): number {
    return getMasonryThumbnailHeight(aspectRatio) + 43 + 12;
  }

  /** Creates the independent columns that prevent masonry rebalancing. */
  function ensureMasonryColumns(): void {
    if (masonryColumns.length) {
      return;
    }
    const columnCount = getMasonryColumnCount();
    masonryColumns = [];
    masonryColumnHeights = Array.from({ length: columnCount }, () => 0);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < columnCount; index += 1) {
      const column = document.createElement("div");
      column.className = "masonry-column";
      masonryColumns.push(column);
      fragment.append(column);
    }
    gallery.append(fragment);
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
        if (state.layout === "masonry") {
          queueMasonryRatioUpdate(card, aspectRatio);
        }
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

  /** Requests filesystem metadata once per card, keeping large directory scans free of per-image stat calls. */
  function requestImageMetadata(resourceUri: string): void {
    if (requestedImageMetadata.has(resourceUri)) {
      return;
    }
    requestedImageMetadata.add(resourceUri);
    vscode.postMessage({ type: "requestImageMetadata", resourceUri });
  }

  /** Appends newly discovered cards without touching cards already in the layout. */
  function renderStableGallery(rebuild = false): void {
    if (rebuild) {
      imageObserver.disconnect();
      gallery.replaceChildren();
      cardsByResourceUri.clear();
      folderGrids.clear();
      folderGroups.clear();
      masonryColumns = [];
      masonryColumnHeights = [];
      state.renderedItemCount = 0;
    }
    gallery.className = `layout-${state.layout}`;
    topSpacer.style.height = "0px";
    bottomSpacer.style.height = "0px";
    const range = getStableGalleryAppendRange(state.renderedItemCount, state.items.length);
    if (range.start === 0 && state.renderedItemCount > state.items.length) {
      renderStableGallery(true);
      return;
    }
    if (range.start === range.end) {
      return;
    }

    if (state.layout === "folders") {
      appendFolderCards(state.items.slice(range.start, range.end));
    } else if (state.layout === "masonry") {
      appendMasonryCards(state.items.slice(range.start, range.end));
    } else {
      const fragment = document.createDocumentFragment();
      for (const item of state.items.slice(range.start, range.end)) {
        fragment.append(createCard(item));
      }
      gallery.append(fragment);
    }
    state.renderedItemCount = range.end;
  }

  /** Appends each masonry card to the shortest column without moving older cards. */
  function appendMasonryCards(items: DirectoryImage[]): void {
    ensureMasonryColumns();
    for (const item of items) {
      const aspectRatio = knownAspectRatios.get(item.resourceUri) || 4 / 3;
      const columnIndex = getShortestMasonryColumnIndex(masonryColumnHeights);
      const card = createCard(item);
      card.dataset.masonryColumn = String(columnIndex);
      card.dataset.masonryHeight = String(getMasonryCardHeight(aspectRatio));
      masonryColumns[columnIndex].append(card);
      masonryColumnHeights[columnIndex] += Number(card.dataset.masonryHeight);
    }
  }

  /** Recomputes column estimates after thumbnail-size changes. */
  function recalculateMasonryColumnHeights(): void {
    if (!masonryColumns.length) {
      return;
    }
    masonryColumnHeights = Array.from({ length: masonryColumns.length }, () => 0);
    for (const card of cardsByResourceUri.values()) {
      const columnIndex = Number(card.dataset.masonryColumn);
      const resourceUri = card.dataset.resourceUri;
      if (!Number.isInteger(columnIndex) || masonryColumnHeights[columnIndex] === undefined || !resourceUri) {
        continue;
      }
      const aspectRatio = knownAspectRatios.get(resourceUri) || 4 / 3;
      const height = getMasonryCardHeight(aspectRatio);
      card.style.setProperty("--masonry-thumbnail-height", `${getMasonryThumbnailHeight(aspectRatio)}px`);
      card.dataset.masonryHeight = String(height);
      masonryColumnHeights[columnIndex] += height;
    }
  }

  /** Appends cards to persistent folder groups, including groups split across scan batches. */
  function appendFolderCards(items: DirectoryImage[]): void {
    for (const item of items) {
      const folder = item.folder || "Top level";
      let grid = folderGrids.get(folder);
      if (!grid) {
        const group = document.createElement("section");
        group.className = "folder-group";
        group.dataset.folder = folder;
        const heading = document.createElement("h2");
        heading.className = "folder-heading";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "folder-toggle";
        toggle.dataset.folder = folder;
        toggle.textContent = folder;
        toggle.title = `Collapse ${folder}`;
        grid = document.createElement("div");
        grid.className = "folder-grid";
        heading.append(toggle);
        group.append(heading, grid);
        gallery.append(group);
        folderGrids.set(folder, grid);
        folderGroups.set(folder, group);
        if (state.collapseNewFolders || collapsedFolders.has(folder)) {
          setFolderCollapsed(folder, true);
        }
      }
      grid.append(createCard(item));
    }
  }

  /** Changes one folder group's disclosure state and keeps its accessible label current. */
  function setFolderCollapsed(folder: string, collapsed: boolean): void {
    const group = folderGroups.get(folder);
    const toggle = group?.querySelector<HTMLButtonElement>(".folder-toggle");
    if (!group || !toggle) {
      return;
    }
    group.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = `${collapsed ? "Expand" : "Collapse"} ${folder}`;
    if (collapsed) {
      collapsedFolders.add(folder);
    } else {
      collapsedFolders.delete(folder);
    }
  }

  /** Collapses or expands all rendered folder groups without reconstructing image cards. */
  function setAllFoldersCollapsed(collapsed: boolean): void {
    state.collapseNewFolders = collapsed;
    for (const folder of folderGroups.keys()) {
      setFolderCollapsed(folder, collapsed);
    }
  }

  /** Queues natural image ratios and applies them only after active scrolling stops. */
  function queueMasonryRatioUpdate(card: HTMLButtonElement, aspectRatio: number): void {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      return;
    }
    pendingMasonryRatios.set(card, aspectRatio);
    if (!state.scrolling) {
      scheduleMasonryRatioUpdates();
    }
  }

  /** Applies a batch of masonry heights while preserving the first visible card. */
  function scheduleMasonryRatioUpdates(): void {
    if (state.masonryUpdateFrame || !pendingMasonryRatios.size) {
      return;
    }
    state.masonryUpdateFrame = requestAnimationFrame(() => {
      state.masonryUpdateFrame = 0;
      const anchor = captureVisualAnchor();
      for (const [card, aspectRatio] of pendingMasonryRatios) {
        if (card.isConnected) {
          card.style.setProperty("--masonry-thumbnail-height", `${getMasonryThumbnailHeight(aspectRatio)}px`);
          const columnIndex = Number(card.dataset.masonryColumn);
          const previousHeight = Number(card.dataset.masonryHeight);
          if (Number.isInteger(columnIndex) && masonryColumnHeights[columnIndex] !== undefined && Number.isFinite(previousHeight)) {
            const nextHeight = getMasonryCardHeight(aspectRatio);
            masonryColumnHeights[columnIndex] += nextHeight - previousHeight;
            card.dataset.masonryHeight = String(nextHeight);
          }
        }
      }
      pendingMasonryRatios.clear();
      if (anchor) {
        requestAnimationFrame(() => restoreVisualAnchor(anchor));
      }
    });
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

  /** Requests the next filesystem batch only when the viewport nears the stable gallery end. */
  function requestMoreIfNeeded(): void {
    const remainingDistance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
    if (state.hasMore && !state.loading && remainingDistance <= SCAN_PREFETCH_MARGIN_PX) {
      requestNextPage(!state.userHasScrolled);
    }
  }

  /** Requests one bounded extension-host scan batch. */
  function requestNextPage(isAutomatic: boolean): void {
    if (state.loading || !state.hasMore) {
      return;
    }
    // Cap opening-time discovery so a deeply nested non-image tree does not delay the tab.
    if (isAutomatic && state.automaticScanRequests >= 2) {
      updateStatus();
      return;
    }
    state.loading = true;
    if (isAutomatic) {
      state.automaticScanRequests += 1;
    }
    updateStatus();
    vscode.postMessage({ type: "nextPage" });
  }

  /** Schedules lightweight scan-prefetch work without rebuilding gallery cards. */
  function scheduleScrollWork(): void {
    if (state.renderFrame) {
      return;
    }
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0;
      requestMoreIfNeeded();
    });
  }

  /** Shows discovery progress without claiming an incomplete scan is a final count. */
  function updateStatus(): void {
    if (state.loading) {
      status.textContent = `Scanning… ${state.items.length} found`;
    } else if (state.hasMore) {
      status.textContent = `${state.items.length} found · continue scanning on demand`;
    } else if (state.skippedDirectories) {
      status.textContent = `${state.items.length} images · ${state.skippedDirectories} folders unavailable`;
    } else {
      status.textContent = `${state.items.length} images`;
    }
    continueScan.hidden = state.loading || !state.hasMore;
    continueScan.disabled = state.loading || !state.hasMore;
  }

  /** Clears client metadata after a user-requested scan restart. */
  function resetScan(): void {
    imageObserver.disconnect();
    state.items = [];
    state.hasMore = true;
    state.loading = false;
    state.skippedDirectories = 0;
    state.automaticScanRequests = 0;
    state.userHasScrolled = false;
    state.renderedItemCount = 0;
    cardsByResourceUri.clear();
    folderGrids.clear();
    folderGroups.clear();
    pendingMasonryRatios.clear();
    masonryColumns = [];
    masonryColumnHeights = [];
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
    renderStableGallery(true);
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
    vscode.postMessage({
      type: "updateFolderFilters",
      includedFolderKeywords: splitFolderKeywords(includedFoldersInput.value),
      excludedFolderKeywords: splitFolderKeywords(excludedFoldersInput.value),
    });
    settingsDialog.close();
  });
  continueScan.addEventListener("click", () => requestNextPage(false));
  rescan.addEventListener("click", () => vscode.postMessage({ type: "rescan" }));
  scroll.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) {
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
    state.userHasScrolled = true;
    state.scrolling = true;
    window.clearTimeout(state.scrollIdleTimer);
    state.scrollIdleTimer = window.setTimeout(() => {
      state.scrolling = false;
      scheduleMasonryRatioUpdates();
    }, SCROLL_IDLE_DELAY_MS);
    scheduleScrollWork();
  }, { passive: true });
  gallery.addEventListener("pointerover", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    if (card?.dataset.resourceUri) {
      requestImageMetadata(card.dataset.resourceUri);
    }
  });
  gallery.addEventListener("click", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    const folderToggle = target instanceof Element ? target.closest<HTMLButtonElement>(".folder-toggle") : undefined;
    if (folderToggle?.dataset.folder) {
      const folder = folderToggle.dataset.folder;
      const group = folderGroups.get(folder);
      state.collapseNewFolders = false;
      setFolderCollapsed(folder, !group?.classList.contains("is-collapsed"));
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
      renderStableGallery(true);
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
    renderStableGallery();
    updateStatus();
    // Two small opening batches cover common root-plus-child trees without recursively exhausting a large tree.
    if (state.hasMore && state.automaticScanRequests < 2 && !state.userHasScrolled) {
      requestNextPage(true);
    }
    if (!state.hasMore && !state.items.length) {
      gallery.innerHTML = '<p class="empty">No supported image files were found in this directory.</p>';
    }
  });

  applyPreferences();
  renderStableGallery();
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
