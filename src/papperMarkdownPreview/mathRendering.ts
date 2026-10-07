/** A formula and its original TeX, captured before KaTeX replaces its contents. */
export type PreviewMathEntry = { element: HTMLElement; tex: string };

/** Minimal renderer surface used by both the browser bridge and responsiveness checks. */
export type PreviewMathApi = {
  render(tex: string, element: HTMLElement, options: { displayMode: boolean; throwOnError: boolean; fleqn: boolean; macros: Record<string, unknown> }): void;
};

/**
 * Renders formulas in source order with short tasks so long documents do not block input.
 * This function is self-contained because the bridge serializes it into the WebView.
 */
export async function renderPreviewMath(
  entries: PreviewMathEntry[],
  katex: PreviewMathApi,
  fleqn: boolean,
  shouldContinue: () => boolean,
  onError: (error: unknown) => void,
): Promise<{ rendered: number; failures: number; maxBatchMs: number; elapsedMs: number }> {
  const started = performance.now();
  // Preserve Pandoc's document-wide macro scope, including definitions across batches.
  const macros: Record<string, unknown> = {};
  let batchStarted = started;
  let rendered = 0;
  let failures = 0;
  let maxBatchMs = 0;
  for (let index = 0; index < entries.length; index++) {
    if (!shouldContinue()) break;
    const { element, tex } = entries[index];
    try {
      katex.render(tex, element, { displayMode: element.classList.contains("display"), throwOnError: false, fleqn, macros });
      rendered++;
    } catch (error) {
      failures++;
      // A malformed document must not flood the extension with one message per formula.
      if (failures <= 3) onError(error);
    }
    const batchMs = performance.now() - batchStarted;
    maxBatchMs = Math.max(maxBatchMs, batchMs);
    if (batchMs >= 8 && index + 1 < entries.length) {
      // Awaiting a resolved promise only yields to microtasks and still blocks input.
      const scheduler = (globalThis as typeof globalThis & { scheduler?: { postTask(callback: () => void, options: { priority: string }): Promise<void> } }).scheduler;
      // Background priority also lets mapping replies and painting run between batches.
      if (scheduler?.postTask) await scheduler.postTask(() => undefined, { priority: "background" });
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
      batchStarted = performance.now();
    }
  }
  return { rendered, failures, maxBatchMs, elapsedMs: performance.now() - started };
}
