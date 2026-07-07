export const LABEL_PREFIXES = ["sec", "fig", "tbl", "eq"];
export type ParsedLine = { text: string; number: number; startOffset: number; endOffset: number };
export type PlainRange = { start: { line: number; character: number }; end: { line: number; character: number } };
export type LabelEntry = { label: string; prefix: string; kind: string; source: string; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; containerRange?: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type ReferenceEntry = { label: string; prefix: string; kind: string; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type HeadingEntry = { title: string; label?: string; level: number; uriText: string; line: number; character: number; range: PlainRange; selectionRange: PlainRange; preview: string };
export type MathBlockEntry = { label?: string; display: true; uriText: string; line: number; endLine: number; range: PlainRange; selectionRange: PlainRange; tex: string };
export type InlineMathEntry = { tex: string; display: false; uriText: string; line: number; character: number; range: PlainRange; fullRange: PlainRange; offset: number; endOffset: number; fullOffset: number; fullEndOffset: number; preview: string };
export type SpanEntry = { uriText: string; attributes: string; line: number; text: string; range: PlainRange; contentRange: PlainRange; offset: number; endOffset: number; preview: string };
export type CodeSpanRange = { start: number; end: number };
export type FencedDivMarker = { type: "open" | "close"; fenceLength: number; attributeText?: string };
export type FencedDivEntry = { uriText: string; depth: number; attributes: string; closed: boolean; openingFenceLength: number; closingFenceLength?: number; range: PlainRange };
export type ParsedPandocDocument = { uriText: string; textLength: number; labels: LabelEntry[]; references: ReferenceEntry[]; headings: HeadingEntry[]; mathBlocks: MathBlockEntry[]; inlineMath: InlineMathEntry[]; fencedDivs: FencedDivEntry[]; spans: SpanEntry[]; labelMap: Map<string, LabelEntry[]>; referenceMap: Map<string, ReferenceEntry[]> };
export type PandocTokenAtPosition = { type: "label" | "reference"; entry: LabelEntry | ReferenceEntry };

const LABEL_SOURCE = "(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+";
const LABEL_PATTERN = new RegExp("\\{#(" + LABEL_SOURCE + ")\\b[^}]*\\}", "g");
const DIV_ID_PATTERN = new RegExp("<div\\s+[^>]*\\bid=[\"'](" + LABEL_SOURCE + ")[\"']", "gi");
const REF_PATTERN = new RegExp("(?<![A-Za-z0-9_])@(" + LABEL_SOURCE + ")\\b", "g");
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_PATTERN = /^\s*(```+|~~~+)/;
const FENCED_DIV_LINE_PATTERN = /^\s*(:{3,})(.*)$/;
const DISPLAY_MATH_BOUNDARY_PATTERN = /^\s*\$\$\s*(?:\{#(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+\b[^}]*\})?\s*$/;

/**
 * Parses a Markdown document with Pandoc-crossref extensions.
 *
 * The scanner intentionally accepts `$$ {#eq:...}` as a display-math closing
 * line because VS Code's built-in Markdown outline can remain stuck in math
 * mode after that Pandoc-specific delimiter.
 *
 * @param {string} text Full Markdown document text.
 * @param {string} uriText Stable URI string used in cached entries.
 * @returns {ParsedPandocDocument}
 */
export function parsePandocDocument(text, uriText = "") {
  const lines = splitLines(text);
  const labels = [];
  const references = [];
  const headings = [];
  const mathBlocks = [];
  const inlineMath = [];
  const fencedDivs = scanFencedDivs(lines, uriText);
  const spans = [];
  const labelMap = new Map();
  const referenceMap = new Map();

  let inYaml = lines[0] && lines[0].text.trim() === "---";
  let inFence = false;
  let fenceMarker = "";
  let inMath = false;
  let mathStart = null;
  let mathBody = [];
  const divLabelStack = [];

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (inYaml) {
      if (line.number > 0 && trimmed === "---") {
        inYaml = false;
      }
      continue;
    }

    const fenceMatch = line.text.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    if (inMath) {
      const isClosing = DISPLAY_MATH_BOUNDARY_PATTERN.test(line.text);
      if (isClosing) {
        const closingLabels = scanLabels(line, uriText, "math");
        addAllLabels(closingLabels, labels, labelMap);
        mathBlocks.push(createMathBlock(uriText, mathStart, line, mathBody, closingLabels));
        inMath = false;
        mathStart = null;
        mathBody = [];
        continue;
      }

      mathBody.push(line.text);
      continue;
    }

    const lineLabels = scanLabels(line, uriText, "markdown");
    updateHtmlDivLabelContainers(line, lineLabels, divLabelStack);
    addAllLabels(lineLabels, labels, labelMap);
    addAllReferences(scanReferences(line, uriText), references, referenceMap);
    inlineMath.push(...scanInlineMath(line, uriText));
    spans.push(...scanPandocSpans(line, uriText));

    const heading = scanHeading(line, uriText);
    if (heading) {
      headings.push(heading);
    }

    if (isDisplayMathStart(line.text)) {
      inMath = true;
      mathStart = line;
      mathBody = [];
    }
  }

  if (inMath && mathStart) {
    mathBlocks.push(createMathBlock(uriText, mathStart, lines[lines.length - 1] || mathStart, mathBody, []));
  }
  closeOpenHtmlDivLabelContainers(divLabelStack, lines[lines.length - 1]);

  return {
    uriText,
    textLength: text.length,
    labels,
    references,
    headings,
    mathBlocks,
    inlineMath,
    fencedDivs,
    spans,
    labelMap,
    referenceMap,
  };
}

/**
 * Splits text into line objects while preserving absolute offsets.
 *
 * @param {string} text Full document text.
 * @returns {ParsedLine[]}
 */
function splitLines(text) {
  const lines = [];
  let lineStart = 0;
  let lineNumber = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\r" && char !== "\n") {
      continue;
    }

    const lineEnd = index;
    const newlineLength = char === "\r" && text[index + 1] === "\n" ? 2 : 1;
    lines.push(createLine(text.slice(lineStart, lineEnd), lineNumber, lineStart, lineEnd));
    lineNumber += 1;
    index += newlineLength - 1;
    lineStart = lineEnd + newlineLength;
  }

  lines.push(createLine(text.slice(lineStart), lineNumber, lineStart, text.length));
  return lines;
}

/**
 * Creates a line object used by the parser.
 *
 * @param {string} text Line text without newline.
 * @param {number} number Zero-based line number.
 * @param {number} startOffset Absolute start offset.
 * @param {number} endOffset Absolute end offset.
 * @returns {ParsedLine}
 */
function createLine(text, number, startOffset, endOffset) {
  return { text, number, startOffset, endOffset };
}

/**
 * Finds Pandoc fenced div blocks and preserves their nested depth.
 *
 * Fenced divs use colon fences that look like ordinary prose in VS Code's
 * Markdown grammar, so we parse them explicitly for editor decorations.
 *
 * @param {ParsedLine[]} lines Parsed document lines.
 * @param {string} uriText URI string for resulting entries.
 * @returns {FencedDivEntry[]}
 */
function scanFencedDivs(lines, uriText) {
  const blocks = [];
  const stack = [];
  let inYaml = lines[0] && lines[0].text.trim() === "---";
  let inFence = false;
  let fenceMarker = "";
  let inMath = false;

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (inYaml) {
      if (line.number > 0 && trimmed === "---") {
        inYaml = false;
      }
      continue;
    }

    const codeFenceMatch = line.text.match(FENCE_PATTERN);
    if (codeFenceMatch) {
      const marker = codeFenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    if (inMath) {
      if (DISPLAY_MATH_BOUNDARY_PATTERN.test(line.text)) {
        inMath = false;
      }
      continue;
    }

    if (isDisplayMathStart(line.text)) {
      inMath = true;
      continue;
    }

    const marker = parseFencedDivMarker(line.text);
    if (!marker) {
      continue;
    }

    if (marker.type === "open") {
      stack.push({ line, marker, depth: stack.length });
      continue;
    }

    const opening = stack.pop();
    if (opening) {
      blocks.push(createFencedDivEntry(uriText, opening, line, true));
    }
  }

  const finalLine = lines[lines.length - 1];
  while (finalLine && stack.length > 0) {
    blocks.push(createFencedDivEntry(uriText, stack.pop(), finalLine, false));
  }

  return blocks.sort((left, right) => left.range.start.line - right.range.start.line);
}

/**
 * Parses a single Pandoc fenced div delimiter line.
 *
 * Opening fences must have attributes; attribute-less colon fences are always
 * closers, which matches Pandoc's fenced_divs rule and prevents prose-like
 * colon runs from becoming accidental block starts.
 *
 * @param {string} lineText Line text without newline.
 * @returns {FencedDivMarker | undefined}
 */
function parseFencedDivMarker(lineText) {
  const match = lineText.match(FENCED_DIV_LINE_PATTERN);
  if (!match) {
    return undefined;
  }

  const fenceLength = match[1].length;
  const attributeText = match[2].trim();
  if (attributeText.length === 0) {
    return { type: "close", fenceLength };
  }

  const normalizedAttributeText = stripTrailingFencedDivColons(attributeText);
  if (!isFencedDivAttributeText(normalizedAttributeText)) {
    return undefined;
  }

  return {
    type: "open",
    fenceLength,
    attributeText: normalizedAttributeText,
  };
}

/**
 * Checks whether text after a colon fence is a Pandoc fenced div attribute.
 *
 * This intentionally accepts Pandoc's `{...}` attributes and the single
 * unbraced class shorthand, plus Pandoc's optional trailing colon run.
 *
 * @param {string} attributeText Text after the opening colon run.
 * @returns {boolean}
 */
function isFencedDivAttributeText(attributeText) {
  return /^(?:\{[^}]*\S[^}]*\}|[^\s{}:]+)$/.test(attributeText);
}

