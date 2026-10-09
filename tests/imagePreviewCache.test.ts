import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import type { ImagePreviewRenderer } from "../src/imagePreview";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** An outer file update should release all old compression variants while keeping current variants reusable. */
async function dropsSupersededImageVersions(context: TestContext): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-image-cache-"));
  context.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const imagePath = path.join(directory, "image.svg");
  let conversions = 0;
  const module = new SourceModuleFixture({ vscode: {},
    "src/imagePreview/imageTokenParser.ts": {}, "src/imagePreview/dataUri.ts": {},
    "src/imagePreview/emfPreview.ts": {},
    "src/imagePreview/svgPreview.ts": {
      /** Reads real fixture bytes so results expose version reuse without inspecting the cache. */
      async renderSvgPreviewDataUri(_document: unknown, file: string, _output: unknown, options: { maxNestedRasterDimension: number }) {
        conversions++;
        return `${await fs.readFile(file, "utf8")}:${options.maxNestedRasterDimension}`;
      },
    },
  }).load<{ ImagePreviewRenderer: typeof ImagePreviewRenderer }>("src/imagePreview/index.ts");
  const renderer = new module.ImagePreviewRenderer({ /** Discards expected routine cache logs. */ appendLine() {} } as unknown as vscode.OutputChannel);
  context.after(() => renderer.dispose());
  const document = { uri: { scheme: "file", fsPath: imagePath } as vscode.Uri };
  const originalTime = new Date("2025-01-01T00:00:00Z");
  await fs.writeFile(imagePath, "old image");
  await fs.utimes(imagePath, originalTime, originalTime);
  assert.equal(await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 100 }), "old image:100");
  await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 50 });
  await fs.writeFile(imagePath, "new image");
  await fs.utimes(imagePath, originalTime, new Date("2025-01-02T00:00:00Z"));
  assert.equal(await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 100 }), "new image:100");
  await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 50 });
  await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 100 });
  assert.equal(conversions, 4);
  // Restoring identical old bytes and metadata exposes whether obsolete variants were actually retained.
  await fs.writeFile(imagePath, "old image");
  await fs.utimes(imagePath, originalTime, originalTime);
  assert.equal(await renderer.renderToDataUri(document, imagePath, ".svg", { nestedRasterMaxDimension: 50 }), "old image:50");
  assert.equal(conversions, 5);
}

test("image preview caches reuse current variants and release superseded file versions", dropsSupersededImageVersions);
