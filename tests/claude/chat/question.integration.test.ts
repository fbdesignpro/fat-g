// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V12, V21, V22, V26, V28, V31, V36 (docs/planning/_archive/M21.md, Design 3, 8; C11, C14, C16–C22, C50,
// C51, C59, C60, C62, C63, C65, C67, C70, C72, C75, C79): a question the model asks the user, on the
// real adapter and process layer against the replay fake, which sends K1's captures — first as the
// adapter tells it, then through the app's own runtime, request registry, chat service and
// conversation store, answered from its card. Each fault is a captured frame with one named change
// (tests/fixtures/claude/replay.mjs). Every wait is on an event: one of the session's, or a push.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ChatPush } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type GivenAnswer, NO_ANSWER, OUTCOME_WORDS, outcomeWords, type QuestionBody } from '@shared/contracts/interaction';
import type { CleanupResult } from '@shared/provider-kit/process';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { DENY_MESSAGE, USER_DECLINE_MESSAGE } from '../../../src/main/providers/claude/chat-wire';
import { type App, type AppOptions, launchApp, placeRecords, S, sessionEntry } from '../../sessions/app';
import { claudeHarness, eventually, type Harness, type HarnessOptions, processGone, READING, watch, type Watched } from './harness';

type Json = Record<string, unknown>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
  for (const spy of Object.values(log)) spy.mockClear();
});
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
const counts = (s: Watched) => (s.session as ClaudeChatSession).counts;
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const kinds = (events: readonly AgentEvent[]): string[] => events.map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type === 'question-resolved' ? `question-resolved:${event.reason}` : event.type));
const isRaised = (event: AgentEvent): boolean => event.type === 'question-raised';
/** An item's body as a question's (M22, C77): an interaction is a question or an approval, by its kind. */
const questionOf = (item: Pick<ConversationItem, 'interaction'>): QuestionBody | null => (item.interaction?.kind === 'question' ? item.interaction : null);

/** What K1's spike sent back with its `allow`, as the capture file holds it: the request's input, and the answers. */
function sentBack(name: string): Json {
  const frames = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Json }[] }).frames;
  const reply = frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response')?.frame as { response: { response: { updatedInput: Json } } };
  return reply.response.response.updatedInput;
}
const allowed = (name: string): Json => ({ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: sentBack(name) });
const denied = { subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null };

/** The second of two options: what K1 answered its first question with. */
const SECOND: readonly GivenAnswer[] = [{ options: [1], text: null }];
/** Two questions in one request, as K1 answered them: free text that is no option for the first, an option for the second. */
const BOTH: readonly GivenAnswer[] = [{ options: [], text: 'notes-3.txt' }, { options: [1], text: null }];
/** K1's three answered questions, each with the answer its spike gave, by the questions' and the options' places. */
const ASKED: readonly (readonly [name: 'm21-question-one' | 'm21-question-multi' | 'm21-question-two', prompt: 'question' | 'questionMulti' | 'questionTwo', given: readonly GivenAnswer[]])[] = [
  ['m21-question-one', 'question', SECOND],
  // Several of three: joined by a comma and a space (C18).
  ['m21-question-multi', 'questionMulti', [{ options: [0, 2], text: null }]],
  ['m21-question-two', 'questionTwo', BOTH],
];

