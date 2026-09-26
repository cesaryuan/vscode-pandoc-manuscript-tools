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
let lastSentHeadingKey = '';
let lastSentOffsetRatio = 0;
let previewUpdateChain = Promise.resolve();
let previewContent = null;
let previewHeadings = null;
let readySent = false;
let pendingSourceScroll = null;
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
// Reuses the rendered heading list until preview HTML is replaced.
function getPreviewHeadings() {
  if (!previewHeadings) {
    const content = ensurePreviewContent();
    previewHeadings = content ? Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6')) : [];
  }
  return previewHeadings;
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
// Returns the viewport height used for heading offsets and ratio calculations.
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
// Makes Markdown source headings comparable to their rendered text content.
function normalizeHeadingKey(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\x60+([^\x60]+)\x60+/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
// Finds the rendered heading nearest the preview viewport top for scroll reporting.
function getVisibleHeadingAnchor() {
  if (!readySent) return null;
  const content = ensurePreviewContent();
  if (!content) return null;
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const heading of getPreviewHeadings()) {
    const distance = Math.abs(heading.getBoundingClientRect().top);
    if (distance < nearestDistance) {
      nearest = heading;
      nearestDistance = distance;
    }
  }
  if (!nearest || nearestDistance > getViewportHeight() * 1.25) return null;
  const text = nearest.cloneNode(true);
  text.querySelectorAll('.header-section-number, .header-section-name').forEach(element => element.remove());
  const headingKey = normalizeHeadingKey(text.textContent || '');
  const headingId = nearest.id || '';
  if (!headingId && !headingKey) return null;
  return {
    headingId,
    headingKey,
    offsetRatio: Math.max(-1.25, Math.min(1.25, nearest.getBoundingClientRect().top / getViewportHeight()))
  };
}
// Resolves a source anchor, preferring Pandoc IDs and disambiguating repeated titles by page position.
function findPreviewHeadingAnchor(message) {
  const content = ensurePreviewContent();
  if (!content) return null;
  if (message.headingId) {
    const byId = document.getElementById(message.headingId);
    if (byId && content.contains(byId) && byId.matches('h1,h2,h3,h4,h5,h6')) return byId;
  }
  const key = normalizeHeadingKey(message.headingKey || '');
  if (!key) return null;
  const max = Math.max(1, getScrollHeight() - getViewportHeight());
  const targetRatio = Math.max(0, Math.min(1, Number(message.ratio) || 0));
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const heading of getPreviewHeadings()) {
    const text = heading.cloneNode(true);
    text.querySelectorAll('.header-section-number, .header-section-name').forEach(element => element.remove());
    if (normalizeHeadingKey(text.textContent || '') !== key) continue;
    const pageRatio = (getScrollTop() + heading.getBoundingClientRect().top) / max;
    const distance = Math.abs(pageRatio - targetRatio);
    if (distance < nearestDistance) {
      nearest = heading;
      nearestDistance = distance;
    }
  }
  return nearest;
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
  const elements = Array.from(root.querySelectorAll('.math')).filter(element => element.tagName === 'SPAN' && !element.querySelector('.katex'));
  if (elements.length === 0) return;
  vscode.postMessage({ type: 'previewKatexStarted', detail: 'math=' + elements.length });
  let katex;
  try {
    katex = await waitForKaTeX();
  } catch (error) {
    vscode.postMessage({ type: 'previewKatexUnavailable', detail: 'math=' + elements.length + ';error=' + String(error) });
    return;
  }
  let failures = 0;
  for (const element of elements) {
    try {
      const tex = unwrapMathDelimiters(element.textContent || '');
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
    previewHeadings = null;
    removeVscodeDefaultStyles();
    const restoreScrollTop = () => {
      setScrollTop(previousScrollTop);
      lastSentRatio = scrollRatio();
      const anchor = getVisibleHeadingAnchor();
      lastSentHeadingKey = anchor ? (anchor.headingId || '') + '|' + (anchor.headingKey || '') : '';
      lastSentOffsetRatio = anchor ? anchor.offsetRatio : 0;
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
      previewHeadings = null;
    }
  }
}
// Applies the latest source position after generated preview headings are available.
function applySourceScroll(message) {
  const max = Math.max(0, getScrollHeight() - getViewportHeight());
  const anchor = findPreviewHeadingAnchor(message);
  const requestedOffset = Number.isFinite(message.offsetRatio)
    ? Math.max(-1.5, Math.min(1.5, message.offsetRatio))
    : 0;
  let targetTop;
  if (anchor) {
    const headingTop = getScrollTop() + anchor.getBoundingClientRect().top;
    targetTop = headingTop - requestedOffset * getViewportHeight();
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
  if (!event.data || event.data.type !== 'sourceScroll') return;
  vscode.postMessage({ type: 'scrollSyncTrace', detail: 'sourceScroll received ready=' + readySent });
  if (!readySent) {
    pendingSourceScroll = event.data;
    return;
  }
  applySourceScroll(event.data);
});
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
    const anchor = getVisibleHeadingAnchor();
    const headingKey = anchor ? (anchor.headingId || '') + '|' + (anchor.headingKey || '') : '';
    if (Math.abs(ratio - lastSentRatio) < 0.01 && headingKey === lastSentHeadingKey && (!anchor || Math.abs(anchor.offsetRatio - lastSentOffsetRatio) < 0.02)) return;
    lastSentRatio = ratio;
    lastSentHeadingKey = headingKey;
    lastSentOffsetRatio = anchor ? anchor.offsetRatio : 0;
    vscode.postMessage({ type: 'previewScroll', ratio, ...(anchor || {}) });
  });
}
window.addEventListener('scroll', handlePreviewScrollEvent, { passive: true });
// Scroll events on the document do not always bubble to window in WebView Chromium.
document.addEventListener('scroll', handlePreviewScrollEvent, { passive: true, capture: true });
const sendReady = () => {
  if (readySent) return;
  ensurePreviewContent();
  readySent = true;
  vscode.postMessage({ type: 'ready' });
  if (pendingSourceScroll) {
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
