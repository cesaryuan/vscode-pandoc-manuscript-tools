/**
 * Scan-depth rules for the directory image preview.
 *
 * The selected directory is depth zero. A finite setting limits the deepest
 * subdirectory the scanner can enter, while -1 preserves unlimited recursion.
 */

/** Sentinel used by configuration and the Webview for unrestricted recursion. */
export const UNLIMITED_DIRECTORY_PREVIEW_SCAN_DEPTH = -1;

/**
 * Normalizes an untrusted scan-depth setting to the supported integer range.
 *
 * @param value Candidate value received from VS Code configuration or the Webview.
 */
export function normalizeDirectoryPreviewScanDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < UNLIMITED_DIRECTORY_PREVIEW_SCAN_DEPTH) {
    return UNLIMITED_DIRECTORY_PREVIEW_SCAN_DEPTH;
  }
  return value;
}

/**
 * Returns whether the scanner may enter a root-relative directory at the configured depth.
 *
 * @param relativeDirectory Root-relative directory path to evaluate.
 * @param scanDepth Maximum subfolder depth, or -1 for unrestricted recursion.
 */
export function shouldScanDirectoryAtDepth(relativeDirectory: string, scanDepth: number): boolean {
  const normalizedScanDepth = normalizeDirectoryPreviewScanDepth(scanDepth);
  if (normalizedScanDepth === UNLIMITED_DIRECTORY_PREVIEW_SCAN_DEPTH) {
    return true;
  }
  const directoryDepth = relativeDirectory.replace(/\\/g, "/").split("/").filter(Boolean).length;
  return directoryDepth <= normalizedScanDepth;
}