// ── As the adapter tells it ───────────────────────────────────────────────────────────────────
describe('a question as the adapter tells it (V4; C16–C20, C59, C62, C63)', () => {
  it.each(ASKED)('raises %s’s question with its questions and its source and no activity, writes nothing until it is answered, and answers it frame for frame as K1 did', async (name, prompt, given) => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts[prompt]);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    const input = sentBack(name)['questions'] as { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[];
    expect(raised).toEqual({
      type: 'question-raised', turnId: 'turn-1', requestId: raised.requestId, sourceId: raised.sourceId, cut: false,
      questions: input.map((question) => ({ text: question.question, header: question.header, options: question.options, multiple: question.multiSelect, freeText: true, secret: false })),
    });
    // The launch offered the fifth tool, and the `init` that lists it passed the check (C16).
    expect(h.only().entry.launches[0]?.args).toContain('Read,Glob,Grep,Agent,AskUserQuestion');
    expect(s.notices()).toEqual([]);
    // The tool's use opened no activity, and nothing was written for the request: the turn is held.
    expect(of(s.events, 'activity-started')).toEqual([]);
    expect(h.only().entry.answers).toEqual([]);
    s.session.answer?.(raised.requestId, given);
    // The CLI's own word that it took the answer, 4 to 8 ms later in K1: its tool result.
    await s.until((event) => event.type === 'question-resolved');
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
    // What reached the CLI: `allow`, the request's input as it came, and the answers by each question's whole text.
    expect(h.only().entry.answers).toEqual([allowed(name)]);
    // The turn went on to what the answer led to: its reads, each opened and ended, none of them the question's.
    const reads = of(s.events, 'activity-started');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((event) => event.activityType === 'read' && event.itemId !== raised.sourceId)).toBe(true);
    expect(of(s.events, 'activity-ended').map((event) => event.status)).toEqual(reads.map(() => 'completed'));
    expect(s.events.findIndex((event) => event.type === 'question-resolved')).toBeLessThan(s.events.indexOf(reads[0] as AgentEvent));
    expect(counts(s)).toMatchObject({ refused: {}, questions: { repeated: 0, unheld: 0, failed: 0 } });
    expect(Object.values(counts(s).dropped).every((count) => count === 0)).toBe(true);
    expect(h.markers()).toEqual([]);
  });

  // M100b, V10 (C31): Skip, as K1 sent it.
  it('declines a skipped question with a `deny` in the user’s words: its error result is the CLI’s word that it took it, nothing fails, and the turn goes on to complete', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.questionDecline);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    expect(raised.questions).toHaveLength(1);
    s.session.decline?.(raised.requestId);
    await s.until((event) => event.type === 'question-resolved');
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
    // What reached the CLI is K1's own reply: `deny`, with fat-g's words and no `interrupt`.
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: USER_DECLINE_MESSAGE, error: null }]);
    expect(h.only().entry.turns).toEqual(['m100b-question-decline']);
    // The error flag is the decline's own: no failure is counted, and nothing was dropped.
    expect(counts(s)).toMatchObject({ refused: {}, questions: { repeated: 0, unheld: 0, failed: 0 } });
    expect(Object.values(counts(s).dropped).every((count) => count === 0)).toBe(true);
    expect(s.notices()).toEqual([]);
    // Replied to once: a second Skip, or an answer after it, writes nothing.
    s.session.decline?.(raised.requestId);
    s.session.answer?.(raised.requestId, SECOND);
    expect(h.only().entry.answers).toHaveLength(1);
    expect(h.markers()).toEqual([]);
  });

  it('a Stop while it waits sends `interrupt` as before: the CLI’s cancel is the Stop’s own and says nothing, and its `result` ends the turn interrupted (C20, C22)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    // No word of the question from the adapter: the turn's end is what settles its card.
    expect(of(s.events, 'question-resolved')).toEqual([]);
    expect(s.notices()).toEqual([]);
    expect(h.only().entry).toMatchObject({ turns: ['m21-question-one'], answers: [], interrupts: [{ inputOpen: true, turn: true, workers: 0 }] });
    // The request is held no longer, and nothing was dropped for the error result that followed the cancel.
    s.session.answer?.(raised.requestId, SECOND);
    expect(counts(s).questions.unheld).toBe(1);
    expect(counts(s).dropped['unopened-item']).toBe(0);
    // The process is up: the next prompt runs on it.
    s.send(h.prompts.goOn, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
    expect(h.only().entry.launches).toHaveLength(1);
    expect(h.only().entry.answers).toEqual([]);
  });

  it('questionTwice: one event for a request delivered twice, counted, and each delivery gets the same reply (C11)', async () => {
    const h = await open();
    h.control({ questionTwice: true });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    s.session.answer?.(raised.requestId, SECOND);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(of(s.events, 'question-raised')).toHaveLength(1);
    expect(counts(s).questions.repeated).toBe(1);
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one'), allowed('m21-question-one')]);
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
  });

  it('questionWorker: a request that names a worker no worker is, is the session’s own, and answered as one (C21)', async () => {
    const h = await open();
    h.control({ questionWorker: true });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    expect(raised).toMatchObject({ turnId: 'turn-1' });
    expect(raised.workerId).toBeUndefined();
    s.session.answer?.(raised.requestId, SECOND);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one')]);
    expect(counts(s).refused).toEqual({});
  });

  it('questionLate: a request that follows its turn’s `result` is refused on the wire, with the notice and a count, and no event (C11)', async () => {
    const h = await open();
    h.control({ questionLate: true });
    const s = start(h);
    s.send(h.prompts.question);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    await s.until((event) => event.type === 'notice' && event.kind === 'request-refused');
    expect(of(s.events, 'question-raised')).toEqual([]);
    expect(of(s.events, 'question-resolved')).toEqual([]);
    expect(counts(s).refused).toEqual({ can_use_tool: 1 });
    // After the turn's own end, and of no turn.
    expect(kinds(s.events).slice(-2)).toEqual(['turn-ended', 'notice:request-refused']);
    expect(of(s.events, 'notice').at(-1)).toEqual({ type: 'notice', kind: 'request-refused' });
    // The question tool's use made no activity either way: the turn's one activity is its read.
    expect(of(s.events, 'activity-started').map((event) => event.activityType)).toEqual(['read']);
    s.send(h.prompts.goOn, 2);
    await s.ended('turn-2');
    expect(h.only().entry.answers).toEqual([denied]);
  });

  it('questionsTwenty: a request a card cannot draw whole is refused, never cut, and the turn goes on (C60)', async () => {
    const h = await open();
    h.control({ questionsTwenty: true });
    const s = start(h);
    s.send(h.prompts.question);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(of(s.events, 'question-raised')).toEqual([]);
    expect(of(s.events, 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    expect(counts(s).refused).toEqual({ can_use_tool: 1 });
    expect(h.only().entry.answers).toEqual([denied]);
    expect(counts(s).dropped['unopened-item']).toBe(0);
  });

  it('optionsNine: nine options are cut to eight for the card, with its flag, and the answer is encoded from the request as it came (C7, C59)', async () => {
    const h = await open();
    h.control({ optionsNine: true });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    expect(raised.cut).toBe(true);
    expect(raised.questions[0]?.options.map((option) => option.label)).toEqual(['notes-1.txt', 'notes-2.txt', 'option-3', 'option-4', 'option-5', 'option-6', 'option-7', 'option-8']);
    s.session.answer?.(raised.requestId, [{ options: [7, 1], text: 'or the ninth' }]);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    const [answer] = h.only().entry.answers;
    expect(answer?.updatedInput?.['answers']).toEqual({ 'Which file should I read?': 'option-8, notes-2.txt, or the ninth' });
    // The nine went back as they came.
    expect((answer?.updatedInput?.['questions'] as { options: unknown[] }[])[0]?.options).toHaveLength(9);
  });

  it('questionCancel: a cancel that names it while the turn runs says `withdrawn`, and the turn goes on (C20)', async () => {
    const h = await open();
    h.control({ questionCancel: true });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'withdrawn' }]);
    expect(h.only().entry.answers).toEqual([]);
    expect(counts(s).dropped['unopened-item']).toBe(0);
  });

  it('questionResultError: an error flag on the tool result after an answer fails nothing, marks it confirmed all the same, and is counted (C19, C62)', async () => {
    const h = await open();
    h.control({ questionResultError: true });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    s.session.answer?.(raised.requestId, SECOND);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
    expect(counts(s).questions.failed).toBe(1);
    expect(of(s.events, 'activity-ended').map((event) => event.status)).toEqual(['completed']);
    expect(s.notices()).toEqual([]);
  });

  it('exitWhileAsking: a process lost with the question pending says `dropped` first, before its notice and the turn’s end (C67)', async () => {
    const h = await open();
    h.control({ exitWhileAsking: 1 });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(kinds(s.events).slice(-3)).toEqual(['question-resolved:dropped', 'notice:connection-lost', 'turn-ended']);
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'dropped' }]);
    await processGone(h, s.session);
    expect(h.only().entry).toMatchObject({ turns: ['m21-question-killed-first'], answers: [] });
  });

  it('exitAtAnswer: an answer whose line the process does not take says `dropped`, and the loss ends the turn with its notice (C14, C66, C75)', async () => {
    const h = await open();
    h.control({ exitAtAnswer: 1 });
    const s = start(h);
    s.send(h.prompts.question);
    const raised = await s.until(isRaised) as Extract<AgentEvent, { type: 'question-raised' }>;
    // The padding the fault's input carries is nothing of the card's.
    expect(raised).toMatchObject({ cut: false, questions: [{ text: 'Which file should I read?' }] });
    s.session.answer?.(raised.requestId, SECOND);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(kinds(s.events).slice(-3)).toEqual(['question-resolved:dropped', 'notice:connection-lost', 'turn-ended']);
    expect(of(s.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'dropped' }]);
    await processGone(h, s.session);
    // Nothing of the answer was taken, and nothing sends it again.
    expect(h.only().entry.answers).toEqual([]);
  });
});

