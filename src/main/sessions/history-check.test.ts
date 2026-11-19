// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16, V17, V26, V28 (docs/planning/_archive/M18.md; C48–C53, C59, C61): the history check on a real store
// and a provider's history in the test's hands — what it asks, what it reads, where it stops, and
// what it marks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryAnswer, HistoryRequest } from '@shared/provider-kit/sessions';
import type { ConversationStore, NewItem } from '../conversations/store';
import { CONVERSATION as A, type Scratch, scratch } from '../conversations/test-support';
import { checkHistory, type CheckTarget, HISTORY_PAGE } from './history-check';
import { type FakeHistoryTurn, historyTurn, pagedHistory } from './runtime-test-support';

let area: Scratch;
let store: ConversationStore;
let asked: HistoryRequest[];
beforeEach(() => {
  area = scratch();
  store = area.open();
  asked = [];
});
afterEach(() => { area.dispose(); });

const NOT_SHOWN = 'A reply here was too large to show.';
const target = (): CheckTarget => ({
  held: () => store.held(A),
  merge: (plans, anchor) => store.mergePage(A, plans, anchor, NOT_SHOWN).anchor,
  mark: (ids, start) => store.markReached(A, ids, start),
});
type History = (reference: string, page: HistoryRequest) => HistoryAnswer | Promise<HistoryAnswer>;
/** One check of the conversation, with every request it made recorded. */
function check(history: History, signal: AbortSignal = new AbortController().signal, pageSize?: number, maxPages?: number) {
  store.ensure(A, 1);
  return checkHistory((page) => { asked.push(page); return Promise.resolve(history('thread-1', page)); }, target(), signal, pageSize, maxPages);
}
const details = () => asked.map((page) => `${page.detail}@${page.cursor ?? 'newest'}×${page.size}`);
const itemsAsked = () => asked.filter((page) => page.detail !== 'none');

/** A turn of two messages, as the provider keeps it. `clientId`: the id the prompt was sent with. */
const made = (id: string, clientId?: string, patch: Parameters<typeof historyTurn>[2] = {}): FakeHistoryTurn => historyTurn(id, [
  { role: 'user', itemId: `${id}-q`, phase: null, text: `question of ${id}`, ...(clientId === undefined ? {} : { clientId }) },
  { role: 'assistant', itemId: `${id}-a`, phase: 'final', text: `answer of ${id}` },
], patch);
const answer = (id: string, text: string, providerItemId: string): NewItem => ({ id, kind: 'message', origin: 'local', providerItemId, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 60, providerAt: null });
/** A turn fat-g ran itself and recorded whole: the prompt echoed, the answer, the provider's end. */
function ran(id: string): void {
  store.acceptPrompt({ conversationId: A, turnId: `local-${id}`, itemId: `client-${id}`, text: `question of ${id}`, at: 50, started: false });
  store.providerTook(A, `local-${id}`, id);
  store.setProviderItemId(A, `client-${id}`, `${id}-q`);
  store.addItem(A, `local-${id}`, answer(`local-${id}-a`, `answer of ${id}`, `${id}-a`));
  store.providerEnded(A, `local-${id}`, 'completed', 70);
}
const shown = () => store.newestPage(A).items.map((item) => item.blocks[0]?.text);
const turns = () => store.newestPage(A).turns;

