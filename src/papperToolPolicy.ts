/** PyPI mirror for Simplified Chinese systems in the UTC+8 timezone. */
export const CHINESE_PYPI_MIRROR = "https://mirrors.cernet.edu.cn/pypi/web/simple";

/**
 * Applies the mirror only when both the system locale and UTC offset match.
 * An explicit offset avoids guessing the timezone from a geographic name.
 */
export function shouldUseChinesePypiMirror(locale: string, utcOffsetMinutes: number): boolean {
  const normalizedLocale = locale.toLowerCase().replace(/_/g, "-");
  const simplifiedChinese = /^zh-(?:cn|sg|my|hans)(?:-|$)/.test(normalizedLocale);
  return simplifiedChinese && utcOffsetMinutes === 8 * 60;
}
