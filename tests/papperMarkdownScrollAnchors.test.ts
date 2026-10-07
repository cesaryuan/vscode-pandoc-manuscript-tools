import assert from "node:assert/strict";
import test from "node:test";
import { PreviewScrollAnchors, type PreviewScrollAnchor } from "../src/papperMarkdownPreview/scrollAnchors";

/** Verifies continuous interpolation and viewport location against independently specified layout coordinates. */
function followsSourceAndPreviewPositions(): void {
  const anchors = new PreviewScrollAnchors();
  assert.equal(anchors.previewTop(10), null);
  assert.equal(anchors.visible(100), undefined);
  anchors.update([
    { blockId: "first", startLine: 10, endLine: 15, top: 100, bottom: 180 },
    { blockId: "second", startLine: 30, endLine: 35, top: 500, bottom: 580 },
    { blockId: "last", startLine: 50, endLine: 55, top: 900, bottom: 1020 },
  ]);
  assert.equal(anchors.previewTop(5), 50);
  assert.equal(anchors.previewTop(20), 300);
  assert.equal(anchors.previewTop(53), 960);
  assert.equal(anchors.previewTop(100), 1020);
  assert.equal(anchors.visible(0)?.blockId, "first");
  assert.equal(anchors.visible(499)?.blockId, "first");
  assert.equal(anchors.visible(500)?.blockId, "second");
  assert.equal(anchors.visible(9000)?.blockId, "last");
}

/** Reproduces side-by-side figures whose visual order differs from their source order, then a layout change. */
function handlesReorderedAndResizedLayout(): void {
  const anchors = new PreviewScrollAnchors();
  anchors.update([
    { blockId: "outer", startLine: 10, endLine: 10, top: 100, bottom: 600 },
    { blockId: "left", startLine: 20, endLine: 20, top: 300, bottom: 600 },
    { blockId: "right", startLine: 30, endLine: 30, top: 150, bottom: 600 },
  ]);
  assert.equal(anchors.visible(200)?.blockId, "right");
  assert.equal(anchors.previewTop(25), 225);
  anchors.update([{ blockId: "right", startLine: 30, endLine: 30, top: 700, bottom: 800 }]);
  assert.equal(anchors.previewTop(30), 700);
  assert.equal(anchors.visible(200)?.blockId, "right");
  anchors.update([]);
  assert.equal(anchors.previewTop(30), null);
}

/** Uses a stable data-access budget to prevent document-end scrolling from becoming a full anchor scan. */
function searchesLongDocumentsWithinLogarithmicBudget(): void {
  let coordinateReads = 0;
  const anchors = new PreviewScrollAnchors();
  const measured: PreviewScrollAnchor[] = Array.from({ length: 20000 }, (_, index) => ({
    blockId: String(index), endLine: index * 3 + 2, bottom: index * 100 + 80,
    /** Counts public source-coordinate access without depending on elapsed CPU time. */
    get startLine() { coordinateReads++; return index * 3; },
    /** Counts layout-coordinate access so a linear scan fails independently of machine speed. */
    get top() { coordinateReads++; return index * 100; },
  }));
  anchors.update(measured);
  coordinateReads = 0;
  assert.equal(anchors.visible(1999950)?.blockId, "19999");
  assert.equal(anchors.previewTop(59997), 1999900);
  assert.ok(coordinateReads < 100, `Document-end lookups read ${coordinateReads} coordinates`);
}

test("source and preview scrolling use continuous mapped coordinates", followsSourceAndPreviewPositions);
test("scroll anchors follow reordered figures and refreshed layouts", handlesReorderedAndResizedLayout);
test("long-document scrolling stays within a logarithmic coordinate-access budget", searchesLongDocumentsWithinLogarithmicBudget);
