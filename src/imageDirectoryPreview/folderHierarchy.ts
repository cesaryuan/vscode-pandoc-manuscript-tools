/**
 * Folder-tree descriptors for the directory image-preview Webview.
 *
 * Image scan batches contain only the folder holding each image. This module
 * derives all of that folder's ancestors so the Webview can create a stable
 * nested group for each parent and let every level collapse independently.
 */

/** Label displayed for images that are directly inside the selected directory. */
export const TOP_LEVEL_FOLDER_LABEL = "Top level";

/** One visible node in the root-relative directory hierarchy. */
export type FolderHierarchyNode = {
  /** Slash-separated root-relative identifier used for DOM and collapse state. */
  path: string;
  /** Parent node identifier, or undefined when this node belongs at the gallery root. */
  parentPath: string | undefined;
  /** Single folder-name segment displayed in the node's toggle. */
  name: string;
  /** Zero-based level below the selected preview directory. */
  depth: number;
};

/**
 * Expands one image folder into all of its visible ancestor nodes.
 *
 * @param folder Root-relative directory that contains an image.
 * @returns Ordered nodes from the gallery root to the image's folder.
 */
export function getFolderHierarchy(folder: string): FolderHierarchyNode[] {
  const segments = folder.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (!segments.length) {
    return [{ path: "", parentPath: undefined, name: TOP_LEVEL_FOLDER_LABEL, depth: 0 }];
  }

  return segments.map((name, depth) => {
    const path = segments.slice(0, depth + 1).join("/");
    return {
      path,
      parentPath: depth ? segments.slice(0, depth).join("/") : undefined,
      name,
      depth,
    };
  });
}
