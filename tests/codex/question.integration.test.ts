// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V20–V22, V26, V31, V34, V35, the integration part (docs/planning/_archive/M21.md, Design 4, 8; C11, C14,
// C23–C28, C41, C56, C60, C65–C70, C75, C78): a question a Codex session asks, through the app's
// runtime, its request registry, its chat service and a conversation store on disk, on the real
// adapter and process layer against the replay fake. No test here uses the real CLI.
//
// These tests send no plan turn (M22b's are in plan.integration.test.ts), so Codex's blocking
// request is reached through the fake alone: for a turn that names no collaboration mode the fake
// chooses a capture by its prompt, so the app's ordinary turn that carries K2's plan prompt is
// answered with K2's plan turn, its request among its frames. Each fault is that request, or a message that asks, with one named change.
//
// Every wait is on what it waits for: a push of the chat's, an event of the session's, the end of
// the session's process. None is a guess at how long something takes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import { type AnswerEntry, NO_ANSWER, OUTCOME_WORDS, outcomeWords, planOf, questionOf } from '@shared/contracts/interaction';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession } from '../sessions/app';
import { codexHarness, type Harness, PROMPTS, type ThreadEntry, watch, type Watched } from './harness';

interface Captured { readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: { readonly input?: { readonly text: string }[] }; readonly result?: unknown } }
const frames = (name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
/** The prompt of a capture's `nth` turn: what makes the fake replay that turn. */
const promptAt = (name: string, nth = 0): string => frames(name).filter((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start')[nth]?.frame.params?.input?.[0]?.text ?? '';
const PLAN = promptAt('m21-codex-plan');
const ASYNC = promptAt('m21-codex-async');
/** fat-g's words for the answer K2 gave (C26): the capture's second turn was started with them. */
const ANSWER = promptAt('m21-codex-async', 1);
const TWO = promptAt('m21-codex-async-two');
const REQUEST = 'item/tool/requestUserInput';
const NOT_FOUND = { code: -32601, message: 'Method not found' };
/** The reply K2 gave its request: `answers` keyed by the question's id. */
const K2 = (() => {
  const all = frames('m21-codex-plan');
  const request = all.find((entry) => entry.dir === 'recv' && entry.frame.method === REQUEST);
  const reply = all.find((entry) => entry.dir === 'send' && entry.frame.method === undefined && entry.frame.id === request?.frame.id);
  return { id: request?.frame.id, result: reply?.frame.result };
})();
/** K2's question, as its card draws it. */
const CARD = { text: 'Which file should the plan be about?', header: 'Choose file', options: [{ label: 'notes-1.txt', description: 'Plan to summarise notes-1.txt.' }, { label: 'notes-2.txt', description: 'Plan to summarise notes-2.txt.' }], multiple: false, freeText: true, secret: false };
const SECOND: AnswerEntry[] = [{ question: 0, options: [1], text: null }];
const MODEL = 'gpt-6-astra';

let harness: Harness | undefined;
let runs: Run[] = [];
afterEach(async () => {
  for (const run of runs) { await run.app.quit(); await run.provider?.dispose(); }
  runs = [];
  await harness?.dispose();
  harness = undefined;
});

/** One run of the app, with each session its runtime made of the facet: its events, as the adapter told them. */
interface Run { readonly app: App; readonly sessions: Watched[]; readonly provider?: AgentProvider }
const dataDir = (h: Harness) => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'codex', [sessionEntry(1, 'codex', { model: MODEL })]);
function launch(h: Harness, options: { readonly own?: { readonly provider: AgentProvider; readonly facet: SessionFacet }; readonly idleMs?: number } = {}): Run {
  const base = options.own?.facet ?? h.facet;
  const sessions: Watched[] = [];
  const tap = (session: ProviderSession): ProviderSession => { sessions.push(watch(session)); return session; };
  const facet: SessionFacet = { ...base, start: (start) => tap(base.start(start)), resume: (resume) => tap(base.resume(resume)) };
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, userDefault: () => 'ask-first', ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }) });
  const run: Run = { app, sessions, ...(options.own === undefined ? {} : { provider: options.own.provider }) };
  runs.push(run);
  return run;
}
async function quit(run: Run): Promise<void> {
  runs = runs.filter((candidate) => candidate !== run);
  await run.app.quit();
  await run.provider?.dispose();
}

/**
 * Resolves at the push that makes `check` hold: looked at now, and again at each push of the chat's.
 * The time is a bound on a test that has gone wrong, and decides nothing.
 */
