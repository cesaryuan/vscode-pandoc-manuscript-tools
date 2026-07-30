import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { resolveLocalPath } from "../src/imagePreview/pathResolver";

/** Verifies a Git-backed SVG can resolve nested images from its displayed filesystem path. */
function verifiesVirtualSvgRelativeImageResolution(): void {
  const imagePath = path.join("E:\\workspace", "assets", "icon.png");
  const resolved = resolveLocalPath(
    { uri: { scheme: "git", fsPath: path.join("E:\\workspace", "test_project", "assets", "fixture.svg") } as import("vscode").Uri },
    "../../assets/icon.png",
    path.dirname(path.join("E:\\workspace", "test_project", "assets", "fixture.svg")),
  );

  assert.equal(resolved, imagePath);
}

test("resolves nested SVG images for Git-backed diff resources", verifiesVirtualSvgRelativeImageResolution);
