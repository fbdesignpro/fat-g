// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What every secretary task is made of (docs/planning/_archive/M26.md, Design 1 and round 2; decision 0028):
// its shape, the bound on the text it is given, and the parse the tasks share. A task names no
// provider and knows nothing of a session: it says what to tell the CLI, what to send it and what to
// make of its reply, so the service stays neutral and a new task is a module of its own.
//
// The models keep to an instruction loosely — M26's spike saw Codex's run to 62 characters before
// "three to six words" was added — so the parse does not trust it: it takes one line, strips what
// dresses it, and cuts a long one at a word.
import { NAME_ELLIPSIS, normalizeSessionName, SESSION_NAME_MAX_GRAPHEMES } from '@shared/contracts/names';

/**
 * A task of the secretary's: what it is told, what it is given, and what is made of its reply. Its
 * two functions are values, not methods: the service hands a task's parse to the job it starts.
 */
export interface SecretaryTask<T> {
  readonly instructions: string;
  readonly input: (source: string) => string;
  /** Null for a reply nothing can be made of. */
  readonly parse: (reply: string) => T | null;
}

/** The most of the user's text that is sent, in UTF-16 units: as Codex's own app cuts it. */
export const MAX_SOURCE_TEXT = 2_000;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A label a model may put before its answer. */
const LABEL = /^(?:session\s+)?title\s*[:\-–—]\s*/iu;
/** What dresses an answer at its start: Markdown marks, quotes, list marks. */
const LEADING = /^[\s#>*_`"'“”‘’«»\-•]+/u;
/** What dresses it at its end, a question or an exclamation mark excepted. */
const TRAILING = /[\s*_`"'“”‘’«».,:;…]+$/u;

/** The user's text, cut at a code point boundary. */
export function cutSource(text: string): string {
  let cut = '';
  for (const unit of text.trim()) {
    if (cut.length + unit.length > MAX_SOURCE_TEXT) break;
    cut += unit;
  }
  return cut;
}

/** A name within the name's bound, cut at the last word that fits where it is longer. */
function withinBound(text: string): string {
  const clusters = [...graphemes.segment(text)].map((cluster) => cluster.segment);
  if (clusters.length <= SESSION_NAME_MAX_GRAPHEMES) return text;
  const head = clusters.slice(0, SESSION_NAME_MAX_GRAPHEMES - 1).join('');
  const space = head.lastIndexOf(' ');
  // A first word longer than the bound is cut where it must be.
  return `${(space > 0 ? head.slice(0, space) : head).replace(TRAILING, '')}${NAME_ELLIPSIS}`;
}

/** A name from a reply: its first line, undressed, on one line and within the name's bound; null for nothing. */
export function parseName(reply: string): string | null {
  const line = reply.split(/\r?\n/u).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  // Dress may wrap a label, and a label dress: the leading pass runs on either side of it.
  const text = line.replace(LEADING, '').replace(LABEL, '').replace(LEADING, '').replace(TRAILING, '');
  const name = normalizeSessionName(withinBound(text.replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '').replace(/ {2,}/gu, ' ').trim()));
  return name === '' ? null : name;
}
