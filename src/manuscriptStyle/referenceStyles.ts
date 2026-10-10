import { unzipSync, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";

export type DocxStyleValues = Record<string, string | number | boolean | Record<string, string | number>>;
export type ReferenceStyle = { id: string; name: string; values: DocxStyleValues; notes: Record<string, string> };
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
type XmlElement = ReturnType<DOMParser["parseFromString"]>["documentElement"];

/** Reads direct XML children by namespace, independent of the document's prefix spelling. */
function child(parent: XmlElement | undefined, name: string, namespace = WORD_NS): XmlElement | undefined {
  if (!parent) return undefined;
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const item = parent.childNodes.item(index);
    if (item?.nodeType === 1 && item.namespaceURI === namespace && item.localName === name) return item as XmlElement;
  }
  return undefined;
}

/** Reads a WordprocessingML attribute, including an empty value when explicitly present. */
function attribute(element: XmlElement | undefined, name: string): string | undefined {
  return element?.hasAttributeNS(WORD_NS, name) ? element.getAttributeNS(WORD_NS, name) : undefined;
}

/** Formats OpenXML integer units without exposing floating-point conversion noise. */
function units(value: string, divisor: number, suffix = "pt"): string {
  return `${Number((Number(value) / divisor).toFixed(4))}${suffix}`;
}

/** Expands theme font names when the reference stores theme bindings instead of concrete fonts. */
function themeFont(theme: XmlElement | undefined, binding: string, eastAsianLanguage: string): string | undefined {
  const scheme = theme?.getElementsByTagNameNS(DRAWING_NS, "fontScheme").item(0);
  const family = child(scheme, binding.startsWith("major") ? "majorFont" : "minorFont", DRAWING_NS);
  const eastAsian = /EastAsia$/i.test(binding);
  const face = child(family, eastAsian ? "ea" : "latin", DRAWING_NS)?.getAttribute("typeface");
  if (face) return face;
  // East Asian theme faces are often empty; Word selects a script-specific font by language.
  const script = /^zh-(?:cn|sg|hans)/i.test(eastAsianLanguage) ? "Hans"
    : /^zh/i.test(eastAsianLanguage) ? "Hant" : /^ja/i.test(eastAsianLanguage) ? "Jpan" : /^ko/i.test(eastAsianLanguage) ? "Hang" : undefined;
  if (!family || !script) return undefined;
  const fonts = family.getElementsByTagNameNS(DRAWING_NS, "font");
  for (let index = 0; index < fonts.length; index += 1) {
    const font = fonts.item(index);
    if (font.getAttribute("script") === script) return font.getAttribute("typeface") || undefined;
  }
  return undefined;
}