// ── Through the app: the runtime, the registry, the chat service and a conversation store on disk ──
const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })]);

/** The app on the harness's adapter, with every event of its sessions and every close, for a test to wait on. */
interface Tapped {
  readonly app: App;
  readonly events: AgentEvent[];
  /** Resolves once an event of a session's matches. */
  until(match: (event: AgentEvent) => boolean, what: string): Promise<AgentEvent>;
  /** The turn's own end, the n-th the sessions told. */
  ended(n?: number): Promise<Extract<AgentEvent, { type: 'turn-ended' }>>;
  /** Resolves at the push of an interaction item that matches. */
  pushed(match: (item: ConversationItem, push: ChatPush) => boolean, what: string): Promise<ConversationItem>;
  /** Resolves once the n-th session the app opened has closed. */
  closed(n?: number): Promise<CleanupResult>;
}

function launch(h: Harness, options: Partial<AppOptions> = {}): Tapped {
  const events: AgentEvent[] = [];
  const sessions: ProviderSession[] = [];
  const waiters = new Set<() => void>();
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const tap = (session: ProviderSession): ProviderSession => { sessions.push(session); session.subscribe((event) => { events.push(event); wake(); }); return session; };
  const facet: SessionFacet = { ...h.facet, start: (start) => tap(h.facet.start(start)), resume: (resume) => tap(h.facet.resume(resume)) };
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, log, ...options });
  apps.push(app);
  app.chat.subscribe(wake);
  /** Waits on what the sessions and the chat service say, and on nothing else: each event and each push looks again. */
  const waitFor = <T>(look: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> => new Promise((resolve, reject) => {
    const check = (): void => {
      const found = look();
      if (found === undefined) return;
      clearTimeout(timer); waiters.delete(check); resolve(found);
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`${what} did not come; the sessions told ${kinds(events).join(', ')}`)); }, timeoutMs);
    waiters.add(check);
    check();
  });
  return {
    app, events,
    until: (match, what) => waitFor(() => events.find(match), what),
    ended: (n = 1) => waitFor(() => of(events, 'turn-ended')[n - 1], `the end of turn ${n}`),
    pushed: (match, what) => waitFor(() => app.pushes.flatMap((push) => ('item' in push && push.item.kind === 'interaction' && match(push.item, push) ? [push.item] : []))[0], what),
    closed: (n = 1) => waitFor(() => sessions[n - 1], `session ${n} opening`).then((session) => session.closed),
  };
}

