/**
 * Normalizes a path copied from the directory preview.
 *
 * This helper intentionally rejects absolute paths and parent traversal. The
 * extension still performs URI-root validation before calling it, but keeping
 * this boundary explicit prevents an unsafe clipboard value if path handling
 * changes later.
 */

/**
 * Converts a candidate path to a safe slash-separated root-relative path.
 *
 * @param candidatePath Candidate path produced from a root/candidate URI pair.
 */
export function normalizePreviewRelativePath(candidatePath: string): string | undefined {
  const normalized = candidatePath.replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return undefined;
  }
  return normalized;
}