function atPush<T>(app: App, check: () => T | undefined | false | null, what: string, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const look = (): boolean => {
      const value = check();
      if (value === undefined || value === false || value === null) return false;
      clearTimeout(timer);
      off();
      resolve(value);
      return true;
    };
    const timer = setTimeout(() => { off(); reject(new Error(`${what} did not come`)); }, timeoutMs);
    const off = app.chat.subscribe(() => { look(); });
    look();
  });
}
const session = (run: Run): Watched => {
  const made = run.sessions.at(-1);
  if (made === undefined) throw new Error('the runtime made no session');
  return made;
};
const counts = (run: Run) => (session(run).session as CodexSession).counts;
/** The session's `n`th turn has ended, as the adapter says it: the runtime took that event in the same step. */
const ended = async (run: Run, n = 1): Promise<Extract<AgentEvent, { type: 'turn-ended' }>> => {
  const made = session(run);
  const ends = (): Extract<AgentEvent, { type: 'turn-ended' }>[] => made.events.flatMap((event) => (event.type === 'turn-ended' ? [event] : []));
  await made.until(() => ends().length >= n, 60_000);
  await run.app.service.settled();
  return ends()[n - 1] as Extract<AgentEvent, { type: 'turn-ended' }>;
};
// A question's card: the captures are plan turns, whose plan is a line of its own since M22b (C14), an interaction too.
const cards = (app: App): ConversationItem[] => app.read(1).items.filter((item) => questionOf(item) !== null);
const cardOf = (app: App, id: string): ConversationItem => {
  const found = cards(app).find((item) => item.id === id);
  if (found === undefined) throw new Error('the card is not in the chat');
  return found;
};
/**
 * A card was pushed reading `outcome` — the one named, or the first that was: the push's own item,
 * as the page is given it. A read made from inside the push that raises a card is too early for it:
 * the registry holds the request once the card is kept, which is one step later.
 */
const cardReading = (app: App, outcome: string, id?: string): Promise<ConversationItem> => atPush(app, () => app.pushes.flatMap((push) => ('item' in push && push.item.kind === 'interaction' && (id === undefined || push.item.id === id) && push.item.interaction?.outcome === outcome ? [push.item] : []))[0], `a card reading ${outcome}`);
const wordsOf = (item: ConversationItem, unconfirmed: boolean): string | null => (item.interaction === null ? null : outcomeWords(item.interaction, unconfirmed));
/** Every outcome a card was ever pushed with, in order. */
const outcomesPushed = (app: App, id: string): string[] => app.pushes.flatMap((push) => ('item' in push && push.item.id === id && push.item.interaction !== null ? [push.item.interaction.outcome] : []));
const assistants = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'message' && item.role === 'assistant');
const users = (app: App): string[] => app.read(1).items.filter((item) => item.role === 'user').map((item) => itemText(item));
const notices = (app: App): string[] => app.read(1).items.flatMap((item) => (item.notice === null ? [] : [item.notice]));
const checked = (app: App) => atPush(app, () => app.read(1).history.state === 'checked', 'the history check');