const cards = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'interaction');
const cardOf = (app: App, id: string): ConversationItem => { const found = app.chat.interaction(S(1), id); if (found === null) throw new Error('no such card'); return found; };
const outcomeOf = (item: ConversationItem | undefined): string | undefined => item?.interaction?.outcome;
/** Every outcome a card was pushed with, in order, without repeats: what the page was told became of it. */
const told = (app: App, id: string): string[] => app.pushes.flatMap((push) => ('item' in push && push.item.id === id ? [String(push.item.interaction?.outcome)] : [])).filter((outcome, index, all) => outcome !== all[index - 1]);
const pending = (item: ConversationItem): boolean => item.interaction?.outcome === 'pending';
const said = (): string => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
const entries = (given: readonly GivenAnswer[]) => given.map((answer, question) => ({ question, options: [...answer.options], text: answer.text }));

describe('a question answered from its card (V4, V12; C17, C18, C33, C62)', () => {
  it('is a pending card in its turn that raises the session’s attention, is answered frame for frame as K1’s was, takes its mark at the tool’s result, and is there, inert, after a restart', async () => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    expect(await app.runtime.send(S(1), h.prompts.question)).toEqual({ status: 'accepted' });
    const card = await t.pushed(pending, 'the pending card');
    const raised = of(t.events, 'question-raised')[0];
    // The card: K1's question, whole, at the tool use that asked it, in the prompt's turn.
    expect(card).toMatchObject({
      kind: 'interaction', turnId: app.read(1).turns[0]?.id, workerId: null, origin: 'local', providerItemId: raised?.sourceId,
      interaction: {
        mode: 'blocking', outcome: 'pending', answers: null, cut: false, settledAt: null, confirmedAt: null, withdrawnBy: null,
        questions: [{ text: 'Which file should I read?', header: 'File choice', multiple: false, freeText: true, secret: false, options: [{ label: 'notes-1.txt', description: 'Read notes-1.txt' }, { label: 'notes-2.txt', description: 'Read notes-2.txt' }] }],
      },
    });
    expect(cards(app)).toEqual([card]);
    // The capsule's "1 question", and the line in fat-g's words: nothing of the question is in the summary.
    expect(app.summary(1)).toMatchObject({ status: 'running', attention: { kind: 'question', count: 1 }, action: { kind: 'asking', label: 'Asking a question' } });
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(true);
    // Nothing was sent: the turn is held until the user answers.
    expect(h.only().entry.answers).toEqual([]);
    expect(of(t.events, 'turn-ended')).toEqual([]);

    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    const confirmed = await t.pushed((item) => item.id === card.id && item.interaction?.confirmedAt != null, 'the answer’s mark');
    expect((await t.ended()).outcome).toBe('completed');
    await app.service.settled();
    // What reached the CLI is K1's own reply: `allow`, the input as it came, the answers by the question's whole text.
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one')]);
    expect(confirmed.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }] });
    expect(outcomeWords(cardOf(app, card.id).interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.answered);
    expect(told(app, card.id)).toEqual(['pending', 'answered']);
    // The turn as the chat keeps it: the prompt, the card, the read the answer led to, and the answer.
    expect(app.read(1).items.map((item) => (item.kind === 'message' ? `${item.role}:${item.phase}` : item.kind === 'activity' ? `activity:${item.activity?.type}` : item.kind))).toEqual(['user:null', 'interaction', 'activity:read', 'assistant:final']);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(false);
    // A second press is stale: refused, and nothing more is sent.
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(h.only().entry.answers).toHaveLength(1);
    // Nothing of the question, its options or the answer is in a log, the summary or the app state: kinds and counts.
    expect(said()).not.toMatch(/Which file|File choice|notes-\d\.txt/);
    expect(JSON.stringify(app.service.snapshot())).not.toMatch(/Which file|File choice|Read notes/);
    // The same after a restart, from the store: the card and its answer, with no process.
    const recorded = app.read(1).items;
    await app.quit();
    apps = [];
    const again = launch(h).app;
    expect(again.read(1).items).toEqual(recorded);
    expect(outcomeOf(cards(again)[0])).toBe('answered');
    expect(await again.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
    // No process was started for it, and nothing more was sent.
    expect(h.only().entry.launches).toHaveLength(1);
    expect(h.only().entry.answers).toHaveLength(1);
  }, 60_000);

  it.each(ASKED.slice(1))('answers %s from its card: several options joined, and free text beside an option of another question, as K1 sent them (C18)', async (name, prompt, given) => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    expect(await app.runtime.send(S(1), h.prompts[prompt])).toEqual({ status: 'accepted' });
    const card = await t.pushed(pending, 'the pending card');
    expect(questionOf(card)?.questions).toHaveLength(given.length);
    expect(await app.runtime.answer(S(1), card.id, entries(given))).toEqual({ status: 'answered' });
    await t.pushed((item) => item.id === card.id && item.interaction?.confirmedAt != null, 'the answer’s mark');
    expect((await t.ended()).outcome).toBe('completed');
    expect(h.only().entry.answers).toEqual([allowed(name)]);
    // The store keeps the answers by their places: the chosen options, and the text as it was typed.
    expect(questionOf(cardOf(app, card.id))?.answers).toEqual(given.map((answer) => ({ options: [...answer.options], text: answer.text, secret: false })));
  }, 60_000);

  it('refuses an answer with no question answered, one that leaves a question of the request out, and one that does not fit it, with nothing written or sent (C45, C78; M100b, C30)', async () => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.questionTwo);
    const card = await t.pushed(pending, 'the pending card');
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [], text: '  ' }, { question: 1, options: [], text: null }])).toEqual({ status: 'refused', reason: 'incomplete' });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0, 1], text: null }, { question: 1, options: [1], text: null }])).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(outcomeOf(cardOf(app, card.id))).toBe('pending');
    expect(h.only().entry.answers).toEqual([]);
    // And it is still answerable.
    expect(await app.runtime.answer(S(1), card.id, entries(BOTH))).toEqual({ status: 'answered' });
    expect((await t.ended()).outcome).toBe('completed');
    expect(h.only().entry.answers).toEqual([allowed('m21-question-two')]);
  }, 60_000);

  // M100b, V10 (C30): a question left blank beside one answered.
  it('sends a question left blank as "No answer" by its whole text, keeps it as none, and the settled card shows it so', async () => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.questionTwo);
    const card = await t.pushed(pending, 'the pending card');
    // Two questions in the one request: the capsule says two (C24).
    expect(app.summary(1)).toMatchObject({ attention: { kind: 'question', count: 2 } });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [], text: null }, { question: 1, options: [1], text: null }])).toEqual({ status: 'answered' });
    await t.pushed((item) => item.id === card.id && item.interaction?.confirmedAt != null, 'the answer’s mark');
    expect((await t.ended()).outcome).toBe('completed');
    const asked = sentBack('m21-question-two')['questions'] as { question: string; options: { label: string }[] }[];
    const sent = h.only().entry.answers[0];
    expect(sent?.behavior).toBe('allow');
    expect(sent?.updatedInput?.['answers']).toEqual({ [asked[0]?.question ?? '']: NO_ANSWER, [asked[1]?.question ?? '']: asked[1]?.options[1]?.label });
    expect(questionOf(cardOf(app, card.id))?.answers).toEqual([null, { options: [1], text: null, secret: false }]);
  }, 60_000);
});

