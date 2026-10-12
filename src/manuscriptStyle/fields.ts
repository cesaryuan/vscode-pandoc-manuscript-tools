/** Shared DOCX field descriptions for style YAML completion and inserted inline comments. */
export type StyleField = {
  description: string;
  values?: readonly string[];
  enumValues?: readonly unknown[];
  valueTypes?: readonly string[];
  section?: string;
  children?: Record<string, StyleField>;
  dynamicChildren?: boolean;
  sequenceItems?: boolean;
  dynamicValueDescription?: string;
};

export { DOCX_STYLE_FIELDS, CHARACTER_STYLE_FIELDS } from "../configurationContract";
