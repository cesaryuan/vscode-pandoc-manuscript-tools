import * as path from "path";

/** Browser-supported image suffixes shown by the directory preview. */
export const DIRECTORY_PREVIEW_IMAGE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp",
]);

/**
 * Checks whether a file name has a suffix the Webview can preview directly.
 *
 * @param fileName File name or URI path.
 */
export function isDirectoryPreviewImageFile(fileName: string): boolean {
  return DIRECTORY_PREVIEW_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}