describe('a question skipped from its card (V10; M100b, C31, C34, C35)', () => {
  it('reads "Declined: the model was told", written before the `deny` is sent; the attention goes, the turn completes, and a second Skip is refused', async () => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    expect(await app.runtime.send(S(1), h.prompts.questionDecline)).toEqual({ status: 'accepted' });
    const card = await t.pushed(pending, 'the pending card');
    expect(app.summary(1)).toMatchObject({ attention: { kind: 'question', count: 1 } });
    expect(app.runtime.dismiss(S(1), card.id)).toEqual({ status: 'dismissed' });
    // On disk before it is sent: the push that says skipped came first.
    expect(outcomeOf(cardOf(app, card.id))).toBe('dismissed');
    expect((await t.ended()).outcome).toBe('completed');
    await app.service.settled();
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: USER_DECLINE_MESSAGE, error: null }]);
    expect(told(app, card.id)).toEqual(['pending', 'dismissed']);
    expect(outcomeWords(cardOf(app, card.id).interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.declined);
    expect(questionOf(cardOf(app, card.id))?.answers).toBeNull();
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(false);
    // Stale: nothing more is sent, by a Skip or an answer.
    expect(app.runtime.dismiss(S(1), card.id)).toEqual({ status: 'refused', reason: 'not-open' });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(h.only().entry.answers).toHaveLength(1);
    // And after a restart, from the store.
    await app.quit();
    apps = [];
    const again = launch(h).app;
    expect(outcomeOf(cards(again)[0])).toBe('dismissed');
    expect(again.runtime.dismiss(S(1), card.id)).toEqual({ status: 'refused', reason: 'not-open' });
  }, 60_000);
});