/** What the fake noted of the session's thread (replay.mjs). */
interface Asked extends ThreadEntry {
  readonly starts?: readonly { readonly capture: string; readonly text: string | null; readonly model: string | null; readonly effort: string | null; readonly mode: string | null }[];
  readonly replies?: readonly ({ readonly id: number; readonly result: unknown } | { readonly id: number; readonly error: unknown })[];
}
const thread = (h: Harness): Asked => {
  const reference = storedSession(dataDir(h), 1)?.['reference'];
  const found: Asked | undefined = typeof reference === 'string' ? h.threads()[reference] : Object.values(h.threads())[0];
  if (found === undefined) throw new Error('the fake has no thread');
  return found;
};
/** Sends a prompt and waits for the card its turn raises. */
async function asked(run: Run, prompt = PLAN): Promise<ConversationItem> {
  expect(await run.app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  return cardReading(run.app, 'pending');
}

describe('Codex’s blocking request, through the app (V5; C23, C24, C59, C62, C63)', () => {
  it('raises a card under the app’s ordinary turn, answers it frame for frame as K2 did, and marks the answer at Codex’s word', async () => {
    const h = harness = await codexHarness();
    place(h);
    const run = launch(h);
    const { app } = run;
    const card = await asked(run);
    // The app's turn was no plan turn: the prompt alone made the fake ask.
    expect(thread(h).starts).toEqual([{ capture: 'm21-codex-plan', text: PLAN, model: MODEL, effort: 'low', mode: null }]);
    expect(card).toMatchObject({ kind: 'interaction', origin: 'local', workerId: null, role: null, interaction: { mode: 'blocking', outcome: 'pending', questions: [CARD], answers: null, confirmedAt: null, answeredBy: null, withdrawnBy: null, cut: false } });
    expect(card.providerItemId).toEqual(expect.any(String));
    // In its turn, after the prompt.
    const before = app.read(1);
    expect(before.items.map((item) => item.kind)).toEqual(['message', 'interaction']);
    expect(before.items[0]?.turnId).toBe(card.turnId);
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(true);
    // The session's attention, and its line: fat-g's words for the kind, and no text of the question's.
    expect(app.summary(1)).toMatchObject({ status: 'running', attention: { kind: 'question', count: 1 }, action: { kind: 'asking', label: 'Asking a question' } });
    expect(JSON.stringify(app.summary(1))).not.toMatch(/notes-|Which file|Choose file/);
    // Nothing was written for the request yet.
    expect(thread(h).replies).toBeUndefined();

    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'answered' });
    const marked = await atPush(app, () => { const now = cardOf(app, card.id); return now.interaction?.confirmedAt != null ? now : null; }, 'the answer’s mark');
    expect(marked.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], cut: false });
    expect(wordsOf(marked, false)).toBe(OUTCOME_WORDS.answered);
    expect(await ended(run)).toMatchObject({ outcome: 'completed', reported: true });
    // What Codex was sent is what K2 sent it: `answers` by the question's own id, the option's label.
    expect(thread(h).replies).toEqual([{ id: K2.id, result: K2.result }]);
    expect(K2.result).toEqual({ answers: { notes_file: { answers: ['notes-2.txt'] } } });
    expect(session(run).events.flatMap((event) => (event.type === 'question-resolved' ? [event.reason] : []))).toEqual(['confirmed']);
    expect(outcomesPushed(app, card.id)).toEqual(['pending', 'answered', 'answered']);
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    expect(notices(app)).toEqual([]);
    // An answer is taken once (C13).
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(thread(h).replies).toHaveLength(1);

    // And it is there after a restart, as it was.
    await quit(run);
    const again = launch(h, { own: await h.adapter() });
    expect(cardOf(again.app, card.id).interaction).toEqual(marked.interaction);
    expect(await again.app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
  }, 120_000);

  it('reads “Withdrawn: the reply ended” at a Stop: the turn ends interrupted, Codex’s word follows it, and the request is never replied to (C27)', async () => {
    const h = harness = await codexHarness();
    place(h);
    const run = launch(h);
    const { app } = run;
    const card = await asked(run);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    expect(await ended(run)).toMatchObject({ outcome: 'interrupted', reported: true });
    const settled = cardOf(app, card.id);
    expect(settled.interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn', answers: null });
    expect(wordsOf(settled, false)).toBe(OUTCOME_WORDS.withdrawnByTurn);
    // The adapter said nothing of the request: main swept it at the turn's end.
    expect(session(run).events.some((event) => event.type === 'question-resolved')).toBe(false);
    expect(thread(h).replies).toBeUndefined();
    expect(thread(h).interrupts).toEqual([{ inputOpen: true, worker: false }]);
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(false);
  }, 120_000);

  it('reads “Withdrawn: the model went on without an answer” where Codex takes the request back while the turn runs (questionResolvedEarly)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ questionResolvedEarly: true });
    const run = launch(h);
    expect(await run.app.runtime.send(S(1), PLAN)).toEqual({ status: 'accepted' });
    const settled = await cardReading(run.app, 'withdrawn');
    expect(settled.interaction).toMatchObject({ withdrawnBy: 'request', answers: null });
    expect(wordsOf(settled, false)).toBe(OUTCOME_WORDS.withdrawnByRequest);
    expect(await ended(run)).toMatchObject({ outcome: 'completed', reported: true });
    expect(outcomesPushed(run.app, settled.id)).toEqual(['pending', 'withdrawn']);
    expect(thread(h).replies).toBeUndefined();
  }, 120_000);

  it('makes one card of a request delivered twice, and one reply answers it (questionTwice; C11)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ questionTwice: true });
    const run = launch(h);
    const card = await asked(run);
    expect(await run.app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'answered' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed' });
    expect(cards(run.app)).toHaveLength(1);
    expect(counts(run).questions.repeated).toBe(1);
    expect(thread(h).replies).toEqual([{ id: K2.id, result: K2.result }]);
    expect(cardOf(run.app, card.id).interaction?.confirmedAt).toEqual(expect.any(Number));
  }, 120_000);
});