/**
 * Removes Pandoc's optional trailing colon run from opening attributes.
 *
 * @param {string} attributeText Raw opening attribute text.
 * @returns {string}
 */
function stripTrailingFencedDivColons(attributeText) {
  return attributeText.replace(/\s*:{3,}\s*$/, "").trim();
}

/**
 * Creates a parsed fenced div entry for decoration and future language features.
 *
 * @param {string} uriText URI string for the entry.
 * @param {{line: ParsedLine, marker: FencedDivMarker, depth: number}} opening Opening fence state.
 * @param {ParsedLine} closing Closing fence or final document line.
 * @param {boolean} closed Whether a real closing fence was found.
 * @returns {FencedDivEntry}
 */
function createFencedDivEntry(uriText, opening, closing, closed) {
  return {
    uriText,
    depth: opening.depth,
    attributes: opening.marker.attributeText || "",
    closed,
    openingFenceLength: opening.marker.fenceLength,
    closingFenceLength: closed ? closing.text.trim().length : undefined,
    range: createRange(opening.line.number, 0, closing.number, closing.text.length),
  };
}

/**
 * Finds Pandoc bracketed spans with inline attributes.
 *
 * This highlights `[text]{custom-style="..."}` and related bracketed span
 * attributes without confusing ordinary Markdown links or images for spans.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @returns {SpanEntry[]}
 */