describe('a question that is never answered (V4, V22; C12, C14, C20, C22, C67)', () => {
  it('reads "Withdrawn: the reply ended" after a Stop: the CLI’s cancel says nothing, and the interrupted end settles the card', async () => {
    const h = await open();
    place(h);
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(pending, 'the pending card');
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    const settled = await t.pushed((item) => item.id === card.id && !pending(item), 'the card’s outcome');
    expect(settled.interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn', answers: null });
    expect(outcomeWords(settled.interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.withdrawnByTurn);
    expect(await t.ended()).toMatchObject({ outcome: 'interrupted', reported: true });
    await app.service.settled();
    expect(of(t.events, 'question-resolved')).toEqual([]);
    expect(told(app, card.id)).toEqual(['pending', 'withdrawn']);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'interrupted' });
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    expect(h.only().entry).toMatchObject({ answers: [], interrupts: [{ turn: true }] });
    // A press on the settled card is stale, and the process stays for the next prompt.
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(h.running('chat')).toHaveLength(1);
  }, 60_000);

  it('reads "Withdrawn: the model went on without an answer" where the CLI takes the request back and the turn goes on (questionCancel)', async () => {
    const h = await open();
    place(h);
    h.control({ questionCancel: true });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(() => true, 'the card');
    const settled = await t.pushed((item) => item.id === card.id && !pending(item), 'the card’s outcome');
    expect(settled.interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'request' });
    expect(outcomeWords(settled.interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.withdrawnByRequest);
    expect((await t.ended()).outcome).toBe('completed');
    expect(told(app, card.id)).toEqual(['pending', 'withdrawn']);
  }, 60_000);

  it('reads "Not answered: the session’s process ended", never "Withdrawn", where the process is lost with it pending; and the resumed session answers nothing of it (exitWhileAsking; K1’s kill)', async () => {
    const h = await open();
    place(h);
    h.control({ exitWhileAsking: 1 });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(() => true, 'the card');
    const settled = await t.pushed((item) => item.id === card.id && !pending(item), 'the card’s outcome');
    expect(settled.interaction).toMatchObject({ outcome: 'dropped', answers: null, withdrawnBy: null });
    expect(outcomeWords(settled.interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.dropped);
    expect(await t.ended()).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    await t.closed();
    await app.service.settled();
    // In the adapter's own order: its drop before its notice and its turn's end, so no end made for the loss withdrew it.
    expect(kinds(t.events).slice(-3)).toEqual(['question-resolved:dropped', 'notice:connection-lost', 'turn-ended']);
    expect(told(app, card.id)).toEqual(['pending', 'dropped']);
    expect(app.pushes.some((push) => 'item' in push && push.item.interaction?.outcome === 'withdrawn')).toBe(false);
    expect(app.summary(1)?.attention?.kind).not.toBe('question');
    // Nothing answers it now: its request went with its process.
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
    // K1's second prompt, to the session resumed in a new process: answered in text, with no request and no new card.
    expect(await app.runtime.send(S(1), h.prompts.goOn)).toEqual({ status: 'accepted' });
    expect((await t.ended(2)).outcome).toBe('completed');
    await app.service.settled();
    const { entry } = h.only();
    expect(entry.turns).toEqual(['m21-question-killed-first', 'm21-question-killed-resumed']);
    expect(entry.launches.map((launched) => launched.resume !== null)).toEqual([false, true]);
    expect(entry.answers).toEqual([]);
    expect(cards(app).map(outcomeOf)).toEqual(['dropped']);
    expect(of(t.events, 'question-raised')).toHaveLength(1);
    // And after a restart it reads the same.
    await app.quit();
    apps = [];
    expect(cards(launch(h).app).map(outcomeOf)).toEqual(['dropped']);
  }, 90_000);
});

describe('an answer and what the CLI does with it (V26, V31; C14, C62, C66, C70, C75)', () => {
  it('reads "Not answered: the session’s process ended" where the answer’s line was not taken: answered, then dropped by the adapter’s own word, and never sent again (exitAtAnswer)', async () => {
    const h = await open();
    place(h);
    h.control({ exitAtAnswer: 1 });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(pending, 'the pending card');
    // The answer is written to the store first, and is fat-g's to take: the press is answered.
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    const settled = await t.pushed((item) => item.id === card.id && item.interaction?.outcome === 'dropped', 'the answer’s drop');
    expect(outcomeWords(settled.interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.dropped);
    // What was entered is kept with it.
    expect(questionOf(settled)?.answers).toEqual([{ options: [1], text: null, secret: false }]);
    expect(await t.ended()).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    await t.closed();
    await app.service.settled();
    expect(kinds(t.events).slice(-3)).toEqual(['question-resolved:dropped', 'notice:connection-lost', 'turn-ended']);
    expect(told(app, card.id)).toEqual(['pending', 'answered', 'dropped']);
    // Nothing of it reached the CLI, and the next prompt's process is sent no answer either.
    expect(h.only().entry.answers).toEqual([]);
    expect(await app.runtime.send(S(1), h.prompts.goOn)).toEqual({ status: 'accepted' });
    expect((await t.ended(2)).outcome).toBe('completed');
    expect(h.only().entry.answers).toEqual([]);
    expect(cards(app).map(outcomeOf)).toEqual(['dropped']);
  }, 90_000);

  it('stays "Answered" where the write went and nothing confirmed it: through the turn’s end, the idle close of its process, and a restart — never "Not answered" (noToolResult)', async () => {
    const h = await open();
    place(h);
    // The question's own result is withheld: the answer is taken, and no word of the CLI's says so.
    h.control({ noToolResult: true });
    // The process is closed as soon as the session is idle.
    const t = launch(h, { idleMs: 1 });
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(pending, 'the pending card');
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    expect((await t.ended()).outcome).toBe('completed');
    expect(await t.closed()).toEqual({ ok: true });
    await app.service.settled();
    // The CLI took the line; its turn is over, and so is its process.
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one')]);
    expect(h.running('chat')).toEqual([]);
    const kept = cardOf(app, card.id);
    expect(kept.interaction).toMatchObject({ outcome: 'answered', confirmedAt: null, answers: [{ options: [1], text: null, secret: false }] });
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    // What its card then says, the turn that carried the answer being over (C68).
    expect(outcomeWords(kept.interaction ?? { outcome: 'pending', withdrawnBy: null }, true)).toBe(OUTCOME_WORDS.unconfirmed);
    expect(of(t.events, 'question-resolved')).toEqual([]);
    expect(told(app, card.id)).toEqual(['pending', 'answered']);
    await app.quit();
    apps = [];
    expect(cards(launch(h).app)[0]?.interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
  }, 90_000);

  it('marks the answer confirmed whatever the tool result’s error flag, and fails nothing of the card (questionResultError)', async () => {
    const h = await open();
    place(h);
    h.control({ questionResultError: true });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(pending, 'the pending card');
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    const confirmed = await t.pushed((item) => item.id === card.id && item.interaction?.confirmedAt != null, 'the answer’s mark');
    expect(confirmed.interaction?.outcome).toBe('answered');
    expect((await t.ended()).outcome).toBe('completed');
  }, 60_000);
});

describe('a request main is not shown (V4; C11, C60)', () => {
  it.each([
    ['questionsTwenty', 'a request of 20 questions'],
    ['questionLate', 'a request after its turn’s end'],
  ] as const)('%s: %s makes no card and raises no attention: it is denied on the wire, and the notice stands for it', async (fault, _what) => {
    const h = await open();
    place(h);
    h.control({ [fault]: true });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    expect((await t.ended()).outcome).toBe('completed');
    await t.until((event) => event.type === 'notice' && event.kind === 'request-refused', 'the notice');
    await app.service.settled();
    expect(cards(app)).toEqual([]);
    expect(app.pushes.some((push) => 'item' in push && push.item.kind === 'interaction')).toBe(false);
    expect(app.read(1).items.filter((item) => item.kind === 'notice').map((item) => item.notice)).toEqual(['request-refused']);
    // The notice precedes the fake CLI recording our reply, especially for a request after the turn.
    await eventually(() => h.only().entry.answers.length === 1, 10_000, 'the CLI recording the refusal');
    expect(h.only().entry.answers).toEqual([denied]);
  }, 60_000);

  it('optionsNine: a card cut to eight options says so, and is answered all the same, with what was not shown typed', async () => {
    const h = await open();
    place(h);
    h.control({ optionsNine: true });
    const t = launch(h);
    const { app } = t;
    await app.runtime.send(S(1), h.prompts.question);
    const card = await t.pushed(pending, 'the pending card');
    expect(card.interaction).toMatchObject({ cut: true, questions: [{ options: { length: 8 } }] });
    // A place past what the card holds is no answer of its own; the ninth is typed.
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [8], text: null }])).toMatchObject({ status: 'refused' });
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [], text: 'option-9' }])).toEqual({ status: 'answered' });
    expect((await t.ended()).outcome).toBe('completed');
    expect(h.only().entry.answers[0]?.updatedInput?.['answers']).toEqual({ 'Which file should I read?': 'option-9' });
  }, 60_000);
});

