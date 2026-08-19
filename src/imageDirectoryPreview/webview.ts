/*
 * Browser-side controller for the directory image-preview Webview.
 *
 * This is bundled as dist/image-directory-preview.js and loaded through a
 * Webview resource URI. Keeping it outside the HTML document avoids depending
 * on inline-script execution and lets the page use a restrictive CSP. It keeps
 * discovered image metadata in memory but mounts only a viewport-sized subset
 * of cards, which bounds image DOM nodes and decoded bitmap pressure.
 */

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

type WebviewMessage = ScanBatchMessage | { type: "reset" };

type VsCodeApi = {
  postMessage(message: { type: string; resourceUri?: string }): void;
  getState(): { layout?: string; thumbnailSize?: number } | undefined;
  setState(state: { layout: string; thumbnailSize: number }): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const WINDOW_BEFORE = 72;
const WINDOW_AFTER = 96;
const PREFETCH_DISTANCE = 44;

/** Runs the directory-preview browser controller once the external script loads. */
function startDirectoryPreview(): void {
  const status = getRequiredElement<HTMLSpanElement>("status");
  const vscode = acquireVsCodeApi();
  const scroll = getRequiredElement<HTMLElement>("scroll");
  const gallery = getRequiredElement<HTMLElement>("gallery");
  const topSpacer = getRequiredElement<HTMLElement>("top-spacer");
  const bottomSpacer = getRequiredElement<HTMLElement>("bottom-spacer");
  const layoutControl = getRequiredElement<HTMLSelectElement>("layout");
  const sizeControl = getRequiredElement<HTMLInputElement>("thumbnail-size");
  const sizeValue = getRequiredElement<HTMLOutputElement>("thumbnail-value");
  const continueScan = getRequiredElement<HTMLButtonElement>("continue-scan");
  const rescan = getRequiredElement<HTMLButtonElement>("rescan");
  const saved = vscode.getState() || {};
  const state = {
    items: [] as DirectoryImage[],
    hasMore: true,
    loading: false,
    skippedDirectories: 0,
    automaticScanRequests: 0,
    userHasScrolled: false,
    layout: saved.layout || "grid",
    thumbnailSize: Number(saved.thumbnailSize) || 180,
    renderedStart: -1,
    renderedEnd: -1,
    renderFrame: 0,
  };

  /** Persists only UI preferences; image metadata stays in the extension-host scan session. */
  function persistPreferences(): void {
    vscode.setState({ layout: state.layout, thumbnailSize: state.thumbnailSize });
  }

  /** Applies a layout and thumbnail-size change without requesting or loading every image. */
  function applyPreferences(): void {
    document.documentElement.style.setProperty("--thumbnail-size", `${state.thumbnailSize}px`);
    layoutControl.value = state.layout;
    sizeControl.value = String(state.thumbnailSize);
    sizeValue.textContent = `${state.thumbnailSize} px`;
    persistPreferences();
  }

  /** Returns a conservative visible column count for the scroll-height estimate. */
  function getColumnCount(): number {
    const available = Math.max(1, scroll.clientWidth - 32);
    const gap = 12;
    return Math.max(1, Math.floor((available + gap) / (state.thumbnailSize + gap)));
  }

  /** Estimates the height occupied by an image prefix so prior cards can be unmounted. */
  function estimateHeightForItems(count: number): number {
    const columns = getColumnCount();
    const cardHeight = state.thumbnailSize + 43;
    if (state.layout === "masonry") {
      return Math.ceil(count / columns) * (state.thumbnailSize * 1.34 + 43);
    }
    if (state.layout === "folders") {
      return Math.ceil(count / columns) * cardHeight + Math.ceil(count / 36) * 29;
    }
    return Math.ceil(count / columns) * cardHeight;
  }

  /** Maps a scroll position to an approximate item index for the bounded render window. */
  function getApproximateIndex(): number {
    const totalEstimate = Math.max(1, estimateHeightForItems(state.items.length));
    return Math.max(0, Math.min(state.items.length - 1, Math.floor((scroll.scrollTop / totalEstimate) * state.items.length)));
  }

  /** Creates one thumbnail card; this is the only point that assigns an image src. */
  function createCard(item: DirectoryImage): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "image-card";
    card.title = item.folder ? `${item.folder}/${item.name}` : item.name;
    card.dataset.resourceUri = item.resourceUri;
    const thumbnail = document.createElement("span");
    thumbnail.className = "thumbnail";
    const image = document.createElement("img");
    image.src = item.src;
    image.alt = item.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => card.classList.add("is-failed"), { once: true });
    thumbnail.append(image);
    const caption = document.createElement("span");
    caption.className = "caption";
    caption.textContent = item.name;
    card.append(thumbnail, caption);
    return card;
  }

  /** Renders a contiguous metadata slice with grouped headings when the folder layout is selected. */
  function appendFolderCards(fragment: DocumentFragment, items: DirectoryImage[]): void {
    let currentFolder: string | undefined;
    let group: HTMLElement | undefined;
    for (const item of items) {
      const folder = item.folder || "Top level";
      if (folder !== currentFolder) {
        currentFolder = folder;
        const folderGroup = document.createElement("section");
        folderGroup.className = "folder-group";
        const heading = document.createElement("h2");
        heading.className = "folder-heading";
        heading.textContent = folder;
        group = document.createElement("div");
        group.className = "folder-grid";
        folderGroup.append(heading, group);
        fragment.append(folderGroup);
      }
      group?.append(createCard(item));
    }
  }

  /** Mounts a small viewport-centered image window and drops offscreen image elements. */
  function renderWindow(force: boolean): void {
    if (!state.items.length) {
      gallery.replaceChildren();
      topSpacer.style.height = "0px";
      bottomSpacer.style.height = "0px";
      return;
    }
    const centeredIndex = getApproximateIndex();
    const start = Math.max(0, centeredIndex - WINDOW_BEFORE);
    const end = Math.min(state.items.length, centeredIndex + WINDOW_AFTER);
    if (!force && start === state.renderedStart && end === state.renderedEnd) {
      requestMoreIfNeeded(end);
      return;
    }
    state.renderedStart = start;
    state.renderedEnd = end;
    gallery.className = `layout-${state.layout}`;
    topSpacer.style.height = `${estimateHeightForItems(start)}px`;
    bottomSpacer.style.height = `${Math.max(0, estimateHeightForItems(state.items.length) - estimateHeightForItems(end))}px`;
    const fragment = document.createDocumentFragment();
    const visibleItems = state.items.slice(start, end);
    if (state.layout === "folders") {
      appendFolderCards(fragment, visibleItems);
    } else {
      for (const item of visibleItems) {
        fragment.append(createCard(item));
      }
    }
    gallery.replaceChildren(fragment);
    requestMoreIfNeeded(end);
  }

  /** Requests the next filesystem batch only when the mounted window nears discovered content. */
  function requestMoreIfNeeded(renderedEnd: number): void {
    if (state.hasMore && !state.loading && renderedEnd >= state.items.length - PREFETCH_DISTANCE) {
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

  /** Schedules rendering after scrolling without running one DOM rebuild per scroll event. */
  function scheduleRender(): void {
    if (state.renderFrame) {
      return;
    }
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0;
      renderWindow(false);
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
    state.items = [];
    state.hasMore = true;
    state.loading = false;
    state.skippedDirectories = 0;
    state.automaticScanRequests = 0;
    state.userHasScrolled = false;
    state.renderedStart = -1;
    state.renderedEnd = -1;
    scroll.scrollTop = 0;
    renderWindow(true);
    updateStatus();
  }

  layoutControl.addEventListener("change", () => {
    state.layout = layoutControl.value;
    state.renderedStart = -1;
    state.renderedEnd = -1;
    applyPreferences();
    renderWindow(true);
  });
  sizeControl.addEventListener("input", () => {
    state.thumbnailSize = Number(sizeControl.value);
    state.renderedStart = -1;
    state.renderedEnd = -1;
    applyPreferences();
    renderWindow(true);
  });
  continueScan.addEventListener("click", () => requestNextPage(false));
  rescan.addEventListener("click", () => vscode.postMessage({ type: "rescan" }));
  scroll.addEventListener("scroll", () => {
    state.userHasScrolled = true;
    scheduleRender();
  }, { passive: true });
  gallery.addEventListener("click", (event) => {
    const target = event.target;
    const card = target instanceof Element ? target.closest<HTMLButtonElement>(".image-card") : undefined;
    if (card?.dataset.resourceUri) {
      vscode.postMessage({ type: "openImage", resourceUri: card.dataset.resourceUri });
    }
  });
  window.addEventListener("resize", () => {
    state.renderedStart = -1;
    state.renderedEnd = -1;
    renderWindow(true);
  });
  window.addEventListener("message", (event: MessageEvent<WebviewMessage>) => {
    const message = event.data;
    if (message?.type === "reset") {
      resetScan();
      return;
    }
    if (message?.type !== "scanBatch") {
      return;
    }
    state.loading = false;
    state.items.push(...(message.items || []));
    state.hasMore = Boolean(message.hasMore);
    state.skippedDirectories = Number(message.skippedDirectories) || 0;
    state.renderedStart = -1;
    state.renderedEnd = -1;
    renderWindow(true);
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
