import assert from "node:assert/strict";
import test from "node:test";
import { renderPreviewMath, type PreviewMathEntry } from "../src/papperMarkdownPreview/mathRendering";

/** Supplies formula containers independently of the browser's glyph layout. */
function formulas(count: number): PreviewMathEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    tex: String(index),
    element: { classList: { contains: () => index % 2 === 0 } } as unknown as HTMLElement,
  }));
}

/** Simulates synchronous formula work so an input task must run before a long document finishes. */
async function keepsInputResponsiveDuringFormulaRendering(): Promise<void> {
  const entries = formulas(40);
  const rendered: string[] = [];
  let renderedWhenInputRan = -1;
  const input = new Promise<void>((resolve) => setTimeout(() => { renderedWhenInputRan = rendered.length; resolve(); }, 0));
  const result = await renderPreviewMath(entries, {
    /** Reproduces KaTeX's synchronous work without a timing assertion tied to CPU speed. */
    render(tex) {
      const started = performance.now();
      while (performance.now() - started < 1) { /* A renderer call cannot yield until it returns. */ }
      rendered.push(tex);
    },
  }, false, () => true, (error) => { throw error; });
  await input;
  assert.ok(renderedWhenInputRan > 0 && renderedWhenInputRan < entries.length, "Input was starved until all formulas finished");
  assert.deepEqual(rendered, entries.map(entry => entry.tex));
  assert.equal(result.rendered, entries.length);
  assert.equal(result.failures, 0);
}

/** Preserves equation alignment and document-wide macro definitions, even after a bad formula. */
async function preservesFormulaSemanticsAndContinuesAfterErrors(): Promise<void> {
  const entries = formulas(3);
  const outputs: string[] = [];
  const errors: unknown[] = [];
  const result = await renderPreviewMath(entries, {
    /** Models a macro definition used by a later formula across a failed middle expression. */
    render(tex, _element, options) {
      assert.equal(options.fleqn, true);
      assert.equal(options.displayMode, tex !== "1");
      if (tex === "0") options.macros.response = "R";
      else if (tex === "1") throw new Error("Invalid formula");
      else outputs.push(String(options.macros.response));
    },
  }, true, () => true, (error) => errors.push(error));
  assert.deepEqual(outputs, ["R"]);
  assert.equal(result.rendered, 2);
  assert.equal(result.failures, 1);
  assert.equal(errors.length, 1);
}

/** A pending refresh must stop spending CPU on the obsolete formula tree. */
async function stopsRenderingSupersededContent(): Promise<void> {
  let current = true;
  const rendered: string[] = [];
  await renderPreviewMath(formulas(3), {
    /** Supersedes the old revision after the first completed expression. */
    render(tex) { rendered.push(tex); current = false; },
  }, false, () => current, (error) => { throw error; });
  assert.deepEqual(rendered, ["0"]);
}

test("long formula rendering lets pending input run before completion", keepsInputResponsiveDuringFormulaRendering);
test("formula batches preserve alignment, macro scope, and error recovery", preservesFormulaSemanticsAndContinuesAfterErrors);
test("formula rendering stops when its preview revision is superseded", stopsRenderingSupersededContent);