describe('a request fat-g does not take (V21, V35; C11, C48, C60, C78)', () => {
  it.each(['questionWorker', 'questionsTwenty', 'optionsNineNoOther', 'noOptionsNoOther'] as const)('%s: refused on the wire with the error reply, with the notice and no card, and the turn goes on', async (fault) => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ [fault]: true });
    const run = launch(h);
    expect(await run.app.runtime.send(S(1), PLAN)).toEqual({ status: 'accepted' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed', reported: true });
    expect(thread(h).replies).toEqual([{ id: K2.id, error: NOT_FOUND }]);
    expect(cards(run.app)).toEqual([]);
    expect(notices(run.app)).toEqual(['request-refused']);
    expect(counts(run).refused).toEqual({ [REQUEST]: 1 });
    expect(session(run).events.some((event) => event.type === 'question-raised' || event.type === 'question-resolved')).toBe(false);
    expect(run.app.summary(1)?.attention?.kind).not.toBe('question');
  }, 120_000);

  it('questionLate: the session’s own request after its turn’s end is refused the same way, and raises nothing', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ questionLate: true });
    const run = launch(h);
    expect(await run.app.runtime.send(S(1), PLAN)).toEqual({ status: 'accepted' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed', reported: true });
    // The request follows the end: the adapter's notice is its word that it came, and was refused.
    await session(run).until((event) => event.type === 'notice' && event.kind === 'request-refused', 60_000);
    expect(counts(run).refused).toEqual({ [REQUEST]: 1 });
    expect(cards(run.app)).toEqual([]);
    expect(session(run).events.some((event) => event.type === 'question-raised')).toBe(false);
  }, 120_000);

  it('optionsOnly: a question of options alone is answered by an option, and a text for it is refused `mismatch` with nothing written or sent', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ optionsOnly: true });
    const run = launch(h);
    const { app } = run;
    const card = await asked(run);
    expect(questionOf(card)?.questions).toEqual([{ ...CARD, freeText: false }]);
    for (const entries of [[{ question: 0, options: [], text: 'notes-3.txt' }], [{ question: 0, options: [0], text: 'and the other' }], [{ question: 0, options: [0, 1], text: null }], [{ question: 0, options: [2], text: null }], [{ question: 0, options: [0], text: null }, { question: 1, options: [0], text: null }]] as AnswerEntry[][]) {
      expect(await app.runtime.answer(S(1), card.id, entries)).toEqual({ status: 'refused', reason: 'mismatch' });
    }
    expect(cardOf(app, card.id).interaction).toMatchObject({ outcome: 'pending', answers: null });
    expect(thread(h).replies).toBeUndefined();
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed' });
    expect(thread(h).replies).toEqual([{ id: K2.id, result: { answers: { notes_file: { answers: ['notes-1.txt'] } } } }]);
    expect(cardOf(app, card.id).interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [0], text: null, secret: false }] });
  }, 120_000);

  it('questionSecret: a secret’s answer goes to Codex, and what is kept of it is the fact alone (C8, C44)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ questionSecret: true });
    const run = launch(h);
    const { app } = run;
    const card = await asked(run);
    expect(questionOf(card)?.questions).toEqual([{ ...CARD, secret: true }]);
    // A secret draws no option: one chosen for it does not fit.
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [], text: 'correct horse battery staple' }])).toEqual({ status: 'answered' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed' });
    expect(thread(h).replies).toEqual([{ id: K2.id, result: { answers: { notes_file: { answers: ['correct horse battery staple'] } } } }]);
    expect(questionOf(cardOf(app, card.id))?.answers).toEqual([{ options: [], text: null, secret: true }]);
    expect(JSON.stringify([app.read(1), app.pushes, app.summary(1)])).not.toContain('correct horse');
  }, 120_000);
});

