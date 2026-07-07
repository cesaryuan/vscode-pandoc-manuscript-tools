import type * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const MATHJAX_NEWCM_DYNAMIC_FONT_DIR = path.join(__dirname, "..", "assets", "mathjax-newcm-font", "cjs", "svg", "dynamic");
const MATHJAX_DYNAMIC_CHUNK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const loadedMathJaxDynamicChunks = new Map<string, unknown>();

type MathJaxAdaptor = {
  childNodes(node: unknown): unknown[];
  kind(node: unknown): string;
  serializeXML(node: unknown): string;
};
type MathJaxHtmlDocument = {
  convertPromise(tex: string, options: { display: boolean; em: number; ex: number; containerWidth: number }): Promise<unknown>;
};
type MathJaxRenderContext = { adaptor: MathJaxAdaptor; html: MathJaxHtmlDocument };
type MathJaxNamespace = { asyncLoad?: (name: string) => unknown; asyncIsSynchronous?: boolean };

export class MathJaxRenderer {
  declare output: import("vscode").OutputChannel;
  declare readyPromise: Promise<MathJaxRenderContext> | undefined;
  declare svgCache: Map<string, Promise<string | undefined>>;
  declare loadFailure: unknown;
  /**
   * Creates a lazy MathJax renderer for hover previews.
   *
   * @param output Output channel for render failures.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.readyPromise = undefined;
    this.svgCache = new Map();
    this.loadFailure = undefined;
  }

  /**
   * Converts TeX into a data URI containing a standalone SVG image.
   *
   * @param tex TeX source.
   * @param display Whether to render in display style.
   * @param foregroundColor CSS color for SVG glyphs.
   */
  async renderToDataUri(tex: string, display: boolean, foregroundColor: string | undefined) {
    const svg = await this.renderToSvg(tex, display, foregroundColor);
    if (!svg) {
      return undefined;
    }
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }

  /**
   * Converts TeX into SVG and caches the result by source text and mode.
   *
   * @param tex TeX source.
   * @param display Whether to render in display style.
   * @param foregroundColor CSS color for SVG glyphs.
   */
  async renderToSvg(tex: string, display: boolean, foregroundColor: string | undefined) {
    const trimmedTex = tex.trim();
    if (!trimmedTex) {
      return undefined;
    }

    const cacheKey = `${display ? "display" : "inline"}:${foregroundColor || "default"}:${trimmedTex}`;
    if (!this.svgCache.has(cacheKey)) {
      this.svgCache.set(cacheKey, this.renderToSvgUncached(trimmedTex, display, foregroundColor));
    }

    return this.svgCache.get(cacheKey);
  }

