import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, type YAMLMap } from "yaml";
import { getYamlHeader } from "../manuscriptStyle/document";
import { STYLE_FIELDS, PANDOC_METADATA_FIELDS } from "../styleConfiguration";
import type { StyleField } from "../manuscriptStyle/fields";

export type SettingsRow = { path: string[]; title: string; description: string; options?: readonly string[];
  kind: "text" | "boolean" | "yaml"; value: string; configured: boolean; inherited?: string };
export type SettingsSection = "math" | "tables" | "docx" | "bibliography" | "images" | "layout" | "references" | "general";
export type SettingsScope = "main" | "reply";
export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; title: string }> = [
  { id: "math", title: "公式与 MathType" }, { id: "tables", title: "表格" }, { id: "docx", title: "DOCX 样式" },
  { id: "bibliography", title: "参考文献样式" }, { id: "images", title: "图片与 SVG" },
  { id: "layout", title: "页面与行号" }, { id: "references", title: "交叉引用与编号" },
  { id: "general", title: "其他设置" },
];

/** Matches Papper's accepted field aliases without changing custom Word style names. */
function normalize(key: string): string {
  const canonical = Object.keys(STYLE_FIELDS).find((name) => STYLE_FIELDS[name].aliases?.includes(key)) ?? key;
  return canonical.replace(/[-_]/g, "").toLowerCase();
}

/** Parses only the configuration scope, keeping manuscript body text outside YAML. */
function configuration(text: string, style: boolean) {
  const header = style ? undefined : getYamlHeader(text);
  const content = style ? text : header?.content ?? "";
  const yaml = parseDocument(content);
  if (yaml.errors.length) throw new Error(`Papper 配置无法解析：${yaml.errors[0].message}`);
  if (!yaml.contents || (isScalar(yaml.contents) && yaml.contents.value === null)) yaml.contents = yaml.createNode({}) as YAMLMap.Parsed;
  if (!isMap(yaml.contents)) throw new Error("Papper 配置必须是 YAML 对象");
  return { yaml, header, content };
}

/** Resolves existing aliases along a path; shared nodes are rejected before editing to avoid changing other settings. */
function resolvePath(root: unknown, keys: string[]): { path: string[]; node: unknown } {
  let node = root;
  const path: string[] = [];
  for (const key of keys) {
    if (isAlias(node) || (isMap(node) && node.anchor)) throw new Error("配置使用了共享 YAML anchor 或 alias，请先展开后设置");
    if (node !== undefined && !isMap(node)) throw new Error("设置的上级配置必须是对象");
    const pair = isMap(node) ? node.items.find((item) => isScalar(item.key) &&
      (normalize(path.at(-1) ?? "") === "docxstyle" ? String(item.key.value) === key : normalize(String(item.key.value)) === normalize(key))) : undefined;
    path.push(pair && isScalar(pair.key) ? String(pair.key.value) : key);
    node = pair?.value;
  }
  if (isAlias(node) || ((isMap(node) || isScalar(node) || isSeq(node)) && node.anchor)) throw new Error("设置使用了共享 YAML anchor 或 alias，请先展开后设置");
  return { path, node };
}

/** Chooses the source's Papper override scope; manuscript metadata remains at Pandoc's top level. */
export function settingsPrefix(style: boolean, scope: SettingsScope, metadata = false): string[] {
  if (style) return [...(scope === "reply" ? ["reply"] : []), ...(metadata ? ["pandocMetadata"] : [])];
  return metadata && scope === "main" ? [] : ["papperSettings", ...(scope === "reply" ? ["reply"] : []), ...(metadata ? ["pandocMetadata"] : [])];
}