describe('what a check asks (V17; C51)', () => {
  it('lists the turns without their items first, and with nothing missing reads no item', async () => {
    ran('p-1');
    ran('p-2');
    expect(await check(pagedHistory([made('p-1', 'client-p-1'), made('p-2', 'client-p-2')]))).toEqual({ state: 'checked', olderUnread: false });
    expect(details()).toEqual([`none@newest×${HISTORY_PAGE}`]);
    expect(shown()).toHaveLength(4);
    // It reached the start, and marked what it saw.
    expect(turns().map((turn) => turn.reached)).toEqual([true, true]);
    expect(store.conversation(A)?.reachedStart).toBe(true);
  });

  it('finds a turn made elsewhere that is newer than every stored one, reads it and places it last', async () => {
    ran('p-1');
    await check(pagedHistory([made('p-1'), made('p-elsewhere')]));
    expect(shown()).toEqual(['question of p-1', 'answer of p-1', 'question of p-elsewhere', 'answer of p-elsewhere']);
    // The page had a turn to read and one that was whole: it was walked a turn at a time, and only the missing one read.
    expect(itemsAsked()).toEqual([{ cursor: null, size: 1, detail: 'full' }]);
  });

  it('finds a turn made elsewhere between two of fat-g’s own, though no check ever marks a turn fat-g ran', async () => {
    ran('p-1');
    ran('p-3');
    await check(pagedHistory([made('p-1'), made('p-2'), made('p-3')]));
    expect(shown()).toEqual(['question of p-1', 'answer of p-1', 'question of p-2', 'answer of p-2', 'question of p-3', 'answer of p-3']);
    expect(itemsAsked()).toEqual([{ cursor: '1', size: 1, detail: 'full' }]);
  });

  it('reads a page whose every turn is missing as one page, and goes on to the start', async () => {
    const history = Array.from({ length: 11 }, (_, n) => made(`p-${n + 1}`));
    expect(await check(pagedHistory(history))).toEqual({ state: 'checked', olderUnread: false });
    expect(details()).toEqual([`none@newest×8`, `full@newest×8`, `none@8×8`, `full@8×8`]);
    expect(shown()).toHaveLength(22);
    expect(shown().slice(0, 2)).toEqual(['question of p-1', 'answer of p-1']);
    expect(shown().at(-1)).toBe('answer of p-11');
  });

  it('stops at a turn an earlier check reached: nothing older is listed again', async () => {
    const history = Array.from({ length: 20 }, (_, n) => made(`p-${n + 1}`));
    await check(pagedHistory(history));
    asked = [];
    // Two more turns were made elsewhere since.
    expect(await check(pagedHistory([...history, made('p-21'), made('p-22')]))).toEqual({ state: 'checked', olderUnread: false });
    // One page listed; its two new turns read; the walk ended at the newest reached turn.
    expect(details()).toEqual(['none@newest×8', 'none@newest×1', 'full@newest×1', 'none@1×1', 'full@1×1']);
    expect(shown().slice(-4)).toEqual(['question of p-21', 'answer of p-21', 'question of p-22', 'answer of p-22']);
    expect(store.conversation(A)?.reachedStart).toBe(true);
  });

  it('asks nothing more of an empty history, and marks the start', async () => {
    expect(await check(pagedHistory([]))).toEqual({ state: 'checked', olderUnread: false });
    expect(asked).toHaveLength(1);
    expect(store.conversation(A)?.reachedStart).toBe(true);
  });
});

