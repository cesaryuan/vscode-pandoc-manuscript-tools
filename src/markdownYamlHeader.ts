import * as vscode from "vscode";
import { getYamlHeader } from "./manuscriptStyle/document";
import type { StyleField } from "./manuscriptStyle/fields";
import {
  PANDOC_METADATA_FIELDS, STYLE_FIELDS, getStyleSuggestions, getStyleHoverEntries,
  createConfigurationCompletionItems, createConfigurationHover,
  type StyleSuggestion, type StyleHoverInfo,
} from "./styleConfiguration";

const AUTHOR_FIELDS: Record<string, StyleField> = {
  name: { description: "作者姓名，每位作者必须填写" },
  affiliation: { description: "作者所属机构名称或共享机构标识，可填写一个或多个" },
  affiliations: { description: "作者所属机构名称或共享机构标识列表" },
  email: { description: "作者邮箱，用于生成通讯作者脚注" },
  title: { description: "作者职称，显示在通讯作者脚注中" },
  corresponding: { description: "设为 true 生成默认通讯作者脚注，也可填写自定义脚注文本", values: ["true", "false"] },
};

const AUTHORS: StyleField = {
  description: "作者列表，每位作者使用包含 name 的对象，可填写机构、邮箱和通讯作者信息",
  children: AUTHOR_FIELDS, sequenceItems: true,
};
const AFFILIATIONS: StyleField = {
  description: "共享机构映射，由作者的 affiliation 或 affiliations 通过标识引用",
  dynamicValueDescription: "共享机构名称，可在作者 affiliation 或 affiliations 中引用此标识",
};

const MANUSCRIPT_FIELDS: Record<string, StyleField> = {
  ...PANDOC_METADATA_FIELDS,
  title: { description: "稿件标题" },
  subtitle: { description: "稿件副标题" },
  authors: AUTHORS,
  author: { ...AUTHORS, description: "作者列表，authors 的兼容别名" },
  affiliations: AFFILIATIONS,
  affiliation: { ...AFFILIATIONS, description: "共享机构映射，affiliations 的兼容别名" },
  abstract: { description: "稿件摘要，可使用 | 编写多行文本" },
  keywords: { description: "稿件关键词列表，例如 [sampling, evaluation]" },
  bibliography: { description: "参考文献数据库路径，例如 references.bib；支持多个文件路径" },
  nocite: { description: "额外列入参考文献的条目；填写 '@*' 可列入所有未引用条目" },
  date: { description: "稿件日期" },
  reply: { description: "审稿回复对应的稿件 Markdown 路径，例如 manuscript.md；用于行号和交叉引用" },
  toc: { description: "是否生成目录", values: ["true", "false"] },
  lof: { description: "是否生成图目录", values: ["true", "false"] },
  lot: { description: "是否生成表目录", values: ["true", "false"] },
  documentclass: { description: "LaTeX 文档类，例如 elsarticle、svjour3、WileyNJDv5 或 IEEEtran" },
  classoption: { description: "LaTeX 文档类选项列表，例如 [preprint, 3p, authoryear]" },
  "header-includes": { description: "追加到输出文档头部的内容，例如 LaTeX 包或期刊信息" },
  papperSettings: {
    description: "本稿件的格式与构建覆盖配置，高于 style.yml；相对字体文件路径以当前 Markdown 所在目录为基准",
    children: STYLE_FIELDS,
  },
};

/** Restricts header language features to local or unsaved Markdown/MDX editor buffers. */
function isMarkdownEditor(document: vscode.TextDocument): boolean {
  return ["markdown", "mdx"].includes(document.languageId) && ["file", "untitled"].includes(document.uri.scheme);
}

/** Returns header-only completions whose replacement offsets point into the original Markdown. */
export function getMarkdownHeaderSuggestions(text: string, offset: number): StyleSuggestion[] | undefined {
  const header = getYamlHeader(text, true);
  if (!header || offset < header.start || offset > header.end || (offset === header.end && header.end < text.length)) return undefined;
  return getStyleSuggestions(header.content, offset - header.start, MANUSCRIPT_FIELDS)
    .map((suggestion) => ({ ...suggestion, start: suggestion.start + header.start, end: suggestion.end + header.start }));
}

/** Builds header help without parsing Markdown body content as YAML. */
export function getMarkdownHeaderHoverEntries(text: string): StyleHoverInfo[] {
  const header = getYamlHeader(text, true);
  if (!header) return [];
  return getStyleHoverEntries(header.content, MANUSCRIPT_FIELDS)
    .map((entry) => ({ ...entry, start: entry.start + header.start, end: entry.end + header.start }));
}

/** Offers manuscript metadata and per-manuscript Papper settings while editing YAML frontmatter. */
export class MarkdownYamlHeaderCompletionProvider implements vscode.CompletionItemProvider {
  /** Uses the shared completion renderer after translating YAML offsets to source-document offsets. */
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] | undefined {
    if (token.isCancellationRequested || !isMarkdownEditor(document)) return undefined;
    const suggestions = getMarkdownHeaderSuggestions(document.getText(), document.offsetAt(position));
    return suggestions ? createConfigurationCompletionItems(document, suggestions) : undefined;
  }
}

/** Shows help for filled header fields while retaining only the latest parsed document version. */
export class MarkdownYamlHeaderHoverProvider implements vscode.HoverProvider {
  private readonly cache = new WeakMap<vscode.TextDocument, { version: number; entries: StyleHoverInfo[] }>();

  /** Resolves the hovered header token and leaves body hovers to existing Markdown providers. */
  provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | undefined {
    if (token.isCancellationRequested || !isMarkdownEditor(document)) return undefined;
    let cached = this.cache.get(document);
    if (!cached || cached.version !== document.version) {
      cached = { version: document.version, entries: getMarkdownHeaderHoverEntries(document.getText()) };
      this.cache.set(document, cached);
    }
    const offset = document.offsetAt(position);
    const info = cached.entries.find((entry) => entry.start <= offset && offset < entry.end);
    return info ? createConfigurationHover(document, info) : undefined;
  }
}
