import * as path from "path";

export type PreviewCanvasAppearance = "checkerboard" | "metafile";

/**
 * Selects the canvas behind a preview according to its source format.
 *
 * Converted EMF/WMF drawings often keep a transparent background and use black
 * strokes or text. The metafile marker lets the Webview add a soft gray
 * checkerboard only in VS Code's dark theme, while light themes retain their
 * existing preview appearance.
 *
 * @param imagePath Source image path.
 */
export function getPreviewCanvasAppearance(imagePath: string): PreviewCanvasAppearance {
  const extension = path.extname(imagePath).toLowerCase();
  return extension === ".emf" || extension === ".wmf" ? "metafile" : "checkerboard";
}
