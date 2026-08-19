/**
 * Directory-keyword filtering rules for the image directory preview.
 *
 * The scanner always traverses non-excluded parent folders so an allowed
 * keyword can match a nested folder. It omits image entries unless their
 * containing relative folder matches the allow list, when one is configured.
 */

/** Normalized include and exclude keywords received from settings or configuration. */
export type DirectoryPreviewFolderFilters = {
  includedFolderKeywords: readonly string[];
  excludedFolderKeywords: readonly string[];
};

/**
 * Normalizes user-provided folder keywords for case-insensitive substring matching.
 *
 * @param values Candidate settings values from configuration or a Webview message.
 */
export function normalizeFolderKeywords(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const keywords = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const keyword = value.trim().toLocaleLowerCase();
    if (keyword) {
      keywords.add(keyword);
    }
  }
  return [...keywords];
}

/**
 * Returns whether the scanner should enter a directory branch.
 *
 * @param relativeFolder Root-relative folder path.
 * @param filters Current include and exclude settings.
 */
export function shouldTraverseDirectory(relativeFolder: string, filters: DirectoryPreviewFolderFilters): boolean {
  return !matchesFolderKeyword(relativeFolder, filters.excludedFolderKeywords);
}

/**
 * Returns whether images inside a relative directory should appear in the preview.
 *
 * @param relativeFolder Root-relative folder path containing the images.
 * @param filters Current include and exclude settings.
 */
export function shouldIncludeDirectoryImages(relativeFolder: string, filters: DirectoryPreviewFolderFilters): boolean {
  if (!shouldTraverseDirectory(relativeFolder, filters)) {
    return false;
  }
  return filters.includedFolderKeywords.length === 0 || matchesFolderKeyword(relativeFolder, filters.includedFolderKeywords);
}

/** Checks whether a root-relative directory path contains any normalized keyword. */
function matchesFolderKeyword(relativeFolder: string, keywords: readonly string[]): boolean {
  const normalizedPath = relativeFolder.replace(/\\/g, "/").toLocaleLowerCase();
  return keywords.some((keyword) => normalizedPath.includes(keyword));
}
