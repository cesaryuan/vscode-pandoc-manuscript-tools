/**
 * Stable gallery and scroll-position helpers.
 *
 * The gallery keeps discovered card skeletons in place and only appends new
 * cards. Masonry also uses fixed independent columns so appending a batch never
 * rebalances cards that the user is currently viewing.
 */

/**
 * Returns the metadata range that has not yet received a stable gallery card.
 *
 * Existing cards are never replaced during scrolling. A rendered count larger
 * than the current item count means the gallery was reset and must be rebuilt.
 *
 * @param renderedCount Number of cards already represented in the DOM.
 * @param itemCount Number of currently discovered images.
 */
export function getStableGalleryAppendRange(renderedCount: number, itemCount: number): { start: number; end: number } {
  const end = Math.max(0, itemCount);
  const start = renderedCount >= 0 && renderedCount <= end ? renderedCount : 0;
  return { start, end };
}

/**
 * Returns the first shortest masonry column so appending never rebalances
 * cards that are already visible.
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
