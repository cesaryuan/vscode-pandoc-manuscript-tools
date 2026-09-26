import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { applyHtmlPreviewKaTeXNonce, buildHtmlPreviewCsp } from "../htmlPreviewCsp";

/**
 * Formats an elapsed wall-clock duration for Output channel timing logs.
 *
 * @param startedAt Epoch milliseconds captured before an operation.
 */
export function formatElapsedMs(startedAt: number) {
  return `${Math.max(0, Date.now() - startedAt)} ms`;
}

/**
 * Returns the HTML path produced by Papper for a Markdown input file.
 *
 * @param rootUri Project root URI.
 * @param markdownUri Markdown file URI.
 */
export function getExpectedHtmlUri(rootUri: vscode.Uri, markdownUri: vscode.Uri) {
  const outputName = `${path.parse(markdownUri.fsPath).name}.html`;
  return vscode.Uri.file(path.join(rootUri.fsPath, "output", "html", outputName));
}

/**
 * Creates a nonce for the inline Webview scroll bridge script.
 */
export function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Removes a temporary Markdown mirror, retrying briefly if Papper still holds it.
 *
 * @param filePath Temporary Markdown path.
 * @param output Output channel for an unusual cleanup failure.
 */
export async function removeTemporaryMarkdown(filePath: string, output: vscode.OutputChannel) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return;
    }
  }
  output.appendLine(`[HTML] Could not remove temporary Markdown mirror: ${filePath}`);
}

/**
 * Returns whether a filesystem error means the temporary file is already gone.
 *
 * @param error Filesystem error.
 */
function isFileNotFoundError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code) === "ENOENT");
}

/**
 * Counts one HTML element type without parsing or rewriting its contents.
 *
 * @param html HTML source.
 * @param elementName Element name to count.
 */
export function countHtmlElements(html: string, elementName: string) {
  return (html.match(new RegExp(`<${elementName}\\b`, "gi")) || []).length;
}

/**
 * Rewrites local HTML resources into Webview-safe URIs.
 *
 * Papper's HTML output keeps relative image/resource paths. Webviews cannot
 * load those paths directly, so resolve them against the Markdown directory.
 *
 * @param html Generated HTML.
 * @param webview Target Webview.
 * @param sourceDirectory Directory containing the source Markdown file.
 */
export function rewriteHtmlResourceUris(html: string, webview: vscode.Webview, sourceDirectory: string) {
  return html.replace(/(\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix: string, value: string, suffix: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) {
      return match;
    }
    const resourcePath = path.resolve(sourceDirectory, value);
    return `${prefix}${webview.asWebviewUri(vscode.Uri.file(resourcePath)).toString()}${suffix}`;
  });
}

/**
 * Injects the Webview scroll bridge into generated standalone HTML.
 *
 * @param html Generated HTML.
 * @param nonce Script nonce.
 * @param cspSource Webview CSP source token.
 */
