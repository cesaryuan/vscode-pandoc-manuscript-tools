/**
 * Image-ratio helpers shared by the directory-preview card renderer.
 *
 * Grid and Folder cards use the natural image ratio after a bitmap loads,
 * while the fallback ratio keeps unloaded cards from collapsing before then.
 */

export const DEFAULT_IMAGE_ASPECT_RATIO = 4 / 3;

/** Returns a safe width-to-height ratio for a decoded image. */
export function getImageAspectRatio(naturalWidth: number, naturalHeight: number): number {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
    return DEFAULT_IMAGE_ASPECT_RATIO;
  }
  return naturalWidth / naturalHeight;
}

/** Returns the natural image height for a rendered width and aspect ratio. */
export function getNaturalImageHeight(renderedWidth: number, aspectRatio: number): number {
  const safeWidth = Number.isFinite(renderedWidth) ? Math.max(0, renderedWidth) : 0;
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_IMAGE_ASPECT_RATIO;
  return safeWidth / safeRatio;
}
