/**
 * Builds the preview Content Security Policy and adds only HTTPS origins referenced
 * by the generated HTML, including MathJax script origins used for its web fonts.
 *
 * @param html Generated Papper HTML after local resource rewriting.
 * @param nonce Nonce for the preview scroll bridge script.
 * @param cspSource VS Code Webview resource source.
 */
export function buildHtmlPreviewCsp(html: string, nonce: string, cspSource: string) {
  const mathJaxFontOrigins = collectMathJaxFontOrigins(html);
  const scriptOrigins = [...new Set([...collectExternalScriptOrigins(html), ...mathJaxFontOrigins])].sort();
  const styleOrigins = collectExternalStylesheetOrigins(html);
  const fontOrigins = [...new Set([...scriptOrigins, ...styleOrigins, ...mathJaxFontOrigins])];

  return [
    "default-src 'none'",
    "base-uri 'none'",
    `img-src ${joinSources([cspSource, "data:", "blob:"])}`,
    `style-src ${joinSources([cspSource, "'unsafe-inline'", "data:", "blob:", ...styleOrigins])}`,
    `style-src-elem ${joinSources([cspSource, "'unsafe-inline'", "data:", "blob:", ...styleOrigins])}`,
    "style-src-attr 'unsafe-inline'",
    `script-src ${joinSources([`'nonce-${nonce}'`, ...scriptOrigins])}`,
    `font-src ${joinSources([cspSource, "data:", "blob:", ...fontOrigins])}`,
    `media-src ${joinSources([cspSource, "data:", "blob:"])}`,
  ].join("; ") + ";";
}

/**
 * Adds the preview nonce to inline MathJax configuration blocks so CSP allows
 * font-path settings inserted by Pandoc before its external MathJax component.
 *
 * @param html Generated HTML.
 * @param nonce Preview script nonce.
 */
export function applyHtmlPreviewMathJaxNonce(html: string, nonce: string) {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes: string, content: string) => {
    const hasSource = /(?:^|\s)src\s*=/i.test(attributes);
    const isMathJaxConfiguration = /(?:window|globalThis)\s*\.\s*MathJax\s*=|\bMathJax\s*=/i.test(content);
    if (hasSource || !isMathJaxConfiguration) {
      return tag;
    }

    const existingNonce = /(?:^|\s)nonce\s*=\s*(["'])(.*?)\1/i;
    if (existingNonce.test(attributes)) {
      const updatedAttributes = attributes.replace(/(\snonce\s*=\s*)(["']).*?\2/i, (_match, prefix: string) => {
        return `${prefix}"${nonce}"`;
      });
      return `<script${updatedAttributes}>${content}</script>`;
    }

    return `<script${attributes} nonce="${nonce}">${content}</script>`;
  });
}

/**
 * Finds MathJax's configured remote font package origin for its dynamically loaded font scripts.
 *
 * @param html Generated HTML containing the optional MathJax configuration block.
 */
function collectMathJaxFontOrigins(html: string) {
  const origins = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    const content = match[2];
    if (/(?:^|\s)src\s*=/i.test(attributes) || !/\bMathJax\s*=/.test(content)) {
      continue;
    }

    for (const fontPath of content.matchAll(/\bfontPath\s*:\s*(["'])(.*?)\1/gi)) {
      const origin = getHttpsOrigin(fontPath[2]);
      if (origin) {
        origins.add(origin);
      }
    }
  }
  return [...origins].sort();
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
