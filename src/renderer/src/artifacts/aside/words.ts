// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for an aside's tab (docs/planning/_archive/M20b.md, Design 6; C36, C37, C39, C42): its head
// line, its field and its buttons, the line shown while an answer is awaited, and what it says
// where nothing can be shown. What a notice says of a turn — that no answer was given, that a Stop
// was not confirmed — is main's, from the notice's kind, and arrives as the notice's own text.
import { type AsideSource, NEW_ASIDE_TITLE } from '@shared/contracts/aside';
import type { ChatAsideReadResult } from '@shared/contracts/chat';

export type AsideRefusal = Extract<ChatAsideReadResult, { status: 'refused' }>['reason'];

export const ASIDE_WORDS = {
  /** A tab whose aside has no question yet (C36). */
  title: NEW_ASIDE_TITLE,
  /** The folded context above an explanation's answer. */
  head: 'Explained excerpt',
  excerptTitle: 'Explained excerpt',
  showExcerpt: 'Show excerpt',
  hideExcerpt: 'Hide excerpt',
  /** Its list, named apart from the chat's own, which is beside it. */
  list: 'Side question’s messages',
  field: 'Follow-up question',
  placeholder: 'Ask a follow-up…',
  firstPlaceholder: 'Ask a question beside the conversation…',
  send: 'Send',
  stop: 'Stop',
  removeFailed: 'Could not remove this side question. Its tab was kept open; try closing it again.',
  /** The store holds none of it any more: it was removed, with its session's chat or by itself. */
  gone: 'This side question is no longer saved in fat-g.',
  /** The excerpt's own line, where it was cut to its bound (C29). */
  cut: 'The passage was too long to keep in full.',
  excerpt: 'The passage asked about',
} as const;

/** Why an aside's tab shows nothing, in fat-g's words. A new aside's is no refusal: it has no question yet. */
export const ASIDE_REFUSALS: Readonly<Record<Exclude<AsideRefusal, 'unknown-aside'>, string>> = {
  'unknown-session': 'This session is no longer listed.',
  'unknown-cursor': 'The earlier part of this side question could not be read.',
};

const lastPart = (path: string): string => path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path;
const linesWords = (lines: AsideSource['lines']): string => (lines === null ? '' : lines.first === lines.last ? ` line ${lines.first}` : ` lines ${lines.first}–${lines.last}`);

/** Where an aside's passage came from, as the control that comes to it reads (C37). */
export function sourceWords(source: AsideSource): string {
  switch (source.kind) {
    case 'message': return `Explaining ${source.workerId === null ? 'chat' : 'sub-agent'}${source.lines === null ? ' message' : linesWords(source.lines)}`;
    case 'activity': return source.part === 'input' ? 'Explaining an action’s input' : 'Explaining an action’s output';
    case 'file': return `Explaining ${lastPart(source.path ?? '')}${linesWords(source.lines)}`;
    // A plan's tab (M22b, C26): the version it was drawn from.
    case 'plan': return `Explaining plan version ${source.version ?? 1}${linesWords(source.lines)}`;
  }
}

/** A tab's title: the aside's own, or fat-g's word for one that has no question yet. */
export const tabTitle = (title: string | null | undefined): string => (title === null || title === undefined || title.trim() === '' ? ASIDE_WORDS.title : title);
