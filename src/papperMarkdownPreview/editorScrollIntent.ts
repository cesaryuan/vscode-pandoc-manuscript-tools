import type * as vscode from "vscode";

type EditorState = {
  selectionVersion: number;
  viewportVersion: number;
  selections: readonly vscode.Selection[];
  viewportStart: vscode.Position | undefined;
  selectionChangedAt: number;
  editedAt: number;
  pending: { timer: NodeJS.Timeout; kind: "mouse" | "keyboard" | "viewport" } | undefined;
};

/** Separates editor navigation from selection gestures and text-edit side effects. */
export class HtmlPreviewEditorScrollIntent {
  private states = new WeakMap<vscode.TextEditor, EditorState>();
  private readonly timers = new Set<NodeJS.Timeout>();

  /** Receives the scroll bridge callback without depending on VS Code at runtime. */
  constructor(private readonly sync: (editor: vscode.TextEditor, position?: vscode.Position) => void) {}

  /** Cancels delayed navigation when the preview closes or changes its source document. */
  dispose() {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.states = new WeakMap();
  }

  /** Captures the source before its first event so typing cannot look like navigation. */
  observe(editor: vscode.TextEditor): EditorState {
    let state = this.states.get(editor);
    if (!state) {
      state = {
        selectionVersion: editor.document.version,
        viewportVersion: editor.document.version,
        selections: editor.selections.slice(),
        viewportStart: editor.visibleRanges[0]?.start,
        selectionChangedAt: -Infinity,
        editedAt: -Infinity,
        pending: undefined,
      };
      this.states.set(editor, state);
    }
    return state;
  }

  /** Invalidates queued navigation before deletion or replacement moves the cursor/viewport. */
  onDocumentChanged(editor: vscode.TextEditor) {
    const state = this.observe(editor);
    state.editedAt = Date.now();
    state.viewportVersion = editor.document.version;
    state.viewportStart = editor.visibleRanges[0]?.start;
    this.cancel(state);
  }

  /** Queues only empty, user-originated cursor moves in an unchanged document. */
  onSelectionChanged(editor: vscode.TextEditor, kind?: "mouse" | "keyboard") {
    const state = this.observe(editor);
    const unchangedDocument = state.selectionVersion === editor.document.version;
    const moved = !sameSelections(state.selections, editor.selections);
    state.selectionVersion = editor.document.version;
    state.selections = editor.selections.slice();
    state.selectionChangedAt = Date.now();
    if (!kind || !unchangedDocument || !moved || !editor.selections.length || editor.selections.some(selection => !selection.isEmpty)) {
      this.cancel(state);
      return;
    }
    // Holding an arrow key should keep updating the preview instead of waiting
    // for key release; the timer reads the latest accepted cursor position.
    if (kind === "keyboard" && state.pending?.kind === "keyboard") {
      return;
    }
    this.cancel(state);
    // Mouse-down first collapses the selection even when the user is about to
    // drag. Wait for the following selection events before treating it as a click.
    this.schedule(editor, state, kind);
  }

  /** Queues viewport scrolling while excluding edits, drag auto-scroll, and resize-only events. */
  onVisibleRangesChanged(editor: vscode.TextEditor) {
    const state = this.observe(editor);
    const start = editor.visibleRanges[0]?.start;
    const unchangedDocument = state.viewportVersion === editor.document.version;
    const moved = start && state.viewportStart && !samePosition(start, state.viewportStart);
    state.viewportVersion = editor.document.version;
    state.viewportStart = start;
    if (state.pending && state.pending.kind !== "viewport") {
      return;
    }
    // VS Code provides no wheel reason on viewport events. Correlate nearby
    // edit/selection events so their automatic reveals cannot drive the preview.
    if (!moved || !unchangedDocument || Date.now() - state.editedAt < 120 || Date.now() - state.selectionChangedAt < 120) {
      this.cancel(state);
      return;
    }
    // Keep the first deadline during continuous wheel input so the preview
    // follows at regular intervals instead of waiting until scrolling stops.
    if (!state.pending) {
      this.schedule(editor, state, "viewport");
    }
  }

  /** Coalesces event bursts and rechecks the buffer/selection before sending a scroll. */
  private schedule(editor: vscode.TextEditor, state: EditorState, kind: "mouse" | "keyboard" | "viewport") {
    const version = editor.document.version;
    const viewportSelections = editor.selections.slice();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      state.pending = undefined;
      const selections = kind === "viewport" ? viewportSelections : state.selections;
      if (version === editor.document.version && sameSelections(selections, editor.selections)) {
        this.sync(editor, kind === "viewport" ? undefined : editor.selection.active);
      }
    }, kind === "mouse" ? 120 : 60);
    this.timers.add(timer);
    state.pending = { timer, kind };
  }

  /** Cancels obsolete work when a newer event changes the user's intent. */
  private cancel(state: EditorState) {
    if (state.pending) {
      clearTimeout(state.pending.timer);
      this.timers.delete(state.pending.timer);
      state.pending = undefined;
    }
  }
}

/** Compares coordinates without needing VS Code's runtime Position implementation. */
function samePosition(left: vscode.Position, right: vscode.Position): boolean {
  return left.line === right.line && left.character === right.character;
}

/** Detects both cursor movement and changes to any selection in a multicursor editor. */
function sameSelections(left: readonly vscode.Selection[], right: readonly vscode.Selection[]): boolean {
  return left.length === right.length && left.every((selection, index) => (
    samePosition(selection.anchor, right[index].anchor) && samePosition(selection.active, right[index].active)
  ));
}
