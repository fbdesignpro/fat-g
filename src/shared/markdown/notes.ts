// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Footnotes (docs/planning/_archive/M19.md, Design 6; C61): numbered marks in the text, and a numbered list
// of the notes after it, with no link and no way back. The parser fat-g bundles reads no footnote,
// so what one is, and which number it has, is fat-g's own. Pure, and it imports no package.
//
//   A note[^why] in the text.          a reference: drawn as its note's number
//
//   [^why]: Because it is so.          a definition: drawn in the list of notes, by that number
//
// A reference to a label with no definition is text, as it was written; a definition nothing refers
// to is drawn nowhere. Notes are numbered in the order they are first referred to, across the whole
// text, so a definition that arrives late can change the numbers of the notes after it (C61).
import { normalizeLabel } from './blocks';

/** A note's label inside its brackets: no white space and no closing bracket, 64 characters at most. */
const LABEL = '[^\\]\\s]{1,64}';

/**
 * A definition at the start of a block: `[^label]:`, then the note's text to the end of the line and
 * of each line after it, up to a blank line or the next definition. Group 1 is the label, group 2 the text.
 */
export const NOTE_DEFINITION = new RegExp(`^ {0,3}\\[\\^(${LABEL})\\]:[ \\t]*([^\\n]*(?:\\n(?![ \\t]*\\n)(?! {0,3}\\[\\^${LABEL}\\]:)[^\\n]*)*)(?:\\n+|$)`);

/** A reference at the start of what is left of a line: `[^label]`. Group 1 is the label. */
export const NOTE_REFERENCE = new RegExp(`^\\[\\^(${LABEL})\\]`);

/** Where the next reference could start in `source`, or -1: what lets a lexer stop its text there. */
export function nextNoteReference(source: string): number {
  return source.indexOf('[^');
}

/** A note's label as its references and its definition are matched by it. */
export function noteLabel(label: string): string {
  return normalizeLabel(label);
}

/** A note's text as one paragraph: its lines joined, each one's indentation gone. */
export function noteText(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ');
}

/**
 * Each note's number: 1 for the first one referred to, and so on (C61). `references` are the labels
 * referred to, in the text's order, as often as they are; only a defined note has a number.
 */
export function numberNotes(references: Iterable<string>, defined: ReadonlySet<string>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const label of references) if (defined.has(label) && !numbers.has(label)) numbers.set(label, numbers.size + 1);
  return numbers;
}