describe('a session’s process lost with a question (V22, V26, V31; C14, C67, C70, C75)', () => {
  const order = (run: Run): string[] => session(run).events.flatMap((event) => (event.type === 'question-resolved' ? [`question-${event.reason}`] : event.type === 'notice' ? [`notice:${event.kind}`] : event.type === 'turn-ended' ? ['turn-ended'] : []));

  it('exitWhileAsking: reads “Not answered: the session’s process ended”, never “Withdrawn” — the adapter’s `dropped` comes before its notice and its turn’s end', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ exitWhileAsking: 1 });
    const run = launch(h, { own: await h.adapter() });
    const { app } = run;
    expect(await app.runtime.send(S(1), PLAN)).toEqual({ status: 'accepted' });
    const dropped = await cardReading(app, 'dropped');
    expect(await ended(run)).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(order(run)).toEqual(['question-dropped', 'notice:connection-lost', 'turn-ended']);
    expect(dropped.interaction).toMatchObject({ outcome: 'dropped', withdrawnBy: null, answers: null });
    expect(wordsOf(dropped, false)).toBe(OUTCOME_WORDS.dropped);
    expect(outcomesPushed(app, dropped.id)).toEqual(['pending', 'dropped']);
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    expect(await app.runtime.answer(S(1), dropped.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(notices(app)).toContain('connection-lost');
    // After a restart it reads the same, and nothing of it can be answered.
    await quit(run);
    const again = launch(h, { own: await h.adapter() });
    expect(wordsOf(cardOf(again.app, dropped.id), false)).toBe(OUTCOME_WORDS.dropped);
    expect(await again.app.runtime.answer(S(1), dropped.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
  }, 120_000);

  it('exitWhileAsking, after an answer whose write went: the answer stands, unconfirmed, and nothing says “Not answered”', async () => {
    const h = harness = await codexHarness();
    place(h);
    const run = launch(h, { own: await h.adapter() });
    const { app } = run;
    const card = await asked(run);
    // Set once the request is out: the process ends as the reply arrives, before Codex's word for it.
    h.control({ exitWhileAsking: 1 });
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'answered' });
    expect(await ended(run)).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    // The reply was taken; the adapter says nothing of the request, whose hold it lets go.
    expect(thread(h).replies).toEqual([{ id: K2.id, result: K2.result }]);
    expect(order(run)).toEqual(['notice:connection-lost', 'turn-ended']);
    const answered = cardOf(app, card.id);
    expect(answered.interaction).toMatchObject({ outcome: 'answered', confirmedAt: null, answers: [{ options: [1], text: null, secret: false }] });
    // Its turn is over, and no mark came (C68).
    expect(wordsOf(answered, true)).toBe(OUTCOME_WORDS.unconfirmed);
    expect(outcomesPushed(app, card.id)).toEqual(['pending', 'answered']);
    await quit(run);
    const again = launch(h, { own: await h.adapter() });
    expect(cardOf(again.app, card.id).interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
  }, 120_000);

  it('exitAtAnswer: an answer cut off as it is written reads “Not answered: the session’s process ended”, the adapter’s `dropped` finding its item', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ exitAtAnswer: 1 });
    const run = launch(h, { own: await h.adapter() });
    const { app } = run;
    const card = await asked(run);
    // The fault's long label, cut for the card: the answer is encoded from the request as it came (C59).
    expect(card.interaction).toMatchObject({ cut: true });
    expect(questionOf(card)?.questions[0]?.options.map((option) => option.label.length)).toEqual([500, 'notes-2.txt'.length]);
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    const dropped = await cardReading(app, 'dropped', card.id);
    expect(wordsOf(dropped, false)).toBe(OUTCOME_WORDS.dropped);
    expect(await ended(run)).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(order(run)).toEqual(['question-dropped', 'notice:connection-lost', 'turn-ended']);
    expect(outcomesPushed(app, card.id)).toEqual(['pending', 'answered', 'dropped']);
    expect(counts(run).questions.unwritten).toBe(1);
    // The fake read no line of it.
    expect(thread(h).replies).toBeUndefined();
    await session(run).session.closed;
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
  }, 120_000);
});

