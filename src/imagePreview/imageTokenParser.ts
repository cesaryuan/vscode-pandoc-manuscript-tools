import * as path from "path";
import * as vscode from "vscode";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);

/**
 * Finds a supported Markdown or HTML image token under the hover position.
 *
 * This parser is intentionally line-local because image preview hovers should
 * stay cheap and should not compete with the full Pandoc label parser.
 *
 * @param {vscode.TextDocument} document Text document.
 * @param {vscode.Position} position Hover position.
 * @returns {ImageToken | undefined}
 */
export function findImageTokenAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const markdownToken = findMarkdownImageToken(line, position);
  if (markdownToken) {
    return markdownToken;
  }
  return findHtmlImageToken(line, position);
}

/**
 * Finds a supported Markdown image token on one line.
 *
 * @param {string} line Source line.
 * @param {vscode.Position} position Hover position.
 * @returns {ImageToken | undefined}
 */
function findMarkdownImageToken(line, position) {
  const imagePattern = /!\[[^\]\n]*(?:\\.[^\]\n]*)*\]\(([^)\n]+)\)/g;
  for (const match of line.matchAll(imagePattern)) {
    const start = match.index || 0;
    const end = start + match[0].length;
    if (!isCharacterInside(position.character, start, end)) {
      continue;
    }

    const rawTarget = extractMarkdownImageDestination(match[1]);
    const token = createImageToken(rawTarget, position.line, start, end);
    if (token) {
      return token;
    }
  }
  return undefined;
}

/**
 * Extracts the path portion from a Markdown image destination.
 *
 * The special handling for `<...>` exists because Pandoc/Markdown commonly use
 * angle brackets when paths contain spaces.
 *
 * @param {string} rawDestination Raw text inside image parentheses.
 * @returns {string}
 */
function extractMarkdownImageDestination(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith("<")) {
    const closingIndex = trimmed.indexOf(">");
    if (closingIndex !== -1) {
      return trimmed.slice(1, closingIndex);
    }
  }

  const quotedMatch = trimmed.match(/^(['"])(.*?)\1/);
  if (quotedMatch) {
    return quotedMatch[2];
  }

  const whitespaceIndex = trimmed.search(/\s/);
  return whitespaceIndex === -1 ? trimmed : trimmed.slice(0, whitespaceIndex);
}

/**
 * Finds a supported HTML `<img src="...">` token on one line.
 *
 * @param {string} line Source line.
 * @param {vscode.Position} position Hover position.
 * @returns {ImageToken | undefined}
 */
function findHtmlImageToken(line, position) {
  const imagePattern = /<img\b[^>]*>/gi;
  for (const match of line.matchAll(imagePattern)) {
    const start = match.index || 0;
    const end = start + match[0].length;
    if (!isCharacterInside(position.character, start, end)) {
      continue;
    }

    const source = getHtmlAttribute(match[0], "src");
    const token = createImageToken(source, position.line, start, end);
    if (token) {
      return token;
    }
  }
  return undefined;
}

/**
 * Reads one quoted or unquoted HTML attribute from a tag.
 *
 * @param {string} tag Source HTML tag.
 * @param {string} attribute Attribute name.
 * @returns {string | undefined}
 */
function getHtmlAttribute(tag, attribute) {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return match ? (match[1] || match[2] || match[3]) : undefined;
}

/**
 * Creates a normalized image token when the target extension is supported.
 *
 * @param {string | undefined} rawTarget Raw image target.
 * @param {number} line Line number.
 * @param {number} start Start character.
 * @param {number} end End character.
 * @returns {ImageToken | undefined}
 */
function createImageToken(rawTarget, line, start, end) {
  if (!rawTarget) {
    return undefined;
  }

  const target = decodeMarkdownUrl(rawTarget.trim());
  const extension = path.extname(stripQueryAndHash(target)).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return undefined;
  }

  return {
    target,
    extension,
    range: new vscode.Range(line, start, line, end),
  };
}

/**
 * Decodes a Markdown URL while tolerating literal Windows paths.
 *
 * @param {string} value URL or path from Markdown/HTML.
 * @returns {string}
 */
function decodeMarkdownUrl(value) {
  try {
    return decodeURI(value);
  } catch (_error) {
    return value;
  }
}

/**
 * Removes URL query and hash suffixes before extension detection.
 *
 * @param {string} value URL or path.
 * @returns {string}
 */
function stripQueryAndHash(value) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? value : value.slice(0, suffixIndex);
}

/**
 * Checks whether a character offset is inside a half-open token range.
 *
 * @param {number} character Character offset.
 * @param {number} start Inclusive start.
 * @param {number} end Exclusive end.
 * @returns {boolean}
 */
function isCharacterInside(character, start, end) {
  return character >= start && character <= end;
}


/**
 * @typedef {{target: string, extension: string, range: vscode.Range}} ImageToken
 */