describe('a turn the store holds without the provider’s end (V17, V26; C16, C51, C59)', () => {
  it('reads again a turn an adapter ended itself, and it takes the outcome the provider gives', async () => {
    // The turn's end was lost: the session's end is stored, the provider's is not.
    store.acceptPrompt({ conversationId: A, turnId: 'local-1', itemId: 'client-1', text: 'question of p-1', at: 50, started: false });
    store.providerTook(A, 'local-1', 'p-1');
    store.sessionEnded(A, 'local-1', 70, 'failed');
    expect(store.turn(A, 'local-1')).toMatchObject({ providerOutcome: null, sessionOutcome: 'failed' });

    await check(pagedHistory([made('p-1', 'client-1')]));
    // The provider had finished it: its answer is read, and its outcome and times are the provider's own.
    expect(shown()).toEqual(['question of p-1', 'answer of p-1']);
    expect(store.turn(A, 'local-1')).toMatchObject({ providerOutcome: 'completed', providerStartedAt: 1_000, providerEndedAt: 3_000, sessionOutcome: 'failed' });
    expect(store.newestPage(A).items[0]).toMatchObject({ id: 'client-1', origin: 'local', providerItemId: 'p-1-q' });
  });

  it('attaches the provider’s turn to a prompt it never confirmed, by the prompt’s client id, and shows it once (C53)', async () => {
    // Killed between the request and its reply: no provider turn id, no echo.
    store.acceptPrompt({ conversationId: A, turnId: 'local-1', itemId: 'client-1', text: 'question of p-1', at: 50, started: false });
    await check(pagedHistory([made('p-1', 'client-1')]));
    expect(shown()).toEqual(['question of p-1', 'answer of p-1']);
    expect(store.turn(A, 'local-1')).toMatchObject({ providerTurnId: 'p-1', providerTook: true, providerOutcome: 'completed' });
    asked = [];
    await check(pagedHistory([made('p-1', 'client-1')]));
    expect(itemsAsked()).toEqual([]);
    expect(shown()).toHaveLength(2);
  });

  it('leaves a start that failed as it is: the provider has no such turn', async () => {
    ran('p-1');
    store.acceptPrompt({ conversationId: A, turnId: 'local-2', itemId: 'client-2', text: 'never reached the provider', at: 80, started: false });
    store.sessionEnded(A, 'local-2', 81, 'failed');
    await check(pagedHistory([made('p-1', 'client-p-1')]));
    expect(itemsAsked()).toEqual([]);
    expect(store.turn(A, 'local-2')).toMatchObject({ providerOutcome: null, providerTurnId: null, sessionOutcome: 'failed' });
    expect(shown()).toEqual(['question of p-1', 'answer of p-1', 'never reached the provider']);
  });

  it('reads again a turn with a gap, and a full read clears it', async () => {
    ran('p-1');
    store.markGap(A, 'local-p-1');
    await check(pagedHistory([made('p-1', 'client-p-1')]));
    expect(itemsAsked()).toEqual([{ cursor: null, size: 8, detail: 'full' }]);
    expect(store.turn(A, 'local-p-1')?.gap).toBe(false);
    expect(shown()).toHaveLength(2);
  });

  it('does not take an outcome the provider does not give', async () => {
    store.acceptPrompt({ conversationId: A, turnId: 'local-1', itemId: 'client-1', text: 'q', at: 50, started: false });
    store.providerTook(A, 'local-1', 'p-1');
    await check(pagedHistory([made('p-1', 'client-1', { outcome: null, endedAt: null, durationMs: null })]));
    expect(store.turn(A, 'local-1')).toMatchObject({ providerOutcome: null, providerEndedAt: null });
  });
});

describe('a page too large to take (M15, C95, C102, C120; M18, Design 6)', () => {
  it('asks again at half the size, down to one turn, then for its summary, and passes over one that fits as neither', async () => {
    const history = [made('p-1'), made('p-big'), made('p-3')];
    // Any read with items that covers the large turn is dropped; so is its summary.
    const dropped = (page: HistoryRequest, slice: readonly FakeHistoryTurn[]) => page.detail !== 'none' && slice.some((entry) => entry.turn.turnId === 'p-big');
    expect(await check(pagedHistory(history, dropped))).toEqual({ state: 'checked', olderUnread: false });
    expect(shown()).toEqual(['question of p-1', 'answer of p-1', NOT_SHOWN, 'question of p-3', 'answer of p-3']);
    expect(store.newestPage(A).items[2]).toMatchObject({ kind: 'notice', notice: 'turn-not-shown', origin: 'provider' });
    // A later check matches the passed-over turn by its id, and adds no second line.
    asked = [];
    await check(pagedHistory(history, dropped));
    expect(shown()).toHaveLength(5);
  });

  it('takes the provider’s own summary of a turn that is too large in full', async () => {
    const big = historyTurn('p-big', [
      { role: 'user', itemId: 'q', phase: null, text: 'the question' },
      { role: 'assistant', itemId: 'c', phase: 'commentary', text: 'a very long working note' },
      { role: 'assistant', itemId: 'a', phase: 'final', text: 'the answer' },
    ]);
    await check(pagedHistory([big], (page) => page.detail === 'full'));
    expect(shown()).toEqual(['the question', 'the answer']);
  });

  it('says that older messages could not be read when not even a turn’s place can be, and keeps what it read', async () => {
    const history = Array.from({ length: 10 }, (_, n) => made(`p-${n + 1}`));
    // The second listing is dropped at every size.
    const dropped = (page: HistoryRequest) => page.cursor !== null && page.detail === 'none';
    expect(await check(pagedHistory(history, dropped))).toEqual({ state: 'checked', olderUnread: true });
    expect(shown()).toHaveLength(16);
    expect(store.conversation(A)?.reachedStart).toBe(false);
  });
});

