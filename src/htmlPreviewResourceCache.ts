import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  convertEmfToSvg,
  convertWmfToSvg,
  WEBVIEW_METAFILE_MAX_HEIGHT,
  WEBVIEW_METAFILE_MAX_WIDTH,
} from "./imagePreview/libemf2svgRuntime";

type OutputChannelLike = { appendLine(message: string): void };
type CacheUriFactory = (filePath: string) => string;
type HtmlMetafileRewriteResult = { html: string; converted: number; reused: number; unavailable: number };
type CachedSvg = { filePath: string; reused: boolean };

const CACHE_FORMAT_VERSION = "html-metafile-svg-v1";

/**
 * Converts HTML image references to cached SVGs only for EMF and WMF resources.
 * Other local image formats keep their original paths for normal Webview URI rewriting.
 *
 * @param html Papper-generated HTML.
 * @param sourceDirectory Directory containing the Markdown source.
 * @param allowedRoot Papper project root allowed for resource reads.
 * @param cacheDirectory Papper project's hidden cache directory for converted SVGs.
 * @param toWebviewUri Converts a cached SVG path to a Webview-safe URI.
 * @param output Extension output channel.
 */
export async function cacheHtmlMetafileImages(
  html: string,
  sourceDirectory: string,
  allowedRoot: string,
  cacheDirectory: string,
  toWebviewUri: CacheUriFactory,
  output: OutputChannelLike,
): Promise<HtmlMetafileRewriteResult> {
  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)];
  let rewrittenHtml = html;
  let converted = 0;
  let reused = 0;
  let unavailable = 0;

  for (const imageMatch of imageTags.reverse()) {
    const tag = imageMatch[0];
    const sourceAttribute = /(\bsrc\s*=\s*)(["'])(.*?)\2/i.exec(tag);
    const resourceValue = sourceAttribute?.[3];
    if (sourceAttribute?.index === undefined || !resourceValue || isExternalResource(resourceValue)) {
      continue;
    }

    const sourcePath = resolveLocalResourcePath(sourceDirectory, resourceValue);
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension !== ".emf" && extension !== ".wmf") {
      continue;
    }
    if (!isPathInsideDirectory(allowedRoot, sourcePath)) {
      unavailable += 1;
      output.appendLine(`[HTML] Skipping metafile outside the Papper project: ${sourcePath}`);
      continue;
    }

    try {
      const cachedSvg = await getOrCreateCachedMetafileSvg(sourcePath, extension, cacheDirectory, output);
      if (!cachedSvg) {
        unavailable += 1;
        continue;
      }

      const originalSuffix = getResourceSuffix(resourceValue);
      const webviewUri = `${toWebviewUri(cachedSvg.filePath)}${originalSuffix}`;
      const rewrittenTag = replaceSourceAttribute(tag, sourceAttribute, webviewUri);
      rewrittenHtml = `${rewrittenHtml.slice(0, imageMatch.index)}${rewrittenTag}${rewrittenHtml.slice(imageMatch.index + tag.length)}`;
      if (cachedSvg.reused) {
        reused += 1;
      } else {
        converted += 1;
      }
    } catch (error) {
      unavailable += 1;
      output.appendLine(`[HTML] Could not cache metafile image ${sourcePath}: ${String(error)}`);
    }
  }

  if (converted || reused || unavailable) {
    output.appendLine(`[HTML] Metafile SVG cache: ${converted} converted, ${reused} reused, ${unavailable} unavailable`);
  }
  return { html: rewrittenHtml, converted, reused, unavailable };
}

/**
 * Returns a cached SVG path or converts and atomically writes a fresh one.
 * The cache key includes source stats and conversion dimensions to prevent stale previews.
 *
 * @param sourcePath Local EMF or WMF source path.
 * @param extension Lowercase metafile extension.
 * @param cacheDirectory Extension cache directory.
 * @param output Extension output channel.
 */