/** Locates schema documentation for an editable field, including arbitrary Word style names. */
function schemaFor(keys: string[], style: boolean): StyleField | undefined {
  let fields = style ? STYLE_FIELDS : { papperSettings: { description: "稿件设置", children: STYLE_FIELDS }, ...PANDOC_METADATA_FIELDS };
  let field: StyleField | undefined;
  for (let index = 0; index < keys.length; index++) {
    field = fields?.[Object.keys(fields ?? {}).find((key) => normalize(key) === normalize(keys[index])) ?? ""];
    if (!field) return undefined;
    fields = field.children;
    if (field.dynamicChildren) index++;
  }
  return field;
}

/** Converts a YAML node to an editable value without interpreting strings such as hexadecimal colors as comments. */
function rowValue(value: unknown, kind: SettingsRow["kind"]): string {
  return value === undefined ? "" : kind === "yaml" ? stringify(value).trim() : String(value ?? "null");
}

/** Finds an explicit configuration value without inventing defaults that Papper has not supplied. */
function valueAt(root: unknown, keys: string[]): unknown {
  const resolved = resolvePath(root, keys);
  const node = resolved.node as { toJSON?: () => unknown } | undefined;
  return node?.toJSON?.();
}

/** Looks up a leaf in an optional override map while allowing scalar parent alternatives such as fontFamily. */
function optionalValue(root: unknown, keys: string[]): unknown {
  try { return valueAt(root, keys); } catch { return undefined; }
}

/** Builds editable fields for one settings section, showing project inheritance separately from local overrides. */
export function getSettingsRows(text: string, style: boolean, scope: SettingsScope, section: SettingsSection,
  styleName = "Body Text", inheritedText = ""): SettingsRow[] {
  const { yaml } = configuration(text, style);
  const inherited = inheritedText ? configuration(inheritedText, true).yaml : undefined;
  const rows: SettingsRow[] = [];
  /** Resolves configuration inheritance without claiming to know Papper's built-in or reference-DOCX defaults. */
  function inheritedValue(keys: string[], projectKeys: string[]): unknown {
    const mainKeys = keys.filter((key) => normalize(key) !== "reply");
    const projectMain = projectKeys.filter((key) => normalize(key) !== "reply");
    const projectReply = inherited ? optionalValue(inherited.contents, projectKeys) : undefined;
    const base = inherited ? optionalValue(inherited.contents, projectMain) : undefined;
    const localMain = scope === "reply" ? optionalValue(yaml.contents, mainKeys) : undefined;
    // Main manuscript metadata can inherit the same setting from papperSettings.pandocMetadata.
    const localMetadata = !style && !keys.some((key) => normalize(key) === "pappersettings")
      ? optionalValue(yaml.contents, ["papperSettings", "pandocMetadata", ...mainKeys]) : undefined;
    return localMetadata ?? localMain ?? projectReply ?? base;
  }
  /** Adds documented fields and nested properties, retaining complex values in a YAML value editor. */
  function add(fields: Record<string, StyleField>, prefix: string[], inheritedPrefix: string[]): void {
    for (const [key, field] of Object.entries(fields)) {
      const keys = [...prefix, key];
      const current = valueAt(yaml.contents, keys);
      const fallback = inheritedValue(keys, [...inheritedPrefix, key]);
      const kind: SettingsRow["kind"] = field.values?.length === 2 && field.values.includes("true") && field.values.includes("false")
        ? "boolean" : (current !== null && typeof current === "object") || field.children && current === undefined ? "yaml" : "text";
      rows.push({ path: resolvePath(yaml.contents, keys).path, title: key, description: field.description, options: field.values, kind,
        value: rowValue(current, kind), configured: current !== undefined, inherited: fallback === undefined ? undefined : rowValue(fallback, kind) });
      if (field.children && (current === undefined || current !== null && typeof current === "object")
        && (fallback === undefined || fallback !== null && typeof fallback === "object")) add(field.children, keys, [...inheritedPrefix, key]);
    }
  }
  const prefix = settingsPrefix(style, scope);
  const inheritedPrefix = settingsPrefix(true, scope);
  if (section === "docx") add(STYLE_FIELDS.docxStyle.children, [...prefix, "docxStyle", styleName], [...inheritedPrefix, "docxStyle", styleName]);
  else if (section === "references" || section === "bibliography") {
    const fields = Object.fromEntries(Object.entries(PANDOC_METADATA_FIELDS).filter(([, field]) => field.section === section)
      .sort(([left], [right]) => Number(right === "csl") - Number(left === "csl")));
    add(fields, settingsPrefix(style, scope, true), settingsPrefix(true, scope, true));
    add(Object.fromEntries(Object.entries(STYLE_FIELDS).filter(([, field]) => field.section === section)), prefix, inheritedPrefix);
  } else {
    const knownSections = new Set(SETTINGS_SECTIONS.map((entry) => entry.id));
    add(Object.fromEntries(Object.entries(STYLE_FIELDS).filter(([key, field]) =>
      !["reply", "pandocMetadata", "docxStyle"].includes(key)
      && (section === "general" ? field.section === "general" || !knownSections.has(field.section as SettingsSection) : field.section === section))), prefix, inheritedPrefix);
  }
  return rows;
}

