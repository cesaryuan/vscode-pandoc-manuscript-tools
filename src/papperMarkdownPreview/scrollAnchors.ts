/** A measured document-space anchor; scrolling changes the viewport, not these coordinates. */
export type PreviewScrollAnchor = { blockId: string; startLine: number; endLine: number; top: number; bottom: number };

/** Searches cached source and layout anchors without walking or measuring the entire DOM per frame. */
export class PreviewScrollAnchors {
  private bySource: PreviewScrollAnchor[] = [];
  private byTop: PreviewScrollAnchor[] = [];

  /** Rebuilds the two ordered indexes only when mappings or document layout change. */
  update(anchors: PreviewScrollAnchor[]): void {
    this.bySource = anchors.slice().sort((left, right) => left.startLine - right.startLine);
    // Nested figures or CSS columns can put visual order ahead of DOM order.
    this.byTop = anchors.slice().sort((left, right) => left.top - right.top);
  }

  /** Finds the visual block immediately above the viewport, including jumps near the document end. */
  visible(scrollTop: number): PreviewScrollAnchor | undefined {
    let low = 0;
    let high = this.byTop.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.byTop[middle].top <= scrollTop) low = middle + 1;
      else high = middle;
    }
    return this.byTop[Math.max(0, low - 1)];
  }

  /** Interpolates fractional source lines using two cached neighbors found in logarithmic time. */
  previewTop(sourcePosition: number): number | null {
    if (!this.bySource.length) return null;
    let low = 0;
    let high = this.bySource.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.bySource[middle].startLine <= sourcePosition) low = middle + 1;
      else high = middle;
    }
    const previous = this.bySource[low - 1];
    const next = this.bySource[low];
    const startPosition = previous?.startLine ?? 0;
    const startTop = previous?.top ?? 0;
    const endPosition = next?.startLine ?? Math.max(startPosition + 1, previous.endLine + 1);
    const endTop = next?.top ?? previous.bottom;
    const progress = Math.max(0, Math.min(1, (sourcePosition - startPosition) / Math.max(1, endPosition - startPosition)));
    return startTop + progress * (endTop - startTop);
  }
}
