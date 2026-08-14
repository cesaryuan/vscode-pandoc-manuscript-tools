import type { HeadingEntry } from "./parser";

export type HeadingFoldingRange = { start: number; end: number };

/**
 * Builds line-based folds for Pandoc Markdown ATX headings.
 *
 * The next heading at the same or a higher level closes a section. A lower-level
 * heading remains inside its parent's fold, which keeps nested navigation and
 * Sticky Scroll scopes aligned with the Pandoc heading hierarchy.
 *
 * @param headings Parsed headings in document order.
 * @param lineCount Total number of lines in the document.
 */
export function buildHeadingFoldingRanges(headings: HeadingEntry[], lineCount: number): HeadingFoldingRange[] {
  const ranges: HeadingFoldingRange[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = getHeadingSectionEndLine(heading, headings, lineCount);
    if (end > heading.line) {
      ranges.push({ start: heading.line, end });
    }
  }

  return ranges;
}

/**
 * Returns the line containing the final character of a heading's section.
 *
 * @param heading Heading whose section should be bounded.
 * @param headings All parsed headings in document order.
 * @param lineCount Total number of lines in the document.
 */
export function getHeadingSectionEndLine(heading: HeadingEntry, headings: HeadingEntry[], lineCount: number): number {
  const headingIndex = headings.indexOf(heading);
  const closingHeading = headingIndex >= 0
    ? headings.slice(headingIndex + 1).find((candidate) => candidate.level <= heading.level)
    : undefined;
  return closingHeading ? closingHeading.line - 1 : lineCount - 1;
}