async function getOrCreateCachedMetafileSvg(
  sourcePath: string,
  extension: string,
  cacheDirectory: string,
  output: OutputChannelLike,
): Promise<CachedSvg | undefined> {
  const sourceStat = await fs.stat(sourcePath);
  const cacheKey = crypto.createHash("sha256")
    .update([
      CACHE_FORMAT_VERSION,
      path.resolve(sourcePath),
      extension,
      sourceStat.size,
      sourceStat.mtimeMs,
      WEBVIEW_METAFILE_MAX_WIDTH,
      WEBVIEW_METAFILE_MAX_HEIGHT,
    ].join("\0"))
    .digest("hex");
  const cachedPath = path.join(cacheDirectory, `${cacheKey}.svg`);

  if (await isFile(cachedPath)) {
    return { filePath: cachedPath, reused: true };
  }

  const sourceBytes = await fs.readFile(sourcePath);
  const svg = extension === ".emf"
    ? await convertEmfToSvg(sourceBytes, output, { maxWidth: WEBVIEW_METAFILE_MAX_WIDTH, maxHeight: WEBVIEW_METAFILE_MAX_HEIGHT })
    : await convertWmfToSvg(sourceBytes, output, { maxWidth: WEBVIEW_METAFILE_MAX_WIDTH, maxHeight: WEBVIEW_METAFILE_MAX_HEIGHT });
  if (!svg) {
    return undefined;
  }

  await writeFileAtomically(cachedPath, cacheDirectory, svg);
  return { filePath: cachedPath, reused: false };
}

/**
 * Writes an SVG through a temporary sibling so an interrupted conversion cannot poison the cache.
 *
 * @param targetPath Final cache path.
 * @param cacheDirectory Cache directory for the temporary sibling.
 * @param content SVG text to store.
 */
async function writeFileAtomically(targetPath: string, cacheDirectory: string, content: string) {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const temporaryPath = path.join(cacheDirectory, `${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await removeCacheTemporaryFile(temporaryPath);
    if (await isFile(targetPath)) {
      return;
    }
    throw error;
  }
}

/**
 * Removes a temporary cache file after a failed atomic rename.
 *
 * @param filePath Temporary path.
 */
async function removeCacheTemporaryFile(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

/**
 * Checks whether a path currently points to a regular file.
 *
 * @param filePath Path to inspect.
 */
async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a relative HTML resource against the Markdown directory after removing URL suffixes.
 *
 * @param sourceDirectory Directory containing the Markdown source.
 * @param value HTML resource attribute value.
 */
function resolveLocalResourcePath(sourceDirectory: string, value: string) {
  const decodedValue = value.replace(/&amp;/gi, "&");
  const suffixIndex = decodedValue.search(/[?#]/);
  let localPath = suffixIndex < 0 ? decodedValue : decodedValue.slice(0, suffixIndex);
  try {
    localPath = decodeURIComponent(localPath);
  } catch {
    // Keep malformed percent-encoding literal so the normal resource rewrite can report it.
  }
  return path.resolve(sourceDirectory, localPath.replace(/[\\/]/g, path.sep));
}

/**
 * Returns whether a resource path stays inside the Papper project root.
 *
 * @param rootDirectory Allowed Papper project root.
 * @param filePath Resolved resource path.
 */
function isPathInsideDirectory(rootDirectory: string, filePath: string) {
  const relativePath = path.relative(path.resolve(rootDirectory), path.resolve(filePath));
  return relativePath === "" || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
}

/**
 * Replaces one img source attribute while preserving its quote style and other attributes.
 *
 * @param tag Original img element text.
 * @param sourceAttribute Matched source attribute.
 * @param value Replacement source URI.
 */
function replaceSourceAttribute(tag: string, sourceAttribute: RegExpExecArray, value: string) {
  const start = sourceAttribute.index;
  const end = start + sourceAttribute[0].length;
  const replacement = `${sourceAttribute[1]}${sourceAttribute[2]}${value}${sourceAttribute[2]}`;
  return `${tag.slice(0, start)}${replacement}${tag.slice(end)}`;
}

/**
 * Returns a resource's query and fragment suffix for its replacement URI.
 *
 * @param value Original resource attribute value.
 */
function getResourceSuffix(value: string) {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex < 0 ? "" : value.slice(suffixIndex);
}

/**
 * Checks whether a resource attribute already uses a URI scheme, anchor, or protocol-relative URL.
 *
 * @param value Resource attribute value.
 */
function isExternalResource(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value);
}

/**
 * Returns whether a filesystem error means a cache file is already missing.
 *
 * @param error Error-like value.
 */
function isFileNotFoundError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code) === "ENOENT");
}
