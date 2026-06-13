"use strict";

const MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS = {
  "accents-b-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js"),
  accents: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js"),
  arabic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js"),
  arrows: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js"),
  "braille-d": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js"),
  braille: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js"),
  calligraphic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  cherokee: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js"),
  "cyrillic-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js"),
  cyrillic: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js"),
  devanagari: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js"),
  "double-struck": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  fraktur: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  "greek-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js"),
  greek: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js"),
  hebrew: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js"),
  "latin-b": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js"),
  "latin-bi": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js"),
  "latin-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js"),
  latin: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js"),
  marrows: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js"),
  math: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js"),
  "monospace-ex": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js"),
  "monospace-l": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js"),
  monospace: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
  mshapes: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js"),
  "phonetics-ss": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js"),
  phonetics: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js"),
  PUA: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js"),
  "sans-serif-b": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js"),
  "sans-serif-bi": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js"),
  "sans-serif-ex": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js"),
  "sans-serif-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js"),
  "sans-serif-r": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js"),
  "sans-serif": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js"),
  script: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  shapes: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js"),
  "symbols-b-i": () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js"),
  symbols: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js"),
  variants: () => require("@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js"),
};

class MathJaxRenderer {
  /**
   * Creates a lazy MathJax renderer for hover previews.
   *
   * @param {vscode.OutputChannel} output Output channel for render failures.
   */
  constructor(output) {
    this.output = output;
    this.readyPromise = undefined;
    this.svgCache = new Map();
    this.loadFailure = undefined;
  }

  /**
   * Converts TeX into a data URI containing a standalone SVG image.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToDataUri(tex, display) {
    const svg = await this.renderToSvg(tex, display);
    if (!svg) {
      return undefined;
    }
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }

  /**
   * Converts TeX into SVG and caches the result by source text and mode.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToSvg(tex, display) {
    const trimmedTex = tex.trim();
    if (!trimmedTex) {
      return undefined;
    }

    const cacheKey = `${display ? "display" : "inline"}:${trimmedTex}`;
    if (!this.svgCache.has(cacheKey)) {
      this.svgCache.set(cacheKey, this.renderToSvgUncached(trimmedTex, display));
    }

    return this.svgCache.get(cacheKey);
  }

  /**
   * Converts TeX into SVG without consulting the cache.
   *
   * @param {string} tex TeX source.
   * @param {boolean} display Whether to render in display style.
   * @returns {Promise<string | undefined>}
   */
  async renderToSvgUncached(tex, display) {
    try {
      const renderer = await this.ensureMathJax();
      if (!renderer) {
        return undefined;
      }

      const node = await renderer.html.convertPromise(tex, {
        display,
        em: 16,
        ex: 8,
        containerWidth: 80 * 16,
      });
      const adaptor = renderer.adaptor;
      const svgNodes = getTopLevelSvgNodes(adaptor, node);
      if (svgNodes.length !== 1) {
        this.output.appendLine(`MathJax returned ${svgNodes.length} top-level SVG fragment(s) for equation ${formatTexForLog(tex)}; expected one complete preview.`);
        return undefined;
      }

      const svg = svgNodes[0];
      if (!svg) {
        this.output.appendLine(`MathJax did not return an SVG for equation: ${formatTexForLog(tex)}`);
        return undefined;
      }

      const serializedSvg = adaptor.serializeXML(svg);
      const renderError = getMathJaxSvgError(serializedSvg);
      if (renderError) {
        this.output.appendLine(`MathJax rendered an error for equation ${formatTexForLog(tex)}: ${renderError}`);
        return undefined;
      }

      return makeSvgHoverFriendly(serializedSvg);
    } catch (error) {
      this.output.appendLine(`MathJax failed to render equation ${formatTexForLog(tex)}: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Loads the direct MathJax TeX-to-SVG renderer once.
   *
   * The extension uses static require calls inside the lazy loader so esbuild
   * can bundle MathJax without invoking the component loader's SRE path probes.
   *
   * @returns {Promise<{adaptor: any, html: any} | undefined>}
   */
  async ensureMathJax() {
    if (this.loadFailure) {
      return undefined;
    }

    if (!this.readyPromise) {
      this.readyPromise = this.loadMathJax();
    }

    try {
      return await this.readyPromise;
    } catch (error) {
      this.loadFailure = error;
      this.output.appendLine(`MathJax is unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Initializes MathJax's direct Node API for TeX-to-SVG rendering.
   *
   * @returns {Promise<{adaptor: any, html: any}>}
   */
  async loadMathJax() {
    require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
    require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
    // \boldsymbol lives in a separate TeX package, so preload it explicitly for common ML notation.
    require("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js");
    require("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js");

    const { mathjax } = require("@mathjax/src/js/mathjax.js");
    const { TeX } = require("@mathjax/src/js/input/tex.js");
    const { SVG } = require("@mathjax/src/js/output/svg.js");
    const { liteAdaptor } = require("@mathjax/src/js/adaptors/liteAdaptor.js");
    const { RegisterHTMLHandler } = require("@mathjax/src/js/handlers/html.js");
    configureMathJaxAsyncLoad(mathjax);

    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ["base", "ams", "boldsymbol", "newcommand"] });
    const svg = new SVG({
      fontCache: "none",
      // VS Code hovers need a single data URI image; MathJax v4 inline
      // linebreaking otherwise returns multiple sibling SVG fragments.
      linebreaks: { inline: false },
    });
    const html = mathjax.document("", { InputJax: tex, OutputJax: svg });

    this.output.appendLine("MathJax direct TeX-to-SVG renderer loaded.");
    return { adaptor, html };
  }

  /**
   * Releases renderer references held by the hover provider.
   */
  dispose() {
    this.readyPromise = undefined;
    if (this.svgCache) {
      this.svgCache.clear();
    }
  }
}

/**
 * Returns complete SVG previews directly under MathJax's container node.
 *
 * Some stretchy operators, including \xleftarrow, embed nested SVG fragments
 * inside the real preview; counting recursive descendants falsely rejects them.
 *
 * @param {any} adaptor MathJax DOM adaptor.
 * @param {any} node MathJax conversion result node.
 * @returns {any[]}
 */
function getTopLevelSvgNodes(adaptor, node) {
  return adaptor.childNodes(node).filter((child) => adaptor.kind(child) === "svg");
}

/**
 * Registers bundled dynamic loaders for MathJax v4 SVG font chunks.
 *
 * VSIX packaging excludes node_modules, so the common \mathcal path must resolve
 * through literal require calls that esbuild can include in dist/extension.js.
 *
 * @param {any} mathjax MathJax direct API namespace.
 */
function configureMathJaxAsyncLoad(mathjax) {
  mathjax.asyncLoad = loadBundledMathJaxDynamicModule;
  mathjax.asyncIsSynchronous = true;
}

/**
 * Loads dynamic MathJax modules, keeping known NewCM SVG chunks bundled.
 *
 * @param {string} name Module name requested by MathJax.
 * @returns {any}
 */
function loadBundledMathJaxDynamicModule(name) {
  const normalizedName = name.replace(/\\/g, "/");
  const dynamicChunkMatch = normalizedName.match(/@mathjax\/mathjax-newcm-font\/js\/svg\/dynamic\/([^/]+)\.js$/);
  if (dynamicChunkMatch && MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS[dynamicChunkMatch[1]]) {
    return MATHJAX_NEWCM_SVG_DYNAMIC_CHUNKS[dynamicChunkMatch[1]]();
  }
  return require(name);
}

/**
 * Extracts MathJax's SVG-level render error when conversion produced merror.
 *
 * MathJax can return an SVG containing an error node instead of throwing; the
 * hover should treat that as a failed preview so the output channel has details.
 *
 * @param {string} svg Serialized MathJax SVG.
 * @returns {string | undefined}
 */
function getMathJaxSvgError(svg) {
  const match = svg.match(/\bdata-mjx-error="([^"]+)"/);
  return match ? decodeHtmlAttribute(match[1]) : undefined;
}

