// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An aside (docs/planning/_archive/M20b.md, Design 1, 7; C4, C8, C24, C29, C30, C36, C45, C50–C52, C75;
// decision 0025): a question asked beside a session — Explain this on a selection, or one typed
// freely — answered against what the session already holds and adding nothing to it. It is a
// conversation of its own in the conversation store, with its session as its parent, and a tab of
// its own in the artifact pane.
//
// Renderer-safe: the shapes main and the page agree on, the bounds, and fat-g's own words — the
// question an Explain this sends, and what a provider's side thread is told. Nothing here names a
// provider, and nothing here is a frame's shape.
import { z } from 'zod';
import { cutTo } from './cut';
import { MAX_TARGET } from './files';

// ── The capability (C24) ──────────────────────────────────────────────────────────────────────

/**
 * Whether a provider answers asides, and how (C11, C24). `streamed`: the answer arrives as it is
 * written, and else whole. `tools`: what the provider's route lets an aside do — nothing but answer
 * from the conversation, or read as well. A follow-up is taken by every provider that takes an aside.
 */
export type AsideCapability = 'none' | { readonly followUp: true; readonly streamed: boolean; readonly tools: 'none' | 'read-only' };

// ── The source (C29, C45, C75) ────────────────────────────────────────────────────────────────

/** A selection's text as an aside keeps it, in UTF-16 units: cut past this, with its flag (C29). */
export const MAX_EXCERPT = 20_000;
/** An aside's title, as decision 0011 bounds a name's first line (C36). */
export const MAX_ASIDE_TITLE = 60;
/** The title of a tab whose aside has no question yet (C36). */
export const NEW_ASIDE_TITLE = 'New aside';

/** What a selection was taken from (C29): a plan's tab since M22b (C26). */
export const ASIDE_SOURCE_KINDS = ['message', 'activity', 'file', 'plan'] as const;
export type AsideSourceKind = (typeof ASIDE_SOURCE_KINDS)[number];

const noControl = (value: string): boolean => !/\p{Cc}/u.test(value);
const itemId = z.string().min(1).max(128).refine(noControl, 'control character');
const line = z.number().int().min(1).max(100_000_000);
const offset = z.number().int().min(0).max(100_000_000);

/** The digest of a drawn text (C75): FNV-1a over its UTF-16 units, as eight hex digits. */
export const DIGEST = /^[0-9a-f]{8}$/;

/**
 * FNV-1a, 32 bits, over a text's UTF-16 units (C75). A check that the drawn text at a marker's
 * offsets is still what was selected, and nothing more: it protects nothing and identifies no one.
 */
export function drawnDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const refFields = {
  kind: z.enum(ASIDE_SOURCE_KINDS),
  /** A message's or an activity's item id, or a plan's id (M22b, C26); null for a file. */
  itemId: itemId.nullable(),
  /** A message's: whose it is. Null for every other kind. */
  role: z.enum(['user', 'assistant']).nullable(),
  /** An activity's: which of its two texts. Null for every other kind. */
  part: z.enum(['input', 'output']).nullable(),
  /** The worker whose item it is, where it is a worker's and not the session's own; else null. */
  workerId: z.string().min(1).max(256).refine(noControl, 'control character').nullable(),
  /** A file's real path; null for every other kind. */
  path: z.string().min(1).max(MAX_TARGET).nullable(),
  /** The source lines the selection touches, first to last, where the drawing carries them (C45). */
  lines: z.strictObject({ first: line, last: line }).refine((value) => value.last >= value.first, 'last before first').nullable(),
  /** Where the selection lies in its source's drawn text (C75): its start and its end, in UTF-16 units. */
  range: z.strictObject({ start: offset, end: offset }).refine((value) => value.end >= value.start, 'end before start'),
  /** The digest of the drawn text between them (C75). */
  digest: z.string().regex(DIGEST),
  /** A plan's: the version the selection was drawn from (M22b, C26). Left out, or null, for every other kind. */
  version: z.number().int().min(1).max(100_000).nullable().optional(),
};

/** Each kind has the fields that are its own, and none of another's. */
function wellFormed(value: { readonly kind: AsideSourceKind; readonly itemId: string | null; readonly role: string | null; readonly part: string | null; readonly workerId: string | null; readonly path: string | null; readonly version?: number | null | undefined }): boolean {
  const version = value.version ?? null;
  switch (value.kind) {
    case 'message': return value.itemId !== null && value.role !== null && value.part === null && value.path === null && version === null;
    case 'activity': return value.itemId !== null && value.role === null && value.part !== null && value.path === null && version === null;
    case 'file': return value.itemId === null && value.role === null && value.part === null && value.workerId === null && value.path !== null && version === null;
    case 'plan': return value.itemId !== null && value.role === null && value.part === null && value.workerId === null && value.path === null && version !== null;
  }
}

/**
 * Where an aside came from, without its text (C30): what a marker carries. The offsets and the
 * digest say where the selection lay in the drawing — what the highlight is painted from (C75) —
 * and are no part of what makes two selections the same.
 */
export const AsideSourceRefSchema = z.strictObject(refFields).refine(wellFormed, 'fields of another kind');
export type AsideSourceRef = z.infer<typeof AsideSourceRefSchema>;

/** A selection's report (C45), and an aside's source as the store keeps it (C29): the place, and the text selected. */
export const AsideSourceSchema = z.strictObject({
  ...refFields,
  /** The selection's text, cut to its bound. */
  excerpt: z.string().min(1).max(MAX_EXCERPT),
  cut: z.boolean(),
}).refine(wellFormed, 'fields of another kind');
export type AsideSource = z.infer<typeof AsideSourceSchema>;

