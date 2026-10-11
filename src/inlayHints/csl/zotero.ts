import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const CSL_NAMESPACE = "http://purl.org/net/xbiblio/csl";
const STYLE_INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
export type ZoteroStyle = { name: string; title: string; titleShort?: string; format?: string };
type ReadResource = (url: string, signal?: AbortSignal) => Promise<string>;

/** Accepts only repository slugs that can safely name a local CSL file. */
export function isStyleName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value.length < 180
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** Fetches official repository resources with a bounded timeout and optional user cancellation. */
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
function parseCsl(xml: string) {
  const document = new DOMParser({ onError: (level, message) => {
    if (level !== "warning") throw new Error(`CSL XML 无法解析：${message}`);
  } }).parseFromString(xml, "application/xml");
  const root = document.documentElement;
  if (!root || root.localName !== "style" || root.namespaceURI !== CSL_NAMESPACE) throw new Error("Zotero 返回的内容不是有效 CSL 样式");
  const links = root.getElementsByTagNameNS(CSL_NAMESPACE, "link");
  let parent: string | undefined;
  for (let index = 0; index < links.length; index++) {
    const link = links.item(index);
    if (link.getAttribute("rel") !== "independent-parent") continue;
    const url = new URL(link.getAttribute("href"));
    const name = url.pathname.replace(/^\/styles\//, "");
    if (!["www.zotero.org", "zotero.org"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
      || !url.pathname.startsWith("/styles/") || !isStyleName(name)) throw new Error("CSL 母样式链接不属于 Zotero 样式库");
    parent = name;
  }
  if (!parent && !root.getElementsByTagNameNS(CSL_NAMESPACE, "citation").length) throw new Error("CSL 样式缺少引用格式或母样式");
  return { document, root, parent, locale: root.getAttribute("default-locale") || undefined };
}

/** Uses the same index and download endpoints as Zotero's style repository, caching its index per session. */
export class ZoteroStyleRepository {
  private index?: Promise<ZoteroStyle[]>;

  /** Allows isolated network fixtures while production uses official Zotero HTTPS resources. */
  constructor(private readonly read: ReadResource = readZoteroResource) {}

  /** Loads journal names and abbreviations once, retrying naturally after a failed index request. */
  getStyles(): Promise<ZoteroStyle[]> {
    if (!this.index) this.index = this.loadIndex().catch((error) => { this.index = undefined; throw error; });
    return this.index;
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
        format: typeof categories?.format === "string" ? categories.format : undefined });
    }
    if (!styles.length) throw new Error("Zotero 样式索引中没有可用样式");
    return styles;
  }

  /** Resolves dependent journal aliases into a self-contained CSL, retaining their overriding locale for offline builds. */
  async downloadStyle(style: ZoteroStyle, signal?: AbortSignal): Promise<string> {
    let name = style.name;
    let locale: string | undefined;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      signal?.throwIfAborted();
      if (!isStyleName(name) || visited.has(name)) throw new Error("CSL 母样式名称无效或存在循环依赖");
      visited.add(name);
      const xml = await this.read(`https://www.zotero.org/styles/${encodeURIComponent(name)}`, signal);
      signal?.throwIfAborted();
      const parsed = parseCsl(xml);
      locale ??= parsed.locale;
      if (parsed.parent) { name = parsed.parent; continue; }
      if (locale && locale !== parsed.locale) {
        parsed.root.setAttribute("default-locale", locale);
        return new XMLSerializer().serializeToString(parsed.document);
      }
      return xml;
    }
    throw new Error("CSL 母样式依赖层级过深");
  }
}