  /**
   * Converts TeX into SVG without consulting the cache.
   *
   * @param tex TeX source.
   * @param display Whether to render in display style.
   * @param foregroundColor CSS color for SVG glyphs.
   */
  async renderToSvgUncached(tex: string, display: boolean, foregroundColor: string | undefined) {
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

      return makeSvgHoverFriendly(serializedSvg, foregroundColor);
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
 * @param adaptor MathJax DOM adaptor.
 * @param node MathJax conversion result node.
 */
function getTopLevelSvgNodes(adaptor: MathJaxAdaptor, node: unknown) {
  return adaptor.childNodes(node).filter((child) => adaptor.kind(child) === "svg");
}

/**
 * Registers external dynamic loaders for MathJax v4 SVG font chunks.
 *
 * The NewCM dynamic font files are packaged beside the bundle so large glyph
 * tables do not inflate `dist/extension.ts`.
 *
 * @param mathjax MathJax direct API namespace.
 */
function configureMathJaxAsyncLoad(mathjax: MathJaxNamespace) {
  mathjax.asyncLoad = loadPackagedMathJaxDynamicModule;
  mathjax.asyncIsSynchronous = true;
}

/**
 * Loads dynamic MathJax modules from the packaged extension assets.
 *
 * @param name Module name requested by MathJax.
 */
function loadPackagedMathJaxDynamicModule(name: string) {
  const normalizedName = name.replace(/\\/g, "/");
  const dynamicChunkMatch = normalizedName.match(/@mathjax\/mathjax-newcm-font\/js\/svg\/dynamic\/([^/]+)\.js$/);
  if (dynamicChunkMatch) {
    return loadPackagedNewcmDynamicChunk(dynamicChunkMatch[1]);
  }
  return require(name);
}

/**
 * Executes a packaged NewCM dynamic font chunk against the bundled font class.
 *
 * MathJax's generated chunks call `require("../../svg.js")`; evaluating them
 * with a tiny local require shim keeps the chunk external without pulling the
 * whole font package into the bundle.
 *
 * @param chunkName NewCM SVG dynamic chunk name.
 */
function loadPackagedNewcmDynamicChunk(chunkName: string) {
  if (loadedMathJaxDynamicChunks.has(chunkName)) {
    return loadedMathJaxDynamicChunks.get(chunkName);
  }

  const chunkPath = getPackagedNewcmDynamicChunkPath(chunkName);
  const code = fs.readFileSync(chunkPath, "utf8");
  const module = { exports: {} };
  const moduleExports = module.exports;
  const { Font } = require("@mathjax/mathjax-newcm-font/js/svg/default.js");
  const context = {
    exports: moduleExports,
    module,
    require: (request: string) => requireMathJaxDynamicChunkDependency(request, Font.DefaultFont),
  };

  vm.runInNewContext(code, context, { filename: chunkPath });
  loadedMathJaxDynamicChunks.set(chunkName, module.exports);
  return module.exports;
}

/**
 * Returns the packaged chunk path after checking the generated file name.
 *
 * MathJax controls the module name, but this guard keeps the asset loader from
 * accepting path separators or traversal if a future request format changes.
 *
 * @param chunkName NewCM SVG dynamic chunk name.
 */
function getPackagedNewcmDynamicChunkPath(chunkName: string) {
  if (!MATHJAX_DYNAMIC_CHUNK_NAME_PATTERN.test(chunkName)) {
    throw new Error(`Unsupported MathJax dynamic font chunk name: ${chunkName}`);
  }
  return path.join(MATHJAX_NEWCM_DYNAMIC_FONT_DIR, `${chunkName}.js`);
}

/**
 * Resolves the limited dependency surface used by generated NewCM chunks.
 *
 * @param request Require path from the generated chunk.
 * @param MathJaxNewcmFont Bundled NewCM font class.
 */
function requireMathJaxDynamicChunkDependency(request: string, MathJaxNewcmFont: unknown) {
  if (request === "../../svg.js") {
    return { MathJaxNewcmFont };
  }
  throw new Error(`Unsupported MathJax dynamic font dependency: ${request}`);
}

/**
 * Extracts MathJax's SVG-level render error when conversion produced merror.
 *
 * MathJax can return an SVG containing an error node instead of throwing; the
 * hover should treat that as a failed preview so the output channel has details.
 *
 * @param svg Serialized MathJax SVG.
 */
function getMathJaxSvgError(svg: string) {
  const match = svg.match(/\bdata-mjx-error="([^"]+)"/);
  return match ? decodeHtmlAttribute(match[1]) : undefined;
}

/**
 * Decodes the small set of HTML entities expected inside SVG attributes.
 *
 * @param value Attribute value.
 */
function decodeHtmlAttribute(value: string) {
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
 * @param tex TeX source.
 */
function formatTexForLog(tex: string) {
  const compactTex = tex.replace(/\s+/g, " ").trim();
  const truncatedTex = compactTex.length > 160 ? `${compactTex.slice(0, 157)}...` : compactTex;
  return `"${truncatedTex}"`;
}

/**
 * Makes a MathJax SVG fit inside hover images without clipping.
 *
 * @param svg Raw MathJax SVG.
 * @param foregroundColor CSS color for SVG glyphs.
 */
function makeSvgHoverFriendly(svg: string, foregroundColor: string | undefined) {
  const sizedSvg = setSvgPixelSize(svg, 720);
  const colorStyle = foregroundColor ? `color:${foregroundColor};` : "";
  // Data-URI SVG images do not inherit VS Code hover foreground reliably, so
  // dark themes need an explicit glyph color while light themes keep MathJax's default.
  const hoverStyle = `background:transparent;${colorStyle}`;
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
 * @param svg Raw MathJax SVG.
 * @param maxWidthPx Maximum rendered width.
 */
function setSvgPixelSize(svg: string, maxWidthPx: number) {
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
 * @param svg Raw SVG.
 * @param attribute Attribute name.
 * @param value Attribute value.
 */
function upsertSvgAttribute(svg: string, attribute: string, value: string) {
  const pattern = new RegExp(`(<svg\\b[^>]*\\s)${attribute}="[^"]*"`);
  if (pattern.test(svg)) {
    return svg.replace(pattern, `$1${attribute}="${value}"`);
  }
  return svg.replace("<svg ", `<svg ${attribute}="${value}" `);
}