/**
 * Decodes the small set of HTML entities expected inside SVG attributes.
 *
 * @param {string} value Attribute value.
 * @returns {string}
 */
function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Formats TeX compactly for one-line output-channel diagnostics.
 *
 * @param {string} tex TeX source.
 * @returns {string}
 */
function formatTexForLog(tex) {
  const compactTex = tex.replace(/\s+/g, " ").trim();
  const truncatedTex = compactTex.length > 160 ? `${compactTex.slice(0, 157)}...` : compactTex;
  return `"${truncatedTex}"`;
}

/**
 * Makes a MathJax SVG fit inside hover images without clipping.
 *
 * @param {string} svg Raw MathJax SVG.
 * @returns {string}
 */
function makeSvgHoverFriendly(svg) {
  const sizedSvg = setSvgPixelSize(svg, 720);
  const hoverStyle = "background:transparent;";
  if (/<svg\b[^>]*\sstyle="/.test(sizedSvg)) {
    return sizedSvg.replace(/(<svg\b[^>]*\sstyle=")/, `$1${hoverStyle}`);
  }
  return sizedSvg.replace("<svg ", `<svg style="${hoverStyle}" `);
}

/**
 * Converts MathJax's ex-based dimensions into capped pixel dimensions.
 *
 * VS Code hover images can crop very wide SVGs; using the viewBox lets the
 * preview scale down while preserving the complete formula.
 *
 * @param {string} svg Raw MathJax SVG.
 * @param {number} maxWidthPx Maximum rendered width.
 * @returns {string}
 */
function setSvgPixelSize(svg, maxWidthPx) {
  const viewBoxMatch = svg.match(/\bviewBox="(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!viewBoxMatch) {
    return svg;
  }

  const viewBoxWidth = Number(viewBoxMatch[3]);
  const viewBoxHeight = Number(viewBoxMatch[4]);
  if (!Number.isFinite(viewBoxWidth) || !Number.isFinite(viewBoxHeight) || viewBoxWidth <= 0 || viewBoxHeight <= 0) {
    return svg;
  }

  const naturalWidthPx = Math.ceil((viewBoxWidth / 1000) * 16);
  const naturalHeightPx = Math.ceil((viewBoxHeight / 1000) * 16);
  const widthPx = Math.min(naturalWidthPx, maxWidthPx);
  const heightPx = Math.max(1, Math.ceil(naturalHeightPx * (widthPx / naturalWidthPx)));

  return upsertSvgAttribute(upsertSvgAttribute(svg, "width", `${widthPx}px`), "height", `${heightPx}px`);
}

/**
 * Adds or replaces an attribute on the root SVG element.
 *
 * @param {string} svg Raw SVG.
 * @param {string} attribute Attribute name.
 * @param {string} value Attribute value.
 * @returns {string}
 */
function upsertSvgAttribute(svg, attribute, value) {
  const pattern = new RegExp(`(<svg\\b[^>]*\\s)${attribute}="[^"]*"`);
  if (pattern.test(svg)) {
    return svg.replace(pattern, `$1${attribute}="${value}"`);
  }
  return svg.replace("<svg ", `<svg ${attribute}="${value}" `);
}


module.exports = {
  MathJaxRenderer,
};
