import * as path from "path";
import * as vscode from "vscode";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".svg", ".emf", ".wmf"]);

/**
 * Finds a supported Markdown or HTML image token under the hover position.
 *
 * This parser is intentionally line-local because image preview hovers should
 * stay cheap and should not compete with the full Pandoc label parser.
 *
 * @param document Text document.
 * @param position Hover position.
 */
export function findImageTokenAtPosition(document: vscode.TextDocument, position: vscode.Position) {
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
 * @param line Source line.
 * @param position Hover position.
 */
function findMarkdownImageToken(line: string, position: vscode.Position) {
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
 * @param rawDestination Raw text inside image parentheses.
 */
function extractMarkdownImageDestination(rawDestination: string) {
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
 * @param line Source line.
 * @param position Hover position.
 */
function findHtmlImageToken(line: string, position: vscode.Position) {
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
 * @param tag Source HTML tag.
 * @param attribute Attribute name.
 */
function getHtmlAttribute(tag: string, attribute: string) {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return match ? (match[1] || match[2] || match[3]) : undefined;
}

/**
 * Creates a normalized image token when the target extension is supported.
 *
 * @param rawTarget Raw image target.
 * @param line Line number.
 * @param start Start character.
 * @param end End character.
 */
function createImageToken(rawTarget: string | undefined, line: number, start: number, end: number) {
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
 * @param value URL or path from Markdown/HTML.
 */
function decodeMarkdownUrl(value: string) {
  try {
    return decodeURI(value);
  } catch (_error) {
    return value;
  }
}

/**
 * Removes URL query and hash suffixes before extension detection.
 *
 * @param value URL or path.
 */
function stripQueryAndHash(value: string) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? value : value.slice(0, suffixIndex);
}

/**
 * Checks whether a character offset is inside a half-open token range.
 *
 * @param character Character offset.
 * @param start Inclusive start.
 * @param end Exclusive end.
 */
function isCharacterInside(character: number, start: number, end: number) {
  return character >= start && character <= end;
}


