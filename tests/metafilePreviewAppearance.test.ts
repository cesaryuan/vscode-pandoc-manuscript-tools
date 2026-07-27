import assert from "node:assert/strict";
import test from "node:test";
import { getPreviewCanvasAppearance } from "../src/imagePreview/previewAppearance";

/** Verifies EMF and WMF previews can receive a dark-theme-specific canvas style. */
function verifiesMetafileCanvasMarker(): void {
  assert.equal(getPreviewCanvasAppearance("C:\\workspace\\assets\\eq_012.emf"), "metafile");
  assert.equal(getPreviewCanvasAppearance("C:\\workspace\\assets\\eq_013.WMF"), "metafile");
}

/** Verifies ordinary SVG previews retain the transparency checkerboard. */
function verifiesSvgCheckerboardCanvas(): void {
  assert.equal(getPreviewCanvasAppearance("/workspace/assets/figure.svg"), "checkerboard");
}

test("marks EMF and WMF previews for dark-theme canvas styling", verifiesMetafileCanvasMarker);
test("keeps a checkerboard canvas for SVG previews", verifiesSvgCheckerboardCanvas);
