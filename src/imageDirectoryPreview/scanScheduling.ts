/**
 * Fair, bounded scheduling rules for directory image discovery.
 *
 * A folder can have thousands of descendants. These helpers let the scanner
 * skip branches that the user has collapsed while retaining their queued work
 * for a later reopen. The Webview requests subsequent batches only from user
 * scrolling, so discovery stays proportional to browsing rather than growing
 * the gallery DOM in the background.
 */

/**
 * Returns whether a directory belongs to a user-collapsed folder branch.
 *
 * @param relativePath Root-relative path queued by the scanner.
 * @param pausedFolders Root-relative folders currently collapsed in the Webview.
 * @returns True when this directory or one of its ancestors is collapsed.
 */
export function isDirectoryPaused(relativePath: string, pausedFolders: ReadonlySet<string>): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  return [...pausedFolders].some((folder) => folder.length > 0 && (normalizedPath === folder || normalizedPath.startsWith(`${folder}/`)));
}

/** Minimal directory metadata needed to select a pending scan candidate. */
export type PendingDirectoryWork = {
  /** Root-relative directory path queued by the scanner. */
  relativePath: string;
};

/**
 * Selects the next non-paused directory, preferring a branch the user just reopened.
 *
 * @param pendingDirectories Directory work retained by the incremental scanner.
 * @param pausedFolders Root-relative collapsed branches that must remain skipped.
 * @param resumedFolders Root-relative branches explicitly reopened by the user.
 * @returns A pending-work index, or -1 when no currently scannable directory exists.
 */
export function getNextScannableDirectoryWorkIndex(
  pendingDirectories: readonly PendingDirectoryWork[],
  pausedFolders: ReadonlySet<string>,
  resumedFolders: ReadonlySet<string>,
): number {
  const isScannable = (work: PendingDirectoryWork): boolean => !isDirectoryPaused(work.relativePath, pausedFolders);
  const resumedIndex = pendingDirectories.findIndex((work) => isScannable(work) && isDirectoryInAnyFolder(work.relativePath, resumedFolders));
  return resumedIndex >= 0 ? resumedIndex : pendingDirectories.findIndex(isScannable);
}

/** Returns whether a directory is the named folder or a descendant of one of its paths. */
function isDirectoryInAnyFolder(relativePath: string, folders: ReadonlySet<string>): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  return [...folders].some((folder) => folder.length > 0 && (normalizedPath === folder || normalizedPath.startsWith(`${folder}/`)));
}
