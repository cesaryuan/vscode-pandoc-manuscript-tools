/** Resolves completion and hover help from the live Papper catalog and source attribute ranges. */
import { getElementAttributeCatalog } from "../configurationContract";
import type { AttributeDefinition, AttributeVariant, ElementDefinition } from "./catalog";
import { getAttributeGroups, type AttributeGroup, type AttributeToken } from "./parser";

export type AttributeHelp = { label: string; description: string; targets: string[]; values: string[]; aliases: string[] };
export type AttributeSuggestion = AttributeHelp & { start: number; end: number; insertText: string; placeholder?: number; kind: "key" | "value" };
export type AttributeHoverInfo = AttributeHelp & { start: number; end: number };
type Domain = { element: ElementDefinition; variant?: AttributeVariant; fields: Record<string, AttributeDefinition> };

/** Matches exact authored discriminator values, including aliases supplied by Papper. */
function variantFor(element: ElementDefinition, value: string | undefined): AttributeVariant | undefined {
  if (value === undefined) return undefined;
  return element.variants?.[value] ?? Object.values(element.variants ?? {}).find((variant) => variant.aliases?.includes(value));
}

/** Builds the allowed property domain after reading the discriminator anywhere in the block. */
function domainFor(group: AttributeGroup): Domain | undefined {
  const element = getElementAttributeCatalog()[group.context];
  if (!element) return undefined;
  const discriminators = group.tokens.filter((token) => token.key === element.discriminator);
  const variant = discriminators.length === 1 ? variantFor(element, discriminators[0].value) : undefined;
  const fields = { ...element.properties, ...variant?.properties };
  if (element.discriminator) {
    fields[element.discriminator] = { description: element.description, valueType: "string",
      values: Object.entries(element.variants ?? {}).flatMap(([key, variant]) => [key, ...(variant.aliases ?? [])]) };
  }
  return { element, variant, fields };
}

/** Resolves an accepted alias without treating spelling variants as arbitrary configuration keys. */
function fieldFor(domain: Domain, key: string): [string, AttributeDefinition] | undefined {
  if (domain.fields[key]) return [key, domain.fields[key]];
  return Object.entries(domain.fields).find(([, field]) => field.aliases?.includes(key));
}

/** Combines authored choices with examples, keeping example values distinct in the source catalog. */
function helpFor(domain: Domain, key: string, field: AttributeDefinition, value?: string): AttributeHelp {
  const variant = key === domain.element.discriminator ? variantFor(domain.element, value) : undefined;
  return { label: key, description: variant?.description ?? field.description,
    targets: field.targets ?? domain.element.targets,
    values: [...new Set([...(field.values ?? []), ...(field.valueType === "boolean" ? ["true", "false"] : []), ...(field.suggestions ?? [])])],
    aliases: field.aliases ?? [] };
}

/** Locates the smallest containing group so embedded page-story directives get their own domain. */
function groupAt(groups: AttributeGroup[], offset: number): AttributeGroup | undefined {
  return groups.filter((group) => group.start < offset && offset <= group.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/** Quotes an inserted value once, or escapes it for the quote already surrounding the source token. */
function insertedValue(value: string, token: AttributeToken, outerQuote?: string): string {
  if (!token.quote) {
    if (!outerQuote) return JSON.stringify(value);
    // Use the opposite quote in nested stories so completion preserves the enclosing value.
    const quote = outerQuote === '"' ? "'" : '"';
    return quote + value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`).replaceAll(outerQuote, `\\${outerQuote}`) + quote;
  }
  let escaped = value.replace(/\\/g, "\\\\").replaceAll(token.quote, `\\${token.quote}`);
  if (token.quotePrefix) escaped = escaped.replace(/\\/g, "\\\\").replaceAll(token.quote, `\\${token.quote}`);
  return escaped + (token.closed ? "" : (token.quotePrefix ?? "") + token.quote);
}

/** Offers context-specific keys and values while retaining existing quotes, suffixes and attribute order. */
export function getAttributeSuggestions(text: string, offset: number, groups = getAttributeGroups(text)): AttributeSuggestion[] | undefined {
  const group = groupAt(groups, offset);
  if (!group) return undefined;
  const domain = domainFor(group);
  if (!domain) return undefined;
  const valueToken = group.tokens.find((token) => token.valueStart !== undefined
    && offset >= token.valueStart && offset <= (token.valueEnd ?? token.end));
  if (valueToken) {
    const entry = fieldFor(domain, valueToken.key);
    if (!entry) return [];
    const [key, field] = entry;
    const help = helpFor(domain, key, field);
    return help.values.map((value) => ({ ...help, label: value,
      description: key === domain.element.discriminator ? variantFor(domain.element, value)?.description ?? help.description : help.description,
      start: valueToken.valueStart!, end: valueToken.valueEnd!, insertText: insertedValue(value, valueToken, group.outerQuote), kind: "value" }));
  }
  const keyToken = group.tokens.find((token) => token.start <= offset && offset <= token.keyEnd);
  if (keyToken && !/^[\w-]+$/.test(keyToken.key)) return [];
  // Text within a filled token (including a closing quote) is not a new attribute position.
  if (!keyToken && group.tokens.some((token) => token.start <= offset && offset < token.end)) return [];
  const used = new Set(group.tokens.filter((token) => token !== keyToken)
    .map((token) => fieldFor(domain, token.key)?.[0] ?? token.key));
  const prefix = text.slice(keyToken?.start ?? offset, offset);
  return Object.entries(domain.fields).filter(([key]) => !used.has(key)).flatMap(([key, field]) => {
    const names = prefix ? [key, ...(field.aliases ?? [])].filter((name) => name.startsWith(prefix)) : [key];
    return names.map((name) => {
      const quote = group.outerQuote === '"' ? "'" : '"';
      const insertText = keyToken?.valueStart !== undefined ? name : `${name}=${quote}${quote}`;
      return { ...helpFor(domain, key, field), label: name, start: keyToken?.start ?? offset,
        end: keyToken?.keyEnd ?? offset, insertText,
        placeholder: keyToken?.valueStart === undefined ? name.length + 2 : undefined, kind: "key" as const };
    });
  });
}

/** Provides key and value hover ranges only for properties accepted by the selected element type. */
export function getAttributeHoverEntries(text: string, groups = getAttributeGroups(text)): AttributeHoverInfo[] {
  const entries: AttributeHoverInfo[] = [];
  for (const group of groups) {
    const domain = domainFor(group);
    if (!domain) continue;
    for (const token of group.tokens) {
      const entry = fieldFor(domain, token.key);
      if (!entry) continue;
      const [key, field] = entry;
      const help = helpFor(domain, key, field, token.value);
      entries.push({ ...help, label: token.key, start: token.start, end: token.keyEnd });
      if (token.valueStart !== undefined && token.valueEnd !== undefined && token.valueEnd > token.valueStart) {
        entries.push({ ...help, label: token.key, start: token.valueStart, end: token.valueEnd });
      }
    }
  }
  return entries;
}
