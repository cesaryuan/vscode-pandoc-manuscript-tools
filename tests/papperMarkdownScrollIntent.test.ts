import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { HtmlPreviewEditorScrollIntent } from "../src/papperMarkdownPreview/editorScrollIntent";

/** Replays editor event sequences and observes the actual requests sent to the scroll bridge. */
class EditorFixture {
  readonly document = { version: 1 };
  readonly editor: vscode.TextEditor;
  readonly requests: Array<{ line?: number; character?: number }> = [];
  readonly intent: HtmlPreviewEditorScrollIntent;

  /** Uses a deterministic clock so drag and edit event ordering remains reproducible. */
  constructor(private readonly context: TestContext) {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    this.editor = {
      document: this.document,
      selections: [],
      visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 30, character: 0 } }],
    } as unknown as vscode.TextEditor;
    this.select(0);
    this.intent = new HtmlPreviewEditorScrollIntent((_editor, position) => {
      this.requests.push({ line: position?.line, character: position?.character });
    });
    this.intent.observe(this.editor);
    context.after(() => this.intent.dispose());
  }

  /** Changes the cursor or range without dispatching an event yet. */
  select(line: number, anchorLine = line, character = 0) {
    const active = { line, character };
    const anchor = { line: anchorLine, character: anchorLine === line ? character : 0 };
    const selection = { active, anchor, isEmpty: line === anchorLine } as vscode.Selection;
    this.editor.selections = [selection];
    this.editor.selection = selection;
  }

  /** Delivers a settled cursor/selection change, or a command-originated change. */
  selection(line: number, anchorLine = line, userNavigation = true, character = 0, kind: "mouse" | "keyboard" = "mouse") {
    this.select(line, anchorLine, character);
    this.intent.onSelectionChanged(this.editor, userNavigation ? kind : undefined);
  }

  /** Delivers a viewport change, including auto-scroll caused by editing or dragging. */
  viewport(line: number) {
    Object.assign(this.editor, { visibleRanges: [{ start: { line, character: 0 }, end: { line: line + 30, character: 0 } }] });
    this.intent.onVisibleRangesChanged(this.editor);
  }

  /** Delivers a text change before the resulting selection and reveal events. */
  edit() {
    this.document.version++;
    this.intent.onDocumentChanged(this.editor);
  }

  /** Lets the event burst settle without real sleeps. */
  settle(milliseconds = 500) {
    this.context.mock.timers.tick(milliseconds);
  }
}

/** Reproduces mouse-down followed by a drag and auto-scroll beyond the editor viewport. */
function ignoresDragSelection(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(10);
  fixture.settle(20);
  fixture.selection(40, 10);
  fixture.viewport(25);
  fixture.settle(20);
  fixture.selection(60, 10);
  fixture.viewport(45);
  fixture.settle();
  assert.deepEqual(fixture.requests, []);
}

/** Reproduces deletion/replacement of a range, then verifies subsequent navigation still works. */
function ignoresSelectionEdits(context: TestContext) {
  const fixture = new EditorFixture(context);
  for (const replacementCharacter of [0, 1]) {
    fixture.selection(70, 10);
    fixture.settle();
    fixture.edit();
    fixture.selection(10, 10, true, replacementCharacter);
    fixture.viewport(5);
    fixture.settle();
    assert.deepEqual(fixture.requests, []);
    fixture.viewport(20);
    fixture.settle();
    assert.equal(fixture.requests.length, 1, "Scrolling after an edit must resume synchronization");
    fixture.selection(21);
    fixture.settle();
    assert.equal(fixture.requests.at(-1)?.line, 21);
    fixture.requests.length = 0;
  }
}

/** Verifies typing cannot synchronize even if the selection arrives before the document listener. */
function ignoresTypingBeforeDocumentNotification(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.document.version++;
  fixture.selection(1, 1, true, 1);
  fixture.intent.onDocumentChanged(fixture.editor);
  fixture.viewport(1);
  fixture.settle();
  assert.deepEqual(fixture.requests, []);
}

