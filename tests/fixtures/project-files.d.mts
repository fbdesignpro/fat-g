// What tests read of the files K2's answers name (./project-files.mjs; M19b, C46), which is plain
// JavaScript with no import so that Node, the spike and the smoke script all run it.

/** Relative path, with `/`, to text. */
export const FILES: Readonly<Record<'README.md' | 'src/tides.js' | 'field notes/harbour-log.md', string>>;
/** The line `nextHighTide` is defined on. */
export const FUNCTION_LINE: number;
/** Each Markdown file's own first heading. */
export const HEADINGS: Readonly<Record<'README.md' | 'field notes/harbour-log.md', string>>;
/** One word of each file that no captured answer holds. */
export const FILE_MARKERS: readonly string[];