/** Extracts inherited formatting and reports Word settings Papper cannot express faithfully. */
function readValues(properties: Map<string, XmlElement>, theme: XmlElement | undefined, themeLanguage: string): Pick<ReferenceStyle, "values" | "notes"> {
  const values: DocxStyleValues = {};
  const notes: Record<string, string> = {};
  const fonts = properties.get("rFonts");
  const language = attribute(properties.get("lang"), "eastAsia") || themeLanguage;
  const fontFamily: Record<string, string> = {};
  for (const [key, direct, binding] of [["western", "ascii", "asciiTheme"], ["chinese", "eastAsia", "eastAsiaTheme"]]) {
    const themeBinding = attribute(fonts, binding);
    const font = themeBinding ? themeFont(theme, themeBinding, language) : attribute(fonts, direct);
    if (font) fontFamily[key] = font;
    else if (themeBinding) notes[`fontFamily.${key}`] = `主题 ${themeBinding}（未指定可解析的字体）`;
  }
  if (Object.keys(fontFamily).length) values.fontFamily = fontFamily;
  const size = attribute(properties.get("sz"), "val");
  if (size !== undefined) values.fontSize = units(size, 2);
  const bold = properties.get("b");
  values.bold = Boolean(bold && !/^(?:0|false|off)$/i.test(attribute(bold, "val") ?? "true"));
  const color = attribute(properties.get("color"), "val");
  if (color && /^[\da-f]{6}$/i.test(color)) values.fontColor = `#${color.toUpperCase()}`;
  else notes.fontColor = color === "auto" ? "auto（Word 自动颜色）" : "未指定（Word 自动颜色）";
  const colorTheme = attribute(properties.get("color"), "themeColor");
  if (colorTheme) {
    // Theme/tint/shade must not be frozen to the fallback RGB stored alongside the theme binding.
    delete values.fontColor;
    notes.fontColor = `主题 ${colorTheme}（保留主题颜色）`;
  }
  const justification = attribute(properties.get("jc"), "val") ?? "left";
  const alignment = ({ both: "justify", start: "left", end: "right" } as Record<string, string>)[justification] ?? justification;
  if (["left", "center", "right", "justify", "distribute"].includes(alignment)) values.alignment = alignment;
  else notes.alignment = `${justification}（Papper 无等价配置）`;
  const spacing = properties.get("spacing");
  const paragraphSpacing: Record<string, string> = {};
  for (const name of ["before", "after"]) {
    const auto = attribute(spacing, `${name}Autospacing`);
    const lines = attribute(spacing, `${name}Lines`);
    if (auto && !/^(?:0|false|off)$/.test(auto)) notes[`paragraphSpacing.${name}`] = "Word 自动段间距（Papper 无等价配置）";
    else if (lines !== undefined) notes[`paragraphSpacing.${name}`] = `${Number(lines) / 100} 行（Papper 仅支持长度）`;
    else paragraphSpacing[name] = units(attribute(spacing, name) ?? "0", 20);
  }
  if (Object.keys(paragraphSpacing).length) values.paragraphSpacing = paragraphSpacing;
  const line = attribute(spacing, "line");
  const rule = attribute(spacing, "lineRule") ?? "auto";
  if (line === undefined) values.lineSpacing = 1;
  else if (rule === "auto") values.lineSpacing = Number(units(line, 240, ""));
  else if (rule === "exact") values.lineSpacing = units(line, 20);
  else notes.lineSpacing = `至少 ${units(line, 20)}（Papper 无等价配置）`;
  const indent = properties.get("ind");
  const indentation: Record<string, string> = {};
  for (const name of ["left", "right", "firstLine", "hanging"]) {
    const chars = attribute(indent, `${name}Chars`);
    const length = attribute(indent, name);
    if (chars !== undefined) {
      if (name === "firstLine") values.firstLineIndentChars = Number(chars) / 100;
      else notes[`indentation.${name}`] = `${Number(chars) / 100} 字符（Papper 此字段仅支持长度）`;
    } else if (length !== undefined) indentation[name] = units(length, 20);
    else if (name === "left" || name === "right") indentation[name] = "0pt";
  }
  // Character, first-line and hanging controls are mutually exclusive in Papper.
  if (values.firstLineIndentChars !== undefined) { delete indentation.firstLine; delete indentation.hanging; }
  else if (indentation.hanging !== undefined) delete indentation.firstLine;
  else if (indentation.firstLine === undefined && !notes["indentation.hanging"]) values.firstLineIndentChars = 0;
  if (Object.keys(indentation).length) values.indentation = indentation;
  return { values, notes };
}