describe('a question asked in a message (V5, V20; C26, C40, C41, C56, C68, C69)', () => {
  const ASKING = { mode: 'async', outcome: 'open', answers: null, confirmedAt: null, answeredBy: null, cut: false };
  const choice = (text: string, options: readonly string[]) => ({ text, header: null, options: options.map((label) => ({ label, description: null })), multiple: false, freeText: true, secret: false });
  const FILE = choice('Which file do you want me to read?', ['notes-1.txt', 'notes-2.txt']);

  it('makes a card after the message, and none of the empty message after it; its answer is a prompt in fat-g’s words, marked when Codex takes that prompt', async () => {
    const h = harness = await codexHarness();
    place(h);
    const run = launch(h);
    const { app } = run;
    expect(await app.runtime.send(S(1), ASYNC)).toEqual({ status: 'accepted' });
    expect(await ended(run)).toMatchObject({ outcome: 'completed', reported: true });
    const first = app.read(1);
    // The prompt, the message that asks, its card: and nothing of the message Codex ended the turn with.
    expect(first.items.map((item) => item.kind)).toEqual(['message', 'message', 'interaction']);
    const [, message, card] = first.items as [ConversationItem, ConversationItem, ConversationItem];
    expect(message).toMatchObject({ role: 'assistant', phase: 'final', state: 'complete', questions: [{ title: FILE.text, options: ['notes-1.txt', 'notes-2.txt'] }] });
    expect(card.interaction).toMatchObject({ ...ASKING, questions: [FILE] });
    expect(card.providerItemId).toBe(message.providerItemId);
    expect(card.turnId).toBe(message.turnId);
    expect(assistants(app).some((item) => itemText(item) === '')).toBe(false);
    // The empty one was opened by its start and let go at its completion: the page was told of a change, and holds no row of it.
    const opened = session(run).events.flatMap((event) => (event.type === 'message-delta' && event.text === '' ? [event.itemId] : []));
    expect(opened).toHaveLength(2);
    expect(first.items.filter((item) => opened.includes(item.providerItemId ?? '')).map((item) => item.kind)).toEqual(['message', 'interaction']);
    // No request was made, and no attention raised: the turn ended.
    expect(session(run).events.some((event) => event.type === 'question-raised')).toBe(false);
    expect(app.summary(1)?.attention?.kind).not.toBe('question');

    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'answered' });
    // The item, the prompt's record and the turn it starts, in one step.
    const answered = cardOf(app, card.id);
    const prompt = app.read(1).items.at(-1) as ConversationItem;
    expect(itemText(prompt)).toBe(ANSWER);
    expect(ANSWER).toBe('Which file do you want me to read?\nnotes-2.txt');
    expect(answered.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], answeredBy: prompt.turnId });
    // Marked at Codex's word that it took that prompt.
    const marked = await atPush(app, () => { const now = cardOf(app, card.id); return now.interaction?.confirmedAt != null ? now : null; }, 'the answer’s mark');
    expect(wordsOf(marked, false)).toBe(OUTCOME_WORDS.answered);
    expect(await ended(run, 2)).toMatchObject({ outcome: 'completed', reported: true });
    // A turn as any, with the record's model and effort.
    expect(thread(h).starts).toEqual([{ capture: 'm21-codex-async', text: ASYNC, model: MODEL, effort: 'low', mode: null }, { capture: 'm21-codex-async#2', text: ANSWER, model: MODEL, effort: 'low', mode: null }]);
    expect(assistants(app).map((item) => item.phase)).toEqual(['final', 'commentary', 'final']);
    expect(itemText(assistants(app).at(-1) as ConversationItem)).toContain('the kettle whistles twice');
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });

    // A second card, dismissed: Codex is told nothing.
    expect(await app.runtime.send(S(1), TWO)).toEqual({ status: 'accepted' });
    expect(await ended(run, 3)).toMatchObject({ outcome: 'completed' });
    const second = cards(app).at(-1) as ConversationItem;
    expect(second.interaction).toMatchObject({ ...ASKING, questions: [FILE, choice('Would you like it quoted or summarised?', ['Quoted', 'Summarised'])] });
    expect(app.runtime.dismiss(S(1), second.id)).toEqual({ status: 'dismissed' });
    expect(wordsOf(cardOf(app, second.id), false)).toBe(OUTCOME_WORDS.dismissed);
    expect(app.runtime.dismiss(S(1), second.id)).toEqual({ status: 'refused', reason: 'not-open' });
    expect(await app.runtime.answer(S(1), second.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(thread(h).turns).toEqual(['m21-codex-async', 'm21-codex-async#2', 'm21-codex-async-two']);
    // Both cards are there after a restart, inert.
    await quit(run);
    const again = launch(h, { own: await h.adapter() });
    expect(cards(again.app).map((item) => [item.id, item.interaction?.outcome])).toEqual([[card.id, 'answered'], [second.id, 'dismissed']]);
  }, 180_000);

  it('passes an open card when a later prompt is sent: the model has moved on (C41)', async () => {
    const h = harness = await codexHarness();
    place(h);
    const run = launch(h);
    const { app } = run;
    expect(await app.runtime.send(S(1), ASYNC)).toEqual({ status: 'accepted' });
    await ended(run);
    const [card] = cards(app) as [ConversationItem];
    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    const passed = cardOf(app, card.id);
    expect(passed.interaction).toMatchObject({ outcome: 'passed', answers: null });
    expect(wordsOf(passed, false)).toBe(OUTCOME_WORDS.passed);
    await ended(run, 2);
    expect(await app.runtime.answer(S(1), card.id, SECOND)).toEqual({ status: 'refused', reason: 'not-pending' });
  }, 120_000);

  it('longAsyncAnswer: refuses an answer past a prompt’s bound as `too-long`, with nothing written or sent, and takes one that fits', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ longAsyncAnswer: true });
    const run = launch(h);
    const { app } = run;
    expect(await app.runtime.send(S(1), ASYNC)).toEqual({ status: 'accepted' });
    await ended(run);
    const [card] = cards(app) as [ConversationItem];
    expect(questionOf(card)?.questions).toHaveLength(16);
    const before = app.read(1);
    const long = 'x'.repeat(10_000);
    expect(await app.runtime.answer(S(1), card.id, Array.from({ length: 16 }, (_, question) => ({ question, options: [], text: long })))).toEqual({ status: 'refused', reason: 'too-long' });
    // Nothing was written, and nothing sent: the card is as it was, and Codex ran no turn.
    expect(app.read(1).items).toEqual(before.items);
    expect(app.read(1).turns).toEqual(before.turns);
    expect(app.service.isRunning(S(1))).toBe(false);
    expect(thread(h).turns).toEqual(['m21-codex-async']);
    expect(thread(h).starts).toHaveLength(1);
    // One answer of the sixteen fits, and an async card takes an answer to any of its questions (C45).
    expect(await app.runtime.answer(S(1), card.id, Array.from({ length: 16 }, (_, question) => ({ question, options: question === 0 ? [1] : [], text: null })))).toEqual({ status: 'answered' });
    expect(await ended(run, 2)).toMatchObject({ outcome: 'completed' });
    // The capture's answer to the first, and "No answer" under each of the fifteen left blank (M100b, C30).
    const blank = (questionOf(card)?.questions ?? []).slice(1).map((question) => `${question.text}\n${NO_ANSWER}`);
    expect(users(app).at(-1)).toBe([ANSWER, ...blank].join('\n\n'));
  }, 120_000);
});