/** A source without its text: what the store's read for the markers answers. */
export function sourceRef(source: AsideSource): AsideSourceRef {
  const { excerpt: _excerpt, cut: _cut, ...ref } = source;
  return ref;
}

type Placed = Pick<AsideSourceRef, 'kind' | 'itemId' | 'part' | 'path' | 'lines'> & Partial<Pick<AsideSourceRef, 'version'>>;

/** The same place (C50): the same thing, and the same lines of it. Whose item it is follows from its id. */
export function samePlace(a: Placed, b: Placed): boolean {
  return a.kind === b.kind && a.itemId === b.itemId && a.part === b.part && a.path === b.path && (a.version ?? null) === (b.version ?? null) && a.lines?.first === b.lines?.first && a.lines?.last === b.lines?.last;
}

/**
 * The same selection again (C50): the same source, the same lines and the same text. Two sentences
 * of one paragraph share their lines and are two selections; the same lines of a file whose text
 * has changed since are another one too.
 */
export function sameSelection(a: Placed & Pick<AsideSource, 'excerpt'>, b: Placed & Pick<AsideSource, 'excerpt'>): boolean {
  return samePlace(a, b) && a.excerpt === b.excerpt;
}

/** A selection's text as a report carries it (C29): cut to its bound, never between the halves of a pair. */
export function cutExcerpt(text: string): { readonly excerpt: string; readonly cut: boolean } {
  const cut = cutTo(text, MAX_EXCERPT);
  return { excerpt: cut.text, cut: cut.cut };
}

// ── The marker (C30) ──────────────────────────────────────────────────────────────────────────

/**
 * An aside as a session's read carries it (C30): enough to draw its marker, its highlight and its
 * restored tab's title, and none of its text. `source` is null for a question typed freely.
 */
export interface AsideMarker {
  readonly id: string;
  readonly title: string;
  readonly source: AsideSourceRef | null;
  readonly createdAt: number;
  /** A turn of it runs. */
  readonly running: boolean;
}

/** An aside as its own read answers it (C31): the marker, with the excerpt. */
export interface AsideView {
  readonly id: string;
  readonly title: string;
  readonly source: AsideSource | null;
  readonly createdAt: number;
  readonly running: boolean;
}

/** What the title of an aside begun by Explain this starts with: it says what the item is, before what it is about. */
export const EXPLAINED_TITLE = 'Explained: ';

/**
 * An aside's title (C36): for one begun by Explain this, "Explained: " and the first line that holds
 * anything of its excerpt; for a question asked freely, the first such line of the question. Cut to
 * its bound, the word before the excerpt counted in it.
 */
export function asideTitle(source: Pick<AsideSource, 'excerpt'> | null, question: string): string {
  const from = source?.excerpt ?? question;
  const first = from.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? '';
  if (first === '') return NEW_ASIDE_TITLE;
  return cutTo(source === null ? first : `${EXPLAINED_TITLE}${first}`, MAX_ASIDE_TITLE).text.trimEnd();
}

// ── fat-g's words (C51, C52) ──────────────────────────────────────────────────────────────────

/**
 * How the seed question names where its passage came from (C51). `path` is the file's, as it is
 * shown: relative to the session's folder where it is inside it.
 */
export function sourcePhrase(source: Pick<AsideSourceRef, 'kind' | 'role' | 'part' | 'lines'> & Partial<Pick<AsideSourceRef, 'version'>>, path: string | null): string {
  switch (source.kind) {
    case 'message': return source.role === 'user' ? 'my earlier message' : 'your earlier answer';
    case 'activity': return source.part === 'input' ? 'the input of an action in this conversation' : 'the output of an action in this conversation';
    case 'file': {
      const named = `the file ${path ?? ''}`.trimEnd();
      return source.lines === null ? named : `${named}, lines ${source.lines.first}–${source.lines.last}`;
    }
    // The plan's version (M22b, C26): what the conversation knows as the plan it proposed or was given.
    case 'plan': return source.version == null ? 'a plan in this conversation' : `version ${source.version} of a plan in this conversation`;
  }
}

/**
 * The question an Explain this sends, and shows as the aside's first (C51): where the passage came
 * from, the passage with each line quoted, and the ask. The excerpt always travels: a provider's
 * side thread may hold nothing of the turn the passage lies in (C8).
 */
export function seedQuestion(phrase: string, excerpt: string): string {
  const quoted = excerpt.split(/\r?\n/).map((part) => (part === '' ? '>' : `> ${part}`)).join('\n');
  return `This is a question beside the conversation, about a passage in ${phrase}. Answer it briefly from what the conversation already holds, and take no action.\n\n${quoted}\n\nExplain this passage.`;
}

/** What a provider's side thread is told, where its route takes an instruction (C52). */
export const ASIDE_INSTRUCTIONS = 'You are answering a question asked beside a conversation, not continuing it. Answer briefly from what the conversation already holds. Take no action: run no command and change no file. Reading a file to answer is acceptable.';

/**
 * A follow-up's question for a side thread that holds nothing of the aside (C22): the earlier
 * questions and answers before it, in fat-g's words, each pair in order — the form K3 sent, which
 * its side thread answered knowing both.
 */
export function withEarlier(history: readonly { readonly question: string; readonly response: string }[], question: string): string {
  if (history.length === 0) return question;
  const earlier = history.map((pair) => `Earlier in this side conversation, I asked:\n\n${pair.question}\n\nAnd you answered:\n\n${pair.response}`).join('\n\n');
  return `${earlier}\n\n${question}`;
}

/** What an aside's tab says of what it may do, in one line (C11, C37). */
export function capabilityWords(capability: AsideCapability): string {
  if (capability === 'none') return '';
  return capability.tools === 'none' ? 'Answers from the conversation and reads nothing.' : 'May read files and run listings; changes nothing.';
}
