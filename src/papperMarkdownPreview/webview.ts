import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { prepareHtmlPreviewKaTeX, buildHtmlPreviewCsp } from "../htmlPreviewCsp";
import { PreviewScrollAnchors } from "./scrollAnchors";
import { renderPreviewMath } from "./mathRendering";

/**
 * Creates a nonce for the inline Webview scroll bridge script.
 */
export function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Removes a temporary Markdown directory, retrying briefly if Papper still holds it.
 *
 * @param directoryPath Temporary build directory.
 * @param output Output channel for an unusual cleanup failure.
 */
export async function removeTemporaryMarkdownDirectory(directoryPath: string, output: vscode.OutputChannel) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return;
    }
  }
  output.appendLine(`[HTML] Could not remove temporary Markdown directory: ${directoryPath}`);
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
  const preparedMath = prepareHtmlPreviewKaTeX(html);
  const csp = buildHtmlPreviewCsp(preparedMath.html, nonce, cspSource);
  // String.raw preserves regex backslashes in the embedded browser script.
  const bridge = String.raw`<meta http-equiv="Content-Security-Policy" content="${csp}"><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let suppressScroll = false;
let scrollFrame = 0;
let sourceScrollFrame = 0;
let latestSourceScroll = null;
let pendingSourceScrollTarget = null;
let pendingSourceScrollTimer = 0;
let lastSentRatio = -1;
let lastSentSourceLine = -1;
let lastSentBlockId = '';
let lastSentBlockOffsetRatio = 0;
let previewUpdateChain = Promise.resolve();
let previewContent = null;
let previewBlocks = [];
let previewTextCache = new WeakMap();
let mappedPreviewBlocks = [];
let previewLayoutDirty = true;
let previewMappingRevision = 0;
let previewResizeObserver = null;
let previewMathRendering = 0;
let previewUserScrolledDuringMath = false;
// Serialize the self-contained class so tests and the packaged bridge use the same algorithm.
const PreviewScrollAnchors = (${PreviewScrollAnchors.toString()});
const previewScrollAnchors = new PreviewScrollAnchors();
const renderPreviewMath = (${renderPreviewMath.toString()});
const previewMathFleqn = ${preparedMath.fleqn};
// Report actual WebView stalls, including layout and image decoding outside our JS timers.
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
  let reportedLongTasks = 0;
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.duration >= 100 && reportedLongTasks++ < 10) {
        vscode.postMessage({ type: 'previewPerformance', detail: 'mainThreadBlocked=' + entry.duration.toFixed(1) + ' ms;at=' + entry.startTime.toFixed(1) + ' ms' });
      }
    }
  }).observe({ type: 'longtask', buffered: true });
}
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
  if (previewResizeObserver) previewResizeObserver.disconnect();
  previewResizeObserver = new ResizeObserver(invalidatePreviewLayout);
  previewResizeObserver.observe(previewContent);
  return previewContent;
}
// Invalidates geometry after images, fonts, styles, or the viewport change document layout.
function invalidatePreviewLayout() {
  previewLayoutDirty = true;
}
window.addEventListener('resize', invalidatePreviewLayout, { passive: true });
document.addEventListener('load', invalidatePreviewLayout, { passive: true, capture: true });
if (document.fonts) document.fonts.addEventListener('loadingdone', invalidatePreviewLayout);
// Measures mapped blocks once per layout revision, never once per scroll frame.
function ensurePreviewLayout() {
  if (!previewLayoutDirty) return;
  const scrollTop = getScrollTop();
  const anchors = mappedPreviewBlocks.map(block => {
    const rect = block.element.getBoundingClientRect();
    return { blockId: block.blockId, startLine: block.startLine, endLine: block.endLine, top: scrollTop + rect.top, bottom: scrollTop + rect.bottom };
  });
  previewScrollAnchors.update(anchors);
  previewLayoutDirty = false;
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
    ...Array.from(content.querySelectorAll('table')).filter(element => !element.closest('figure')),
    // Display equations are wrapped in <p> by Pandoc, so keep the equation
    // block while omitting inline math that belongs to ordinary prose.
    ...Array.from(content.querySelectorAll('.math')).filter(element => element.classList.contains('display') || !element.closest('p,li,figure,table')),
    ...Array.from(content.querySelectorAll('p')).filter(element => !element.closest('figure,table') && !element.querySelector('.math.display') && getClickableText(element).length > 0),
    // Tight list items have no <p>. Map their prose as a block so repeated
    // inline variables cannot become anchors pointing to unrelated later text.
    ...Array.from(content.querySelectorAll('li')).filter(element => !element.closest('figure,table') && !element.querySelector('p') && getClickableText(element).length > 0)
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
    const figureCaption = figure ? getFigureCaption(element) : null;
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
      display: math && element.classList.contains('display')
    };
  });
}
// Requests one source mapping for the current rendered block order.
function requestPreviewBlockMapping() {
  const started = performance.now();
  previewTextCache = new WeakMap();
  previewBlocks = collectPreviewBlocks();
  mappedPreviewBlocks = [];
  invalidatePreviewLayout();
  previewBlockMapReady = false;
  vscode.postMessage({
    type: 'previewBlocks',
    revision: ++previewMappingRevision,
    blocks: previewBlocks.map(({ element, ...block }) => block)
  });
  vscode.postMessage({ type: 'previewPerformance', detail: 'blocks=' + previewBlocks.length + ';collect=' + (performance.now() - started).toFixed(1) + ' ms' });
}
// Releases a source scroll request if a host mapping cannot be produced.
function deferSourceScrollUntilMapping(message) {
  pendingSourceScroll = message;
  if (pendingSourceMappingTimer) window.clearTimeout(pendingSourceMappingTimer);
  pendingSourceMappingTimer = window.setTimeout(() => {
    if (pendingSourceScroll === message && !previewBlockMapReady && previewMathRendering === 0) {
      pendingSourceScroll = null;
      applySourceScroll(message);
    }
    pendingSourceMappingTimer = 0;
  }, 1000);
}
// Interpolates between source/block anchors so wheel scrolling does not snap
// repeatedly to one paragraph top and then jump to the next paragraph.
function getPreviewTopForSourcePosition(sourcePosition) {
  ensurePreviewLayout();
  return previewScrollAnchors.previewTop(sourcePosition);
}
// Returns the mapped block currently nearest the top of the preview viewport.
function getVisibleSourceBlock() {
  ensurePreviewLayout();
  return previewScrollAnchors.visible(getScrollTop());
}
// VS Code may inject #_defaultStyles after the preview loads; remove it so it
// cannot override Papper's generated styles, including after incremental updates.
function removeVscodeDefaultStyles() {
  const style = document.getElementById('_defaultStyles');
  if (style && style.tagName === 'STYLE') style.remove();
}
// VS Code inserts defaults into <head>; observing formula mutations in <body>
// needlessly searched the entire growing document during every render batch.
const styleObserver = new MutationObserver(removeVscodeDefaultStyles);
if (document.head) styleObserver.observe(document.head, { childList: true });
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
    if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
  }
  // A trailing TeX escaped space (backslash + space) is a command. Trimming
  // raw Pandoc TeX turns it into a dangling backslash and breaks valid formulas.
  return tex;
}
// Defers automatic scroll synchronization while formula batches change paragraph heights.
async function renderKaTeX(root) {
  if (previewMathRendering++ === 0) previewUserScrolledDuringMath = false;
  try {
    await renderKaTeXContent(root);
  } finally {
    previewMathRendering--;
    if (previewMathRendering === 0 && root === previewContent) {
      invalidatePreviewLayout();
      if (pendingSourceScroll && readySent) {
        if (previewBlockMapReady) {
          const message = pendingSourceScroll;
          pendingSourceScroll = null;
          applySourceScroll(message);
        } else deferSourceScrollUntilMapping(pendingSourceScroll);
      } else if (previewUserScrolledDuringMath) handlePreviewScrollEvent();
    }
  }
}
// Retains raw TeX immediately, then renders only spans not already converted by KaTeX.
async function renderKaTeXContent(root) {
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
  let katex;
  try {
    katex = await waitForKaTeX();
  } catch (error) {
    vscode.postMessage({ type: 'previewKatexUnavailable', detail: 'math=' + renderableEntries.length + ';error=' + String(error) });
    return;
  }
  const result = await renderPreviewMath(renderableEntries, katex, previewMathFleqn,
    // Stop work on nodes superseded by a newer preview revision.
    () => root.isConnected && root.contains(renderableEntries[0].element),
    error => vscode.postMessage({ type: 'previewKatexFailed', detail: 'error=' + String(error) }));
  vscode.postMessage({ type: 'previewPerformance', detail: 'math=' + result.rendered + ';failures=' + result.failures + ';elapsed=' + result.elapsedMs.toFixed(1) + ' ms;maxBatch=' + result.maxBatchMs.toFixed(1) + ' ms' });
}
// Returns visible text while excluding rendered formulas that have a separate
// TeX source locator.
function getClickableText(element) {
  // Prose does not change when KaTeX replaces formula glyphs; retain this revision's text.
  if (previewTextCache.has(element)) return previewTextCache.get(element);
  // Reject formula subtrees before visiting them. Cloning first copied tens of
  // thousands of KaTeX glyph nodes merely to discard them during refreshed mapping.
  const excluded = '.math, .katex, .citation, .header-section-number, .header-section-name, script, style'
    + (element.matches('li') ? ', ul, ol' : '');
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    // Reject excluded containers together with every nested glyph node.
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }
  });
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue || '');
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  previewTextCache.set(element, text);
  return text;
}
// Finds a Pandoc label on the block itself; only headings and math may use a
// semantic wrapper because nested subfigure tables must not inherit figure ids.
function getClickableLabel(element) {
  const ownLabel = element.id && /^(?:sec|fig|tbl|eq):/.test(element.id) ? element.id : '';
  if (ownLabel) return ownLabel;
  if (element.matches('h1,h2,h3,h4,h5,h6') || element.matches('.math')) {
    const wrapper = element.closest('[id^="sec:"], [id^="eq:"]');
    return wrapper ? wrapper.id : '';
  }
  return '';
}
// Returns the caption owned by a figure rather than the first nested subfigure caption.
function getFigureCaption(figure) {
  return Array.from(figure.querySelectorAll('figcaption')).find(caption => caption.closest('figure') === figure) || null;
}
// Returns the nearest block ID assigned during source mapping.
function getClickableBlockId(element) {
  const block = element.closest('[data-pmt-block-id]');
  return block ? block.getAttribute('data-pmt-block-id') || '' : '';
}
// Emits a source-navigation request for a clicked rendered block.
let pendingPreviewImageClickTimer = 0;
let pendingPreviewImage = null;
// Sends the existing source-navigation message for one rendered image.
function emitPreviewImageClick(image) {
  const figure = image.closest('figure');
  if (figure) {
    const figureCaption = getFigureCaption(figure);
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'image', blockId: getClickableBlockId(figure), label: getClickableLabel(figure), text: figureCaption ? getClickableText(figureCaption) : image.getAttribute('alt') || '', caption: figureCaption ? getClickableText(figureCaption) : '', alt: image.getAttribute('alt') || '' });
    return;
  }
  vscode.postMessage({ type: 'previewBlockClick', blockType: 'image', blockId: getClickableBlockId(image), label: getClickableLabel(image), text: image.getAttribute('alt') || '', alt: image.getAttribute('alt') || '' });
}
// Delays image source navigation long enough to distinguish a single click from a double click.
function schedulePreviewImageClick(image) {
  if (pendingPreviewImageClickTimer) window.clearTimeout(pendingPreviewImageClickTimer);
  pendingPreviewImage = image;
  pendingPreviewImageClickTimer = window.setTimeout(() => {
    if (pendingPreviewImage === image) {
      pendingPreviewImage = null;
      emitPreviewImageClick(image);
    }
    pendingPreviewImageClickTimer = 0;
  }, 220);
}
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
  const image = target.closest('img');
  if (image) {
    if (event.detail >= 2) {
      if (pendingPreviewImageClickTimer) window.clearTimeout(pendingPreviewImageClickTimer);
      pendingPreviewImageClickTimer = 0;
      pendingPreviewImage = null;
      return;
    }
    schedulePreviewImageClick(image);
    return;
  }
  const figure = target.closest('figure');
  if (figure) {
    const image = figure.querySelector('img');
    const figureCaption = getFigureCaption(figure);
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'image', blockId: getClickableBlockId(figure), label: getClickableLabel(figure), text: figureCaption ? getClickableText(figureCaption) : image ? image.getAttribute('alt') || '' : '', caption: figureCaption ? getClickableText(figureCaption) : '', alt: image ? image.getAttribute('alt') || '' : '' });
    return;
  }
  const table = target.closest('table');
  if (table) {
    const tableCaption = table.querySelector('caption');
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'table', blockId: getClickableBlockId(table), label: getClickableLabel(table), text: getClickableText(table), caption: tableCaption ? getClickableText(tableCaption) : '' });
    return;
  }
  const paragraph = target.closest('p,li');
  if (paragraph) {
    const mathInParagraph = paragraph.querySelector('.math, [data-pmt-tex]');
    if (mathInParagraph && target === mathInParagraph) return;
    vscode.postMessage({ type: 'previewBlockClick', blockType: 'paragraph', blockId: getClickableBlockId(paragraph), label: getClickableLabel(paragraph), text: getClickableText(paragraph) });
  }
}
document.addEventListener('click', handlePreviewClick);
const MIN_IMAGE_LIGHTBOX_ZOOM = 0.1;
const MAX_IMAGE_LIGHTBOX_ZOOM = 8;
let imageLightbox = null;
let imageLightboxImage = null;
let imageLightboxZoomValue = null;
let imageLightboxZoom = 1;
let imageLightboxBaseWidth = 0;
let imageLightboxBaseHeight = 0;
let imageLightboxPanX = 0;
let imageLightboxPanY = 0;
let imageLightboxPointerId = null;
let imageLightboxPointerStartX = 0;
let imageLightboxPointerStartY = 0;
let imageLightboxPanStartX = 0;
let imageLightboxPanStartY = 0;
// Creates the image-only lightbox and its lightweight controls once per preview page.
function ensureImageLightbox() {
  if (imageLightbox && imageLightbox.isConnected) return imageLightbox;
  if (!document.body) return null;
  imageLightbox = document.createElement('div');
  imageLightbox.setAttribute('role', 'dialog');
  imageLightbox.setAttribute('aria-modal', 'true');
  imageLightbox.setAttribute('aria-label', 'Image preview');
  imageLightbox.tabIndex = -1;
  // Keep a light checkerboard behind transparent SVGs so black labels remain readable.
  imageLightbox.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background-color:#f3f3f3;background-image:linear-gradient(45deg,#e1e1e1 25%,transparent 25%,transparent 75%,#e1e1e1 75%),linear-gradient(45deg,#e1e1e1 25%,transparent 25%,transparent 75%,#e1e1e1 75%),linear-gradient(45deg,transparent 25%,#e1e1e1 25%,#e1e1e1 75%,transparent 75%),linear-gradient(45deg,transparent 25%,#e1e1e1 25%,#e1e1e1 75%,transparent 75%);background-position:0 0,10px 10px,10px 0,0 10px;background-size:20px 20px;display:none;font-family:var(--vscode-font-family,sans-serif);';
  const viewport = document.createElement('div');
  viewport.style.cssText = 'position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:48px 24px 24px;box-sizing:border-box;';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:absolute;top:12px;right:14px;z-index:1;display:flex;align-items:center;gap:4px;padding:5px 6px;border:1px solid rgba(255,255,255,.24);border-radius:8px;background:rgba(24,24,24,.72);color:rgba(255,255,255,.96);box-shadow:0 2px 12px rgba(0,0,0,.28);backdrop-filter:blur(6px);';
  const makeButton = (label, text) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = text;
    button.style.cssText = 'min-width:28px;height:26px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:inherit;font:600 13px/1 var(--vscode-font-family,sans-serif);cursor:pointer;';
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(255,255,255,.14)'; });
    button.addEventListener('mouseleave', () => { button.style.background = 'transparent'; });
    return button;
  };
  const zoomOut = makeButton('Zoom out', '−');
  const zoomIn = makeButton('Zoom in', '+');
  const fit = makeButton('Fit image to window', 'Fit');
  const close = makeButton('Close image preview', '×');
  imageLightboxZoomValue = document.createElement('span');
  imageLightboxZoomValue.style.cssText = 'min-width:42px;padding:0 4px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums;';
  zoomOut.addEventListener('click', () => setImageLightboxZoom(imageLightboxZoom / 1.2));
  zoomIn.addEventListener('click', () => setImageLightboxZoom(imageLightboxZoom * 1.2));
  fit.addEventListener('click', fitImageLightbox);
  close.addEventListener('click', closeImageLightbox);
  toolbar.append(zoomOut, imageLightboxZoomValue, zoomIn, fit, close);
  imageLightboxImage = document.createElement('img');
  imageLightboxImage.draggable = false;
  imageLightboxImage.style.cssText = 'display:none;position:absolute;max-width:none;max-height:none;user-select:none;-webkit-user-drag:none;';
  imageLightboxImage.addEventListener('load', fitImageLightbox);
  imageLightboxImage.addEventListener('pointerdown', beginImageLightboxPan);
  imageLightboxImage.addEventListener('pointermove', moveImageLightboxPan);
  imageLightboxImage.addEventListener('pointerup', endImageLightboxPan);
  imageLightboxImage.addEventListener('pointercancel', endImageLightboxPan);
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    setImageLightboxZoom(imageLightboxZoom * Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });
  imageLightbox.addEventListener('click', (event) => {
    if (event.target === imageLightbox || event.target === viewport) closeImageLightbox();
  });
  viewport.appendChild(imageLightboxImage);
  imageLightbox.append(viewport, toolbar);
  document.body.appendChild(imageLightbox);
  return imageLightbox;
}
// Updates the image dimensions and pan transform without scaling a cached compositor bitmap.
function updateImageLightboxTransform() {
  if (!imageLightboxImage) return;
  if (imageLightboxBaseWidth > 0 && imageLightboxBaseHeight > 0) {
    imageLightboxImage.style.width = imageLightboxBaseWidth * imageLightboxZoom + 'px';
    imageLightboxImage.style.height = imageLightboxBaseHeight * imageLightboxZoom + 'px';
  }
  // Translation remains GPU-friendly; the zoom itself is expressed as CSS dimensions
  // so SVG images can be rasterized again at their new display size.
  imageLightboxImage.style.transform = 'translate3d(' + imageLightboxPanX + 'px,' + imageLightboxPanY + 'px,0)';
  if (imageLightboxZoomValue) imageLightboxZoomValue.textContent = Math.round(imageLightboxZoom * 100) + '%';
}
// Applies a bounded zoom level without changing the surrounding Markdown layout.
function setImageLightboxZoom(value) {
  imageLightboxZoom = Math.max(MIN_IMAGE_LIGHTBOX_ZOOM, Math.min(MAX_IMAGE_LIGHTBOX_ZOOM, value));
  if (imageLightboxZoom <= 1) {
    imageLightboxPanX = 0;
    imageLightboxPanY = 0;
  }
  updateImageLightboxTransform();
}
// Fits the current image inside the lightbox viewport and resets its pan position.
function fitImageLightbox() {
  if (!imageLightbox || !imageLightboxImage || !imageLightboxImage.naturalWidth) return;
  const viewport = imageLightboxImage.parentElement;
  if (!viewport) return;
  const availableWidth = Math.max(120, viewport.clientWidth - 48);
  const availableHeight = Math.max(120, viewport.clientHeight - 72);
  const fitScale = Math.min(1, availableWidth / imageLightboxImage.naturalWidth, availableHeight / imageLightboxImage.naturalHeight);
  imageLightboxBaseWidth = Math.max(1, imageLightboxImage.naturalWidth * fitScale);
  imageLightboxBaseHeight = Math.max(1, imageLightboxImage.naturalHeight * fitScale);
  imageLightboxPanX = 0;
  imageLightboxPanY = 0;
  setImageLightboxZoom(1);
}
// Begins dragging only after the image has been enlarged beyond its fitted size.
function beginImageLightboxPan(event) {
  if (imageLightboxZoom <= 1 || !imageLightboxImage) return;
  imageLightboxPointerId = event.pointerId;
  imageLightboxPointerStartX = event.clientX;
  imageLightboxPointerStartY = event.clientY;
  imageLightboxPanStartX = imageLightboxPanX;
  imageLightboxPanStartY = imageLightboxPanY;
  imageLightboxImage.setPointerCapture(event.pointerId);
  imageLightboxImage.style.cursor = 'grabbing';
}
// Applies pointer movement to the image without affecting the document's scroll position.
function moveImageLightboxPan(event) {
  if (event.pointerId !== imageLightboxPointerId) return;
  imageLightboxPanX = imageLightboxPanStartX + event.clientX - imageLightboxPointerStartX;
  imageLightboxPanY = imageLightboxPanStartY + event.clientY - imageLightboxPointerStartY;
  updateImageLightboxTransform();
}
// Ends a lightbox image drag and restores the normal cursor.
function endImageLightboxPan(event) {
  if (event.pointerId !== imageLightboxPointerId) return;
  imageLightboxPointerId = null;
  imageLightboxImage?.releasePointerCapture?.(event.pointerId);
  if (imageLightboxImage) imageLightboxImage.style.cursor = '';
}
// Opens the image lightbox using the already-resolved Webview image URI.
function openImageLightbox(image) {
  if (!image || !image.src) return;
  const overlay = ensureImageLightbox();
  if (!overlay || !imageLightboxImage) return;
  if (pendingPreviewImageClickTimer) window.clearTimeout(pendingPreviewImageClickTimer);
  pendingPreviewImageClickTimer = 0;
  pendingPreviewImage = null;
  imageLightboxImage.onload = fitImageLightbox;
  imageLightboxImage.alt = image.alt || 'Image preview';
  imageLightboxImage.src = image.currentSrc || image.src;
  imageLightboxImage.style.display = 'block';
  overlay.style.display = 'block';
  overlay.focus();
  if (imageLightboxImage.complete) fitImageLightbox();
}
// Closes the image-only preview without changing the surrounding Markdown page.
function closeImageLightbox() {
  if (!imageLightbox) return;
  imageLightbox.style.display = 'none';
  if (imageLightboxImage) {
    imageLightboxImage.style.display = 'none';
    imageLightboxImage.removeAttribute('src');
  }
  imageLightboxBaseWidth = 0;
  imageLightboxBaseHeight = 0;
  imageLightboxPointerId = null;
}
document.addEventListener('dblclick', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const image = target?.closest('img');
  if (!image) return;
  event.preventDefault();
  event.stopPropagation();
  openImageLightbox(image);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && imageLightbox?.style.display === 'block') closeImageLightbox();
});
async function replacePreviewHtml(html, token) {
  const previousScrollTop = getScrollTop();
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
      mappedPreviewBlocks = [];
      invalidatePreviewLayout();
      previewBlockMapReady = false;
    }
  }
}
// Keeps only the latest source request for each browser frame; a fixed host
// throttle previously made wheel scrolling advance in visibly separated steps.
function applySourceScroll(message) {
  latestSourceScroll = message;
  if (sourceScrollFrame) return;
  sourceScrollFrame = requestAnimationFrame(() => {
    sourceScrollFrame = 0;
    const latest = latestSourceScroll;
    latestSourceScroll = null;
    scrollPreviewToSource(latest);
  });
}
// Applies a continuous mapped source coordinate after block mappings are available.
function scrollPreviewToSource(message) {
  const max = Math.max(0, getScrollHeight() - getViewportHeight());
  const requestedOffset = Number.isFinite(message.offsetRatio)
    ? Math.max(-1.5, Math.min(1.5, message.offsetRatio))
    : 0;
  let targetTop;
  const sourcePosition = Number.isFinite(message.sourcePosition) ? Number(message.sourcePosition)
    : Number.isFinite(message.sourceLine) ? Number(message.sourceLine) : null;
  const mappedTop = sourcePosition === null ? null : getPreviewTopForSourcePosition(sourcePosition);
  if (mappedTop !== null) {
    targetTop = mappedTop - requestedOffset * getViewportHeight();
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
    // A slow host reply from an older HTML revision must not overwrite fresh anchors.
    if (Number.isInteger(event.data.revision) && event.data.revision !== previewMappingRevision) return;
    applyPreviewBlockMap(event.data.mappings);
    return;
  }
  if (!event.data || event.data.type !== 'sourceScroll') return;
  // Measuring every source request during rendering caused repeated full layout
  // passes; apply the latest request once the formula heights have settled.
  if (previewMathRendering > 0) {
    pendingSourceScroll = event.data;
    return;
  }
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
  mappedPreviewBlocks = [];
  for (const block of previewBlocks) {
    const mapping = mappingById.get(block.blockId);
    if (!mapping || !Number.isFinite(mapping.startLine)) {
      block.element.removeAttribute('data-source-line');
      block.element.removeAttribute('data-source-end-line');
      continue;
    }
    block.element.setAttribute('data-source-line', String(mapping.startLine));
    const endLine = Number.isFinite(mapping.endLine) ? mapping.endLine : mapping.startLine;
    block.element.setAttribute('data-source-end-line', String(endLine));
    mappedPreviewBlocks.push({ element: block.element, blockId: block.blockId, startLine: mapping.startLine, endLine });
  }
  invalidatePreviewLayout();
  previewBlockMapReady = true;
  if (pendingSourceMappingTimer) {
    window.clearTimeout(pendingSourceMappingTimer);
    pendingSourceMappingTimer = 0;
  }
  if (pendingSourceScroll && previewMathRendering === 0) {
    const message = pendingSourceScroll;
    pendingSourceScroll = null;
    applySourceScroll(message);
  }
}
// Handles scroll events from either the viewport or a nested document scroller.
function handlePreviewScrollEvent() {
  if (suppressScroll || scrollFrame || previewMathRendering > 0) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (suppressScroll || previewMathRendering > 0) return;
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
    const sourceLine = block ? block.startLine : null;
    const blockId = block ? block.blockId : '';
    const blockOffsetRatio = block ? Math.max(-1.5, Math.min(1.5, (block.top - getScrollTop()) / getViewportHeight())) : 0;
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
// Keep a user's wheel gesture ahead of a queued automatic initial source position.
window.addEventListener('wheel', () => {
  if (previewMathRendering > 0) {
    previewUserScrolledDuringMath = true;
    pendingSourceScroll = null;
  }
}, { passive: true });
const sendReady = () => {
  if (readySent) return;
  const content = ensurePreviewContent();
  // The standalone Papper page may have rendered KaTeX before this bridge;
  // record annotation TeX immediately so clicks still locate source math.
  if (content) {
    // renderKaTeX records TeX before its first await. Formula glyph replacement
    // changes geometry, but not descriptors, so one initial mapping is enough.
    void renderKaTeX(content).catch(error => vscode.postMessage({ type: 'previewKatexFailed', detail: 'initial=' + String(error) }));
    requestPreviewBlockMapping();
  } else {
    requestPreviewBlockMapping();
  }
  readySent = true;
  vscode.postMessage({ type: 'ready' });
  if (pendingSourceScroll && previewMathRendering === 0 && (previewBlockMapReady || !Number.isFinite(pendingSourceScroll.sourceLine))) {
    const message = pendingSourceScroll;
    pendingSourceScroll = null;
    applySourceScroll(message);
  }
};
window.addEventListener('DOMContentLoaded', sendReady, { once: true });
window.addEventListener('load', sendReady, { once: true });
</script>`;
  const withoutExistingCsp = preparedMath.html.replace(/<meta\s+http-equiv=["']content-security-policy["'][^>]*>\s*/gi, "");
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
