// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the context meter draws of a reading (decision 0033), apart from how: which cells are
// filled, from which one the CLI compacts, and the tooltip's sections, each row with its share of
// its section's largest. Pure, so the counts are tested without the page.
import type { ContextCalls, ContextReading } from '@shared/contracts/sessions';
import { CONTEXT_WORDS } from './context-words';

/**
 * The meter's cells: two rows, filled a column at a time from the left. Fifteen columns make the
 * strip 126 px, one and a half times "Auto reviewed" in the mode control (82 px, measured at 100 %).
 */
export const CONTEXT_COLUMNS = 15;
export const CONTEXT_ROWS = 2;
export const CONTEXT_CELLS = CONTEXT_COLUMNS * CONTEXT_ROWS;

export interface ContextCells {
  /** How many cells are filled, from the first: at least one for a context that holds anything. */
  readonly filled: number;
  /** The first cell the CLI's compaction line falls in, from which every cell is ground red; null where it gives none inside the window. */
  readonly compactFrom: number | null;
}

/** The cells of a reading, or none filled with no reading. */
export function contextCells(reading: ContextReading | undefined, cells: number = CONTEXT_CELLS): ContextCells {
  if (reading === undefined) return { filled: 0, compactFrom: null };
  const share = Math.min(1, reading.used / reading.window);
  const filled = reading.used > 0 ? Math.max(1, Math.round(share * cells)) : 0;
  const { compactAt } = reading;
  const from = compactAt == null ? null : Math.floor((compactAt / reading.window) * cells);
  return { filled, compactFrom: from === null || from >= cells ? null : from };
}

/** The share of the window used, as a whole percent. */
export const contextPercent = (reading: ContextReading): number => Math.round((reading.used / reading.window) * 100);

export interface ContextRow {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  /** Its tokens over its section's largest, from 0 to 1: how far its bar reaches. */
  readonly share: number;
}

export interface ContextSection {
  readonly key: 'parts' | 'messages' | 'lastCall' | 'calls';
  readonly title: string;
  readonly rows: readonly ContextRow[];
}

type Row = Omit<ContextRow, 'share'>;

/** Each row's share of the largest; a section of none is no section. */
function section(key: ContextSection['key'], rows: readonly Row[], largestFirst: boolean): ContextSection | null {
  if (rows.length === 0) return null;
  const largest = Math.max(...rows.map((row) => row.tokens));
  const ordered = largestFirst ? [...rows].sort((a, b) => b.tokens - a.tokens) : rows;
  return { key, title: CONTEXT_WORDS.sections[key], rows: ordered.map((row) => ({ ...row, share: largest === 0 ? 0 : row.tokens / largest })) };
}

/** A call's counts, in its rows: those the CLI did not tell apart are left out. */
function callRows(calls: ContextCalls): Row[] {
  const words = CONTEXT_WORDS.rows;
  const totalInput = calls.input + (calls.cacheRead ?? 0) + (calls.cacheWrite ?? 0);
  const cachedPercent = calls.cacheRead === undefined || totalInput === 0 ? null : Math.min(calls.cacheRead === totalInput ? 100 : 99, Math.round((calls.cacheRead / totalInput) * 100));
  return [
    { key: 'input', label: words.input, tokens: calls.input },
    ...(calls.cacheRead === undefined ? [] : [{ key: 'cacheRead', label: cachedPercent === null ? words.cacheRead : `${words.cacheRead} (${cachedPercent}%)`, tokens: calls.cacheRead }]),
    ...(calls.cacheWrite === undefined ? [] : [{ key: 'cacheWrite', label: words.cacheWrite, tokens: calls.cacheWrite }]),
    { key: 'output', label: words.output, tokens: calls.output },
    ...(calls.reasoning === undefined ? [] : [{ key: 'reasoning', label: words.reasoning, tokens: calls.reasoning }]),
  ];
}

/**
 * The tooltip's sections, in the order they stand: the parts in context in the CLI's own order, then
 * the messages, the last call and the whole chat, each largest first. A part keeps the CLI's label.
 * Messages that hold nothing yet make no section, and `Other` is left out while it is nothing.
 */
export function contextSections(reading: ContextReading): ContextSection[] {
  const words = CONTEXT_WORDS.rows;
  const { messages } = reading;
  const messageRows: Row[] = messages === undefined ? [] : [
    { key: 'toolResults', label: words.toolResults, tokens: messages.toolResults },
    { key: 'toolCalls', label: words.toolCalls, tokens: messages.toolCalls },
    { key: 'answers', label: words.answers, tokens: messages.answers },
    { key: 'prompts', label: words.prompts, tokens: messages.prompts },
    { key: 'attachments', label: words.attachments, tokens: messages.attachments },
    ...(messages.other === 0 ? [] : [{ key: 'other', label: words.other, tokens: messages.other }]),
  ];
  return [
    section('parts', (reading.parts ?? []).map((part, at) => ({ key: `part-${at}`, label: part.label, tokens: part.tokens })), false),
    section('messages', messageRows.some((row) => row.tokens > 0) ? messageRows : [], true),
    section('lastCall', reading.lastCall === undefined ? [] : callRows(reading.lastCall), true),
    section('calls', reading.calls === undefined ? [] : callRows(reading.calls), true),
  ].filter((found): found is ContextSection => found !== null);
}