describe('a question the history holds (V5, V20, V34; C28, C41, C56)', () => {
  /** What the fake was asked of the thread's history, as `view×limit`, a cursor marked `@`. */
  const reads = (h: Harness): string[] => (thread(h).historyReads ?? []).map((read) => `${read.view}×${String(read.limit)}${read.cursor ? '@' : ''}`);
  /** One run that sends these prompts on an adapter of its own, then quits. */
  async function ran(h: Harness, prompts: readonly string[], options: { readonly idleMs?: number } = {}): Promise<Run> {
    const run = launch(h, { own: await h.adapter(), ...options });
    for (const [n, prompt] of prompts.entries()) {
      expect(await run.app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
      await ended(run, n + 1);
    }
    return run;
  }
  const outcomes = (app: App): (string | undefined)[] => cards(app).map((item) => item.interaction?.outcome);

  it('makes a card of each: passed where a turn stands after it, open where none does; no item of the empty messages; and a second read changes nothing', async () => {
    const h = harness = await codexHarness();
    place(h);
    // fat-g ran one turn of its own; K2's five were made elsewhere.
    await quit(await ran(h, [PROMPTS.t1]));
    h.control({ history: 'm21' });
    const run = launch(h);
    const { app } = run;
    await app.select(1);
    await checked(app);
    const read = app.read(1);
    expect(users(app)).toEqual([PROMPTS.t1, PLAN, PLAN, ASYNC, ANSWER, TWO]);
    // Each card directly after the message that asked, in that message's turn, under its id.
    const asking = read.items.filter((item) => item.questions.length > 0);
    expect(asking).toHaveLength(2);
    for (const message of asking) {
      const next = read.items[read.items.indexOf(message) + 1];
      expect(next).toMatchObject({ kind: 'interaction', origin: 'provider', turnId: message.turnId, providerItemId: message.providerItemId, interaction: { mode: 'async', answers: null } });
      expect((next === undefined ? null : questionOf(next))?.questions.map((question) => question.text)).toEqual(message.questions.map((question) => question.title));
    }
    // The one with one question was answered in the next turn: passed. The two-question one is the newest: open.
    expect(cards(app).map((item) => [questionOf(item)?.questions.length, item.interaction?.outcome])).toEqual([[1, 'passed'], [2, 'open']]);
    expect(cards(app).map((item) => wordsOf(item, false))).toEqual([OUTCOME_WORDS.passed, null]);
    // The history holds an empty message after each: none is an item.
    expect(assistants(app).some((item) => itemText(item) === '')).toBe(false);
    // And the answered plan turn's plan, which fat-g did not see arrive: a message, never a plan's line (M22b, C28).
    const provided = assistants(app).filter((item) => item.origin === 'provider');
    expect(provided).toHaveLength(5);
    expect(provided.filter((item) => itemText(item).startsWith('1. Read notes-2.txt'))).toHaveLength(1);
    expect(read.items.filter((item) => item.kind === 'interaction' && planOf(item) !== null)).toEqual([]);
    const made = cards(app).map((item) => item.id);

    // A second read, by the next run's check: the same items, under the same ids.
    await quit(run);
    const again = launch(h, { own: await h.adapter() });
    await again.app.select(1);
    await checked(again.app);
    expect(again.app.read(1).items).toEqual(read.items);
    // A settled card keeps its outcome through one more: the open one, dismissed.
    const open = cards(again.app).at(-1) as ConversationItem;
    expect(again.app.runtime.dismiss(S(1), open.id)).toEqual({ status: 'dismissed' });
    await quit(again);
    const third = launch(h, { own: await h.adapter() });
    await third.app.select(1);
    await checked(third.app);
    expect(outcomes(third.app)).toEqual(['passed', 'dismissed']);
    expect(cards(third.app).map((item) => item.id)).toEqual(made);
  }, 180_000);

  it('makes no second card where the store holds the message with its questions, does not read that turn again, and passes its open card when the check adds a turn after it', async () => {
    const h = harness = await codexHarness();
    place(h);
    const first = await ran(h, [ASYNC]);
    const [card] = cards(first.app) as [ConversationItem];
    expect(card.interaction?.outcome).toBe('open');
    await quit(first);
    h.control({ history: 'm21' });
    const run = launch(h);
    const { app } = run;
    await app.select(1);
    await checked(app);
    // Listed; then one turn at a time, and only the four the store lacked read with their items.
    expect(reads(h).filter((read) => read.startsWith('full'))).toEqual(['full×1', 'full×1@', 'full×1@', 'full×1@']);
    expect(reads(h)[0]).toBe('notLoaded×8');
    expect(users(app)).toEqual([PLAN, PLAN, ASYNC, ANSWER, TWO]);
    // The same card, once: passed by the turns the check added after it. And the newest turn's, open.
    expect(cards(app).map((item) => [item.id === card.id, item.origin, item.interaction?.outcome])).toEqual([[true, 'local', 'passed'], [false, 'provider', 'open']]);
    expect(cards(app).filter((item) => item.providerItemId === card.providerItemId)).toHaveLength(1);
  }, 180_000);

  it.each([
    ['with no turn after it, open', false, 'open'],
    ['with a later turn stored here that Codex never took, passed', true, 'passed'],
  ] as const)('historyPartialQuestion: completes a message that was left partial, and makes its card: %s', async (_name, later, outcome) => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ historyPartialQuestion: true });
    // Its process is closed as soon as its turn has ended, so that the next prompt reopens the session.
    const first = await ran(h, [TWO], { idleMs: 1 });
    const { app } = first;
    const partial = assistants(app);
    expect(partial).toMatchObject([{ state: 'partial', questions: [] }]);
    expect(cards(app)).toEqual([]);
    if (later) {
      await session(first).session.closed;
      // The process ends as the session is reopened: the prompt is stored, and Codex never takes it.
      h.control({ historyPartialQuestion: true, exitDuringStart: 1 });
      expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
      expect(await ended(first)).toMatchObject({ outcome: 'failed', reported: false });
      expect(app.read(1).turns.map((turn) => turn.state)).toEqual(['ended', 'unacknowledged']);
      expect(cards(app)).toEqual([]);
    }
    await quit(first);

    h.control({ history: 'm21' });
    const run = launch(h);
    await run.app.select(1);
    await checked(run.app);
    const whole = run.app.read(1).items.find((item) => item.id === partial[0]?.id);
    expect(whole).toMatchObject({ state: 'complete', origin: 'local', questions: [{ title: 'Which file do you want me to read?' }, { title: 'Would you like it quoted or summarised?' }] });
    // Its card, made at the completion, after it: by the stored order whole (C28, C41).
    const made = cards(run.app);
    expect(made.map((item) => [item.providerItemId === whole?.providerItemId, questionOf(item)?.questions.length, item.interaction?.outcome])).toEqual([[false, 1, 'passed'], [true, 2, outcome]]);
    expect(users(run.app)).toEqual([PLAN, PLAN, ASYNC, ANSWER, TWO, ...(later ? [PROMPTS.t1] : [])]);
    // The empty message its turn ended with is none here either.
    expect(assistants(run.app).some((item) => itemText(item) === '')).toBe(false);
  }, 180_000);
});
