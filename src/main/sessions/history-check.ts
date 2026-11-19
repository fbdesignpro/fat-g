// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The history check (docs/planning/_archive/M18.md, Design 6; C48–C53, C61; M15, C92–C95, C102, C120, C134;
// M20a.md, Design 6; C19, C58):
// what a provider that keeps a conversation is asked, once per session per run, so that turns made
// in its own apps are found and a conversation with nothing missing reads no message again.
//
//   1. the newest turns are listed without their items, a page at a time, newest first
//   2. a turn the store lacks, or holds unfinished or with a gap, is read with its items — its
//      messages and, where the provider's history gives them, what the session did between them;
//      one it holds whole costs nothing; one an earlier check reached ends the walk
//   3. the marks are written once, at the end, and only when the walk ended: at a reached turn, at
//      the conversation's start, or at its bound of pages (C61)
//
// A page too large to take is asked again at half its size, down to one turn; one turn that still
// does not fit is asked for as the provider's own summary of it; and one that fits as neither is
// passed over, with a line in its place. Any other failure, and an abort, end the check as failed:
// what it merged stays, and it marks nothing, so the next check lists the same turns again, reads no
// item of the ones the store now holds, and goes on to what this one never reached.
//
// It sends no event to the summary: no turn, action, worker or attention comes from history (C92).
// It names no provider, and matches nothing itself: merge.ts plans, the store writes.
import type { HistoryActivity, HistoryMessage, HistoryPlan, HistoryTurn } from '@shared/contracts/agent-events';
import type { HistoryReturnedImage } from '@shared/contracts/returned-images';
import type { HistoryAnswer, HistoryRequest } from '@shared/provider-kit/sessions';
import { type Held, listedTurn, planTurn, type ReadDetail, type TurnPlan } from '../conversations/merge';

/** A page's size, in turns (C95). */
export const HISTORY_PAGE = 8;
/** A walk gives up after this many pages: a provider that never ends its paging is not followed for ever. */
export const MAX_HISTORY_PAGES = 256;

export interface CheckTarget {
  images?(images: readonly HistoryReturnedImage[]): Promise<void>;
  /** What the store holds, read afresh at each use: a page merged a moment ago is held. */
  held(): Held;
  /** One page's plans, newest first, written in one transaction. Answers the anchor for the next older page. */
  merge(plans: readonly TurnPlan[], anchor: string | null): string | null;
  /** The marks, once (C61): the provider's ids of the turns the walk saw, and whether it reached the start. */
  mark(providerTurnIds: readonly string[], reachedStart: boolean): void;
}

export type CheckOutcome = { readonly state: 'checked'; readonly olderUnread: boolean } | { readonly state: 'failed' };

type Read = (page: HistoryRequest, signal: AbortSignal) => Promise<HistoryAnswer>;
type Page = Extract<HistoryAnswer, { kind: 'page' }>;

/** A walk that cannot go on: it failed, or was aborted. */
class Stopped extends Error {}

/** A page's turns newest first, each with its own messages and activities in the provider's order. */
function turnsOf(page: Page): { readonly turn: HistoryTurn; readonly messages: readonly HistoryMessage[]; readonly activities: readonly HistoryActivity[]; readonly plans: readonly HistoryPlan[] }[] {
  const activities = page.activities ?? [];
  const plans = page.plans ?? [];
  return [...page.turns].reverse().map((turn) => ({
    turn,
    messages: page.messages.filter((message) => message.turnId === turn.turnId),
    activities: activities.filter((activity) => activity.turnId === turn.turnId),
    plans: plans.filter((plan) => plan.turnId === turn.turnId),
  }));
}

