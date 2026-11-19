// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The parser (docs/planning/_archive/M19.md, Design 6; C28, C61, C62, C66; decision 0021): the one file that
// imports `marked`, of which fat-g uses the lexer alone. No HTML string is ever made: the tokens it
// gives are turned into React elements by render.tsx. Everything else that draws Markdown takes
// what this file answers, so another parser could replace this one here.
//
// A text is lexed whole, every time (C66): a definition, a title or a label can reach back over any
// number of earlier blocks, so no part of an earlier reading is kept. What is kept between two
// readings is the drawing alone, by each block's signature (src/shared/markdown/blocks.ts).
//
// Footnotes are fat-g's own (C28, C61): `marked` reads none, and would take a one-word note's
// definition for a link's. Two tokenizers, given to the lexer as its extensions, read a note's
// definition at the start of a block and a reference to a defined note in a line; the rules of both
// are in src/shared/markdown/notes.ts.
import { Lexer, Marked, type Token, type TokenizerThis } from 'marked';
import { type Named, signatureOf, type SourceBlock, toBlocks } from '@shared/markdown/blocks';
import { nextNoteReference, NOTE_DEFINITION, NOTE_REFERENCE, noteLabel, noteText, numberNotes } from '@shared/markdown/notes';

export type MarkdownToken = Token;

/** The token types of fat-g's own two tokenizers. */
export const NOTE_DEFINITION_TOKEN = 'noteDefinition';
export const NOTE_REFERENCE_TOKEN = 'noteReference';

/** A block of a parsed text, with what its drawing is cached by and what its names are looked up in. */
export interface ParsedBlock extends SourceBlock<MarkdownToken> {
  readonly signature: string;
  readonly named: Named;
}

/** A note that is referred to and defined: its number, and its text as inline tokens. */
export interface ParsedNote {
  readonly number: number;
  readonly label: string;
  readonly tokens: readonly MarkdownToken[];
}

export interface Parsed {
  readonly blocks: readonly ParsedBlock[];
  /** In the order of their numbers. */
  readonly notes: readonly ParsedNote[];
  /** What the list of notes is cached by. */
  readonly notesSignature: string;
  readonly named: Named;
}

/** What one reading knows of its notes: each definition, by label, and the labels referred to, in the text's order. */
interface NoteState {
  readonly defined: Map<string, { readonly text: string; readonly tokens: MarkdownToken[] }>;
  readonly references: string[];
}

const states = new WeakMap<object, NoteState>();
function stateOf(lexer: object): NoteState {
  let state = states.get(lexer);
  if (state === undefined) {
    state = { defined: new Map(), references: [] };
    states.set(lexer, state);
  }
  return state;
}

// CommonMark with GFM's tables, strikethrough, task lists and autolink literals (C29). A single
// line break is no break.
const reader = new Marked({ gfm: true, breaks: false });
reader.use({
  extensions: [
    {
      name: NOTE_DEFINITION_TOKEN,
      level: 'block',
      tokenizer(this: TokenizerThis, source: string) {
        const match = NOTE_DEFINITION.exec(source);
        if (match === null) return undefined;
        const label = noteLabel(match[1] ?? '');
        const text = noteText(match[2] ?? '');
        const tokens: MarkdownToken[] = [];
        const state = stateOf(this.lexer);
        // A label's first definition is its note, as a link's first definition is its address.
        if (!state.defined.has(label)) {
          state.defined.set(label, { text, tokens });
          this.lexer.inline(text, tokens);
        }
        return { type: NOTE_DEFINITION_TOKEN, raw: match[0], label, text, tokens };
      },
    },
    {
      name: NOTE_REFERENCE_TOKEN,
      level: 'inline',
      start(this: TokenizerThis, source: string) {
        const at = nextNoteReference(source);
        return at === -1 ? undefined : at;
      },
      tokenizer(this: TokenizerThis, source: string) {
        const match = NOTE_REFERENCE.exec(source);
        if (match === null) return undefined;
        const label = noteLabel(match[1] ?? '');
        const state = stateOf(this.lexer);
        // A reference to a note nothing defines is the text it was written as.
        if (!state.defined.has(label)) return undefined;
        state.references.push(label);
        return { type: NOTE_REFERENCE_TOKEN, raw: match[0], label };
      },
    },
  ],
});

/**
 * A text, read as Markdown: its top-level blocks, each with its signature, and its notes by number.
 * Throws what the lexer throws: the caller draws the text plain then (C37).
 */
export function parse(text: string): Parsed {
  const lexer = new Lexer(reader.defaults);
  const tokens = lexer.lex(text);
  const state = stateOf(lexer);
  const numbers = numberNotes(state.references, new Set(state.defined.keys()));
  const named: Named = { links: tokens.links, notes: numbers };
  const blocks = toBlocks<MarkdownToken>(tokens).map((block): ParsedBlock => ({ ...block, signature: signatureOf(block.source, named), named }));
  const notes = [...numbers].map(([label, number]): ParsedNote => ({ number, label, tokens: state.defined.get(label)?.tokens ?? [] }));
  const notesSignature = [...numbers].map(([label, number]) => `${number}\u0003${signatureOf(state.defined.get(label)?.text ?? '', named)}`).join('\u0004');
  return { blocks, notes, notesSignature, named };
}
