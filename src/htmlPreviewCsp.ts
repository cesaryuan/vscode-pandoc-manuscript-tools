/**
 * Adds the preview nonce to Pandoc's inline KaTeX initializer.
 *
 * Pandoc emits this script for `--math-method=katex`; the WebView CSP would
 * block it unless the generated initializer receives the bridge nonce.
 *
 * @param html Generated Papper HTML.
 * @param nonce Preview script nonce.
 */
export function applyHtmlPreviewKaTeXNonce(html: string, nonce: string) {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes: string, content: string) => {
    const hasSource = /(?:^|\s)src\s*=/i.test(attributes);
    const isKaTeXInitializer = /\bkatex\.render\s*\(/i.test(content)
      && /getElementsByClassName\s*\(\s*["']math["']\s*\)/i.test(content);
    if (hasSource || !isKaTeXInitializer) {
      return tag;
    }
    const existingNonce = /(?:^|\s)nonce\s*=\s*(["'])(.*?)\1/i;
    if (existingNonce.test(attributes)) {
      const updatedAttributes = attributes.replace(/(\snonce\s*=\s*)(["']).*?\2/i, (_match, prefix: string) => `${prefix}"${nonce}"`);
      return `<script${updatedAttributes}>${content}</script>`;
    }
    return `<script${attributes} nonce="${nonce}">${content}</script>`;
  });
}

/**
 * Builds the preview Content Security Policy from resources referenced by the generated HTML.
 *
 * @param html Generated Papper HTML after local resource rewriting.
 * @param nonce Nonce for the preview scroll bridge script.
 * @param cspSource VS Code Webview resource source.
 */
export function buildHtmlPreviewCsp(html: string, nonce: string, cspSource: string) {
  const scriptOrigins = collectExternalScriptOrigins(html);
  const styleOrigins = collectExternalStylesheetOrigins(html);
  const fontOrigins = [...new Set([...scriptOrigins, ...styleOrigins])];
  const externalResourceSources = [...new Set(["https:", ...scriptOrigins, ...styleOrigins])];

  return [
    "default-src 'none'",
    "base-uri 'none'",
    `img-src ${joinSources([cspSource, "data:", "blob:"])}`,
    `style-src ${joinSources([cspSource, "'unsafe-inline'", "data:", "blob:", ...styleOrigins])}`,
    `style-src-elem ${joinSources([cspSource, "'unsafe-inline'", "data:", "blob:", ...styleOrigins])}`,
    "style-src-attr 'unsafe-inline'",
    `script-src ${joinSources([`'nonce-${nonce}'`, ...externalResourceSources])}`,
    `font-src ${joinSources([cspSource, "data:", "blob:", ...externalResourceSources, ...fontOrigins])}`,
    `connect-src ${joinSources([cspSource, "data:", "blob:", ...externalResourceSources])}`,
    `media-src ${joinSources([cspSource, "data:", "blob:"])}`,
  ].join("; ") + ";";
}

/**
 * Finds HTTPS origins explicitly used by external script tags.
 *
 * @param html Generated HTML.
 */
function collectExternalScriptOrigins(html: string) {
  const origins = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const source = readQuotedAttribute(match[0], "src");
    const origin = getHttpsOrigin(source);
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * Finds HTTPS origins explicitly used by linked stylesheets.
 *
 * @param html Generated HTML.
 */
function collectExternalStylesheetOrigins(html: string) {
  const origins = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const relations = readQuotedAttribute(tag, "rel")?.toLowerCase().split(/\s+/) || [];
    if (!relations.includes("stylesheet")) {
      continue;
    }
    const origin = getHttpsOrigin(readQuotedAttribute(tag, "href"));
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * Reads a single quoted HTML attribute from a tag.
 *
 * @param tag HTML element text.
 * @param name Attribute name.
 */
function readQuotedAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2]?.replace(/&amp;/gi, "&");
}

/**
 * Returns an HTTPS origin, ignoring relative, non-HTTPS, and malformed URLs.
 * Webviews run in a secure context, where remote HTTP resources are blocked.
 *
 * @param value Candidate resource URL.
 */
function getHttpsOrigin(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Joins unique CSP source expressions without widening the allowed origins.
 *
 * @param sources CSP source expressions.
 */
function joinSources(sources: string[]) {
  return [...new Set(sources)].join(" ");
}
