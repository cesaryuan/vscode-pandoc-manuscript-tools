/** Display labels and groups for the settings page; configuration keys and values remain owned by the schema. */
export const SETTINGS_LABELS: Record<string, string> = {
  mathtype: "可编辑 MathType 公式", mathtypeConversionMethod: "转换后端", mathtypeSvgBackend: "SVG 渲染器",
  mathtypeTypstMathFont: "Typst 数学字体", font: "数学符号字体", calligraphicFont: "花体数学字体",
  tableAutofit: "默认表格布局", docxNativeCrossref: "Word 原生交叉引用",
  docxEmbedSvgImages: "内嵌 SVG 子图像", docxConvertSvgToPng: "SVG 转 PNG",
  docxSvgToPngWidth: "输出宽度", docxSvgToPngDpi: "输出 DPI", docxSvgToPngScale: "缩放比例",
  docxShowLineNumbers: "行号模式", docxShowPageNumbers: "页脚页码", docxPageMargins: "页面边距",
  top: "上边距", bottom: "下边距", left: "左边距", right: "右边距", inside: "内侧边距", outside: "外侧边距",
  fontFamily: "字体", western: "西文字体", chinese: "中文字体", fontName: "旧版字体名称",
  fontSize: "字号", fontColor: "字体颜色", bold: "粗体", lineSpacing: "行距", alignment: "对齐方式",
  firstLineIndentChars: "首行缩进（字符）", indentation: "段落缩进", firstLine: "首行缩进", hanging: "悬挂缩进",
  paragraphSpacing: "段落间距", before: "段前间距", after: "段后间距", family: "旧版字体名称",
  csl: "当前参考文献样式", "reference-section-title": "参考文献章节标题", "link-citations": "引文链接",
  citationNumberRangeDelimiter: "引文范围分隔符", figureTitle: "图题前缀", tableTitle: "表题前缀",
  titleDelim: "题注分隔符", figPrefix: "图引用前缀", tblPrefix: "表引用前缀", secPrefix: "章节引用前缀",
  eqnPrefix: "公式引用前缀", linkReferences: "交叉引用链接", autoSectionLabels: "自动章节标签",
  autoEqnLabels: "自动公式编号", numberSections: "章节编号", sectionsDepth: "章节编号深度",
  chapters: "按章节编号", chaptersDepth: "章节层级深度", chapDelim: "章节编号分隔符",
  subfigGrid: "子图网格布局", subfigureChildTemplate: "子图题注模板", subfigureTemplate: "父图题注模板", lang: "文档语言",
};

export const SETTINGS_GROUPS: Record<string, Array<{ title: string; keys: string[]; collapsed?: boolean }>> = {
  math: [
    { title: "转换与渲染", keys: ["mathtype", "mathtypeConversionMethod", "mathtypeSvgBackend"] },
    { title: "数学字体", keys: ["mathtypeTypstMathFont"] },
  ],
  tables: [{ title: "表格布局", keys: ["tableAutofit"] }],
  docx: [
    { title: "字体与文字", keys: ["fontFamily", "fontSize", "fontColor", "bold"] },
    { title: "段落排版", keys: ["lineSpacing", "alignment", "firstLineIndentChars", "indentation", "paragraphSpacing"] },
    { title: "旧版兼容设置", keys: ["fontName", "font"], collapsed: true },
  ],
  images: [
    { title: "图像处理", keys: ["docxEmbedSvgImages", "docxConvertSvgToPng"] },
    { title: "PNG 输出尺寸", keys: ["docxSvgToPngWidth", "docxSvgToPngDpi", "docxSvgToPngScale"] },
  ],
  layout: [
    { title: "页码与行号", keys: ["docxShowLineNumbers", "docxShowPageNumbers"] },
    { title: "页面边距", keys: ["docxPageMargins"] },
  ],
  references: [
    { title: "题注与引用文字", keys: ["figureTitle", "tableTitle", "titleDelim", "figPrefix", "tblPrefix", "secPrefix", "eqnPrefix"] },
    { title: "链接与自动标签", keys: ["linkReferences", "autoSectionLabels", "autoEqnLabels", "docxNativeCrossref"] },
    { title: "章节编号", keys: ["numberSections", "sectionsDepth", "chapters", "chaptersDepth", "chapDelim"] },
    { title: "子图与文档语言", keys: ["subfigGrid", "subfigureChildTemplate", "subfigureTemplate", "lang"] },
  ],
};
