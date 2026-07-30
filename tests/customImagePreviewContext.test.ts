import assert from "node:assert/strict";
import test from "node:test";
import { CustomImagePreviewContext } from "../src/customImagePreviewContext";

/** Verifies the built-in SVG preview guard is enabled only for this extension's lifetime. */
function verifiesCustomImagePreviewContextLifetime(): void {
  const contextUpdates: Array<[string, boolean]> = [];
  const previewContext = new CustomImagePreviewContext((key, value) => contextUpdates.push([key, value]));

  previewContext.enable();
  previewContext.dispose();

  assert.deepEqual(contextUpdates, [
    ["hasCustomImagePreview", true],
    ["hasCustomImagePreview", false],
  ]);
}

test("enables and clears the custom image preview context", verifiesCustomImagePreviewContextLifetime);
