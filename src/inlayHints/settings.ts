import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap } from "yaml";
import { getYamlHeader } from "../manuscriptStyle/document";
import { asArray, asRecord, flattenAstText } from "./ast";

export const INLAY_METADATA_FIELDS = {
  figPrefix: "图引用 prefix",
  tblPrefix: "表引用 prefix",
  eqnPrefix: "公式引用 prefix",
  secPrefix: "章节引用 prefix",
  figureTitle: "图题注 title",
  tableTitle: "表题注 title",
  csl: "参考文献 CSL",
} as const;
export type InlayMetadataField = keyof typeof INLAY_METADATA_FIELDS;
export type InlayMetadataValue = string | string[];
export type MetadataEdit = { start: number; end: number; text: string };

/** Restricts hover commands to Papper's documented cross-reference and caption metadata. */
export function isInlayMetadataField(value: unknown): value is InlayMetadataField {
  return typeof value === "string" && Object.hasOwn(INLAY_METADATA_FIELDS, value);
}

/** Checks scalar and singular/plural prefix values before passing them into an editor command. */
export function isInlayMetadataValue(value: unknown): value is InlayMetadataValue {
  return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string"));
}

/** Reads the effective metadata from the built AST, retaining separate singular/plural prefixes. */
export function getBuiltMetadataValue(ast: unknown, field: InlayMetadataField): InlayMetadataValue | undefined {
  const meta = asRecord(asRecord(ast)?.meta)?.[field];
  const node = asRecord(meta);
  if (node?.t === "MetaList") {
    const values = asArray(node.c);
    return values?.length ? values.map(flattenAstText) : undefined;
  }
  return node && ["MetaString", "MetaInlines", "MetaBlocks"].includes(String(node.t)) ? flattenAstText(meta) : undefined;
}

/** Parses an editable YAML header without risking loss of invalid or anchored metadata. */
function parseEditableHeader(text: string) {
  const header = getYamlHeader(text);
  const yaml = parseDocument(header?.content ?? "");
  if (yaml.errors.length) throw new Error(`YAML header 无法解析：${yaml.errors[0].message}`);
  if (!yaml.contents || (isScalar(yaml.contents) && yaml.contents.value === null)) yaml.contents = yaml.createNode({}) as YAMLMap.Parsed;
  if (!isMap(yaml.contents)) throw new Error("YAML header 顶层必须是对象");
  // Changing a shared anchor would also change metadata outside this setting.
  if (yaml.contents.anchor) throw new Error("YAML header 使用了 anchor，请先展开为独立对象");
  return { header, yaml, root: yaml.contents as YAMLMap };
}

/** Reads an explicit manuscript override; callers fall back to the actual build's inherited value. */
export function getManuscriptMetadataValue(text: string, field: InlayMetadataField): InlayMetadataValue | undefined {
  const { root } = parseEditableHeader(text);
  if (!root.has(field)) return undefined;
  const node: unknown = root.get(field, true);
  if (isAlias(node) || ((isScalar(node) || isSeq(node)) && node.anchor)) throw new Error(`${field} 使用了 YAML anchor 或 alias，请先展开后设置`);
  if (isSeq(node) && node.items.some((item) => isAlias(item) || (isScalar(item) && item.anchor))) {
    throw new Error(`${field} 列表使用了 YAML anchor 或 alias，请先展开后设置`);
  }
  const value = isScalar(node) ? node.value : isSeq(node) ? node.items.map((item) => isScalar(item) ? item.value : undefined) : undefined;
  if (!isInlayMetadataValue(value)) throw new Error(`${field} 必须是文本或非空文本列表`);
  return value;
}

/** Finds the field's actual YAML value so matching names in comments, nested settings or prose cannot misdirect navigation. */
export function getManuscriptMetadataRange(text: string, field: InlayMetadataField): { start: number; end: number } | undefined {
  const { header, root } = parseEditableHeader(text);
  const node: unknown = root.get(field, true);
  if (!header || !(isScalar(node) || isSeq(node)) || !node.range) return undefined;
  return { start: header.start + node.range[0], end: header.start + node.range[1] };
}

/** Creates one header-only edit at Pandoc's highest-priority manuscript scope, preserving the body verbatim. */
export function createManuscriptMetadataEdit(text: string, field: InlayMetadataField, value: InlayMetadataValue): MetadataEdit | undefined {
  if (!isInlayMetadataField(field) || !isInlayMetadataValue(value)) throw new Error("无效的引用或题注设置");
  const current = getManuscriptMetadataValue(text, field);
  if (JSON.stringify(current) === JSON.stringify(value)) return undefined;
  const { header, yaml, root } = parseEditableHeader(text);
  const previous = root.get(field, true);
  const replacement = yaml.createNode(value);
  if (isScalar(previous) || isSeq(previous)) {
    replacement.comment = previous.comment;
    replacement.commentBefore = previous.commentBefore;
    replacement.spaceBefore = previous.spaceBefore;
  }
  // Singular/plural entries can have separate explanatory comments that must survive prefix edits.
  if (isSeq(previous) && isSeq(replacement)) {
    for (const [index, item] of replacement.items.entries()) {
      const oldItem = previous.items[index];
      if (isScalar(item) && isScalar(oldItem)) {
        item.comment = oldItem.comment;
        item.commentBefore = oldItem.commentBefore;
        item.spaceBefore = oldItem.spaceBefore;
      }
    }
  }
  if (isScalar(replacement)) replacement.type = Scalar.QUOTE_DOUBLE;
  root.set(field, replacement);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const content = yaml.toString({ lineWidth: 0 }).replace(/\n/g, newline);
  if (header) return { start: header.start, end: header.end, text: content };
  const start = text.startsWith("\uFEFF") ? 1 : 0;
  return { start, end: start, text: `---${newline}${content}---${newline}` };
}
