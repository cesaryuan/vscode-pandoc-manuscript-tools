import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { CHINESE_STYLES_ORIGIN, isCommunityPathSegment, loadCommunityStyles, parseCommunityPreview } from "./chinese";

const CSL_NAMESPACE = "http://purl.org/net/xbiblio/csl";
const STYLE_INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
export type ZoteroStyle = { name: string; title: string; titleShort?: string; format?: string; dependent?: boolean;
  source?: "chinese"; searchText?: string; community?: { directory: string; file: string; previewKey: string } };
export type ZoteroPreview = { citations: string[]; bibliography: string };
type ReadResource = (url: string, signal?: AbortSignal) => Promise<string>;

/** Accepts only repository slugs that can safely name a local CSL file. */
export function isStyleName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value.length < 180
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** Fetches either repository's resources with a bounded timeout and optional user cancellation. */
async function readZoteroResource(url: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  /** Relays progress cancellation to the current network request. */
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 30000);
  try {
    signal?.throwIfAborted();
    // Zotero's download endpoint rejects combined JSON/XML Accept values with HTTP 406.
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Zotero 请求失败：HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Parses CSL before any disk write and discovers dependent styles that need their parent formatting rules. */
function parseCsl(xml: string, community = false) {
  const document = new DOMParser({ onError: (level, message) => {
    if (level !== "warning") throw new Error(`CSL XML 无法解析：${message}`);
  } }).parseFromString(xml, "application/xml");
  const root = document.documentElement;
  if (!root || root.localName !== "style" || root.namespaceURI !== CSL_NAMESPACE) throw new Error("Zotero 返回的内容不是有效 CSL 样式");
  const links = root.getElementsByTagNameNS(CSL_NAMESPACE, "link");
  let parent: string | undefined;
  let communityParent: string | undefined;
  for (let index = 0; index < links.length; index++) {
    const link = links.item(index);
    if (link.getAttribute("rel") !== "independent-parent") continue;
    const url = new URL(link.getAttribute("href"));
    if (community && url.origin === CHINESE_STYLES_ORIGIN && url.pathname.startsWith("/styles/")) {
      const directory = decodeURIComponent(url.pathname.slice("/styles/".length));
      if (!isCommunityPathSegment(directory)) throw new Error("中文社区 CSL 母样式路径无效");
      communityParent = directory; continue;
    }
    const name = url.pathname.replace(/^\/styles\//, "");
    if (!["www.zotero.org", "zotero.org"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
      || !url.pathname.startsWith("/styles/") || !isStyleName(name)) throw new Error("CSL 母样式链接不属于 Zotero 样式库");
    parent = name;
  }
  if (!parent && !communityParent && !root.getElementsByTagNameNS(CSL_NAMESPACE, "citation").length) throw new Error("CSL 样式缺少引用格式或母样式");
  return { document, root, parent, communityParent, locale: root.getAttribute("default-locale") || undefined };
}

/** Shares official and Chinese community search indexes while keeping each library's downloads and previews distinct. */
export class ZoteroStyleRepository {
  private index?: Promise<ZoteroStyle[]>;
  private communityIndex?: Promise<ZoteroStyle[]>;
  private combinedIndex?: ZoteroStyle[];
  readonly indexWarnings: string[] = [];
  private readonly previews = new Map<string, ZoteroPreview>();

  /** Allows isolated fixtures while production reads each library's published HTTPS resources. */
  constructor(private readonly read: ReadResource = readZoteroResource) {}

  /** Merges independently cached indexes and retries failed sources without discarding the available library. */
  async getStyles(): Promise<ZoteroStyle[]> {
    if (this.combinedIndex) return this.combinedIndex;
    if (!this.index) this.index = this.loadIndex().catch((error) => { this.index = undefined; throw error; });
    if (!this.communityIndex) this.communityIndex = loadCommunityStyles(this.read).catch((error) => { this.communityIndex = undefined; throw error; });
    const results = await Promise.allSettled([this.index, this.communityIndex]);
    this.indexWarnings.length = 0;
    const styles: ZoteroStyle[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") styles.push(...result.value);
      else this.indexWarnings.push(`${index === 0 ? "Zotero 官方" : "Zotero 中文社区"}样式库加载失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
    if (!styles.length) throw new Error(this.indexWarnings.join("；"));
    if (!this.indexWarnings.length) this.combinedIndex = styles;
    return styles;
  }

  /** Validates the repository index without trusting remote names as arbitrary filesystem paths. */
  private async loadIndex(): Promise<ZoteroStyle[]> {
    const data: unknown = JSON.parse(await this.read(STYLE_INDEX_URL));
    if (!Array.isArray(data)) throw new Error("Zotero 样式索引格式不正确");
    const styles: ZoteroStyle[] = [];
    for (const value of data) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (!isStyleName(entry.name) || typeof entry.title !== "string") continue;
      const categories = entry.categories as Record<string, unknown> | undefined;
      styles.push({ name: entry.name, title: entry.title,
        titleShort: typeof entry.titleShort === "string" ? entry.titleShort : undefined,
        format: typeof categories?.format === "string" ? categories.format : undefined,
        dependent: entry.dependent === 1 || entry.dependent === true });
    }
    if (!styles.length) throw new Error("Zotero 样式索引中没有可用样式");
    return styles;
  }

  /** Loads Zotero's actual sample citations and bibliography, caching successful previews with bounded memory. */
  async getPreview(style: ZoteroStyle, signal?: AbortSignal): Promise<ZoteroPreview> {
    if (!isStyleName(style.name)) throw new Error("无效的 CSL 预览名称");
    signal?.throwIfAborted();
    const key = `${style.source === "chinese" ? "chinese/" : ""}${style.dependent ? "dependent/" : ""}${style.name}`;
    const cached = this.previews.get(key);
    if (cached) { this.previews.delete(key); this.previews.set(key, cached); return cached; }
    if (style.source === "chinese") {
      if (!/^[a-f0-9]{1,16}$/.test(style.community?.previewKey ?? "")) throw new Error("无效的中文社区预览名称");
      const preview = parseCommunityPreview(await this.read(`${CHINESE_STYLES_ORIGIN}/styles-data/${style.community.previewKey}.json`, signal));
      signal?.throwIfAborted(); this.cachePreview(key, preview); return preview;
    }
    const data: unknown = JSON.parse(await this.read(`https://www.zotero.org/styles-files/previews/combined/${key}.json`, signal));
    signal?.throwIfAborted();
    const record = data as Record<string, unknown>;
    if (!record || !Array.isArray(record.citation) || !record.citation.every((entry) => typeof entry === "string")
      || typeof record.bibliography !== "string") throw new Error("Zotero 样式预览格式不正确");
    const preview = { citations: record.citation as string[], bibliography: record.bibliography };
    this.cachePreview(key, preview);
    return preview;
  }

  /** Bounds successful previews from both libraries without caching failed or cancelled requests. */
  private cachePreview(key: string, preview: ZoteroPreview): void {
    this.previews.set(key, preview);
    if (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value);
  }

  /** Resolves dependent journal aliases into a self-contained CSL, retaining their overriding locale for offline builds. */
  async downloadStyle(style: ZoteroStyle, signal?: AbortSignal): Promise<string> {
    let current = style;
    let locale: string | undefined;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      signal?.throwIfAborted();
      const identity = `${current.source ?? "official"}/${current.name}`;
      if (!isStyleName(current.name) || visited.has(identity)) throw new Error("CSL 母样式名称无效或存在循环依赖");
      visited.add(identity);
      let url = `https://www.zotero.org/styles/${encodeURIComponent(current.name)}`;
      if (current.source === "chinese") {
        if (!isCommunityPathSegment(current.community?.directory) || !isCommunityPathSegment(current.community?.file)
          || !current.community.file.endsWith(".csl")) throw new Error("无效的中文社区 CSL 路径");
        url = `${CHINESE_STYLES_ORIGIN}/styles/${encodeURIComponent(current.community.directory)}/${encodeURIComponent(current.community.file)}`;
      }
      const xml = await this.read(url, signal);
      signal?.throwIfAborted();
      const parsed = parseCsl(xml, current.source === "chinese");
      locale ??= parsed.locale;
      if (parsed.communityParent) {
        current = (await this.getStyles()).find(candidate => candidate.source === "chinese" && candidate.community?.directory === parsed.communityParent);
        if (!current) throw new Error("未找到中文社区 CSL 母样式");
        continue;
      }
      if (parsed.parent) { current = { name: parsed.parent, title: parsed.parent }; continue; }
      if (locale && locale !== parsed.locale) {
        parsed.root.setAttribute("default-locale", locale);
        return new XMLSerializer().serializeToString(parsed.document);
      }
      return xml;
    }
    throw new Error("CSL 母样式依赖层级过深");
  }
}