function scanPandocSpans(line, uriText) {
  const spans = [];
  const codeSpanRanges = collectMarkdownCodeSpanRanges(line.text);
  const openingBrackets = [];

  for (let index = 0; index < line.text.length; index += 1) {
    if (isIndexInRanges(index, codeSpanRanges) || isEscaped(line.text, index)) {
      continue;
    }

    const character = line.text[index];
    if (character === "[") {
      if (index > 0 && line.text[index - 1] === "!") {
        continue;
      }
      openingBrackets.push(index);
      continue;
    }

    if (character !== "]") {
      continue;
    }

    const openingBracket = openingBrackets.pop();
    if (openingBracket === undefined) {
      continue;
    }

    // Bug fix: nested bracket content such as Pandoc citations `[@a; @b]`
    // must consume their own `[` / `]` pair, or the outer span highlight
    // would incorrectly start at the citation instead of the real span start.
    if (line.text[index + 1] !== "{") {
      continue;
    }

    const closingBrace = findClosingAttributeBrace(line.text, index + 2);
    if (closingBrace === -1) {
      continue;
    }

    const attributes = line.text.slice(index + 2, closingBrace).trim();
    if (!isPandocSpanAttributeText(attributes)) {
      continue;
    }

    spans.push({
      uriText,
      attributes,
      line: line.number,
      text: line.text.slice(openingBracket + 1, index),
      range: createRange(line.number, openingBracket, line.number, closingBrace + 1),
      contentRange: createRange(line.number, openingBracket + 1, line.number, index),
      offset: line.startOffset + openingBracket,
      endOffset: line.startOffset + closingBrace + 1,
      preview: line.text.trim(),
    });

    index = closingBrace;
  }

  return spans;
}