/** Lists configured Word styles plus common names so styles can be edited before adding overrides. */
export function getSettingsStyleNames(text: string, style: boolean, scope: SettingsScope, inheritedText = ""): string[] {
  const names = new Set(["Body Text", "Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Caption", "Image Caption", "Figure", "Table", "Table Text", "Table Caption", "Revision Char"]);
  for (const [source, isStyle] of [[text, style], [inheritedText, true]] as const) {
    const root = configuration(source, isStyle).yaml.contents;
    for (const selectedScope of [...new Set([scope, "main" as const])]) {
      const configured = optionalValue(root, [...settingsPrefix(isStyle, selectedScope), "docxStyle"]);
      if (configured && typeof configured === "object" && !Array.isArray(configured)) Object.keys(configured).forEach((name) => names.add(name));
    }
  }
  return [...names];
}

/** Creates a validated, comment-preserving configuration edit and keeps manuscript prose byte-for-byte unchanged. */
export function createSettingsEdit(text: string, style: boolean, keys: string[], input: string, reset = false) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key || key.length > 200)) throw new Error("无效的设置字段");
  const field = schemaFor(keys, style);
  if (!field || field.dynamicChildren || keys.at(-1) === "reply") throw new Error("不支持的设置字段");
  const { yaml, header, content } = configuration(text, style);
  const resolved = resolvePath(yaml.contents, keys);
  if (reset) yaml.deleteIn(resolved.path);
  else {
    let value: unknown = input;
    if (field.children || isMap(resolved.node) || isSeq(resolved.node)) {
      const parsed = parseDocument(input);
      if (parsed.errors.length) throw new Error(`字段值无法解析：${parsed.errors[0].message}`);
      value = parsed.toJSON();
      if (value !== null && typeof value !== "object" && !field.values?.length && !["fontFamily", "font"].includes(keys.at(-1))) throw new Error("此设置需要 YAML 对象");
    } else if (["true", "false", "null"].includes(input)) value = JSON.parse(input);
    else if (/^-?\d+(?:\.\d+)?$/.test(input)) value = Number(input);
    if (field.values?.length === 2 && field.values.includes("true") && field.values.includes("false") && typeof value !== "boolean") throw new Error("此设置需要开启或关闭");
    const replacement = yaml.createNode(value);
    if (isScalar(resolved.node) || isMap(resolved.node) || isSeq(resolved.node)) {
      replacement.comment = resolved.node.comment;
      replacement.commentBefore = resolved.node.commentBefore;
      replacement.spaceBefore = resolved.node.spaceBefore;
    }
    yaml.setIn(resolved.path, replacement);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const serialized = yaml.toString({ lineWidth: 0 }).replace(/\n/g, newline);
  const start = header?.start ?? (text.startsWith("\uFEFF") ? 1 : 0);
  const end = header?.end ?? (style ? text.length : start);
  return { start, end, text: style || header ? serialized : `---${newline}${serialized}---${newline}`, original: content };
}
