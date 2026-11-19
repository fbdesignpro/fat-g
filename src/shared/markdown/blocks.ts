// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A parsed Markdown text as blocks (docs/planning/_archive/M19.md, Design 6; C62, C65–C67): what draws
// Markdown and knows neither React nor the parser. Pure, and it imports no package: main and shared
// stay what they were, and the parser itself is the page's (src/renderer/src/markdown/parse.ts).
//
// A text is lexed whole at every update (C66), so what is drawn depends on the text alone. What is
// kept from one update to the next is the drawing, block by block (C65, C67): a block is drawn again
// only when its signature changes — its own source, or what it names. What a block names is what its
// square brackets hold: a link reference's label, an image's, a note's. A definition that arrives
// later changes the signature of the blocks that name it, and of no other.
//
// Names are read off the source by its brackets, not off the parser's tokens: a bracket that turns
// out to be no reference costs that block one drawing more when a definition of that label arrives,
// and no reference is ever missed.

/** A token as a Markdown lexer gives one: its type, and the source it was read from. Whatever else it holds is the renderer's to read. */
export interface SourceToken {
  readonly type: string;
  readonly raw: string;
}

/** One top-level block of a text. */
export interface SourceBlock<T extends SourceToken = SourceToken> {
  /** Its place among the text's blocks: what its drawing is keyed by. */
  readonly index: number;
  /** Its source: the token's own, and the blank lines after it, which belong to it. */
  readonly source: string;
  readonly token: T;
  /**
   * The lines of the text its source starts and ends on, from 1 (M19b, C41): the blank lines before
   * the first block and those after any block belong to it, as its source does. What finds a block
   * by a line, in a message as in a file.
   */
  readonly firstLine: number;
  readonly lastLine: number;
}

/** A link reference definition, as a lexer gives it by its label. */
export interface LinkDefinition {
  readonly href: string;
  readonly title?: string | null | undefined;
}

/** The token type of blank lines between blocks. */
const SPACE = 'space';

/**
 * The top-level tokens of a text as its blocks, in order. Blank lines are no block of their own:
 * they belong to the block before them, and those before the first block belong to it.
 */
export function toBlocks<T extends SourceToken>(tokens: readonly T[]): SourceBlock<T>[] {
  const blocks: { index: number; source: string; token: T; firstLine: number; lastLine: number }[] = [];
  let leading = '';
  for (const token of tokens) {
    const last = blocks.at(-1);
    if (token.type === SPACE) {
      if (last === undefined) leading += token.raw; else last.source += token.raw;
      continue;
    }
    blocks.push({ index: blocks.length, source: leading + token.raw, token, firstLine: 1, lastLine: 1 });
    leading = '';
  }
  // Counted over the sources once they are whole: a block's blank lines are its own (C41).
  let line = 1;
  for (const block of blocks) {
    const breaks = lineBreaks(block.source);
    block.firstLine = line;
    // A source that ends in a line break ends on the line that break closes.
    block.lastLine = line + Math.max(0, breaks - (block.source.endsWith('\n') ? 1 : 0));
    line += breaks;
  }
  return blocks;
}

function lineBreaks(source: string): number {
  let count = 0;
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) count += 1;
  return count;
}

/** A label as references and definitions are matched by it: its white space collapsed, and no case. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A label's longest length, in characters: CommonMark's 999. */
const MAX_LABEL = 999;
/** What one pair of square brackets holds, with no bracket inside it but an escaped one. */
const BRACKETS = /\[((?:[^[\]\\]|\\.)+)\]/g;
/** How a note's label starts inside its brackets: `[^label]`. */
export const NOTE_PREFIX = '^';

/**
 * The labels a source names: what each of its innermost pairs of square brackets holds, normalized,
 * each once, in the order they first appear. A note's keeps its `^`. A source with no bracket names none.
 */
export function namedLabels(source: string): readonly string[] {
  if (!source.includes('[')) return [];
  const labels = new Set<string>();
  for (const match of source.matchAll(BRACKETS)) {
    const inner = match[1] ?? '';
    if (inner.length > MAX_LABEL) continue;
    const label = normalizeLabel(inner);
    if (label !== '') labels.add(label);
  }
  return [...labels];
}

/** What a text's definitions and notes are, at one reading of it: what a block's names are looked up in. */
export interface Named {
  /** The link reference definitions, by normalized label. */
  readonly links: Readonly<Record<string, LinkDefinition | undefined>>;
  /** Each referenced, defined note's number, by its normalized label without the `^`. */
  readonly notes: ReadonlyMap<string, number>;
}

const FIELD = '\u0001';
const ENTRY = '\u0002';
const NAMES = '\u0000';

/**
 * What a block's drawing is cached by (C65, C67): its source, and what each label it names is at
 * this reading — a definition's address and title, a note's number, or nothing. Two readings give
 * the same signature exactly when the block draws the same. A source that names nothing known is
 * its own signature.
 */
export function signatureOf(source: string, named: Named): string {
  const labels = namedLabels(source);
  if (labels.length === 0) return source;
  const parts: string[] = [];
  for (const label of labels) {
    if (label.startsWith(NOTE_PREFIX)) {
      const number = named.notes.get(label.slice(NOTE_PREFIX.length));
      if (number !== undefined) parts.push(`${label}${FIELD}${number}`);
      continue;
    }
    // An own property alone: a label such as `constructor` names no definition.
    const link = Object.hasOwn(named.links, label) ? named.links[label] : undefined;
    if (link !== undefined) parts.push(`${label}${FIELD}${link.href}${FIELD}${link.title ?? ''}`);
  }
  return parts.length === 0 ? source : `${source}${NAMES}${parts.join(ENTRY)}`;
}

/** Whether two signatures are of one source: they differ, if at all, only in what the block names. */
export function sameSource(before: string, after: string): boolean {
  const source = (signature: string): string => { const at = signature.indexOf(NAMES); return at === -1 ? signature : signature.slice(0, at); };
  return source(before) === source(after);
}
