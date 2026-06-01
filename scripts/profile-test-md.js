"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const {
  parsePandocDocument,
  findMathBlockAtPosition,
  findInlineMathAtPosition,
  findTokenAtPosition,
} = require("../src/parser");

const repoRoot = path.resolve(__dirname, "..");
const targetPath = path.resolve(repoRoot, process.argv[2] || "test.md");
const uriText = `file:///${targetPath.replace(/\\/g, "/")}`;
const parseIterations = Number(process.env.PROFILE_PARSE_ITERATIONS || 50);
let mathJaxReadyPromise;

/**
 * Measures one synchronous or asynchronous profiler stage.
 *
 * @param {string} name Stage name shown in the report.
 * @param {() => unknown | Promise<unknown>} action Stage body.
 * @returns {Promise<{name: string, ms: number, result: unknown}>}
 */
async function measure(name, action) {
  const started = performance.now();
  const result = await action();
  return { name, ms: performance.now() - started, result };
}

/**
 * Formats a duration with enough precision for sub-millisecond parser stages.
 *
 * @param {number} ms Duration in milliseconds.
 * @returns {string}
 */
function formatMs(ms) {
  return `${ms.toFixed(3)} ms`;
}

/**
 * Builds the same label-to-definitions map used by diagnostics and hovers.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {Map<string, import("../src/parser").LabelEntry[]>}
 */
function buildDefinitionMap(parsed) {
  const map = new Map();
  for (const label of parsed.labels) {
    if (!map.has(label.label)) {
      map.set(label.label, []);
    }
    map.get(label.label).push(label);
  }
  return map;
}

/**
 * Simulates the extension's diagnostics pass without the VS Code API objects.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {{undefinedReferences: number, duplicateLabels: number, total: number}}
 */
function buildDiagnostics(parsed) {
  const definitionMap = buildDefinitionMap(parsed);
  let undefinedReferences = 0;
  let duplicateLabels = 0;

  for (const reference of parsed.references) {
    if (!definitionMap.has(reference.label)) {
      undefinedReferences += 1;
    }
  }

  for (const label of parsed.labels) {
    const definitions = definitionMap.get(label.label) || [];
    if (definitions.length > 1) {
      duplicateLabels += 1;
    }
  }

  return {
    undefinedReferences,
    duplicateLabels,
    total: undefinedReferences + duplicateLabels,
  };
}

/**
 * Builds a lightweight outline tree matching the extension's symbol grouping.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {{roots: unknown[], totalSymbols: number}}
 */
function buildOutline(parsed) {
  const roots = [];
  const stack = [];

  for (const heading of parsed.headings) {
    const symbol = { title: formatHeadingTitle(heading), label: heading.label || "", line: heading.line, level: heading.level, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(symbol);
    } else {
      stack[stack.length - 1].symbol.children.push(symbol);
    }
    stack.push({ level: heading.level, symbol });
  }

  for (const label of parsed.labels.filter((entry) => entry.prefix !== "sec")) {
    const symbol = { title: label.label, label: label.kind, line: label.line, level: 7, children: [] };
    const parent = findNearestHeadingSymbol(roots, label.line);
    if (parent) {
      parent.children.push(symbol);
    } else {
      roots.push(symbol);
    }
  }

  return { roots, totalSymbols: countSymbols(roots) };
}

/**
 * Formats a heading title like the extension's Outline provider.
 *
 * @param {import("../src/parser").HeadingEntry} heading Parsed heading.
 * @returns {string}
 */
function formatHeadingTitle(heading) {
  return `${"#".repeat(heading.level)} ${heading.title}`;
}

/**
 * Finds the nearest outline heading before a label line.
 *
 * @param {Array<{line: number, children: unknown[]}>} symbols Candidate symbols.
 * @param {number} line Target line.
 * @returns {{line: number, children: unknown[]} | undefined}
 */
function findNearestHeadingSymbol(symbols, line) {
  let nearest;
  for (const symbol of symbols) {
    if (symbol.line <= line) {
      nearest = symbol;
    }
    const childNearest = findNearestHeadingSymbol(symbol.children, line);
    if (childNearest && childNearest.line <= line) {
      nearest = childNearest;
    }
  }
  return nearest;
}

/**
 * Counts all symbols in a tree.
 *
 * @param {Array<{children: unknown[]}>} symbols Root symbols.
 * @returns {number}
 */
function countSymbols(symbols) {
  let total = 0;
  for (const symbol of symbols) {
    total += 1 + countSymbols(symbol.children);
  }
  return total;
}

/**
 * Simulates the completion provider's unique sorted label list.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {string[]}
 */
