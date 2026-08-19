/**
 * Column-count rules for the image-directory preview.
 *
 * Grid, Masonry, and Folder layouts share this arithmetic so the visible
 * column control remains predictable as the Webview viewport changes.
 */

export const MIN_THUMBNAIL_SIZE_PX = 96;
export const DIRECTORY_PREVIEW_GAP_PX = 14;

export type ColumnCountBounds = {
  min: number;
  max: number;
};

/** Returns the legal column-count interval for a viewport and horizontal inset. */
export function getColumnCountBounds(viewportWidth: number, horizontalInset: number): ColumnCountBounds {
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.floor(viewportWidth) : 0;
  const safeHorizontalInset = Number.isFinite(horizontalInset) ? Math.max(0, Math.floor(horizontalInset)) : 0;
  const availableWidth = Math.max(1, safeViewportWidth - safeHorizontalInset);
  const max = Math.max(1, Math.floor((availableWidth + DIRECTORY_PREVIEW_GAP_PX) / (MIN_THUMBNAIL_SIZE_PX + DIRECTORY_PREVIEW_GAP_PX)));
  return { min: 1, max };
}

/** Clamps a persisted or user-entered column count to the current viewport interval. */
export function clampColumnCount(columns: number, bounds: ColumnCountBounds): number {
  const numericColumns = Number.isFinite(columns) ? Math.round(columns) : bounds.min;
  return Math.max(bounds.min, Math.min(bounds.max, numericColumns));
}

/** Converts a column count into the card width available after inter-column gaps. */
export function getThumbnailSizeForColumns(viewportWidth: number, columns: number, horizontalInset: number): number {
  const bounds = getColumnCountBounds(viewportWidth, horizontalInset);
  const safeColumns = clampColumnCount(columns, bounds);
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.floor(viewportWidth) : 0;
  const safeHorizontalInset = Number.isFinite(horizontalInset) ? Math.max(0, Math.floor(horizontalInset)) : 0;
  const availableWidth = Math.max(1, safeViewportWidth - safeHorizontalInset);
  return Math.max(MIN_THUMBNAIL_SIZE_PX, Math.floor((availableWidth - DIRECTORY_PREVIEW_GAP_PX * (safeColumns - 1)) / safeColumns));
}

/** Applies one Ctrl-wheel step, where wheel-up removes a column and wheel-down adds one. */
export function getWheelAdjustedColumnCount(currentColumns: number, deltaY: number, bounds: ColumnCountBounds): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return clampColumnCount(currentColumns, bounds);
  }
  const direction = deltaY < 0 ? -1 : 1;
  return clampColumnCount(currentColumns + direction, bounds);
}
