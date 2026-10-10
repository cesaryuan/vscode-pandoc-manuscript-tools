import { isAlias, isMap, isScalar, Pair, parseDocument, YAMLMap } from "yaml";
import { collectMarkdownCodeSpanRanges, parsePandocDocument } from "../parser";
import { DOCX_STYLE_FIELDS, type StyleField } from "./fields";
import type { DocxStyleValues } from "./referenceStyles";

export type StyleTarget = { name: string; line: number; endLine: number; startCharacter: number; endCharacter: number };
export type YamlHeader = { start: number; end: number; content: string; bodyStart: number };

/** Finds the leading Pandoc YAML header, preserving BOM, delimiters and body bytes. */
export function getYamlHeader(text: string): YamlHeader | undefined {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!opening) return undefined;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(text);
  if (!match) throw new Error("YAML header 缺少结束分隔符 --- 或 ...");
  return { start: opening[0].length, end: match.index, content: text.slice(opening[0].length, match.index), bodyStart: match.index + match[0].length };
}

/** Finds eligible source blocks without offering prose styles inside code, comments, YAML or math. */
export function getManuscriptStyleTargets(text: string): StyleTarget[] {
  const header = getYamlHeader(text);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const parsed = parsePandocDocument(text.replace(/^\uFEFF/, ""));
  const targets: StyleTarget[] = [];
  const headerEndLine = header ? text.slice(0, header.bodyStart).split(/\r?\n/).length - 1 : 0;
  let fence = "";
  let comment = false;
  let displayMath = false;
  let gridTable = false;
  let pipeTableEnd = -1;
  for (let line = headerEndLine; line < lines.length; line += 1) {
    const source = lines[line];
    const trimmed = source.trim();
    const codeFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(source);
    if (fence) {
      if (codeFence && codeFence[1][0] === fence[0] && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = "";
      continue;
    }
    if (codeFence) { fence = codeFence[1]; continue; }
    if (comment) { if (source.includes("-->")) comment = false; continue; }
    if (trimmed.startsWith("<!--")) { comment = !source.includes("-->"); continue; }
    if (/^\$\$|^\\\[|^\\\]/.test(trimmed)) {
      // A complete one-line display formula must not hide all subsequent body-style actions.
      if (!/^\$\$.+\$\$/.test(trimmed) && !/^\\\[.*\\\]/.test(trimmed)) displayMath = !displayMath;
      continue;
    }
    if (displayMath || /^ {4}|^\t/.test(source)) continue;
    if (!trimmed) { gridTable = false; continue; }
    if (/^(?::{3,}|<\/?(?:div|table|thead|tbody|tr)\b|<\/?figure\b)/i.test(trimmed)) continue;
    const heading = parsed.headings.find((entry) => entry.line === line);
    const setext = line + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[line + 1]);
    let name: string;
    if (heading) name = `标题 ${heading.level}`;
    else if (setext && !/^[>|+]/.test(trimmed)) name = `标题 ${lines[line + 1].trim()[0] === "=" ? 1 : 2}`;
    else if (/^(?:[-*_]\s*){3,}$/.test(trimmed) || /^\[.+\]:\s*\S/.test(trimmed) || /^\s*\{[^}]+\}\s*$/.test(source)) continue;
    else {
      // Pipe and grid table cells use Table Text; table captions are a different Word style.
      if (source.includes("|") && line + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[line + 1]) && lines[line + 1].includes("|")) {
        pipeTableEnd = line + 1;
        while (pipeTableEnd + 1 < lines.length && lines[pipeTableEnd + 1].trim() && lines[pipeTableEnd + 1].includes("|")) pipeTableEnd += 1;
      }
      if (/^\s*\+(?:[-=]+\+)+\s*$/.test(source)) gridTable = true;
      if (line <= pipeTableEnd || gridTable) name = "Table Text";
      else if (/^(?:Table\s*:|表\s*[:：])/.test(trimmed) || /^:\s+/.test(trimmed)) name = "Table Caption";
      else if (/^\s*<img\b/i.test(source)) name = "Image Caption";
      else name = "正文文本";
    }
    const endLine = setext && !heading ? line + 1 : line;
    const custom = [...parsed.fencedDivs].reverse().find((div) => div.range.start.line < line && div.range.end.line > line
      && /(?:^|[\s{])custom-style\s*=/.test(div.attributes));
    const customName = custom?.attributes.match(/custom-style\s*=\s*["']([^"']+)["']/)?.[1];
    if (customName && name === "正文文本") name = customName;
    const cellStyle = source.match(/custom-text-style\s*=\s*["']([^"']+)["']/)?.[1];
    if (cellStyle && name === "Table Text") name = cellStyle;
    targets.push({ name, line, endLine, startCharacter: 0, endCharacter: lines[endLine].length });
    // Images inside prose expose their caption action only over the image token.
    const images = /!\[(?:[^\]\\]|\\.)*\](?:\([^\n]*?\)|\[[^\]\n]*\])(?:\{[^}\n]*\})?/g;
    const literalRanges = collectMarkdownCodeSpanRanges(source);
    for (const image of source.matchAll(images)) {
      if (literalRanges.some((range) => image.index >= range.start && image.index < range.end) || /\\$/.test(source.slice(0, image.index))) continue;
      targets.push({ name: "Image Caption", line, endLine: line, startCharacter: image.index, endCharacter: image.index + image[0].length });
    }
    if (endLine > line) line = endLine;
  }
  return targets;
}