export function injectHtmlPreviewBridge(html: string, nonce: string, cspSource: string) {
  const noncePreparedHtml = applyHtmlPreviewKaTeXNonce(html, nonce);
  const csp = buildHtmlPreviewCsp(noncePreparedHtml, nonce, cspSource);
  // String.raw preserves regex backslashes in the embedded browser script.
  const bridge = String.raw`<meta http-equiv="Content-Security-Policy" content="${csp}"><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'scrollSyncTrace', detail: 'bridge loaded' });
let suppressScroll = false;
let scrollFrame = 0;
let lastScrollTraceAt = 0;
let pendingSourceScrollTarget = null;
let pendingSourceScrollTimer = 0;
let lastSentRatio = -1;
let lastSentSourceLine = -1;
let lastSentBlockId = '';
let lastSentBlockOffsetRatio = 0;
let previewUpdateChain = Promise.resolve();
let previewContent = null;
let previewBlocks = [];
let previewBlockMapReady = false;
let readySent = false;
let pendingSourceScroll = null;
let pendingSourceMappingTimer = 0;
function ensurePreviewContent() {
  if (previewContent && previewContent.isConnected) return previewContent;
  if (!document.body) return null;
  previewContent = document.getElementById('pmt-preview-content');
  if (!previewContent) {
    previewContent = document.createElement('div');
    previewContent.id = 'pmt-preview-content';
    previewContent.append(...Array.from(document.body.childNodes));
    document.body.appendChild(previewContent);
  }
  return previewContent;
}
// Returns the element that owns the document's vertical scroll position.
function getScrollElement() {
  return document.scrollingElement || document.documentElement || document.body;
}
// Reads scrollTop from the active document scroller, with the viewport as a fallback.
function getScrollTop() {
  const scroller = getScrollElement();
  return scroller ? scroller.scrollTop : window.scrollY || 0;
}
// Returns the scrollable document height used by both directions of synchronization.
function getScrollHeight() {
  const scroller = getScrollElement();
  return scroller ? scroller.scrollHeight : document.documentElement.scrollHeight;
}
// Returns the viewport height used for mapped block offsets and ratio calculations.
function getViewportHeight() {
  return window.innerHeight || document.documentElement.clientHeight || 1;
}
// Sets the active document scroller without assuming that the viewport owns scrolling.
function setScrollTop(top) {
  const scroller = getScrollElement();
  if (scroller && typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: 'auto' });
    return;
  }
  window.scrollTo({ top, behavior: 'auto' });
}
// Emits at most four WebView scroll diagnostics per second to keep Output usable.
function traceScroll(message) {
  const now = Date.now();
  if (now - lastScrollTraceAt < 250) return;
  lastScrollTraceAt = now;
  vscode.postMessage({ type: 'scrollSyncTrace', detail: message });
}
function scrollRatio() {
  const max = Math.max(1, getScrollHeight() - getViewportHeight());
  return Math.max(0, Math.min(1, getScrollTop() / max));
}
// Collects rendered blocks once per HTML revision for source-line mapping.
function collectPreviewBlocks() {
  const content = ensurePreviewContent();
  if (!content) return [];
  const candidates = [
    ...Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6')),
    ...Array.from(content.querySelectorAll('figure')),
    ...Array.from(content.querySelectorAll('table')),
    ...Array.from(content.querySelectorAll('.math')).filter(element => !element.closest('p,figure,table')),
    ...Array.from(content.querySelectorAll('p')).filter(element => !element.closest('figure,table'))
  ];
  const unique = Array.from(new Set(candidates));
  unique.sort((left, right) => {
    const relation = left.compareDocumentPosition(right);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return unique.map((element, index) => {
    const blockId = 'pmt-block-' + index;
    element.setAttribute('data-pmt-block-id', blockId);
    element.removeAttribute('data-source-line');
    element.removeAttribute('data-source-end-line');
    let blockType = 'paragraph';
    let text = getClickableText(element);
    const heading = element.matches('h1,h2,h3,h4,h5,h6');
    const math = element.matches('.math');
    const figure = element.matches('figure');
    const table = element.matches('table');
    if (heading) blockType = 'heading';
    else if (math) blockType = 'math';
    else if (figure) blockType = 'image';
    else if (table) blockType = 'table';
    const image = figure ? element.querySelector('img') : null;
    const figureCaption = figure ? element.querySelector('figcaption') : null;
    const tableCaption = table ? element.querySelector('caption') : null;
    const alt = image ? image.getAttribute('alt') || '' : '';
    const caption = figureCaption ? getClickableText(figureCaption) : tableCaption ? getClickableText(tableCaption) : '';
    if (figure) text = caption || alt;
    if (table) text = getClickableText(element);
    return {
      element,
      blockId,
      blockType,
      label: getClickableLabel(element),
      text,
      caption,
      alt,
      tex: math ? element.getAttribute('data-pmt-tex') || '' : '',
      display: math
    };
  });
}
// Requests one source mapping for the current rendered block order.
function requestPreviewBlockMapping() {
  previewBlocks = collectPreviewBlocks();
  previewBlockMapReady = false;
  vscode.postMessage({
    type: 'previewBlocks',
    blocks: previewBlocks.map(({ element, ...block }) => block)
  });
}
// Releases a source scroll request if a host mapping cannot be produced.
function deferSourceScrollUntilMapping(message) {
  pendingSourceScroll = message;
  if (pendingSourceMappingTimer) window.clearTimeout(pendingSourceMappingTimer);
  pendingSourceMappingTimer = window.setTimeout(() => {
    if (pendingSourceScroll === message && !previewBlockMapReady) {
      pendingSourceScroll = null;
      applySourceScroll(message);
    }
    pendingSourceMappingTimer = 0;
  }, 1000);
}
// Returns the block whose source line is closest to the requested source position.
function findPreviewBlockForSourceLine(sourceLine) {
  let containing = null;
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const block of previewBlocks) {
    const startLine = Number(block.element.getAttribute('data-source-line'));
    const endLine = Number(block.element.getAttribute('data-source-end-line'));
    if (!Number.isFinite(startLine)) continue;
    if (Number.isFinite(endLine) && sourceLine >= startLine && sourceLine <= endLine) {
      containing = block;
      break;
    }
    const distance = Math.abs(startLine - sourceLine);
    if (distance < nearestDistance) {
      nearest = block;
      nearestDistance = distance;
    }
  }
  return containing || nearest;
}
// Returns the mapped block currently nearest the top of the preview viewport.
function getVisibleSourceBlock() {
  let previous = null;
  let next = null;
  for (const block of previewBlocks) {
    if (!block.element.hasAttribute('data-source-line')) continue;
    const rect = block.element.getBoundingClientRect();
    if (rect.top <= 0) {
      previous = block;
      continue;
    }
    next = block;
    break;
  }
  return previous || next;
}
// VS Code may inject #_defaultStyles after the preview loads; remove it so it
// cannot override Papper's generated styles, including after incremental updates.
function removeVscodeDefaultStyles() {
  document.querySelectorAll('style#_defaultStyles').forEach(style => style.remove());
}
const styleObserver = new MutationObserver(removeVscodeDefaultStyles);
styleObserver.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', removeVscodeDefaultStyles, { once: true });
removeVscodeDefaultStyles();
// Waits briefly for the KaTeX script declared by the generated HTML.
function waitForKaTeX() {
  if (window.katex && typeof window.katex.render === 'function') {
    return Promise.resolve(window.katex);
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (window.katex && typeof window.katex.render === 'function') {
        resolve(window.katex);
        return;
      }
      if (Date.now() - startedAt >= 5000) {
        reject(new Error('KaTeX did not load within 5 seconds.'));
        return;
      }
      window.setTimeout(check, 25);
    };
    check();
  });
}
// Removes Pandoc's outer math delimiters before rendering a raw math span.
function unwrapMathDelimiters(tex) {
  const trimmed = tex.trim();
  const delimiters = [
    [/^\\\(([\s\S]*)\\\)$/, '$1'],
    [/^\\\[([\s\S]*)\\\]$/, '$1'],
    [/^\$\$([\s\S]*)\$\$$/, '$1'],
    [/^\$([\s\S]*)\$$/, '$1']
  ];
  for (const [pattern, replacement] of delimiters) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement).trim();
  }
  return trimmed;
}
// Renders raw Pandoc math spans that KaTeX has not already converted.
async function renderKaTeX(root) {
  const elements = Array.from(root.querySelectorAll('.math')).filter(element => element.tagName === 'SPAN');
  if (elements.length === 0) return;
  const formulaEntries = elements.map(element => {
    const annotation = element.querySelector('annotation[encoding="application/x-tex"], annotation');
    const tex = element.getAttribute('data-pmt-tex') || annotation?.textContent || unwrapMathDelimiters(element.textContent || '');
    return { element, tex };
  });
  // Keep the pre-render TeX because KaTeX replaces the span text with nested
  // glyph markup, which is not stable enough for source navigation matching.
  formulaEntries.forEach(({ element, tex }) => element.setAttribute('data-pmt-tex', tex));
  const renderableEntries = formulaEntries.filter(({ element }) => !element.querySelector('.katex'));
  if (renderableEntries.length === 0) return;
  vscode.postMessage({ type: 'previewKatexStarted', detail: 'math=' + renderableEntries.length });
  let katex;
  try {
    katex = await waitForKaTeX();
  } catch (error) {
    vscode.postMessage({ type: 'previewKatexUnavailable', detail: 'math=' + renderableEntries.length + ';error=' + String(error) });
    return;
  }
  let failures = 0;
  for (const { element, tex } of renderableEntries) {
    try {
      katex.render(tex, element, {
        displayMode: element.classList.contains('display'),
        throwOnError: false
      });
    } catch (error) {
      failures += 1;
      vscode.postMessage({ type: 'previewKatexFailed', detail: 'error=' + String(error) });
    }
  }
  vscode.postMessage({ type: 'previewKatexFinished', detail: 'katex=' + root.querySelectorAll('.katex').length + ';failures=' + failures });
}
// Returns visible text while excluding rendered formulas that have a separate
// TeX source locator.
function getClickableText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.math, .katex, .citation, .header-section-number, .header-section-name, script, style').forEach(child => child.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}
// Finds a Pandoc label exposed as an id on the rendered block or its wrapper.
function getClickableLabel(element) {
  const labeled = element.closest('[id^="sec:"], [id^="fig:"], [id^="tbl:"], [id^="eq:"]');
  return labeled ? labeled.id : '';
}
// Returns the nearest block ID assigned during source mapping.
function getClickableBlockId(element) {
  const block = element.closest('[data-pmt-block-id]');
  return block ? block.getAttribute('data-pmt-block-id') || '' : '';
}
// Emits a source-navigation request for a clicked rendered block.
function handlePreviewClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest('a, button, input, select, textarea, summary')) return;
  const caption = target.closest('figcaption, caption');
  if (caption) {
    const owner = caption.closest('figure, table');
    const image = owner ? owner.querySelector('img') : null;
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'caption', blockId: owner ? getClickableBlockId(owner) : '', label: owner ? getClickableLabel(owner) : '', text: getClickableText(caption), caption: getClickableText(caption), alt: image ? image.getAttribute('alt') || '' : '' });
    return;
  }
  const heading = target.closest('h1, h2, h3, h4, h5, h6');
  if (heading) {
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'heading', blockId: getClickableBlockId(heading), label: getClickableLabel(heading), text: getClickableText(heading) });
    return;
  }
  const math = target.closest('[data-pmt-tex], .math');
  if (math) {
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'math', blockId: getClickableBlockId(math), label: getClickableLabel(math), tex: math.getAttribute('data-pmt-tex') || '', text: getClickableText(math), display: math.classList.contains('display') });
    return;
  }
  const figure = target.closest('figure');
  if (figure) {
    const image = figure.querySelector('img');
    const figureCaption = figure.querySelector('figcaption');
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'image', blockId: getClickableBlockId(figure), label: getClickableLabel(figure), text: figureCaption ? getClickableText(figureCaption) : image ? image.getAttribute('alt') || '' : '', caption: figureCaption ? getClickableText(figureCaption) : '', alt: image ? image.getAttribute('alt') || '' : '' });
    return;
  }
  const table = target.closest('table');
  if (table) {
    const tableCaption = table.querySelector('caption');
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'table', blockId: getClickableBlockId(table), label: getClickableLabel(table), text: getClickableText(table), caption: tableCaption ? getClickableText(tableCaption) : '' });
    return;
  }
  const image = target.closest('img');
  if (image) {
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'image', blockId: getClickableBlockId(image), label: getClickableLabel(image), text: image.getAttribute('alt') || '', alt: image.getAttribute('alt') || '' });
    return;
  }
  const paragraph = target.closest('p');
  if (paragraph) {
    const mathInParagraph = paragraph.querySelector('.math, [data-pmt-tex]');
    if (mathInParagraph && target === mathInParagraph) return;
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'paragraph', blockId: getClickableBlockId(paragraph), label: getClickableLabel(paragraph), text: getClickableText(paragraph) });
  }
}
document.addEventListener('click', handlePreviewClick);
async function replacePreviewHtml(html, token) {
  const previousScrollTop = getScrollTop();
  vscode.postMessage({ type: 'previewUpdateStarted', detail: token || '' });
  let staging = null;
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const nextBody = parsed.body;
    if (!nextBody) throw new Error('The generated preview has no body element.');
    suppressScroll = true;
    staging = document.createElement('div');
    // Keep the next revision in a live but invisible tree so KaTeX can finish
    // before the visible tree is replaced and raw TeX never flashes.
    staging.style.cssText = 'position:fixed;left:-100000px;top:0;width:100%;visibility:hidden;pointer-events:none;z-index:-1;';
    staging.innerHTML = nextBody.innerHTML;
    document.body.appendChild(staging);
    const currentPandocStyles = Array.from(document.head.querySelectorAll('style[data-papper-preview-style="pandoc"]'));
    const nextPandocStyles = Array.from(parsed.head.querySelectorAll('style[data-papper-preview-style="pandoc"]'));
    const stylesChanged = currentPandocStyles.length !== nextPandocStyles.length || currentPandocStyles.some((style, index) => style.textContent !== nextPandocStyles[index].textContent);
    if (stylesChanged) {
      currentPandocStyles.forEach(style => style.remove());
      nextPandocStyles.forEach(style => document.head.appendChild(style.cloneNode(true)));
    }
    const content = ensurePreviewContent();
    if (!content) throw new Error('Preview content container is unavailable.');
    await renderKaTeX(staging);

    // Copy rendered staging markup into the stable visible container.
    const nextContentHtml = staging.innerHTML;
    staging.remove();
    staging = null;
    content.innerHTML = nextContentHtml;
    requestPreviewBlockMapping();
    removeVscodeDefaultStyles();
    const restoreScrollTop = () => {
      setScrollTop(previousScrollTop);
      lastSentRatio = scrollRatio();
      lastSentSourceLine = -1;
      lastSentBlockId = '';
      lastSentBlockOffsetRatio = 0;
    };
    requestAnimationFrame(() => {
      restoreScrollTop();
      suppressScroll = false;
    });
    window.setTimeout(restoreScrollTop, 120);
    const pendingImages = Array.from(content.querySelectorAll('img')).filter(image => !image.complete);
    if (pendingImages.length) {
      Promise.all(pendingImages.map(image => new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      }))).then(restoreScrollTop);
    }
    vscode.postMessage({ type: 'previewUpdateFinished', detail: token || '' });
  } catch (error) {
    if (staging) staging.remove();
    suppressScroll = false;
    vscode.postMessage({ type: 'previewUpdateFailed', detail: token || String(error) });
    const fallback = new DOMParser().parseFromString(html, 'text/html').body;
    if (fallback) {
      document.body.innerHTML = fallback.innerHTML;
      previewContent = null;
      previewBlocks = [];
      previewBlockMapReady = false;
    }
  }
}
// Applies the latest source position after generated preview block mappings are available.
function applySourceScroll(message) {
  const max = Math.max(0, getScrollHeight() - getViewportHeight());
  const requestedOffset = Number.isFinite(message.offsetRatio)
    ? Math.max(-1.5, Math.min(1.5, message.offsetRatio))
    : 0;
  let targetTop;
  const sourceLine = Number.isFinite(message.sourceLine) ? Number(message.sourceLine) : null;
  const block = sourceLine === null ? null : findPreviewBlockForSourceLine(sourceLine);
  if (block) {
    const blockTop = getScrollTop() + block.element.getBoundingClientRect().top;
    targetTop = blockTop - requestedOffset * getViewportHeight();
  } else {
    const ratio = Number.isFinite(message.ratio) ? Math.max(0, Math.min(1, message.ratio)) : 0;
    targetTop = ratio * max - requestedOffset * getViewportHeight();
  }
  targetTop = Math.max(0, Math.min(max, targetTop));
  // Ignore only this programmatic position; a time window can swallow real user scrolling.
  pendingSourceScrollTarget = targetTop;
  if (pendingSourceScrollTimer) window.clearTimeout(pendingSourceScrollTimer);
  pendingSourceScrollTimer = window.setTimeout(() => {
    pendingSourceScrollTarget = null;
    pendingSourceScrollTimer = 0;
  }, 300);
  setScrollTop(targetTop);
}
window.addEventListener('message', event => {
  if (event.data && event.data.type === 'replacePreviewHtml' && typeof event.data.html === 'string') {
    previewUpdateChain = previewUpdateChain.then(() => replacePreviewHtml(event.data.html, event.data.token));
    return;
  }
  if (event.data && event.data.type === 'previewBlockMap') {
    applyPreviewBlockMap(event.data.mappings);
    return;
  }
  if (!event.data || event.data.type !== 'sourceScroll') return;
  vscode.postMessage({ type: 'scrollSyncTrace', detail: 'sourceScroll received ready=' + readySent });
  if (!readySent) {
    deferSourceScrollUntilMapping(event.data);
    return;
  }
  if (!previewBlockMapReady && Number.isFinite(event.data.sourceLine)) {
    deferSourceScrollUntilMapping(event.data);
    return;
  }
  applySourceScroll(event.data);
});
// Applies host-provided source ranges to the rendered block elements.
function applyPreviewBlockMap(mappings) {
  const mappingById = new Map((Array.isArray(mappings) ? mappings : []).map(mapping => [mapping.blockId, mapping]));
  for (const block of previewBlocks) {
    const mapping = mappingById.get(block.blockId);
    if (!mapping || !Number.isFinite(mapping.startLine)) {
      block.element.removeAttribute('data-source-line');
      block.element.removeAttribute('data-source-end-line');
      continue;
    }
    block.element.setAttribute('data-source-line', String(mapping.startLine));
    block.element.setAttribute('data-source-end-line', String(Number.isFinite(mapping.endLine) ? mapping.endLine : mapping.startLine));
  }
  previewBlockMapReady = true;
  if (pendingSourceMappingTimer) {
    window.clearTimeout(pendingSourceMappingTimer);
    pendingSourceMappingTimer = 0;
  }
  if (pendingSourceScroll) {
    const message = pendingSourceScroll;
    pendingSourceScroll = null;
    applySourceScroll(message);
  }
}
// Handles scroll events from either the viewport or a nested document scroller.
function handlePreviewScrollEvent() {
  if (suppressScroll || scrollFrame) return;
  traceScroll('scroll event observed top=' + Math.round(getScrollTop()));
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (suppressScroll) return;
    if (pendingSourceScrollTarget !== null && Math.abs(getScrollTop() - pendingSourceScrollTarget) < 2) {
      pendingSourceScrollTarget = null;
      if (pendingSourceScrollTimer) window.clearTimeout(pendingSourceScrollTimer);
      pendingSourceScrollTimer = 0;
      return;
    }
    pendingSourceScrollTarget = null;
    if (pendingSourceScrollTimer) window.clearTimeout(pendingSourceScrollTimer);
    pendingSourceScrollTimer = 0;
    const ratio = scrollRatio();
    const block = getVisibleSourceBlock();
    const sourceLine = block ? Number(block.element.getAttribute('data-source-line')) : null;
    const blockId = block ? block.blockId : '';
    const blockOffsetRatio = block ? Math.max(-1.5, Math.min(1.5, block.element.getBoundingClientRect().top / getViewportHeight())) : 0;
    if (Math.abs(ratio - lastSentRatio) < 0.01 && sourceLine === lastSentSourceLine && blockId === lastSentBlockId && Math.abs(blockOffsetRatio - lastSentBlockOffsetRatio) < 0.02) return;
    lastSentRatio = ratio;
    lastSentSourceLine = sourceLine;
    lastSentBlockId = blockId;
    lastSentBlockOffsetRatio = blockOffsetRatio;
    vscode.postMessage({ type: 'previewScroll', ratio, sourceLine: Number.isFinite(sourceLine) ? sourceLine : undefined, blockId, blockOffsetRatio });
  });
}
window.addEventListener('scroll', handlePreviewScrollEvent, { passive: true });
// Scroll events on the document do not always bubble to window in WebView Chromium.
document.addEventListener('scroll', handlePreviewScrollEvent, { passive: true, capture: true });
const sendReady = () => {
  if (readySent) return;
  const content = ensurePreviewContent();
  // The standalone Papper page may have rendered KaTeX before this bridge;
  // record annotation TeX immediately so clicks still locate source math.
  if (content) {
    const katexRender = renderKaTeX(content).catch(error => vscode.postMessage({ type: 'previewKatexFailed', detail: 'initial=' + String(error) }));
    requestPreviewBlockMapping();
    void katexRender.finally(requestPreviewBlockMapping);
  } else {
    requestPreviewBlockMapping();
  }
  readySent = true;
  vscode.postMessage({ type: 'ready' });
  if (pendingSourceScroll && (previewBlockMapReady || !Number.isFinite(pendingSourceScroll.sourceLine))) {
    const message = pendingSourceScroll;
    pendingSourceScroll = null;
    applySourceScroll(message);
  }
};
window.addEventListener('DOMContentLoaded', sendReady, { once: true });
window.addEventListener('load', sendReady, { once: true });
</script>`;
  const withoutExistingCsp = noncePreparedHtml.replace(/<meta\s+http-equiv=["']content-security-policy["'][^>]*>\s*/gi, "");
  const markedPandocStyles = withoutExistingCsp.replace(/<style(?=[\s>])/gi, '<style data-papper-preview-style="pandoc"');
  const headIndex = markedPandocStyles.search(/<head(?:\s[^>]*)?>/i);
  if (headIndex >= 0) {
    const end = markedPandocStyles.indexOf(">", headIndex) + 1;
    return `${markedPandocStyles.slice(0, end)}${bridge}${markedPandocStyles.slice(end)}`;
  }
  return `${bridge}${markedPandocStyles}`;
}
/**
 * Waits briefly for a WebView to acknowledge an incremental HTML replacement.
 *
 * @param confirmation Promise resolved by the panel message handler.
 */
export async function waitForWebviewUpdate(confirmation: Promise<boolean>) {
  return Promise.race([
    confirmation,
    // KaTeX renders synchronously after its page script loads, so a short bound
    // is enough to release the build queue if that external script is blocked.
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
}
