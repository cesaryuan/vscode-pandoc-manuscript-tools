import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Resolves a local image target against the current document.
 *
 * Remote URLs are intentionally rejected because hover previews should not make
 * network requests for manuscript-local asset hovers.
 *
 * @param document Document containing the image reference.
 * @param target Image target from Markdown, HTML, or SVG.
 * @param baseDirectory Optional base directory for nested SVG images.
 */
export function resolveLocalPath(document: { uri: import("vscode").Uri }, target: string, baseDirectory: string | undefined = undefined): string | undefined {
  if (!target || isDataUri(target) || isRemoteUrl(target)) {
    return undefined;
  }

  const withoutSuffix = stripQueryAndHash(target);
  const fileUriPath = tryParseFileUri(withoutSuffix);
  if (fileUriPath) {
    return fileUriPath;
  }

  if (path.isAbsolute(withoutSuffix)) {
    return withoutSuffix;
  }

  if (document.uri.scheme !== "file") {
    return undefined;
  }

  const root = baseDirectory || path.dirname(document.uri.fsPath);
  return path.resolve(root, normalizeRelativeSeparators(withoutSuffix));
}

/**
 * Checks whether a value is already an embedded data URI.
 *
 * @param value URI or path.
 */
export function isDataUri(value: string): boolean {
  return /^data:/i.test(value);
}

/**
 * Checks whether a value is a remote URL.
 *
 * @param value URI or path.
 */
export function isRemoteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value);
}

/**
 * Parses a file URI into a platform path.
 *
 * @param value URI or path.
 */
function tryParseFileUri(value: string) {
  if (!/^file:\/\//i.test(value)) {
    return undefined;
  }
  try {
    return fileURLToPath(value);
  } catch (_error) {
    return undefined;
  }
}

/**
 * Removes URL query and hash suffixes from a local path.
 *
 * @param value URI or path.
 */
function stripQueryAndHash(value: string) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? value : value.slice(0, suffixIndex);
}

/**
 * Normalizes slash-separated Markdown paths for the host platform.
 *
 * @param value Relative path.
 */
function normalizeRelativeSeparators(value: string) {
  return value.replace(/[\\/]+/g, path.sep);
}

