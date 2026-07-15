const REVIEWER_REPLY_FILE_NAME = "reply_to_reviewers.md";

/**
 * Checks whether a URI path points to the reviewer-reply Markdown file.
 *
 * The comparison is case-insensitive so the special definition scope behaves
 * consistently on Windows and remote workspaces with different path casing.
 *
 * @param uriPath URI path or filesystem-style path.
 */
export function isReviewerReplyPath(uriPath: string): boolean {
  const normalizedPath = uriPath.replace(/\\/g, "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  return fileName.toLowerCase() === REVIEWER_REPLY_FILE_NAME;
}

/**
 * Adds manuscript definitions to the effective definition scope of a reviewer reply.
 *
 * This is the narrow bug fix for references in `reply_to_reviewers.md`: other
 * Markdown files must remain document-local even when `manuscript.md` is cached.
 *
 * @param documentPath Current document path.
 * @param localDefinitions Definitions parsed from the current document.
 * @param manuscriptDefinitions Definitions parsed from the workspace manuscript.
 */
export function mergeReviewerReplyDefinitions<T>(documentPath: string, localDefinitions: T[], manuscriptDefinitions: T[]): T[] {
  if (!isReviewerReplyPath(documentPath) || manuscriptDefinitions.length === 0) {
    return localDefinitions;
  }
  return [...localDefinitions, ...manuscriptDefinitions];
}

/**
 * Resolves definitions for one label with reviewer-reply fallback semantics.
 *
 * Local definitions take precedence so a quoted local label is not reported as
 * a duplicate merely because the same label also exists in the manuscript.
 *
 * @param documentPath Current document path.
 * @param localDefinitions Matching definitions from the current document.
 * @param manuscriptDefinitions Matching definitions from the workspace manuscript.
 */
export function resolveReviewerReplyDefinitions<T>(documentPath: string, localDefinitions: T[], manuscriptDefinitions: T[]): T[] {
  if (localDefinitions.length > 0 || !isReviewerReplyPath(documentPath)) {
    return localDefinitions;
  }
  return manuscriptDefinitions;
}
