import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseChinesePypiMirror } from "../src/papperToolPolicy";

/** Verifies the mirror needs both a Simplified Chinese system locale and UTC+8. */
function usesMirrorOnlyForSimplifiedChineseAtUtcEight(): void {
  assert.equal(shouldUseChinesePypiMirror("zh-CN", 480), true);
  assert.equal(shouldUseChinesePypiMirror("zh-Hans-CN", 480), true);
  assert.equal(shouldUseChinesePypiMirror("zh-TW", 480), false);
  assert.equal(shouldUseChinesePypiMirror("en-US", 480), false);
  assert.equal(shouldUseChinesePypiMirror("zh-CN", 0), false);
}

test("selects the PyPI mirror from both locale and timezone", usesMirrorOnlyForSimplifiedChineseAtUtcEight);
