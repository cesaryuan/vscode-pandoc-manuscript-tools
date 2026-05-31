"use strict";

const LABEL_PREFIXES = ["sec", "fig", "tbl", "eq"];
const LABEL_SOURCE = "(?:sec|fig|tbl|eq):[-A-Za-z0-9_:.]+";
const LABEL_PATTERN = new RegExp("\\{#(" + LABEL_SOURCE + ")\\b[^}]*\\}", "g");
const DIV_ID_PATTERN = new RegExp("<div\\s+[^>]*\\bid=[\"'](" + LABEL_SOURCE + ")[\"']", "gi");
const REF_PATTERN = new RegExp("(?<![A-Za-z0-9_])@(" + LABEL_SOURCE + ")\\b", "g");
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_PATTERN = /^\s*(```+|~~~+)/;
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
function parsePandocDocument(text, uriText = "") {
  const lines = splitLines(text);
  const labels = [];
  const references = [];
  const headings = [];
  const mathBlocks = [];
  const inlineMath = [];
  const labelMap = new Map();
  const referenceMap = new Map();

  let inYaml = lines[0] && lines[0].text.trim() === "---";
  let inFence = false;
  let fenceMarker = "";
  let inMath = false;
  let mathStart = null;
  let mathBody = [];

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
    addAllLabels(lineLabels, labels, labelMap);
    addAllReferences(scanReferences(line, uriText), references, referenceMap);
    inlineMath.push(...scanInlineMath(line, uriText));

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

  return {
    uriText,
    textLength: text.length,
    labels,
    references,
    headings,
    mathBlocks,
    inlineMath,
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
  scanDelimitedInlineMath(line, uriText, "$", "$", entries);
  scanDelimitedInlineMath(line, uriText, "\\(", "\\)", entries);
  return entries;
}

/**
 * Scans inline math wrapped by one delimiter pair.
 *
 * @param {ParsedLine} line Parsed line.
 * @param {string} uriText URI string for resulting entries.
 * @param {string} openDelimiter Opening delimiter.
 * @param {string} closeDelimiter Closing delimiter.
 * @param {InlineMathEntry[]} entries Target entries.
 */
function scanDelimitedInlineMath(line, uriText, openDelimiter, closeDelimiter, entries) {
  let searchStart = 0;
  while (searchStart < line.text.length) {
    const openIndex = findNextDelimiter(line.text, openDelimiter, searchStart);
    if (openIndex < 0) {
      return;
    }

    if (openDelimiter === "$" && line.text[openIndex + 1] === "$") {
      searchStart = openIndex + 2;
      continue;
    }

    const contentStart = openIndex + openDelimiter.length;
    const closeIndex = findNextDelimiter(line.text, closeDelimiter, contentStart);
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
 * @returns {number}
 */
function findNextDelimiter(text, delimiter, start) {
  let index = text.indexOf(delimiter, start);
  while (index >= 0 && isEscaped(text, index)) {
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return index;
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
function findTokenAtPosition(parsed, position) {
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
function findMathBlockAtPosition(parsed, position) {
  return parsed.mathBlocks.find((entry) => containsPosition(entry.range, position));
}

/**
 * Finds the inline math span under a cursor position.
 *
 * @param {ParsedPandocDocument} parsed Parsed document.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {InlineMathEntry | undefined}
 */
function findInlineMathAtPosition(parsed, position) {
  return parsed.inlineMath.find((entry) => containsPosition(entry.fullRange, position));
}

/**
 * Checks whether a range includes a position.
 *
 * @param {PlainRange} range Plain range.
 * @param {{line: number, character: number}} position Cursor position.
 * @returns {boolean}
 */
function containsPosition(range, position) {
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

module.exports = {
  LABEL_PREFIXES,
  parsePandocDocument,
  findMathBlockAtPosition,
  findInlineMathAtPosition,
  findTokenAtPosition,
  containsPosition,
};

/**
 * @typedef {{text: string, number: number, startOffset: number, endOffset: number}} ParsedLine
 * @typedef {{start: {line: number, character: number}, end: {line: number, character: number}}} PlainRange
 * @typedef {{label: string, prefix: string, kind: string, source: string, uriText: string, line: number, character: number, range: PlainRange, fullRange: PlainRange, offset: number, endOffset: number, fullOffset: number, fullEndOffset: number, preview: string}} LabelEntry
 * @typedef {{label: string, prefix: string, kind: string, uriText: string, line: number, character: number, range: PlainRange, fullRange: PlainRange, offset: number, endOffset: number, fullOffset: number, fullEndOffset: number, preview: string}} ReferenceEntry
 * @typedef {{title: string, label?: string, level: number, uriText: string, line: number, character: number, range: PlainRange, selectionRange: PlainRange, preview: string}} HeadingEntry
 * @typedef {{label?: string, display: true, uriText: string, line: number, endLine: number, range: PlainRange, selectionRange: PlainRange, tex: string}} MathBlockEntry
 * @typedef {{tex: string, display: false, uriText: string, line: number, character: number, range: PlainRange, fullRange: PlainRange, offset: number, endOffset: number, fullOffset: number, fullEndOffset: number, preview: string}} InlineMathEntry
 * @typedef {{uriText: string, textLength: number, labels: LabelEntry[], references: ReferenceEntry[], headings: HeadingEntry[], mathBlocks: MathBlockEntry[], inlineMath: InlineMathEntry[], labelMap: Map<string, LabelEntry[]>, referenceMap: Map<string, ReferenceEntry[]>}} ParsedPandocDocument
 */
