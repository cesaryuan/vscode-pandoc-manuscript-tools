/**
 * Pure layout helpers for the directory-preview virtual gallery.
 *
 * Discovered image metadata can grow with user-driven scanning, but the browser
 * mounts only the rows around the viewport. Folder rows are flattened here so
 * parent collapse remains independent from the short-lived DOM nodes.
 */

import { getFolderHierarchy, type FolderHierarchyNode } from "./folderHierarchy";

/** Smallest image shape needed to build stable virtual folder rows. */
export type FolderVirtualItem = {
  folder: string;
  resourceUri: string;
};

/** One independently mountable row in the folder layout. */
export type FolderVirtualRow<Item extends FolderVirtualItem> =
  | { key: string; kind: "folder"; folder: FolderHierarchyNode }
  | { key: string; kind: "cards"; folder: FolderHierarchyNode; items: Item[] };

/** Result of flattening discovered folders while respecting collapsed ancestors. */
export type FolderVirtualLayout<Item extends FolderVirtualItem> = {
  folders: FolderHierarchyNode[];
  rows: FolderVirtualRow<Item>[];
};

/** Bounded slice of virtual rows plus the heights represented by its spacers. */
export type VirtualWindow = {
  start: number;
  end: number;
  top: number;
  bottom: number;
};

/** Returns the first row whose bottom edge lies after the requested offset. */
function findFirstRowAfter(offsets: readonly number[], target: number): number {
  const rowCount = Math.max(0, offsets.length - 1);
  let low = 0;
  let high = rowCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle + 1] ?? 0) <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Returns the first row whose top edge reaches the requested offset. */
function findFirstRowAt(offsets: readonly number[], target: number): number {
  const rowCount = Math.max(0, offsets.length - 1);
  let low = 0;
  let high = rowCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Selects a viewport-centered row window and reports the omitted spacer heights.
 *
 * The hard row cap is a safety boundary for unusually tall Webviews or trees
 * containing thousands of short folder headers.
 *
 * @param offsets Monotonic row offsets with one trailing total-height entry.
 * @param scrollTop Current scroll offset inside the gallery scroller.
 * @param viewportHeight Current scroller viewport height.
 * @param overscan Extra pixels mounted above and below the viewport.
 * @param maxRows Maximum number of rows allowed in the DOM window.
 */
export function getVirtualWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  maxRows: number,
): VirtualWindow {
  const rowCount = Math.max(0, offsets.length - 1);
  const totalHeight = offsets[rowCount] ?? 0;
  if (!rowCount) {
    return { start: 0, end: 0, top: 0, bottom: 0 };
  }

  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const safeOverscan = Math.max(0, overscan);
  const rowLimit = Math.max(1, Math.floor(maxRows));
  const requestedStart = findFirstRowAfter(offsets, Math.max(0, safeScrollTop - safeOverscan));
  const requestedEnd = Math.max(
    requestedStart + 1,
    findFirstRowAt(offsets, Math.min(totalHeight, safeScrollTop + safeViewportHeight + safeOverscan)),
  );
  let start = Math.min(requestedStart, rowCount - 1);
  let end = Math.min(rowCount, Math.max(start + 1, requestedEnd));
  if (end - start > rowLimit) {
    const visibleStart = findFirstRowAfter(offsets, safeScrollTop);
    const rowsBeforeViewport = Math.min(Math.floor(rowLimit / 4), Math.max(0, visibleStart));
    start = Math.max(0, Math.min(rowCount - rowLimit, visibleStart - rowsBeforeViewport));
    end = Math.min(rowCount, start + rowLimit);
  }

  return {
    start,
    end,
    top: offsets[start] ?? 0,
    bottom: Math.max(0, totalHeight - (offsets[end] ?? totalHeight)),
  };
}

/**
 * Flattens the discovered folder hierarchy into independently virtualizable rows.
 *
 * A collapsed folder contributes its own header but no image rows or descendant
 * headers, matching the previous nested-DOM disclosure behavior.
 *
 * @param items Discovered images in scanner order.
 * @param collapsedFolders Root-relative folder paths currently collapsed.
 * @param columns Number of cards placed in each folder image row.
 */
export function buildFolderVirtualRows<Item extends FolderVirtualItem>(
  items: readonly Item[],
  collapsedFolders: ReadonlySet<string>,
  columns: number,
): FolderVirtualLayout<Item> {
  type TreeNode = {
    folder: FolderHierarchyNode;
    children: TreeNode[];
    images: Item[];
  };

  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const folders: FolderHierarchyNode[] = [];
  for (const item of items) {
    const hierarchy = getFolderHierarchy(item.folder);
    for (const folder of hierarchy) {
      if (nodes.has(folder.path)) {
        continue;
      }
      const node: TreeNode = { folder, children: [], images: [] };
      nodes.set(folder.path, node);
      folders.push(folder);
      const parent = folder.parentPath === undefined ? undefined : nodes.get(folder.parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    nodes.get(hierarchy.at(-1)!.path)!.images.push(item);
  }

  const rows: FolderVirtualRow<Item>[] = [];
  const cardsPerRow = Math.max(1, Math.floor(columns));
  /** Adds one visible subtree and stops immediately at a collapsed parent. */
  const appendNode = (node: TreeNode): void => {
    rows.push({ key: `folder:${node.folder.path}`, kind: "folder", folder: node.folder });
    if (collapsedFolders.has(node.folder.path)) {
      return;
    }
    for (let start = 0; start < node.images.length; start += cardsPerRow) {
      const rowItems = node.images.slice(start, start + cardsPerRow);
      rows.push({
        key: `folder-cards:${node.folder.path}:${rowItems[0]?.resourceUri ?? start}:${rowItems.at(-1)?.resourceUri ?? start}:${rowItems.length}`,
        kind: "cards",
        folder: node.folder,
        items: rowItems,
      });
    }
    for (const child of node.children) {
      appendNode(child);
    }
  };
  for (const root of roots) {
    appendNode(root);
  }
  return { folders, rows };
}

/**
 * Returns the first shortest masonry column so cards within a virtual block
 * retain deterministic placement while that block is mounted.
 *
 * @param columnHeights Current estimated height of every stable column.
 */
export function getShortestMasonryColumnIndex(columnHeights: readonly number[]): number {
  if (!columnHeights.length) {
    return 0;
  }
  let shortestIndex = 0;
  for (let index = 1; index < columnHeights.length; index += 1) {
    if (columnHeights[index] < columnHeights[shortestIndex]) {
      shortestIndex = index;
    }
  }
  return shortestIndex;
}
