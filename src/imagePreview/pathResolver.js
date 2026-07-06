"use strict";

const path = require("path");
const { fileURLToPath } = require("url");

/**
 * Resolves a local image target against the current document.
 *
 * Remote URLs are intentionally rejected because hover previews should not make
 * network requests for manuscript-local asset hovers.
 *
 * @param {vscode.TextDocument} document Document containing the image reference.
 * @param {string} target Image target from Markdown, HTML, or SVG.
 * @param {string=} baseDirectory Optional base directory for nested SVG images.
 * @returns {string | undefined}
 */
function resolveLocalPath(document, target, baseDirectory) {
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
 * @param {string} value URI or path.
 * @returns {boolean}
 */
function isDataUri(value) {
  return /^data:/i.test(value);
}

/**
 * Checks whether a value is a remote URL.
 *
 * @param {string} value URI or path.
 * @returns {boolean}
 */
function isRemoteUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value);
}

/**
 * Parses a file URI into a platform path.
 *
 * @param {string} value URI or path.
 * @returns {string | undefined}
 */
function tryParseFileUri(value) {
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
 * @param {string} value URI or path.
 * @returns {string}
 */
function stripQueryAndHash(value) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1 ? value : value.slice(0, suffixIndex);
}

/**
 * Normalizes slash-separated Markdown paths for the host platform.
 *
 * @param {string} value Relative path.
 * @returns {string}
 */
function normalizeRelativeSeparators(value) {
  return value.replace(/[\\/]+/g, path.sep);
}

module.exports = {
  resolveLocalPath,
  isDataUri,
  isRemoteUrl,
};