/** Verifies a click and arrow navigation send the final cursor, including movement within one line. */
function synchronizesCursorNavigation(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(40);
  fixture.viewport(25);
  fixture.settle();
  assert.deepEqual(fixture.requests, [{ line: 40, character: 0 }]);
  fixture.selection(41, 41, true, 0, "keyboard");
  fixture.settle();
  fixture.selection(41, 41, true, 3, "keyboard");
  fixture.settle();
  assert.deepEqual(fixture.requests.slice(1), [{ line: 41, character: 0 }, { line: 41, character: 3 }]);
}

/** Verifies collapsing an existing range by navigation is different from replacing it with text. */
function synchronizesNavigationOutOfSelection(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(40, 10);
  fixture.settle();
  fixture.selection(10);
  fixture.settle();
  assert.deepEqual(fixture.requests, [{ line: 10, character: 0 }]);
}

/** Verifies wheel scrolling can follow an edit that did not move the editor viewport. */
function resumesScrollingAfterStationaryEdit(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.edit();
  fixture.selection(0, 0, true, 1);
  fixture.settle();
  fixture.viewport(20);
  fixture.settle();
  assert.deepEqual(fixture.requests, [{ line: undefined, character: undefined }]);
}

/** Verifies viewport scrolling with an existing range works after selection gestures have settled. */
function synchronizesScrollingWithSelection(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(20, 10);
  fixture.settle();
  fixture.viewport(10);
  fixture.viewport(20);
  fixture.settle();
  assert.deepEqual(fixture.requests, [{ line: undefined, character: undefined }]);
}

/** Reproduces viewport-first event ordering and cancels it when an edit or drag follows. */
function cancelsPendingScroll(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.viewport(30);
  fixture.selection(45, 10);
  fixture.settle();
  fixture.viewport(40);
  fixture.edit();
  fixture.selection(10);
  fixture.settle();
  assert.deepEqual(fixture.requests, []);
}

/** Verifies command/unknown-origin reveals and duplicate cursor notifications stay quiet. */
function ignoresNonUserNavigation(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(40, 40, false);
  fixture.viewport(25);
  fixture.settle();
  fixture.selection(40);
  fixture.settle();
  assert.deepEqual(fixture.requests, []);
}

/** Verifies closing/switching the preview discards delayed clicks and viewport requests. */
function cancelsDisposedNavigation(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(10);
  fixture.intent.dispose();
  fixture.settle();
  assert.deepEqual(fixture.requests, []);
}

/** Verifies continuous wheel input updates the preview before scrolling stops. */
function followsContinuousScrolling(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.viewport(10);
  fixture.settle(20);
  fixture.viewport(20);
  fixture.settle(20);
  fixture.viewport(30);
  fixture.settle(20);
  assert.equal(fixture.requests.length, 1);
  fixture.viewport(40);
  fixture.settle(60);
  assert.equal(fixture.requests.length, 2);
}

/** Verifies holding an arrow key sends the latest cursor before key release. */
function followsRepeatedArrowNavigation(context: TestContext) {
  const fixture = new EditorFixture(context);
  fixture.selection(1, 1, true, 0, "keyboard");
  fixture.settle(20);
  fixture.selection(2, 2, true, 0, "keyboard");
  fixture.settle(20);
  fixture.selection(3, 3, true, 0, "keyboard");
  fixture.settle(20);
  assert.deepEqual(fixture.requests, [{ line: 3, character: 0 }]);
}

test("dragging a selection and its auto-scroll do not move the preview", ignoresDragSelection);
test("deleting or replacing selected text does not move the preview", ignoresSelectionEdits);
test("typing before the document notification does not move the preview", ignoresTypingBeforeDocumentNotification);
test("click and arrow cursor navigation synchronize their final position", synchronizesCursorNavigation);
test("navigation collapsing a range synchronizes without a text edit", synchronizesNavigationOutOfSelection);
test("wheel scrolling resumes after an edit without a viewport change", resumesScrollingAfterStationaryEdit);
test("scrolling with a settled text selection still synchronizes", synchronizesScrollingWithSelection);
test("later drag/edit events cancel an earlier viewport scroll", cancelsPendingScroll);
test("command-origin and duplicate cursor events do not synchronize", ignoresNonUserNavigation);
test("closing the preview cancels pending navigation", cancelsDisposedNavigation);
test("continuous wheel scrolling synchronizes before scrolling stops", followsContinuousScrolling);
test("holding an arrow key synchronizes before key release", followsRepeatedArrowNavigation);