/** Parses actual reference DOCX styles, resolving basedOn chains and document defaults. */
export function readReferenceStyles(docx: Uint8Array): ReferenceStyle[] {
  const files = unzipSync(docx, { filter: (entry) => ["word/styles.xml", "word/theme/theme1.xml", "word/settings.xml"].includes(entry.name) });
  /** Parses only trusted-format XML entries and rejects malformed reference documents. */
  const parseXml = (name: string): XmlElement | undefined => {
    if (!files[name]) return undefined;
    return new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(`Invalid ${name}: ${message}`); } })
      .parseFromString(strFromU8(files[name]), "application/xml").documentElement;
  };
  const styles = parseXml("word/styles.xml");
  if (!styles || styles.localName !== "styles" || styles.namespaceURI !== WORD_NS) throw new Error("Reference DOCX has no valid word/styles.xml");
  const theme = parseXml("word/theme/theme1.xml");
  const settings = parseXml("word/settings.xml");
  const themeLanguage = attribute(settings?.getElementsByTagNameNS(WORD_NS, "themeFontLang").item(0), "eastAsia") ?? "";
  const defaults = child(styles, "docDefaults");
  const definitions = new Map<string, XmlElement>();
  const styleNodes = styles.getElementsByTagNameNS(WORD_NS, "style");
  for (let index = 0; index < styleNodes.length; index += 1) {
    const node = styleNodes.item(index);
    const id = attribute(node, "styleId");
    if (id) definitions.set(id, node);
  }
  /** Merges property attributes so a partial child spacing/indent/font preserves its ancestor. */
  const mergeProperties = (target: Map<string, XmlElement>, container: XmlElement | undefined): void => {
    if (!container) return;
    for (let index = 0; index < container.childNodes.length; index += 1) {
      const property = container.childNodes.item(index) as XmlElement;
      if (property.nodeType !== 1 || property.namespaceURI !== WORD_NS) continue;
      const name = property.localName;
      const previous = target.get(name);
      if (previous && ["rFonts", "spacing", "ind", "lang"].includes(name)) {
        const merged = previous.cloneNode(true) as XmlElement;
        // Changing between theme/direct font and character/length indentation supersedes the old alternative.
        const alternatives: Record<string, string[]> = {
          ascii: ["asciiTheme"], asciiTheme: ["ascii"], eastAsia: ["eastAsiaTheme"], eastAsiaTheme: ["eastAsia"],
          left: ["leftChars"], leftChars: ["left"], right: ["rightChars"], rightChars: ["right"],
          firstLine: ["firstLineChars", "hanging", "hangingChars"], firstLineChars: ["firstLine", "hanging", "hangingChars"],
          hanging: ["hangingChars", "firstLine", "firstLineChars"], hangingChars: ["hanging", "firstLine", "firstLineChars"],
          before: ["beforeLines"], beforeLines: ["before"], after: ["afterLines"], afterLines: ["after"],
        };
        for (let attrIndex = 0; attrIndex < property.attributes.length; attrIndex += 1) {
          const attr = property.attributes.item(attrIndex);
          for (const alternative of alternatives[attr.localName] ?? []) merged.removeAttributeNS(WORD_NS, alternative);
          merged.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
        }
        target.set(name, merged);
      } else target.set(name, property);
    }
  };
  /** Resolves recursive inheritance with an explicit cycle guard for corrupt/custom references. */
  const resolve = (id: string, visiting = new Set<string>()): Map<string, XmlElement> => {
    if (visiting.has(id)) throw new Error(`Cyclic reference style inheritance: ${id}`);
    visiting.add(id);
    const definition = definitions.get(id);
    const parent = attribute(child(definition, "basedOn"), "val");
    const properties = parent && definitions.has(parent) ? resolve(parent, visiting) : new Map<string, XmlElement>();
    if (!parent || !definitions.has(parent)) {
      mergeProperties(properties, child(child(defaults, "pPrDefault"), "pPr"));
      mergeProperties(properties, child(child(defaults, "rPrDefault"), "rPr"));
    }
    mergeProperties(properties, child(definition, "pPr"));
    mergeProperties(properties, child(definition, "rPr"));
    visiting.delete(id);
    return properties;
  };
  return [...definitions].filter(([, definition]) => attribute(definition, "type") === "paragraph")
    .map(([id, definition]) => ({ id, name: attribute(child(definition, "name"), "val") ?? id, ...readValues(resolve(id), theme, themeLanguage) }));
}

/** Matches Word built-ins by ID or translated name, while preserving exact custom names. */
export function findReferenceStyle(styles: ReferenceStyle[], requested: string): ReferenceStyle | undefined {
  const aliases: Record<string, string> = { 正文文本: "BodyText", 正文: "Normal" };
  const heading = requested.match(/^(?:标题|Heading)\s*(\d)$/i);
  const id = heading ? `Heading${heading[1]}` : aliases[requested] ?? requested.replace(/\s/g, "");
  return styles.find((style) => style.name === requested)
    ?? styles.find((style) => style.id.toLowerCase() === id.toLowerCase() || style.name.replace(/\s/g, "").toLowerCase() === id.toLowerCase());
}
