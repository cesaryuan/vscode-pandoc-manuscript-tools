/** Shared DOCX field descriptions for style YAML completion and inserted inline comments. */
export type StyleField = {
  description: string;
  values?: readonly string[];
  children?: Record<string, StyleField>;
  dynamicChildren?: boolean;
  sequenceItems?: boolean;
  dynamicValueDescription?: string;
};

const BOOLEAN_VALUES = ["true", "false"] as const;

export const DOCX_STYLE_FIELDS: Record<string, StyleField> = {
  fontFamily: { description: "字体名称，或分别指定西文和中文字体", children: {
    western: { description: "西文字体名称，例如 Times New Roman" },
    chinese: { description: "中文字体名称，例如 宋体" },
  } },
  fontName: { description: "兼容旧配置的字体名称" },
  fontSize: { description: "字体大小，例如 10.5pt、小五或四号；也可输入其他正磅值", values: ["10.5pt", "12pt", "小五", "五号", "小四", "四号", "小三", "三号"] },
  fontColor: { description: "字体颜色，例如 #000000、rgb(0, 0, 0) 或 [0, 0, 0]；十六进制颜色必须加引号", values: ['"#000000"', '"#FF0000"', '"#0000FF"'] },
  bold: { description: "是否使用粗体", values: BOOLEAN_VALUES },
  lineSpacing: { description: "行距倍数、single、one-half、double 或精确磅值", values: ["single", "one-half", "double", "1.5", "18pt"] },
  alignment: { description: "段落对齐方式", values: ["left", "center", "right", "justify", "distribute", "centre"] },
  firstLineIndentChars: { description: "Word 字符数形式的首行缩进" },
  indentation: {
    description: "长度形式的段落缩进",
    children: {
      left: { description: "左缩进，例如 0.5cm" },
      right: { description: "右缩进，例如 0.5cm" },
      firstLine: { description: "首行缩进，例如 0.5cm" },
      hanging: { description: "悬挂缩进，例如 0.5cm" },
    },
  },
  paragraphSpacing: {
    description: "段前和段后间距",
    children: {
      before: { description: "段前间距，例如 6pt" },
      after: { description: "段后间距，例如 6pt" },
    },
  },
  font: { description: "兼容旧配置的字体对象", children: { family: { description: "兼容旧配置的字体名称" } } },
};
