/** Adapts Papper's versioned editor export to the shared completion and settings model. */
import bundledContract from "../assets/papper-configuration.json";
import type { StyleField } from "./manuscriptStyle/fields";
import { parseElementAttributeCatalog, type ElementAttributeCatalog } from "./elementAttributes/catalog";

type Schema = { description?: string; type?: string | string[]; enum?: unknown[]; properties?: Record<string, Schema>;
  items?: Schema; additionalProperties?: boolean | Schema; required?: string[];
  "x-papper-suggestions"?: string[]; "x-papper-section"?: string };
export type ConfigurationRule = { scope: "style" | "docxTextStyle"; kind: "atMostOne"; paths: string[][] };
export type ConfigurationContract = { contractVersion: number; papperVersion: string;
  schemas: Record<"style" | "pandocMetadata" | "docxTextStyle" | "manuscriptFrontmatter", Schema>;
  templates: { styleProject: string }; defaults: { standard: Record<string, unknown>; chinese: Record<string, unknown> };
  rules: ConfigurationRule[]; elementAttributes?: ElementAttributeCatalog };

export const STYLE_FIELDS: Record<string, StyleField> = {};
export const PANDOC_METADATA_FIELDS: Record<string, StyleField> = {};
export const DOCX_STYLE_FIELDS: Record<string, StyleField> = {};
export const CHARACTER_STYLE_FIELDS: Record<string, StyleField> = {};
export const MANUSCRIPT_FIELDS: Record<string, StyleField> = {};
let currentContract: ConfigurationContract;
let revision = 0;
let elementAttributes: ElementAttributeCatalog = {};

/** Rejects unsupported or malformed exports before replacing any working editor data. */
export function parseConfigurationContract(value: unknown): ConfigurationContract {
  const candidate = value as ConfigurationContract;
  if (!candidate || candidate.contractVersion !== 1 || typeof candidate.papperVersion !== "string"
    || typeof candidate.templates?.styleProject !== "string" || !candidate.templates.styleProject.trim()
    || !candidate.defaults?.standard || !candidate.defaults?.chinese || !Array.isArray(candidate.rules)) {
    throw new Error("Unsupported or incomplete Papper configuration contract");
  }
  for (const name of ["style", "pandocMetadata", "docxTextStyle", "manuscriptFrontmatter"] as const) {
    if (!candidate.schemas?.[name]?.properties || typeof candidate.schemas[name].properties !== "object"
      || Array.isArray(candidate.schemas[name].properties)) {
      throw new Error(`Missing Papper ${name} schema`);
    }
    fieldsFromSchema(candidate.schemas[name]);
  }
  if (!candidate.schemas.style.properties.docxStyle || !candidate.schemas.style.properties.pandocMetadata
    || !candidate.schemas.manuscriptFrontmatter.properties.papperSettings) {
    throw new Error("Missing Papper configuration domains");
  }
  for (const rule of candidate.rules) {
    if (!["style", "docxTextStyle"].includes(rule.scope) || rule.kind !== "atMostOne"
      || !Array.isArray(rule.paths) || rule.paths.some((parts) => !Array.isArray(parts)
        || !parts.length || parts.some((part) => typeof part !== "string" || !part))) {
      throw new Error("Invalid Papper configuration rule");
    }
  }
  if (candidate.elementAttributes !== undefined) parseElementAttributeCatalog(candidate.elementAttributes);
  return candidate;
}

/** Converts inline version-one schemas, retaining arbitrary names and array item mappings. */
function fieldsFromSchema(schema: Schema, depth = 0): Record<string, StyleField> {
  if (depth > 20) throw new Error("Papper configuration schema is too deeply nested");
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
    throw new Error("Invalid Papper configuration properties");
  }
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, definition]) => {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)
      || definition.description !== undefined && typeof definition.description !== "string") {
      throw new Error(`Invalid Papper configuration field ${key}`);
    }
    const types = definition.type === undefined ? [] : Array.isArray(definition.type) ? definition.type : [definition.type];
    if (types.some((type) => typeof type !== "string")) throw new Error(`Invalid field types for ${key}`);
    const suggestions = definition["x-papper-suggestions"] ?? [];
    if (!Array.isArray(suggestions) || suggestions.some((value) => typeof value !== "string")
      || definition["x-papper-section"] !== undefined && typeof definition["x-papper-section"] !== "string"
      || definition.enum !== undefined && (!Array.isArray(definition.enum)
        || definition.enum.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value)))) {
      throw new Error(`Invalid field suggestions for ${key}`);
    }
    const values = [...new Set([...(definition.enum?.map(String) ?? []),
      ...(types.includes("boolean") ? ["true", "false"] : []), ...suggestions,
      ...(types.includes("null") ? ["null"] : [])])];
    const dynamic = typeof definition.additionalProperties === "object" && definition.additionalProperties !== null
      ? definition.additionalProperties : undefined;
    const childrenSchema = dynamic?.properties ? dynamic : definition.items?.properties ? definition.items : definition;
    const children = childrenSchema.properties ? fieldsFromSchema(childrenSchema, depth + 1) : undefined;
    const field: StyleField = { description: definition.description ?? key, values: values.length ? values : undefined,
      enumValues: definition.enum, valueTypes: types, section: definition["x-papper-section"],
      children, dynamicChildren: dynamic?.properties ? true : undefined,
      sequenceItems: definition.items?.properties ? true : undefined, dynamicValueDescription: dynamic?.description };
    return [key, field];
  }));
}

/** Replaces records in place so existing providers and inline style editors see the same definitions. */
function replaceFields(target: Record<string, StyleField>, source: Record<string, StyleField>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/** Atomically installs a validated export; no source document or project configuration is edited. */
export function applyConfigurationContract(value: unknown): void {
  const contract = parseConfigurationContract(value);
  const style = fieldsFromSchema(contract.schemas.style);
  const metadata = fieldsFromSchema(contract.schemas.pandocMetadata);
  const text = fieldsFromSchema(contract.schemas.docxTextStyle);
  const manuscript = fieldsFromSchema(contract.schemas.manuscriptFrontmatter);
  // Older Papper executables omit this additive member; keep the usable offline catalog.
  const attributes = contract.elementAttributes ?? elementAttributes;
  // Named styles must share the live typography model instead of a stale nested copy.
  style.docxStyle.children = text;
  if (style.reply?.children?.docxStyle) style.reply.children.docxStyle.children = text;
  style.pandocMetadata.children = metadata;
  manuscript.papperSettings.children = style;
  replaceFields(STYLE_FIELDS, style);
  replaceFields(PANDOC_METADATA_FIELDS, metadata);
  replaceFields(DOCX_STYLE_FIELDS, text);
  replaceFields(MANUSCRIPT_FIELDS, manuscript);
  replaceFields(CHARACTER_STYLE_FIELDS, Object.fromEntries(
    ["fontFamily", "fontSize", "fontColor", "bold"].filter((key) => text[key]).map((key) => [key, text[key]])));
  currentContract = contract;
  elementAttributes = attributes;
  revision += 1;
}

/** Returns the active template/default export, including the bundled offline fallback. */
export function getConfigurationContract(): ConfigurationContract { return currentContract; }

/** Invalidates document hover caches when installed Papper definitions change. */
export function getConfigurationRevision(): number { return revision; }

/** Returns live element definitions, preserving offline help when an older CLI omits them. */
export function getElementAttributeCatalog(): ElementAttributeCatalog { return elementAttributes; }

applyConfigurationContract(bundledContract);
