import { DOMParser, type Node } from "@xmldom/xmldom";
import type { ZoteroPreview } from "./zotero";

const FORMATTING_TAGS = new Set(["div", "span", "p", "i", "em", "b", "strong", "sup", "sub", "br", "small"]);
const BLOCKED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template"]);
const STYLE_PROPERTIES = new Set(["line-height", "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
  "padding-left", "padding-right", "padding-top", "padding-bottom", "text-indent", "text-align", "font-style", "font-weight",
  "font-variant", "font-size", "vertical-align", "float", "clear", "width", "display"]);

/** Escapes plain titles and textual HTML nodes before inserting them into the preview. */
export function escapePreviewText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Retains CSL typography and hanging indents while stripping executable or resource-loading HTML from remote samples. */
export function sanitizePreviewHtml(html: string): string {
  const document = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
  /** Serializes only text and formatting; remote event handlers, links and resources never survive. */
  const serialize = (node: Node): string => {
    if (node.nodeType === 3) return escapePreviewText(node.nodeValue ?? "");
    if (node.nodeType !== 1) return "";
    const element = node as import("@xmldom/xmldom").Element;
    const tag = element.localName.toLowerCase();
    if (BLOCKED_TAGS.has(tag)) return "";
    let children = "";
    for (let index = 0; index < node.childNodes.length; index++) children += serialize(node.childNodes.item(index));
    if (!FORMATTING_TAGS.has(tag)) return children;
    const className = (element.getAttribute("class") ?? "").split(/\s+/).filter((entry) => /^csl-[a-z-]+$/.test(entry)).join(" ");
    const style = (element.getAttribute("style") ?? "").split(";").map((declaration) => {
      const match = /^\s*([a-z-]+)\s*:\s*([a-z0-9 .%+\-]+)\s*$/i.exec(declaration);
      return match && STYLE_PROPERTIES.has(match[1].toLowerCase()) ? `${match[1].toLowerCase()}:${match[2].trim()}` : "";
    }).filter(Boolean).join(";");
    const attributes = `${className ? ` class="${escapePreviewText(className)}"` : ""}${style ? ` style="${escapePreviewText(style)}"` : ""}`;
    return tag === "br" ? "<br>" : `<${tag}${attributes}>${children}</${tag}>`;
  };
  const body = document.getElementsByTagName("body").item(0);
  if (!body) return "";
  let safe = "";
  for (let index = 0; index < body.childNodes.length; index++) safe += serialize(body.childNodes.item(index));
  return safe;
}

/** Renders both Zotero sample sections with their original safe formatting. */
export function renderZoteroPreview(preview: ZoteroPreview): string {
  return `<section><h2>Citations</h2><div class="citations">${preview.citations.map(sanitizePreviewHtml).join(" ")}</div></section>`
    + `<section><h2>Bibliography</h2>${sanitizePreviewHtml(preview.bibliography)}</section>`;
}