function buildCompletions(parsed) {
  const seen = new Set();
  return parsed.labels
    .filter((entry) => !seen.has(entry.label) && seen.add(entry.label))
    .map((entry) => entry.label)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Exercises token and math lookups at positions that exist in the fixture.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {{tokenLookups: number, displayMathLookups: number, inlineMathLookups: number}}
 */
function runHoverAndNavigationLookups(parsed) {
  let tokenLookups = 0;
  let displayMathLookups = 0;
  let inlineMathLookups = 0;

  for (const entry of [...parsed.labels, ...parsed.references]) {
    if (findTokenAtPosition(parsed, { line: entry.line, character: entry.character })) {
      tokenLookups += 1;
    }
  }

  for (const entry of parsed.mathBlocks) {
    if (findMathBlockAtPosition(parsed, { line: entry.line, character: 0 })) {
      displayMathLookups += 1;
    }
  }

  for (const entry of parsed.inlineMath) {
    if (findInlineMathAtPosition(parsed, { line: entry.line, character: entry.character + 1 })) {
      inlineMathLookups += 1;
    }
  }

  return { tokenLookups, displayMathLookups, inlineMathLookups };
}

/**
 * Loads MathJax the same way the extension does for hover preview timing.
 *
 * @returns {Promise<any>}
 */
async function loadMathJax() {
  if (mathJaxReadyPromise) {
    return mathJaxReadyPromise;
  }

  // Keep this aligned with extension.js: use the direct API so profiling matches
  // the packaged extension bundle rather than MathJax's component loader.
  mathJaxReadyPromise = Promise.resolve().then(() => {
    require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
    require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
    // Keep \boldsymbol coverage aligned with the extension hover renderer.
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
    const svg = new SVG({ fontCache: "none", linebreaks: { inline: false } });
    const html = mathjax.document("", { InputJax: tex, OutputJax: svg });
    return { adaptor, html };
  });
  return mathJaxReadyPromise;
}

/**
 * Registers the same bundled MathJax dynamic loader used by extension.js.
 *
 * @param {any} mathjax MathJax direct API namespace.
 */
function configureMathJaxAsyncLoad(mathjax) {
  mathjax.asyncLoad = loadBundledMathJaxDynamicModule;
  mathjax.asyncIsSynchronous = true;
}

/**
 * Loads dynamic MathJax modules, keeping known NewCM SVG chunks bundle-friendly.
 *
 * @param {string} name Module name requested by MathJax.
 * @returns {any}
 */
function loadBundledMathJaxDynamicModule(name) {
  const normalizedName = name.replace(/\\/g, "/");
  if (normalizedName.endsWith("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js")) {
    return require("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js");
  }
  if (normalizedName.endsWith("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js")) {
    return require("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js");
  }
  return require(name);
}

/**
 * Renders one display and one inline formula to capture cold/warm hover costs.
 *
 * @param {import("../src/parser").ParsedPandocDocument} parsed Parsed document.
 * @returns {Promise<{displaySvgLength: number, inlineSvgLength: number}>}
 */
async function renderMathSamples(parsed) {
  const renderer = await loadMathJax();
  const adaptor = renderer.adaptor;
  const displayTex = parsed.mathBlocks[0] && parsed.mathBlocks[0].tex;
  const inlineTex = parsed.inlineMath[0] && parsed.inlineMath[0].tex;
  let displaySvgLength = 0;
  let inlineSvgLength = 0;

  if (displayTex) {
    const displayNode = await renderer.html.convertPromise(displayTex, { display: true, em: 16, ex: 8, containerWidth: 80 * 16 });
    displaySvgLength = adaptor.serializeXML(adaptor.tags(displayNode, "svg")[0]).length;
  }

  if (inlineTex) {
    const inlineNode = await renderer.html.convertPromise(inlineTex, { display: false, em: 16, ex: 8, containerWidth: 80 * 16 });
    inlineSvgLength = adaptor.serializeXML(adaptor.tags(inlineNode, "svg")[0]).length;
  }

  return { displaySvgLength, inlineSvgLength };
}

/**
 * Runs repeated parses to smooth out one-off Node startup and JIT noise.
 *
 * @param {string} text Markdown source.
 * @returns {{iterations: number, totalMs: number, avgMs: number}}
 */
function benchmarkParse(text) {
  const started = performance.now();
  for (let index = 0; index < parseIterations; index += 1) {
    parsePandocDocument(text, uriText);
  }
  const totalMs = performance.now() - started;
  return { iterations: parseIterations, totalMs, avgMs: totalMs / parseIterations };
}

/**
 * Runs the profiler and prints a compact report.
 */
async function main() {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target Markdown file does not exist: ${targetPath}`);
  }

  const stages = [];
  stages.push(await measure("read file", () => fs.readFileSync(targetPath, "utf8")));
  const text = stages[0].result;

  stages.push(await measure("parse document", () => parsePandocDocument(text, uriText)));
  const parsed = stages[1].result;

  stages.push(await measure("build diagnostics", () => buildDiagnostics(parsed)));
  stages.push(await measure("build outline symbols", () => buildOutline(parsed)));
  stages.push(await measure("build completions", () => buildCompletions(parsed)));
  stages.push(await measure("hover/navigation lookups", () => runHoverAndNavigationLookups(parsed)));
  stages.push(await measure("repeated parse benchmark", () => benchmarkParse(text)));

  const mathStage = await measure("MathJax cold render samples", () => renderMathSamples(parsed));
  stages.push(mathStage);
  stages.push(await measure("MathJax warm render samples", () => renderMathSamples(parsed)));

  console.log(`Profile target: ${path.relative(repoRoot, targetPath)}`);
  console.log(`Document: ${text.length} chars, ${text.split(/\r?\n/).length} lines`);
  console.log("");
  console.log("Stage timings:");
  for (const stage of stages) {
    console.log(`- ${stage.name.padEnd(28)} ${formatMs(stage.ms)}`);
  }

  console.log("");
  console.log("Parsed counts:");
  console.log(`- labels: ${parsed.labels.length}`);
  console.log(`- references: ${parsed.references.length}`);
  console.log(`- headings: ${parsed.headings.length}`);
  console.log(`- display math blocks: ${parsed.mathBlocks.length}`);
  console.log(`- inline math spans: ${parsed.inlineMath.length}`);

  console.log("");
  console.log("Stage details:");
  console.log(`- diagnostics: ${JSON.stringify(stages[2].result)}`);
  console.log(`- outline symbols: ${stages[3].result.totalSymbols}`);
  console.log(`- completions: ${stages[4].result.length}`);
  console.log(`- lookups: ${JSON.stringify(stages[5].result)}`);
  console.log(`- parse benchmark: ${stages[6].result.iterations} iterations, avg ${formatMs(stages[6].result.avgMs)}`);
  console.log(`- MathJax sample SVG lengths: ${JSON.stringify(mathStage.result)}`);

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