/** Matches translated built-in style names without conflating case-sensitive custom names. */
function sameStyle(left: string, right: string): boolean {
  /** Normalizes only Word's known bilingual built-in aliases. */
  const normalize = (name: string): string => name.replace(/^标题\s*(\d)$/, "Heading $1").replace(/^正文文本$/, "Body Text");
  return normalize(left) === normalize(right);
}

/** Normalizes Papper's supported camelCase, snake_case and kebab-case field aliases. */
function sameField(left: string, right: string): boolean {
  return left.replace(/[-_]/g, "").toLowerCase() === right.replace(/[-_]/g, "").toLowerCase();
}

/** Adds a concrete style block in one YAML edit without overwriting user values or comments. */
export function addManuscriptStyle(text: string, name: string, defaults: DocxStyleValues): { text: string; styleName: string } {
  const header = getYamlHeader(text);
  const yaml = parseDocument(header?.content ?? "");
  if (yaml.errors.length) throw new Error(`YAML header 无法解析：${yaml.errors[0].message}`);
  if (!yaml.contents || (isScalar(yaml.contents) && yaml.contents.value === null)) yaml.contents = yaml.createNode({}) as YAMLMap.Parsed;
  if (!isMap(yaml.contents)) throw new Error("YAML header 顶层必须是对象");
  let changed = false;
  /** Obtains an editable map while rejecting aliases and incompatible existing scalar values. */
  const ensureMap = (parent: YAMLMap, requested: string, fieldAlias = false): YAMLMap => {
    const pair = parent.items.find((entry) => isScalar(entry.key) && (fieldAlias ? sameField(String(entry.key.value), requested) : String(entry.key.value) === requested));
    if (pair && isMap(pair.value)) {
      // Editing an anchored map would also change other metadata referencing that anchor.
      if (pair.value.anchor) throw new Error(`${requested} 使用了 YAML anchor，请先展开为独立对象再设置样式`);
      return pair.value;
    }
    if (pair && (isAlias(pair.value) || !isScalar(pair.value) || pair.value.value !== null)) throw new Error(`${requested} 必须是可编辑的 YAML 对象`);
    const map = yaml.createNode({}) as YAMLMap;
    if (pair) pair.value = map;
    else parent.set(requested, map);
    changed = true;
    return map;
  };
  const papper = ensureMap(yaml.contents, "papperSettings");
  const styles = ensureMap(papper, "docxStyle", true);
  const existingName = styles.items.find((entry) => isScalar(entry.key) && sameStyle(String(entry.key.value), name));
  const styleName = existingName ? String((existingName.key as { value: unknown }).value) : name;
  const style = ensureMap(styles, styleName);
  /** Fills missing fields with inline help while preserving existing values, comments and compatible indents. */
  const fill = (target: YAMLMap, source: Record<string, unknown>, root = target, fields: Record<string, StyleField> = DOCX_STYLE_FIELDS): void => {
    /** Looks up a field using Papper's accepted aliases. */
    const has = (map: YAMLMap, key: string): boolean => map.items.some((entry) => isScalar(entry.key) && sameField(String(entry.key.value), key));
    const indentationPair = root.items.find((entry) => isScalar(entry.key) && sameField(String(entry.key.value), "indentation"));
    for (const [key, value] of Object.entries(source)) {
      const field = fields[key];
      if (has(target, key)) {
        const pair = target.items.find((entry) => isScalar(entry.key) && sameField(String(entry.key.value), key));
        if (isMap(pair.value) && value && typeof value === "object") {
          if (pair.value.anchor) throw new Error(`${key} 使用了 YAML anchor，请先展开为独立对象再设置样式`);
          fill(pair.value, value as Record<string, unknown>, root, field?.children ?? {});
        }
        continue;
      }
      if (key === "fontFamily" && (has(root, "fontName") || has(root, "font"))) continue;
      if (key === "firstLineIndentChars" && indentationPair && (!isMap(indentationPair.value) || has(indentationPair.value, "firstLine") || has(indentationPair.value, "hanging"))) continue;
      if (["firstLine", "hanging"].includes(key) && (has(root, "firstLineIndentChars") || has(target, key === "firstLine" ? "hanging" : "firstLine"))) continue;
      if (value && typeof value === "object") {
        const nested = yaml.createNode({}) as YAMLMap;
        fill(nested, value as Record<string, unknown>, root, field?.children ?? {});
        if (nested.items.length) {
          // Map descriptions belong on the key; a map's own comment would appear after its children.
          const keyNode = yaml.createNode(key);
          if (field?.description) keyNode.comment = ` ${field.description}`;
          target.add(new Pair(keyNode, nested));
          changed = true;
        }
      } else {
        const node = yaml.createNode(value);
        if (field?.description) node.comment = ` ${field.description}`;
        target.add(new Pair(yaml.createNode(key), node));
        changed = true;
      }
    }
  };
  fill(style, defaults);
  // Re-serializing an unchanged header can relocate map-key comments; repeated clicks must be a no-op.
  if (!changed) return { text, styleName };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const content = yaml.toString({ lineWidth: 0 }).replace(/\n/g, newline);
  const updated = header ? text.slice(0, header.start) + content + text.slice(header.end)
    : `${text.startsWith("\uFEFF") ? "\uFEFF" : ""}---${newline}${content}---${newline}${newline}${text.replace(/^\uFEFF/, "")}`;
  return { text: updated, styleName };
}
