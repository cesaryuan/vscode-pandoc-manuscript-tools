/** Validates Papper's additive element catalog before any editor provider sees it. */
export type AttributeDefinition = {
  description: string; valueType: "string" | "boolean" | "integer" | "length";
  values?: string[]; suggestions?: string[]; aliases?: string[]; targets?: string[]; docxMetadata?: boolean;
};
export type AttributeVariant = { description: string; aliases?: string[]; properties: Record<string, AttributeDefinition> };
export type ElementDefinition = { description: string; targets: string[]; properties: Record<string, AttributeDefinition>;
  discriminator?: string; variants?: Record<string, AttributeVariant> };
export type ElementAttributeCatalog = Record<string, ElementDefinition>;

/** Requires a mapping rather than accepting arrays or null as authored definitions. */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Rejects malformed names and lists without constraining enum strings or example contents. */
function strings(value: unknown, optional = true): boolean {
  return optional && value === undefined || Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Checks a property domain and rejects ambiguous aliases that would change duplicate detection. */
function properties(value: unknown): void {
  if (!record(value)) throw new Error("Invalid Papper attribute properties");
  const names = new Set(Object.keys(value));
  for (const [key, field] of Object.entries(value)) {
    if (!/^[\w-]+$/.test(key) || !record(field) || typeof field.description !== "string"
      || !["string", "boolean", "integer", "length"].includes(field.valueType as string)
      || !strings(field.values) || !strings(field.suggestions) || !strings(field.aliases) || !strings(field.targets)
      || field.docxMetadata !== undefined && typeof field.docxMetadata !== "boolean") {
      throw new Error(`Invalid Papper attribute ${key}`);
    }
    for (const alias of (field.aliases ?? []) as string[]) {
      if (!/^[\w-]+$/.test(alias) || names.has(alias)) throw new Error(`Ambiguous Papper attribute alias ${alias}`);
      names.add(alias);
    }
  }
}

/** Validates an optional version-one extension independently of the YAML schema adapter. */
export function parseElementAttributeCatalog(value: unknown): ElementAttributeCatalog {
  if (!record(value)) throw new Error("Invalid Papper element attribute catalog");
  for (const [name, element] of Object.entries(value)) {
    if (!record(element) || typeof element.description !== "string" || !strings(element.targets, false)
      || element.discriminator !== undefined && (typeof element.discriminator !== "string" || !/^[\w-]+$/.test(element.discriminator))) {
      throw new Error(`Invalid Papper attribute context ${name}`);
    }
    properties(element.properties);
    if (element.variants !== undefined) {
      if (!element.discriminator || !record(element.variants)) throw new Error(`Invalid Papper attribute variants ${name}`);
      const names = new Set(Object.keys(element.variants));
      for (const [key, variant] of Object.entries(element.variants)) {
        if (!key || !record(variant) || typeof variant.description !== "string" || !strings(variant.aliases)) {
          throw new Error(`Invalid Papper attribute variant ${key}`);
        }
        properties(variant.properties);
        for (const alias of (variant.aliases ?? []) as string[]) {
          if (!alias || names.has(alias)) throw new Error(`Ambiguous Papper variant alias ${alias}`);
          names.add(alias);
        }
      }
    }
  }
  return value as ElementAttributeCatalog;
}