describe('the marks (V28; C61)', () => {
  const history = Array.from({ length: 20 }, (_, n) => made(`p-${n + 1}`));

  it('marks no turn when the check fails after merging pages: Try again reads no item of the turns then held, and imports the rest', async () => {
    const page = pagedHistory(history);
    // The third page of the walk fails.
    const failing: History = (reference, request) => (request.cursor === '16' ? { kind: 'failed' } : page(reference, request));
    expect(await check(failing)).toEqual({ state: 'failed' });
    expect(shown()).toHaveLength(32);
    expect(turns().some((turn) => turn.reached)).toBe(false);
    expect(store.conversation(A)?.reachedStart).toBe(false);

    asked = [];
    expect(await check(page)).toEqual({ state: 'checked', olderUnread: false });
    // The sixteen it holds are listed and not read; the four it never reached are.
    expect(details()).toEqual(['none@newest×8', 'none@8×8', 'none@16×8', 'full@16×8']);
    expect(shown()).toHaveLength(40);
    expect(shown()[0]).toBe('question of p-1');
    expect(store.newestPage(A).turns.every((turn) => turn.reached)).toBe(true);
    expect(store.conversation(A)?.reachedStart).toBe(true);
  });

  it('marks no turn when it is aborted, whenever the abort comes', async () => {
    const controller = new AbortController();
    const page = pagedHistory(history);
    const aborting: History = (reference, request) => { if (request.cursor === '8' && request.detail === 'full') controller.abort(); return page(reference, request); };
    expect(await check(aborting, controller.signal)).toEqual({ state: 'failed' });
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM turn WHERE reached = 1').get())).toEqual({ n: 0 });
    // Aborted before it began: nothing is asked.
    asked = [];
    expect(await check(page, controller.signal)).toEqual({ state: 'failed' });
    expect(asked).toEqual([]);
  });

  it('marks what it saw when its bound stops it, and says that older messages are unread', async () => {
    expect(await check(pagedHistory(history), new AbortController().signal, 8, 2)).toEqual({ state: 'checked', olderUnread: true });
    expect(shown()).toHaveLength(32);
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM turn WHERE reached = 1').get())).toEqual({ n: 16 });
    expect(store.conversation(A)?.reachedStart).toBe(false);
    // The next check ends at its newest turn: what lies past the bound stays unread, as in M15.
    asked = [];
    expect(await check(pagedHistory(history), new AbortController().signal, 8, 2)).toEqual({ state: 'checked', olderUnread: false });
    expect(details()).toEqual(['none@newest×8']);
  });

  it('fails, marking nothing, when the store cannot take a page', async () => {
    let fail = false;
    area.dispose();
    area = scratch();
    store = area.open({ hook: (point) => { if (fail && point === 'merge') throw new Error('disk full'); } });
    fail = true;
    expect(await check(pagedHistory(history))).toEqual({ state: 'failed' });
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM turn').get())).toEqual({ n: 0 });
  });
});