export async function checkHistory(read: Read, target: CheckTarget, signal: AbortSignal, pageSize: number = HISTORY_PAGE, maxPages: number = MAX_HISTORY_PAGES): Promise<CheckOutcome> {
  /** The provider's ids of the turns the walk saw. */
  const seen: string[] = [];
  /** The nearest newer turn both sides hold: an unknown turn goes directly before it (C49). */
  let anchor: string | null = null;

  /** Resolves when the check is aborted: a read that never answers does not hold the walk past it. */
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  async function ask(request: HistoryRequest): Promise<Page | 'dropped'> {
    if (signal.aborted) throw new Stopped();
    const answer = await Promise.race([read(request, signal).catch((): HistoryAnswer => ({ kind: 'failed' })), aborted]);
    if (answer === 'aborted' || signal.aborted || answer.kind === 'failed') throw new Stopped();
    return answer.kind === 'dropped' ? 'dropped' : answer;
  }

  async function merge(page: Page, detail: ReadDetail): Promise<void> {
    const held = target.held();
    // A summary is the provider's own short form of a turn: its activities are none of it.
    const plans = turnsOf(page).map((read) => planTurn(read.turn, read.messages, detail, held, detail === 'full' ? read.activities : [], read.plans));
    for (const turn of page.turns) seen.push(turn.turnId);
    anchor = target.merge(plans, anchor);
    if (detail === 'full' && page.images !== undefined) await target.images?.(page.images);
  }

  /**
   * Reads `size` turns from `cursor` with their items, by the ladder for a page that is dropped.
   * Answers the cursor to what follows them, or `lost` when not even a turn's place could be read.
   */
  async function readWithItems(cursor: string | null, size: number): Promise<{ readonly next: string | null } | 'lost'> {
    const full = await ask({ cursor, size, detail: 'full' });
    if (full !== 'dropped') { await merge(full, 'full'); return { next: full.next }; }
    if (size > 1) {
      // Half as many, then the rest from where that half ended.
      const half = Math.floor(size / 2);
      const first = await readWithItems(cursor, half);
      if (first === 'lost' || first.next === null) return first;
      return readWithItems(first.next, size - half);
    }
    const summary = await ask({ cursor, size: 1, detail: 'summary' });
    if (summary !== 'dropped') { await merge(summary, 'summary'); return { next: summary.next }; }
    // Too large as either: a line stands in its place (C102).
    const place = await ask({ cursor, size: 1, detail: 'none' });
    if (place === 'dropped') return 'lost';
    await merge(place, 'passed-over');
    return { next: place.next };
  }

  /** The turns of a listing, newest first, with what the store says of each. */
  const judge = (page: Page) => turnsOf(page).map(({ turn }) => ({ turn, ...listedTurn(turn, target.held()) }));

  /** A turn the store holds whole: nothing is read, and the next unknown turn goes before it. */
  function passBy(entry: ReturnType<typeof judge>[number]): void {
    seen.push(entry.turn.turnId);
    if (entry.stored !== null) anchor = entry.stored.id;
  }

  const finish = (reachedStart: boolean, olderUnread: boolean): CheckOutcome => {
    target.mark(seen, reachedStart);
    return { state: 'checked', olderUnread };
  };

  try {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const listing = await ask({ cursor, size: pageSize, detail: 'none' });
      // Not even the turns' places could be read: what was read stays, and a line says so (C95).
      if (listing === 'dropped') return finish(false, true);
      const listed = judge(listing);
      const stopAt = listed.findIndex((entry) => entry.stop);
      const before = stopAt === -1 ? listed : listed.slice(0, stopAt);

      if (before.every((entry) => !entry.read)) {
        // Nothing missing: the page costs no item.
        for (const entry of before) passBy(entry);
      } else if (stopAt === -1 && before.every((entry) => entry.read)) {
        // Every turn of the page: read again with its items, as one page.
        const read = await readWithItems(cursor, pageSize);
        if (read === 'lost') return finish(false, true);
      } else {
        // Some of them: one turn at a time, each read alone by the cursor that leads to it.
        let at = cursor;
        for (let index = 0; index < before.length; index += 1) {
          const one = await ask({ cursor: at, size: 1, detail: 'none' });
          if (one === 'dropped') return finish(false, true);
          const [entry] = judge(one);
          if (entry === undefined || entry.stop) break;
          if (entry.read) {
            const read = await readWithItems(at, 1);
            if (read === 'lost') return finish(false, true);
          } else passBy(entry);
          if (one.next === null) break;
          at = one.next;
        }
      }

      // A turn an earlier check reached: everything older was seen then.
      if (stopAt !== -1) return finish(false, false);
      if (listing.next === null) return finish(true, false);
      cursor = listing.next;
    }
    // The bound: what was seen is marked, and what lies past it stays unread, as in M15.
    return finish(false, true);
  } catch {
    // It failed or was aborted, or the store could not take a page: nothing is marked (C61).
    return { state: 'failed' };
  }
}