/**
 * Finds the closing brace for one inline attribute block.
 *
 * Escaped braces are kept literal so `\}` inside an attribute value does not
 * prematurely end the span decoration.
 *
 * @param {string} text Line text.
 * @param {number} start First character after the opening `{`.
 * @returns {number}
 */
function findClosingAttributeBrace(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "}" && !isEscaped(text, index)) {
      return index;
    }
  }
  return -1;
}

/**
 * Checks whether a bracketed span has real Pandoc attributes.
 *
 * @param {string} attributes Raw attribute text without surrounding braces.
 * @returns {boolean}
 */
function isPandocSpanAttributeText(attributes) {
  return attributes.length > 0;
}

/**
 * Finds Pandoc labels on one line.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @param {string} source Logical source type, for example `markdown` or `math`.
 * @returns {LabelEntry[]}
 */
function scanLabels(line, uriText, source) {
  const labels = [];
  collectLabelMatches(line, uriText, source, LABEL_PATTERN, labels, 1);
  collectLabelMatches(line, uriText, "html-div", DIV_ID_PATTERN, labels, 1);
  return labels;
}

/**
 * Tracks the line span of `<div id="fig:...">` labels for subfigure outline nesting.
 *
 * Only div labels are container parents; this prevents ordinary figure/table
 * labels from accidentally nesting every following label in the Outline.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {LabelEntry[]} lineLabels Labels found on this line.
 * @param {Array<LabelEntry | undefined>} divLabelStack Open div stack.
 */
function updateHtmlDivLabelContainers(line, lineLabels, divLabelStack) {
  const divLabels = lineLabels.filter((entry) => entry.source === "html-div");
  const divTagPattern = /<\/div\s*>|<div\b[^>]*>/gi;
  let match;

  while ((match = divTagPattern.exec(line.text))) {
    const tag = match[0].toLowerCase();
    if (tag.startsWith("</div")) {
      closeHtmlDivLabelContainer(divLabelStack, line, match.index + match[0].length);
      continue;
    }

    const tagOffset = line.startOffset + match.index;
    const label = divLabels.find((entry) => entry.fullOffset === tagOffset);
    divLabelStack.push(label);
  }
}

/**
 * Closes one open div label container at a concrete document location.
 *
 * @param {Array<LabelEntry | undefined>} divLabelStack Open div stack.
 * @param {ParsedLine} line Closing line.
 * @param {number} endCharacter Character after the closing `</div>`.
 */
function closeHtmlDivLabelContainer(divLabelStack, line, endCharacter) {
  const label = divLabelStack.pop();
  if (!label) {
    return;
  }

  label.containerRange = createRange(label.line, label.fullRange.start.character, line.number, endCharacter);
}

/**
 * Gives unclosed div labels a finite container so outline parenting remains stable.
 *
 * @param {Array<LabelEntry | undefined>} divLabelStack Open div stack.
 * @param {ParsedLine | undefined} finalLine Final document line.
 */
function closeOpenHtmlDivLabelContainers(divLabelStack, finalLine) {
  if (!finalLine) {
    return;
  }

  while (divLabelStack.length > 0) {
    closeHtmlDivLabelContainer(divLabelStack, finalLine, finalLine.text.length);
  }
}

/**
 * Converts regex label matches into normalized label entries.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @param {string} source Logical source type.
 * @param {RegExp} pattern Label regex.
 * @param {LabelEntry[]} labels Target label collection.
 * @param {number} groupIndex Capturing group index containing the label.
 */
function collectLabelMatches(line, uriText, source, pattern, labels, groupIndex) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(line.text))) {
    const label = match[groupIndex];
    const labelStart = match.index + match[0].indexOf(label);
    labels.push({
      label,
      prefix: getLabelPrefix(label),
      kind: getLabelKind(label),
      source,
      uriText,
      line: line.number,
      character: labelStart,
      range: createRange(line.number, labelStart, line.number, labelStart + label.length),
      fullRange: createRange(line.number, match.index, line.number, match.index + match[0].length),
      offset: line.startOffset + labelStart,
      endOffset: line.startOffset + labelStart + label.length,
      fullOffset: line.startOffset + match.index,
      fullEndOffset: line.startOffset + match.index + match[0].length,
      preview: line.text.trim(),
    });
  }
}