// V27 (docs/planning/_archive/M19.md; C68): a turn that holds a message whose whole text never arrived is not
// whole — read wherever the walk comes to it, never the walk's end — and the walk is not lengthened
// for it.
describe('a turn that holds a partial message (M19: V27; C68)', () => {
  /** A turn fat-g ran whose answer's completing frame was withheld and whose end was delivered: finished, gapless, and not whole. */
  function ranPartial(id: string): void {
    store.acceptPrompt({ conversationId: A, turnId: `local-${id}`, itemId: `client-${id}`, text: `question of ${id}`, at: 50, started: false });
    store.providerTook(A, `local-${id}`, id);
    store.setProviderItemId(A, `client-${id}`, `${id}-q`);
    store.saveProgress(A, store.reserveItem(A, `local-${id}`), { ...answer(`local-${id}-a`, `answer of`, `${id}-a`), phase: 'commentary' });
    store.providerEnded(A, `local-${id}`, 'completed', 70);
  }
  /** The turn as a provider keeps it when it has no item for the answer: Codex's, for one that was stopped. */
  const withoutAnswer = (id: string): FakeHistoryTurn => historyTurn(id, [{ role: 'user', itemId: `${id}-q`, phase: null, text: `question of ${id}`, clientId: `client-${id}` }]);
  const answerOf = (id: string) => store.newestPage(A).items.find((item) => item.id === `local-${id}-a`);

  it('is read with its items behind newer turns no check has reached, and its answer is completed where it stands', async () => {
    ran('p-1');
    ranPartial('p-2');
    ran('p-3');
    ran('p-4');
    expect(store.turn(A, 'local-p-2')).toMatchObject({ providerOutcome: 'completed', gap: false });
    expect(answerOf('p-2')).toMatchObject({ state: 'partial', blocks: [{ text: 'answer of' }] });

    expect(await check(pagedHistory(['p-1', 'p-2', 'p-3', 'p-4'].map((id) => made(id, `client-${id}`))))).toEqual({ state: 'checked', olderUnread: false });
    // The two newer turns are whole and cost no item; the partial one alone was read.
    expect(itemsAsked()).toEqual([{ cursor: '2', size: 1, detail: 'full' }]);
    expect(answerOf('p-2')).toMatchObject({ id: 'local-p-2-a', state: 'complete', phase: 'final', order: { turn: 2, item: 2 }, blocks: [{ text: 'answer of p-2' }], time: { receivedAt: 60, providerAt: null } });
    expect(shown()).toHaveLength(8);
  });

  it('is read again when an earlier check reached it, and never ends the walk', async () => {
    ran('p-1');
    ranPartial('p-2');
    // The first check finds no item for the answer: the turn stays partial, and is marked as seen.
    await check(pagedHistory([made('p-1', 'client-p-1'), withoutAnswer('p-2')]));
    expect(answerOf('p-2')).toMatchObject({ state: 'partial' });
    expect(turns().map((turn) => turn.reached)).toEqual([true, true]);

    // A later check comes to it first: reached, and still read. The walk ends at the whole turn behind it.
    asked = [];
    expect(await check(pagedHistory([made('p-1', 'client-p-1'), made('p-2', 'client-p-2')]))).toEqual({ state: 'checked', olderUnread: false });
    expect(details()).toEqual(['none@newest×8', 'none@newest×1', 'full@newest×1']);
    expect(answerOf('p-2')).toMatchObject({ state: 'complete', blocks: [{ text: 'answer of p-2' }] });
    // A third check has nothing to read: the turn is whole, and reached.
    asked = [];
    await check(pagedHistory([made('p-1', 'client-p-1'), made('p-2', 'client-p-2')]));
    expect(details()).toEqual(['none@newest×8']);
  });

  it('is not read again behind a newer whole turn a check has reached: the walk is not lengthened for it', async () => {
    ranPartial('p-1');
    ran('p-2');
    // The first check after its end comes to it, and finds no item for its answer.
    await check(pagedHistory([withoutAnswer('p-1'), made('p-2', 'client-p-2')]));
    expect(itemsAsked()).toEqual([{ cursor: '1', size: 1, detail: 'full' }]);
    expect(answerOf('p-1')).toMatchObject({ state: 'partial' });

    // The newer turn is whole and reached: the walk ends there, also when the history has since gained the answer.
    asked = [];
    expect(await check(pagedHistory([made('p-1', 'client-p-1'), made('p-2', 'client-p-2')]))).toEqual({ state: 'checked', olderUnread: false });
    expect(details()).toEqual(['none@newest×8']);
    expect(answerOf('p-1')).toMatchObject({ state: 'partial', blocks: [{ text: 'answer of' }] });
  });
});