// A sub-agent is offered no question tool, and K1's told so in its report (C21): these run the path
// a request that names a worker takes all the same, on the fake's `workerAsks`, which K1 did not
// see. The worker is K17's, which runs on after the turn that started it.
describe('a worker’s question (V21, V28, V36; C21, C65, C72, C79)', () => {
  /** K17's first turn, with its worker asking as the control says. */
  async function workerAsks(when: 'during' | 'after' | 'unconfirmed'): Promise<{ h: Harness; t: Tapped; app: App; card: ConversationItem; workerId: string; writes: readonly Promise<void>[] }> {
    const h = await open();
    const writes: Promise<void>[] = [];
    if (when === 'unconfirmed') {
      const openProcess = h.context.processes.openProcess.bind(h.context.processes);
      vi.spyOn(h.context.processes, 'openProcess').mockImplementation(async (...args) => {
        const opened = await openProcess(...args);
        const write = opened.process.write.bind(opened.process);
        vi.spyOn(opened.process, 'write').mockImplementation((...args) => {
          const written = write(...args);
          writes.push(written);
          return written;
        });
        return opened;
      });
    }
    place(h);
    h.control({ workerAsks: when });
    const t = launch(h);
    const { app } = t;
    expect(await app.runtime.send(S(1), h.prompts.self)).toEqual({ status: 'accepted' });
    const card = await t.pushed(pending, 'the worker’s pending card');
    // The parent's turn completes, and its worker runs on.
    expect(await t.ended()).toMatchObject({ outcome: 'completed', reported: true });
    await app.service.settled();
    const workerId = of(t.events, 'worker-started')[0]?.workerId ?? '';
    return { h, t, app, card, workerId, writes };
  }
  /** The item that started the worker, in the session's own chat: what says whether the worker still runs. */
  const workerItem = (app: App): ConversationItem | undefined => app.read(1).items.find((item) => item.activity?.type === 'worker');

  it.each(['during', 'after'] as const)('asked %s its parent’s turn: placed under the worker, pending and answerable after the parent’s `result`, and confirmed by the worker’s own result', async (when) => {
    const { h, t, app, card, workerId } = await workerAsks(when);
    const raised = of(t.events, 'question-raised')[0];
    const ended = t.events.findIndex((event) => event.type === 'turn-ended');
    // Before the parent's `result`, or after it: either way under the worker, in the turn that started it.
    expect(t.events.indexOf(raised as AgentEvent) < ended).toBe(when === 'during');
    expect(raised).toMatchObject({ workerId, turnId: of(t.events, 'turn-started')[0]?.turnId });
    expect(card).toMatchObject({ workerId, turnId: app.read(1).turns[0]?.id, interaction: { mode: 'blocking', outcome: 'pending', questions: [{ text: 'Which file should I read?' }] } });
    // The worker's item: in its own read, in none of the session's pages, and listed as waiting there.
    expect(cards(app)).toEqual([]);
    // Listed as a question's (M22, C36): a worker's approvals wait in the same list, told apart by their kind.
    expect(app.read(1).waiting).toEqual([{ workerId, itemId: card.id, kind: 'question' }]);
    const theirs = app.runtime.readWorker(S(1), workerId);
    expect(theirs.status === 'read' ? theirs.items.filter((item) => item.kind === 'interaction').map((item) => item.id) : theirs).toEqual([card.id]);
    expect(app.pushes.find((push) => 'item' in push && push.item.id === card.id)).toMatchObject({ workerId });
    // The parent's turn is over, the worker runs, and its question still waits: the hold outlived the turn.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(app.service.isRunning(S(1))).toBe(true);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'question', count: 1 });
    expect(app.runtime.requests.pending(S(1), card.id)).toBe(true);
    expect(h.only().entry.answers).toEqual([]);

    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    // The worker's result, by the worker's own path, with no turn of the session's in flight.
    const confirmed = await t.pushed((item) => item.id === card.id && item.interaction?.confirmedAt != null, 'the answer’s mark');
    expect(confirmed.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }] });
    expect(of(t.events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: raised?.requestId, reason: 'confirmed' }]);
    expect(t.events.findIndex((event) => event.type === 'question-resolved')).toBeGreaterThan(ended);
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one')]);
    expect(app.read(1).waiting).toEqual([]);
    expect(told(app, card.id)).toEqual(['pending', 'answered']);
    // It opened no activity of the worker's, and the worker runs still.
    expect(of(t.events, 'activity-started').some((event) => event.itemId === raised?.sourceId)).toBe(false);
    expect(of(t.events, 'worker-ended')).toEqual([]);
  }, 90_000);

  it('left unanswered, is let go at the worker’s end, which settles it "Withdrawn: the reply ended"', async () => {
    const { h, t, app, card } = await workerAsks('after');
    // No turn of the session's runs: a Stop ends its workers, and the process with them.
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    const settled = await t.pushed((item) => item.id === card.id && !pending(item), 'the card’s outcome');
    expect(settled.interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
    expect(outcomeWords(settled.interaction ?? { outcome: 'pending', withdrawnBy: null }, false)).toBe(OUTCOME_WORDS.withdrawnByTurn);
    await t.closed();
    await app.service.settled();
    // The adapter said nothing of the question: the worker's end is what settled it.
    expect(of(t.events, 'question-resolved')).toEqual([]);
    expect(kinds(t.events).slice(-2)).toEqual(['worker-ended', 'notice:workers-stopped']);
    expect(app.read(1).waiting).toEqual([]);
    expect(h.only().entry.answers).toEqual([]);
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
  }, 90_000);

  it('answered and never confirmed: "Answered" while the worker runs, and "Answered; the model did not confirm it" at the worker’s end, after a restart too (C79)', async () => {
    const { h, t, app, card, writes } = await workerAsks('unconfirmed');
    const before = t.events.length;
    expect(await app.runtime.answer(S(1), card.id, [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    // The fake took the answer. Its last-tool progress is no new executing use (M105), and does
    // not create an action or confirm the question whose result it deliberately withholds.
    await eventually(() => h.only().entry.answers.length === 1, 10_000, 'the fake receiving the worker answer');
    // Receipt can precede stdin's flush callback. Stop while that write is pending legitimately
    // drops the answer; this case needs a delivered answer whose confirmation never comes.
    await Promise.all(writes);
    expect(t.events.slice(before).filter((event) => event.type === 'question-resolved')).toEqual([]);
    // The parent's turn is over, and the worker runs.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended' });
    expect(workerItem(app)?.activity?.status).toBe('running');
    const unmarked = cardOf(app, card.id).interaction ?? { outcome: 'pending', withdrawnBy: null };
    expect(unmarked).toMatchObject({ outcome: 'answered', confirmedAt: null });
    // What carries its answer still runs: the card reads answered, whatever its own turn's state (C79).
    expect(outcomeWords(unmarked, workerItem(app)?.activity?.status !== 'running')).toBe(OUTCOME_WORDS.answered);
    expect(app.read(1).waiting).toEqual([]);
    // The worker ends with nothing confirmed.
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await t.closed();
    await app.service.settled();
    expect(workerItem(app)?.activity?.status).not.toBe('running');
    const after = cardOf(app, card.id).interaction ?? { outcome: 'pending', withdrawnBy: null };
    expect(after).toMatchObject({ outcome: 'answered', confirmedAt: null });
    expect(outcomeWords(after, workerItem(app)?.activity?.status !== 'running')).toBe(OUTCOME_WORDS.unconfirmed);
    expect(told(app, card.id)).toEqual(['pending', 'answered']);
    expect(h.only().entry.answers).toEqual([allowed('m21-question-one')]);
    await app.quit();
    apps = [];
    const again = launch(h).app;
    expect(cardOf(again, card.id).interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
    expect(workerItem(again)?.activity?.status).not.toBe('running');
  }, 90_000);
});