/**
 * Finds Pandoc cross-reference tokens on one line.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @returns {ReferenceEntry[]}
 */
function scanReferences(line, uriText) {
  const references = [];
  REF_PATTERN.lastIndex = 0;
  let match;
  while ((match = REF_PATTERN.exec(line.text))) {
    const label = match[1];
    const labelStart = match.index + 1;
    references.push({
      label,
      prefix: getLabelPrefix(label),
      kind: getLabelKind(label),
      uriText,
      line: line.number,
      character: labelStart,
      range: createRange(line.number, labelStart, line.number, labelStart + label.length),
      fullRange: createRange(line.number, match.index, line.number, match.index + match[0].length),
      offset: line.startOffset + labelStart,
      endOffset: line.startOffset + labelStart + label.length,
      fullOffset: line.startOffset + match.index,
      fullEndOffset: line.startOffset + match.index + match[0].length,
      preview: line.text.trim(),
    });
  }
  return references;
}

/**
 * Finds a Markdown heading and strips a trailing Pandoc section label.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @returns {HeadingEntry | undefined}
 */
function scanHeading(line, uriText) {
  const match = line.text.match(HEADING_PATTERN);
  if (!match) {
    return undefined;
  }

  const level = match[1].length;
  const rawTitle = match[2].trim();
  const labelMatch = rawTitle.match(/\s*\{#(sec:[^}]+)\}\s*$/);
  const label = labelMatch ? labelMatch[1] : undefined;
  const title = stripTrailingAttribute(rawTitle);
  const titleStart = line.text.indexOf(match[2]);

  return {
    title,
    label,
    level,
    uriText,
    line: line.number,
    character: titleStart,
    range: createRange(line.number, 0, line.number, line.text.length),
    selectionRange: createRange(line.number, titleStart, line.number, titleStart + title.length),
    preview: line.text.trim(),
  };
}

/**
 * Creates a math block record for hover previews and equation symbols.
 *
 * @param {string} uriText URI string for resulting entries.
 * @param {ParsedLine} startLine Opening math delimiter.
 * @param {ParsedLine} endLine Closing math delimiter or final document line.
 * @param {string[]} bodyLines TeX body lines.
 * @param {LabelEntry[]} closingLabels Labels found on the closing delimiter.
 * @returns {MathBlockEntry}
 */
function createMathBlock(uriText, startLine, endLine, bodyLines, closingLabels) {
  const equationLabel = closingLabels.find((entry) => entry.prefix === "eq");
  return {
    label: equationLabel ? equationLabel.label : undefined,
    display: true,
    uriText,
    line: startLine.number,
    endLine: endLine.number,
    range: createRange(startLine.number, 0, endLine.number, endLine.text.length),
    selectionRange: equationLabel ? equationLabel.range : createRange(startLine.number, 0, startLine.number, startLine.text.length),
    tex: bodyLines.join("\n").trim(),
  };
}

/**
 * Finds inline TeX math on one line.
 *
 * Inline formulas are intentionally independent from cross-reference parsing:
 * they only power hover previews and do not create labels or references.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @returns {InlineMathEntry[]}
 */
function scanInlineMath(line, uriText) {
  const entries = [];
  const codeSpanRanges = collectMarkdownCodeSpanRanges(line.text);
  scanDelimitedInlineMath(line, uriText, "$", "$", entries, codeSpanRanges);
  scanDelimitedInlineMath(line, uriText, "\\(", "\\)", entries, codeSpanRanges);
  return entries;
}

/**
 * Finds inline Markdown code spans so math-like text inside backticks is ignored.
 *
 * This handles the preview false positive where code such as `$x$` should stay
 * literal instead of becoming a MathJax hover target.
 *
 * @param {string} text Line text.
 * @returns {CodeSpanRange[]}
 */
function collectMarkdownCodeSpanRanges(text) {
  const ranges = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    const opening = findNextBacktickRun(text, searchStart);
    if (!opening) {
      break;
    }

    const closing = findMatchingBacktickRun(text, opening.end, opening.length);
    if (!closing) {
      break;
    }

    ranges.push({ start: opening.start, end: closing.end });
    searchStart = closing.end;
  }

  return ranges;
}

/**
 * Finds the next unescaped backtick run in a line.
 *
 * @param {string} text Line text.
 * @param {number} start Search start index.
 * @returns {{start: number, end: number, length: number} | undefined}
 */
function findNextBacktickRun(text, start) {
  let index = text.indexOf("`", start);
  while (index >= 0) {
    const end = countBacktickRunEnd(text, index);
    if (!isEscaped(text, index)) {
      return { start: index, end, length: end - index };
    }
    index = text.indexOf("`", end);
  }
  return undefined;
}

/**
 * Finds the closing backtick run with the same length as the opener.
 *
 * Markdown code spans need this special case because doubled backticks may
 * contain single-backtick text without ending the span.
 *
 * @param {string} text Line text.
 * @param {number} start Search start index.
 * @param {number} delimiterLength Backtick run length to match.
 * @returns {{start: number, end: number, length: number} | undefined}
 */
function findMatchingBacktickRun(text, start, delimiterLength) {
  let run = findNextBacktickRun(text, start);
  while (run) {
    if (run.length === delimiterLength) {
      return run;
    }
    run = findNextBacktickRun(text, run.end);
  }
  return undefined;
}

/**
 * Counts a contiguous run of backticks.
 *
 * @param {string} text Line text.
 * @param {number} start First backtick index.
 * @returns {number}
 */
function countBacktickRunEnd(text, start) {
  let end = start;
  while (text[end] === "`") {
    end += 1;
  }
  return end;
}

/**
 * Scans inline math wrapped by one delimiter pair.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @param {string} openDelimiter Opening delimiter.
 * @param {string} closeDelimiter Closing delimiter.
 * @param {InlineMathEntry[]} entries Target entries.
 * @param {CodeSpanRange[]} ignoredRanges Inline code ranges that must not preview as math.
 */
function scanDelimitedInlineMath(line, uriText, openDelimiter, closeDelimiter, entries, ignoredRanges) {
  let searchStart = 0;
  while (searchStart < line.text.length) {
    const openIndex = findNextDelimiter(line.text, openDelimiter, searchStart, ignoredRanges);
    if (openIndex < 0) {
      return;
    }

    if (openDelimiter === "$" && line.text[openIndex + 1] === "$") {
      searchStart = openIndex + 2;
      continue;
    }

    const contentStart = openIndex + openDelimiter.length;
    const closeIndex = findNextDelimiter(line.text, closeDelimiter, contentStart, ignoredRanges);
    if (closeIndex < 0) {
      return;
    }

    if (closeDelimiter === "$" && line.text[closeIndex + 1] === "$") {
      searchStart = closeIndex + 2;
      continue;
    }

    const tex = line.text.slice(contentStart, closeIndex).trim();
    if (tex.length > 0) {
      entries.push({
        tex,
        display: false,
        uriText,
        line: line.number,
        character: openIndex,
        range: createRange(line.number, contentStart, line.number, closeIndex),
        fullRange: createRange(line.number, openIndex, line.number, closeIndex + closeDelimiter.length),
        offset: line.startOffset + contentStart,
        endOffset: line.startOffset + closeIndex,
        fullOffset: line.startOffset + openIndex,
        fullEndOffset: line.startOffset + closeIndex + closeDelimiter.length,
        preview: line.text.trim(),
      });
    }

    searchStart = closeIndex + closeDelimiter.length;
  }
}

/**
 * Finds the next unescaped inline math delimiter.
 *
 * @param {string} text Line text.
 * @param {string} delimiter Delimiter to find.
 * @param {number} start Search start index.
 * @param {CodeSpanRange[]=} ignoredRanges Ranges where delimiters are literal code.
 * @returns {number}
 */
function findNextDelimiter(text, delimiter, start, ignoredRanges = []) {
  let index = text.indexOf(delimiter, start);
  while (index >= 0 && (isEscaped(text, index) || isIndexInRanges(index, ignoredRanges))) {
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return index;
}

/**
 * Checks whether an index falls inside ignored line ranges.
 *
 * @param {number} index Character index.
 * @param {CodeSpanRange[]} ranges Ignored ranges.
 * @returns {boolean}
 */
function isIndexInRanges(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * Checks whether a character at an index is escaped by an odd backslash count.
 *
 * @param {string} text Line text.
 * @param {number} index Character index.
 * @returns {boolean}
 */
function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Checks whether a line starts a display math block.
 *
 * @param {string} lineText Line text.
 * @returns {boolean}
 */
function isDisplayMathStart(lineText) {
  return /^\s*\$\$\s*$/.test(lineText);
}

/**
 * Adds label entries to flat and keyed collections.
 *
 * @param {LabelEntry[]} entries Label entries to add.
 * @param {LabelEntry[]} labels Flat label collection.
 * @param {Map<string, LabelEntry[]>} labelMap Label map.
 */
function addAllLabels(entries, labels, labelMap) {
  for (const entry of entries) {
    labels.push(entry);
    if (!labelMap.has(entry.label)) {
      labelMap.set(entry.label, []);
    }
    labelMap.get(entry.label).push(entry);
  }
}

/**
 * Adds reference entries to flat and keyed collections.
 *
 * @param {ReferenceEntry[]} entries Reference entries to add.
 * @param {ReferenceEntry[]} references Flat reference collection.
 * @param {Map<string, ReferenceEntry[]>} referenceMap Reference map.
 */
function addAllReferences(entries, references, referenceMap) {
  for (const entry of entries) {
    references.push(entry);
    if (!referenceMap.has(entry.label)) {
      referenceMap.set(entry.label, []);
    }
    referenceMap.get(entry.label).push(entry);
  }
}

/**
 * Removes a trailing Pandoc attribute from display text.
 *
 * @param {string} value Heading text.
 * @returns {string}
 */
function stripTrailingAttribute(value) {
  return value.replace(/\s*\{[^}]+\}\s*$/, "").trim();
}

/**
 * Returns the prefix before the first colon in a Pandoc label.
 *
 * @param {string} label Pandoc label.
 * @returns {string}
 */
function getLabelPrefix(label) {
  return label.split(":", 1)[0];
}

/**
 * Returns a human-readable label kind.
 *
 * @param {string} label Pandoc label.
 * @returns {string}
 */
function getLabelKind(label) {
  const prefix = getLabelPrefix(label);
  if (prefix === "sec") {
    return "Section";
  }
  if (prefix === "fig") {
    return "Figure";
  }
  if (prefix === "tbl") {
    return "Table";
  }
  if (prefix === "eq") {
    return "Equation";
  }
  return "Label";
}

/**
 * Creates a plain serializable range.
 *
 * @param {number} startLine Start line.
 * @param {number} startCharacter Start character.
 * @param {number} endLine End line.
 * @param {number} endCharacter End character.
 * @returns {PlainRange}
 */
function createRange(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

/**
 * Finds the parsed token under a cursor position.
 *
 * @param {ParsedPandocDocument} parsed Parsed document.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {{type: string, entry: LabelEntry | ReferenceEntry} | undefined}
 */
export function findTokenAtPosition(parsed, position) {
  const reference = parsed.references.find((entry) => containsPosition(entry.fullRange, position));
  if (reference) {
    return { type: "reference", entry: reference };
  }

  const label = parsed.labels.find((entry) => containsPosition(entry.fullRange, position));
  if (label) {
    return { type: "label", entry: label };
  }

  return undefined;
}

/**
 * Finds the display math block under a cursor position.
 *
 * @param {ParsedPandocDocument} parsed Parsed document.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {MathBlockEntry | undefined}
 */
export function findMathBlockAtPosition(parsed, position) {
  return parsed.mathBlocks.find((entry) => containsPosition(entry.range, position));
}

/**
 * Finds the inline math span under a cursor position.
 *
 * @param {ParsedPandocDocument} parsed Parsed document.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {InlineMathEntry | undefined}
 */
export function findInlineMathAtPosition(parsed, position) {
  return parsed.inlineMath.find((entry) => containsPosition(entry.fullRange, position));
}

/**
 * Checks whether a range includes a position.
 *
 * @param {PlainRange} range Plain range.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {boolean}
 */
export function containsPosition(range, position) {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }
  return true;
}


