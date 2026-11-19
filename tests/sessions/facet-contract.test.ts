// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M15.md; C7, C8, C81): the example provider, defined only under tests/support,
// implements the session facet, and passes the tests every facet passes. Codex's facet runs the
// same set against its replay fake in tests/codex/facet.integration.test.ts.
//
// It passes them in both its forms (docs/planning/_archive/M18.md, V12, V26; C6, C25, C47, C59): with a
// history to read back, and with none. The rest is what the store's tests rely on of it: whose end
// each of its turns' ends is, and what its history holds.
//
// And in the form that labels no phase (docs/planning/_archive/M16.md, V36; C74, C84): the contract takes a
// turn's answer either way, so its own change is proven here, with no CLI's fake.
//
// And telling its messages in deltas (docs/planning/_archive/M19.md, V2; C3–C6, C57): the contract folds a
// message's deltas into the message, and a message told either way reaches the chat as one message.
//
// And telling what it does (docs/planning/_archive/M20a.md, V14; C53): an activity started and ended, and a
// worker with the item that started it and its own work, through the contract and through main.
//
// And answering a question asked beside a session (docs/planning/_archive/M20b.md, V14; C24–C26): whole, and
// as it is written; an ask that completes, one stopped and one refused, through the contract.
//
// And asking the user a question (docs/planning/_archive/M21.md, V12; C30): as a request its turn waits on —
// an answer that completes, a request main refuses, one a Stop leaves to its turn's end — and in a
// message, through the contract and through main.
//
// And saying what it may do (docs/planning/_archive/M22.md, V11, V15; C35, C39): two modes under names no
// built-in provider has, its reading one among them, changed by a restart or on its live process;
// an action approved, denied, granted for the session, withdrawn, refused and dropped, through the
// contract and through main — the proof that no shared file branches on a mode's name.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtInProviders } from '../../src/main/providers';
import { EXAMPLE_ANSWER, EXAMPLE_APPROVAL, EXAMPLE_APPROVAL_PROMPT, EXAMPLE_ASIDE_ANSWER, EXAMPLE_ASK, EXAMPLE_ASKED, EXAMPLE_CHANGE_REFUSED, EXAMPLE_LOOK, type ExampleFacet, examplePermissions, EXAMPLE_DESCRIPTOR, EXAMPLE_QUESTION, EXAMPLE_QUESTION_PROMPT, EXAMPLE_EARLIER_TURN, EXAMPLE_HISTORY, EXAMPLE_NOTE, EXAMPLE_READ, EXAMPLE_REFERENCE, EXAMPLE_REPORT, exampleAsides, exampleDefinition, exampleDefinitionWithSessions, exampleFollowUpAnswer, type ExampleSessionOptions, exampleSessionFacet, EXAMPLE_PLANS } from '../support/example-provider';
import { type AgentEvent, AgentEventSchema, HistoryMessageSchema, HistoryTurnSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import { approvalOf, outcomeWords } from '@shared/contracts/interaction';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { HistoryAnswer, HistoryFacet, HistoryRequest, ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import { type App, launchApp, placeRecords, S, sessionEntry, until as untilHolds } from './app';
import { collect, describeFacetContract, type FacetHarness, foldDeltas, workFaults } from './facet-contract';

const START = { folder: '/projects/example', model: 'example-large', effort: 'quick', speed: null, otherFolders: [], mode: null, processKey: 'process-1' } as const;

describeFacetContract('the example provider', () =>
  Promise.resolve({ facet: exampleSessionFacet(), history: true, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, with no history', () =>
  Promise.resolve({ facet: exampleSessionFacet({ history: false }), history: false, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, naming its answer on the turn’s end', () =>
  Promise.resolve({ facet: exampleSessionFacet({ answer: 'named' }), history: true, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, naming its answer, with no history', () =>
  Promise.resolve({ facet: exampleSessionFacet({ answer: 'named', history: false }), history: false, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, telling its messages in deltas', () =>
  Promise.resolve({ facet: exampleSessionFacet({ messages: 'deltas' }), history: true, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, in deltas, naming its answer, with no history', () =>
  Promise.resolve({ facet: exampleSessionFacet({ messages: 'deltas', answer: 'named', history: false }), history: false, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

const context = {} as ProviderContext;

describe('the capability and the facet (C6)', () => {
  it('go together: a provider that says it has sessions has a facet, and one that does not has none', () => {
    const withSessions = exampleDefinitionWithSessions();
    expect(withSessions.descriptor.capabilities.sessions).toBe(true);
    expect(withSessions.factory(context).sessions).toBeDefined();
    expect(withSessions.factory(context).descriptor.capabilities.sessions).toBe(true);

    expect(EXAMPLE_DESCRIPTOR.capabilities.sessions).toBe(false);
    expect(exampleDefinition().factory(context).sessions).toBeUndefined();
  });

  it('go together for history too: the facet has the member exactly when the descriptor says so (M18, C6, C25)', () => {
    const withHistory = exampleDefinitionWithSessions();
    expect(withHistory.descriptor.capabilities).toMatchObject({ sessions: true, history: true });
    expect(withHistory.factory(context).descriptor.capabilities.history).toBe(true);
    expect(withHistory.factory(context).sessions?.history).toBeDefined();

    const without = exampleDefinitionWithSessions({ history: false });
    expect(without.descriptor.capabilities).toMatchObject({ sessions: true, history: false });
    expect(without.factory(context).descriptor.capabilities.history).toBe(false);
    const facet = without.factory(context).sessions;
    expect(facet).toBeDefined();
    expect(facet !== undefined && 'history' in facet).toBe(false);
    expect('history' in exampleSessionFacet({ history: false })).toBe(false);

    expect(EXAMPLE_DESCRIPTOR.capabilities.history).toBe(false);
  });

  it('holds for every built-in provider', () => {
    for (const definition of builtInProviders('0.0.0')) {
      const provider = definition.factory({ processes: { supervise: () => ({ onState: () => () => undefined, onNotification: () => () => undefined }) }, logger: { record: () => undefined }, probeDirectory: '/' } as unknown as ProviderContext);
      expect(provider.sessions !== undefined, definition.descriptor.id).toBe(definition.descriptor.capabilities.sessions);
      expect(provider.sessions?.history !== undefined, definition.descriptor.id).toBe(definition.descriptor.capabilities.history);
    }
  });
});

// ── The example provider's own (M18, C25, C47, C59) ───────────────────────────────────────────
const signal = (): AbortSignal => new AbortController().signal;
const request = (n: number) => ({ turnId: `turn-${n}`, prompt: `Prompt ${n}`, effort: 'quick', speed: null, messageId: `message-${n}` });
const start = (facet: SessionFacet) => facet.start(START);
const ends = (events: readonly AgentEvent[]) => events.filter((event) => event.type === 'turn-ended');
/** Runs a turn to its end. */
async function run(session: ProviderSession, n: number): Promise<AgentEvent[]> {
  const seen = collect(session);
  session.send(request(n));
  return (await seen.ended(`turn-${n}`)).filter((event) => !('turnId' in event) || event.turnId === `turn-${n}`);
}
/** Resolves at the session's next event that matches. */
const until = (session: ProviderSession, match: (event: AgentEvent) => boolean): Promise<void> => new Promise((resolve) => { const unsubscribe = session.subscribe((event) => { if (match(event)) { unsubscribe(); resolve(); } }); });
const commentary = (event: AgentEvent): boolean => event.type === 'message' && event.phase === 'commentary';
function historyOf(facet: SessionFacet): HistoryFacet {
  if (facet.history === undefined) throw new Error('the facet has no history');
  return facet.history;
}
async function page(facet: SessionFacet, read: Partial<HistoryRequest> = {}, reference = EXAMPLE_REFERENCE): Promise<Extract<HistoryAnswer, { kind: 'page' }>> {
  const answer = await historyOf(facet).read(reference, { cursor: null, size: 8, detail: 'full', ...read }, signal());
  if (answer.kind !== 'page') throw new Error(`the history read answered ${answer.kind}`);
  return answer;
}

describe('how the example provider tells a turn’s answer (M16, V36; C74, C84)', () => {
  const phases = (events: readonly AgentEvent[]) => events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [[event.itemId, event.phase]] : []));

  it('labels it as it arrives in its first form, and names none on the end', async () => {
    const events = await run(start(exampleSessionFacet()), 1);
    expect(phases(events)).toEqual([['example-note-1', 'commentary'], ['example-answer-1', 'final']]);
    expect(ends(events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
  });

  it('labels no phase in its second form: every message is commentary, and the completed end names the last', async () => {
    const facet = exampleSessionFacet({ answer: 'named' });
    const events = await run(start(facet), 1);
    expect(phases(events)).toEqual([['example-note-1', 'commentary'], ['example-answer-1', 'commentary']]);
    expect(ends(events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'example-answer-1' }]);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    // Read back, the answer is labelled: what a history says of a turn that completed.
    expect((await page(facet)).messages.filter((message) => message.turnId === 'example-turn-1').map((message) => [message.itemId, message.phase])).toEqual([['example-user-1', null], ['example-note-1', 'commentary'], ['example-answer-1', 'final']]);
  });

  it('names no answer on an end that is not completed, the provider’s own or the session’s', async () => {
    const facet = exampleSessionFacet({ answer: 'named' });
    const session = start(facet);
    const seen = collect(session);
    session.send(request(1));
    await until(session, commentary);
    session.stop();
    expect(ends(await seen.ended('turn-1'))).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);

    session.send(request(2));
    await until(session, commentary);
    await session.close();
    expect(ends(seen.events).at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'interrupted', reported: false });
  });
});

describe('the other folders a facet is handed (M16, C61)', () => {
  it('are the capability’s: a provider made to take them says so, and one that is not does not', () => {
    expect(exampleDefinitionWithSessions().descriptor.capabilities.otherFolders).toBe(false);
    expect(exampleDefinitionWithSessions({ otherFolders: true }).descriptor.capabilities.otherFolders).toBe(true);
    expect(EXAMPLE_DESCRIPTOR.capabilities.otherFolders).toBe(false);
  });

  it('are noted at each start and each resume, as they were handed', () => {
    const facet = exampleSessionFacet();
    facet.start({ ...START, otherFolders: ['/projects/second', '/projects/third'] });
    facet.resume({ ...START, reference: EXAMPLE_REFERENCE, otherFolders: ['/projects/second'] });
    facet.start(START);
    expect(facet.handed).toEqual([['/projects/second', '/projects/third'], ['/projects/second'], []]);
  });
});

describe('the example provider’s turns (M18, V26; C47, C59)', () => {
  it('numbers its turns across the sessions of one facet, so no id repeats after a resume', async () => {
    const facet = exampleSessionFacet();
    const first = start(facet);
    const one = await run(first, 1);
    await first.close();
    const again = facet.resume({ ...START, reference: EXAMPLE_REFERENCE });
    const two = await run(again, 2);
    await again.close();

    expect(one.find((event) => event.type === 'turn-started')).toEqual({ type: 'turn-started', turnId: 'turn-1', providerTurnId: 'example-turn-1' });
    expect(two.find((event) => event.type === 'turn-started')).toEqual({ type: 'turn-started', turnId: 'turn-2', providerTurnId: 'example-turn-2' });
    expect(one.flatMap((event) => (event.type === 'message' ? [event.itemId] : []))).toEqual(['example-user-1', 'example-note-1', 'example-answer-1']);
    expect(two.flatMap((event) => (event.type === 'message' ? [event.itemId] : []))).toEqual(['example-user-2', 'example-note-2', 'example-answer-2']);
    expect(one.map((event) => event.type)).toEqual(['turn-started', 'session-started', 'message', 'action-changed', 'message', 'message', 'turn-ended']);
    expect(two.map((event) => event.type)).toEqual(['turn-started', 'message', 'action-changed', 'message', 'message', 'turn-ended']);
    // Another facet is another conversation, counted from one again.
    expect((await run(start(exampleSessionFacet()), 1))[0]).toMatchObject({ providerTurnId: 'example-turn-1' });
  });

  it('reports a turn that played to its end, and one ended by Stop, as the provider’s own', async () => {
    const session = start(exampleSessionFacet());
    expect(ends(await run(session, 1))).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);

    const seen = collect(session);
    session.send(request(2));
    await until(session, commentary);
    session.stop();
    expect(ends(await seen.ended('turn-2'))).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'interrupted', reported: true }]);
    // It goes on: the next prompt is taken, and nothing more comes of the stopped turn.
    const three = await run(session, 3);
    expect(ends(three)).toEqual([{ type: 'turn-ended', turnId: 'turn-3', outcome: 'completed', reported: true }]);
    expect(seen.events.filter((event) => 'turnId' in event && event.turnId === 'turn-2').at(-1)?.type).toBe('turn-ended');
    for (const event of seen.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('says the turn’s start, and the reference still to come, before the end of a turn stopped at once', async () => {
    const session = start(exampleSessionFacet());
    const seen = collect(session);
    session.send(request(1));
    session.stop();
    expect(seen.events).toEqual([
      { type: 'turn-started', turnId: 'turn-1', providerTurnId: 'example-turn-1' },
      { type: 'session-started', reference: EXAMPLE_REFERENCE, folder: START.folder },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true },
    ]);
    // Once: the next turn of the session reports no reference.
    expect((await run(session, 2)).map((event) => event.type)).not.toContain('session-started');
  });

  it('does not report a turn ended by close: the end is the session’s own, and nothing more is said', async () => {
    const session = start(exampleSessionFacet());
    const seen = collect(session);
    session.send(request(1));
    await session.close();
    expect(seen.events).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);

    const later = start(exampleSessionFacet());
    const seenLater = collect(later);
    later.send(request(1));
    await until(later, commentary);
    await later.close();
    expect(ends(seenLater.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seenLater.events.at(-1)?.type).toBe('turn-ended');
    expect(seenLater.events.some((event) => event.type === 'message' && event.phase === 'final')).toBe(false);
  });
});

describe('the example provider’s history (M18, V12; C25, C47, C51)', () => {
  it('starts with one turn made elsewhere, whose prompt has no client id', async () => {
    const facet = exampleSessionFacet();
    expect(await page(facet)).toEqual({ kind: 'page', turns: [EXAMPLE_EARLIER_TURN], messages: EXAMPLE_HISTORY, next: null });
    expect(EXAMPLE_EARLIER_TURN.turnId).toBe('example-turn-0');
    expect(EXAMPLE_HISTORY.map((message) => [message.turnId, message.role, 'clientId' in message])).toEqual([['example-turn-0', 'user', false], ['example-turn-0', 'assistant', false]]);
    expect(HistoryTurnSchema.safeParse(EXAMPLE_EARLIER_TURN).success).toBe(true);
    for (const message of EXAMPLE_HISTORY) expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
  });

  it('holds each turn its sessions ran, from the turn’s end: its outcome, its times, and the ids its live events carried', async () => {
    const facet = exampleSessionFacet();
    const session = start(facet);
    const before = Date.now();
    const seen = collect(session);
    session.send(request(1));
    // Not while it runs.
    expect((await page(facet)).turns).toEqual([EXAMPLE_EARLIER_TURN]);
    const live = await seen.ended('turn-1');
    await session.close();
    const again = facet.resume({ ...START, reference: EXAMPLE_REFERENCE });
    await run(again, 2);

    const answer = await page(facet);
    expect(answer.next).toBeNull();
    expect(answer.turns.map((turn) => [turn.turnId, turn.outcome])).toEqual([['example-turn-0', 'completed'], ['example-turn-1', 'completed'], ['example-turn-2', 'completed']]);
    for (const turn of answer.turns) expect(HistoryTurnSchema.safeParse(turn).success, turn.turnId).toBe(true);
    for (const message of answer.messages) expect(HistoryMessageSchema.safeParse(message).success, message.itemId).toBe(true);
    const [, one] = answer.turns;
    expect(one?.startedAt).toBeGreaterThanOrEqual(before);
    expect(one?.endedAt).toBeGreaterThanOrEqual(one?.startedAt ?? Infinity);
    expect(one?.durationMs).toBe((one?.endedAt ?? 0) - (one?.startedAt ?? 0));

    const mine = answer.messages.filter((message) => message.turnId === 'example-turn-1');
    expect(mine).toEqual([
      { role: 'user', itemId: 'example-user-1', phase: null, text: 'Prompt 1', turnId: 'example-turn-1', clientId: 'message-1', at: one?.startedAt },
      { role: 'assistant', itemId: 'example-note-1', phase: 'commentary', text: EXAMPLE_NOTE, turnId: 'example-turn-1', at: one?.startedAt },
      { role: 'assistant', itemId: 'example-answer-1', phase: 'final', text: EXAMPLE_ANSWER, turnId: 'example-turn-1', at: one?.startedAt },
    ]);
    expect(mine.map((message) => message.itemId)).toEqual(live.flatMap((event) => (event.type === 'message' ? [event.itemId] : [])));
    expect(answer.messages.map((message) => message.turnId)).toEqual(['example-turn-0', 'example-turn-0', 'example-turn-1', 'example-turn-1', 'example-turn-1', 'example-turn-2', 'example-turn-2', 'example-turn-2']);
  });

  it('pages newest first by size and cursor, each page oldest first, and reads a turn as its summary or not at all', async () => {
    const facet = exampleSessionFacet();
    const session = start(facet);
    for (const n of [1, 2, 3]) await run(session, n);

    const newest = await page(facet, { size: 2 });
    expect(newest.turns.map((turn) => turn.turnId)).toEqual(['example-turn-2', 'example-turn-3']);
    expect(newest.messages.map((message) => message.itemId)).toEqual(['example-user-2', 'example-note-2', 'example-answer-2', 'example-user-3', 'example-note-3', 'example-answer-3']);
    expect(typeof newest.next).toBe('string');
    // A turn that ends between two reads moves no page.
    await run(session, 4);
    const older = await page(facet, { size: 2, cursor: newest.next });
    expect(older.turns.map((turn) => turn.turnId)).toEqual(['example-turn-0', 'example-turn-1']);
    expect(older.next).toBeNull();
    const one = await page(facet, { size: 1, cursor: newest.next });
    expect(one.turns.map((turn) => turn.turnId)).toEqual(['example-turn-1']);
    expect((await page(facet, { size: 8, cursor: one.next })).turns).toEqual([EXAMPLE_EARLIER_TURN]);

    const summary = await page(facet, { size: 2, detail: 'summary' });
    expect(summary.turns.map((turn) => turn.turnId)).toEqual(['example-turn-3', 'example-turn-4']);
    expect(summary.messages.map((message) => message.itemId)).toEqual(['example-user-3', 'example-answer-3', 'example-user-4', 'example-answer-4']);
    const none = await page(facet, { size: 2, detail: 'none' });
    expect(none.turns).toEqual(summary.turns);
    expect(none.messages).toEqual([]);
    expect(none.next).toBe(summary.next);
  });

  it('fails for a reference or a cursor it does not know, a size that is none, and a read already cancelled', async () => {
    const facet = exampleSessionFacet();
    const read = (reference: string, change: Partial<HistoryRequest> = {}, aborted = false) => {
      const controller = new AbortController();
      if (aborted) controller.abort();
      return historyOf(facet).read(reference, { cursor: null, size: 8, detail: 'full', ...change }, controller.signal);
    };
    expect(await read('some-other-session')).toEqual({ kind: 'failed' });
    expect(await read(EXAMPLE_REFERENCE, { cursor: 'example-turn-9' })).toEqual({ kind: 'failed' });
    expect(await read(EXAMPLE_REFERENCE, { cursor: '1' })).toEqual({ kind: 'failed' });
    // Nothing is before the first turn: no page gave it as a cursor.
    expect(await read(EXAMPLE_REFERENCE, { cursor: 'example-turn-0' })).toEqual({ kind: 'failed' });
    expect(await read(EXAMPLE_REFERENCE, { size: 0 })).toEqual({ kind: 'failed' });
    expect(await read(EXAMPLE_REFERENCE, {}, true)).toEqual({ kind: 'failed' });
    expect((await read(EXAMPLE_REFERENCE)).kind).toBe('page');
    expect(historyOf(facet).onAvailable(() => undefined)()).toBeUndefined();
  });

  it('keeps a turn the provider took however it ended, with what was said of it by then, and none it never took', async () => {
    const facet = exampleSessionFacet();
    const session = start(facet);
    // Stopped at once: the provider took it, and said nothing of it but its start.
    session.send(request(1));
    session.stop();
    // Stopped after its commentary.
    session.send(request(2));
    await until(session, commentary);
    session.stop();
    // Closed after its start was said: the session's own end, and the provider still has the turn.
    session.send(request(3));
    await until(session, (event) => event.type === 'turn-started' && event.turnId === 'turn-3');
    await session.close();
    // Closed before its start was said: never the provider's.
    const again = facet.resume({ ...START, reference: EXAMPLE_REFERENCE });
    again.send(request(4));
    await again.close();
    // The number it was given is not used again.
    const last = facet.resume({ ...START, reference: EXAMPLE_REFERENCE });
    await run(last, 5);

    const answer = await page(facet);
    expect(answer.turns.map((turn) => [turn.turnId, turn.outcome])).toEqual([['example-turn-0', 'completed'], ['example-turn-1', 'interrupted'], ['example-turn-2', 'interrupted'], ['example-turn-3', 'interrupted'], ['example-turn-5', 'completed']]);
    const items = (turnId: string) => answer.messages.filter((message) => message.turnId === turnId).map((message) => [message.itemId, message.clientId]);
    expect(items('example-turn-1')).toEqual([['example-user-1', 'message-1']]);
    expect(items('example-turn-2')).toEqual([['example-user-2', 'message-2'], ['example-note-2', undefined]]);
    expect(items('example-turn-3')).toEqual([['example-user-3', 'message-3']]);
    expect(items('example-turn-5')).toEqual([['example-user-5', 'message-5'], ['example-note-5', undefined], ['example-answer-5', undefined]]);
    for (const turn of answer.turns) expect(HistoryTurnSchema.safeParse(turn).success, turn.turnId).toBe(true);
    for (const message of answer.messages) expect(HistoryMessageSchema.safeParse(message).success, message.itemId).toBe(true);
  });

  it('shares its history between the adapters one definition makes, and has none to read in its other form', async () => {
    const definition = exampleDefinitionWithSessions();
    const first = definition.factory(context).sessions as SessionFacet;
    await run(start(first), 1);
    const second = definition.factory(context).sessions as SessionFacet;
    expect((await page(second)).turns.map((turn) => turn.turnId)).toEqual(['example-turn-0', 'example-turn-1']);

    const without = exampleDefinitionWithSessions({ history: false }).factory(context).sessions as SessionFacet;
    expect(ends(await run(start(without), 1))).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    expect(without.history).toBeUndefined();
  });
});

// ── A message told either way (M19, V2; C3–C6, C57) ───────────────────────────────────────────
describe('a message told whole or in deltas (M19: V2; C3–C6, C57)', () => {
  it('is opened by a delta with no text, grows, and is completed by its whole message: the example provider’s second way of telling one', async () => {
    const whole = await run(start(exampleSessionFacet()), 1);
    expect(whole.some((event) => event.type === 'message-delta')).toBe(false);

    const events = await run(start(exampleSessionFacet({ messages: 'deltas' })), 1);
    const note = events.filter((event) => (event.type === 'message-delta' || event.type === 'message') && event.itemId === 'example-note-1');
    expect(note[0]).toEqual({ type: 'message-delta', turnId: 'turn-1', itemId: 'example-note-1', phase: 'commentary', text: '' });
    expect(note.at(-1)).toEqual({ type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'example-note-1', phase: 'commentary', text: EXAMPLE_NOTE });
    expect(note.length).toBeGreaterThan(3);
    // Folded, it says what the first way says, event for event.
    const folded = foldDeltas(events);
    expect(folded.events).toEqual(whole);
    expect([...folded.streamed]).toEqual([['example-note-1', EXAMPLE_NOTE], ['example-answer-1', EXAMPLE_ANSWER]]);
    expect(folded.open).toEqual([]);
    expect(folded.faults).toEqual([]);
  });

  it('leaves a message open when its turn is stopped between two deltas: no whole message comes for it', async () => {
    const session = start(exampleSessionFacet({ messages: 'deltas' }));
    const seen = collect(session);
    session.send(request(1));
    // On the event itself, and not on a look every few milliseconds: the provider tells a piece a timer
    // tick, and a look that came late found the whole message there.
    await until(session, (event) => event.type === 'message-delta' && event.itemId === 'example-note-1' && event.text !== '');
    session.stop();
    const folded = foldDeltas(await seen.ended('turn-1'));
    expect(folded.open).toEqual(['example-note-1']);
    expect(EXAMPLE_NOTE.startsWith(folded.streamed.get('example-note-1') ?? 'x')).toBe(true);
    expect(folded.events.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
  });

  it('declares nothing: no descriptor has a field for streaming a message, and the example provider’s is the same either way (C5)', () => {
    const whole = exampleDefinitionWithSessions();
    const deltas = exampleDefinitionWithSessions({ messages: 'deltas' });
    expect(deltas.descriptor).toEqual(whole.descriptor);
    for (const definition of [whole, deltas, ...builtInProviders('0.0.0')]) {
      // What a provider's asides are says whether an aside's answer is streamed (M20b, C24): that is
      // the aside's tab's to know, which waits with a line of its own where it is not. Of a session's
      // own messages a descriptor still says nothing.
      const { asides: _asides, ...capabilities } = definition.descriptor.capabilities;
      expect(JSON.stringify({ ...definition.descriptor, capabilities })).not.toMatch(/stream|delta|partial/i);
    }
  });

  it('declares how each provider answers an aside: Claude whole and from the conversation alone, Codex streamed and reading, the example provider not at all (M20b, C24)', () => {
    const asides = Object.fromEntries(builtInProviders('0.0.0').map((definition) => [definition.descriptor.id, definition.descriptor.capabilities.asides]));
    expect(asides).toEqual({
      claude: { followUp: true, streamed: false, tools: 'none' },
      codex: { followUp: true, streamed: true, tools: 'read-only' },
    });
    expect(exampleDefinitionWithSessions().descriptor.capabilities.asides).toBe('none');
  });

  // Through main, as the app wires it: the runtime, the chat service and a conversation store on disk.
  describe('through main', () => {
    /**
     * One run of the app with one session of a provider whose facet is `facet`. The record writes
     * still under way land before the drop: they would make the folder again once it is removed.
     */
    async function withApp(facet: SessionFacet, work: (app: App) => Promise<void>): Promise<void> {
      const root = mkdtempSync(path.join(tmpdir(), 'fatg-facet-contract-'));
      const folder = path.join(root, 'project');
      mkdirSync(folder);
      const { descriptor } = exampleDefinitionWithSessions({ history: false });
      placeRecords(path.join(root, 'data'), folder, descriptor.id, [sessionEntry(1, descriptor.id, { model: 'example-large', effort: 'quick' })]);
      const app = launchApp({ dir: path.join(root, 'data'), descriptor, facet: () => facet });
      try { await work(app); } finally { await app.service.settled(); app.drop(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    }
    async function turn(app: App, prompt = 'Say hello.'): Promise<void> {
      expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
      await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
    }
    /** The chat's messages, each as its role, phase, state and text. */
    const chatOf = (app: App) => app.read(1).items.map((item) => [item.role, item.phase, item.state, item.providerItemId, itemText(item)]);

    it('reaches the chat as one message either way, with the text its whole message carries (C3, C4)', async () => {
      let told: unknown[] = [];
      await withApp(exampleSessionFacet({ history: false }), async (app) => { await turn(app); told = chatOf(app); });
      expect(told).toEqual([
        ['user', null, 'complete', 'example-user-1', 'Say hello.'],
        ['assistant', 'commentary', 'complete', 'example-note-1', EXAMPLE_NOTE],
        ['assistant', 'final', 'complete', 'example-answer-1', EXAMPLE_ANSWER],
      ]);
      await withApp(exampleSessionFacet({ history: false, messages: 'deltas' }), async (app) => {
        await turn(app);
        expect(chatOf(app)).toEqual(told);
        // Each message was pushed at its opening and at its completion, under one id.
        const items = app.pushes.flatMap((push) => ('item' in push && push.item.role === 'assistant' ? [`${push.item.providerItemId}:${push.item.state}`] : []));
        expect(items).toEqual(['example-note-1:streaming', 'example-note-1:complete', 'example-answer-1:streaming', 'example-answer-1:complete']);
        expect(app.conversations.newestPage(S(1)).items).toHaveLength(3);
      });
    });

    /** A provider whose one session says, for each prompt, what `script` gives for its turn — and is ended by Stop. */
    function scripted(script: (turnId: string) => readonly AgentEvent[]): SessionFacet {
      const session = (): ProviderSession => {
        const listeners = new Set<(event: AgentEvent) => void>();
        let running: string | null = null;
        let resolveClosed: (result: { ok: boolean }) => void = () => undefined;
        const closed = new Promise<{ ok: boolean }>((resolve) => { resolveClosed = resolve; });
        const emit = (event: AgentEvent): void => { for (const listener of [...listeners]) listener(event); };
        return {
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          send(request) {
            running = request.turnId;
            setTimeout(() => {
              emit({ type: 'turn-started', turnId: request.turnId });
              for (const event of script(request.turnId)) emit(event);
              if (script(request.turnId).some((event) => event.type === 'turn-ended')) running = null;
            }, 0);
          },
          stop() { if (running !== null) { const turnId = running; running = null; emit({ type: 'turn-ended', turnId, outcome: 'interrupted', reported: true }); } },
          closed,
          close() { resolveClosed({ ok: true }); return closed; },
          recheck: () => Promise.resolve({ ok: true }),
        };
      };
      return { start: session, resume: session };
    }
    const delta = (turnId: string, text: string, itemId = 'item-1'): AgentEvent => ({ type: 'message-delta', turnId, itemId, phase: 'final', text });
    const message = (turnId: string, text: string, itemId = 'item-1'): AgentEvent => ({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text });
    const end = (turnId: string): AgentEvent => ({ type: 'turn-ended', turnId, outcome: 'completed', reported: true });

    it('takes the whole message’s text where it differs from what its deltas brought, and appends nothing after it (C4)', async () => {
      await withApp(scripted((turnId) => [delta(turnId, ''), delta(turnId, 'Helo, '), delta(turnId, 'wrold'), message(turnId, 'Hello, world.'), delta(turnId, ' And more.'), end(turnId)]), async (app) => {
        await turn(app);
        expect(chatOf(app).at(-1)).toEqual(['assistant', 'final', 'complete', 'item-1', 'Hello, world.']);
        // The delta after its message was dropped, and counted by its kind.
        expect(app.chat.dropped()).toMatchObject({ complete: 1 });
      });
    });

    it('drops the deltas past the bound, and says the message was cut — until its whole message says otherwise (C6)', async () => {
      const over = (turnId: string): AgentEvent[] => [delta(turnId, ''), ...Array.from({ length: 11 }, () => delta(turnId, 'x'.repeat(10_000)))];
      // No whole message comes: stopped, it is kept as far as the bound, cut.
      await withApp(scripted(over), async (app) => {
        expect(await app.runtime.send(S(1), 'Go on.')).toEqual({ status: 'accepted' });
        await untilHolds(() => app.chat.dropped().bound > 0, 'the bound being reached');
        const streaming = app.read(1).items.at(-1);
        expect(streaming).toMatchObject({ state: 'streaming', blocks: [{ cut: true }] });
        expect(itemText(streaming ?? { blocks: [] })).toHaveLength(MAX_MESSAGE_TEXT);
        app.runtime.stop(S(1));
        await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
        expect(app.read(1).items.at(-1)).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
      });
      // The whole message is the authority for the flag too.
      await withApp(scripted((turnId) => [...over(turnId), message(turnId, 'Short, after all.'), end(turnId)]), async (app) => {
        await turn(app);
        expect(app.read(1).items.at(-1)).toMatchObject({ state: 'complete', blocks: [{ text: 'Short, after all.', cut: false }] });
      });
    });

    it('changes nothing for a delta that comes after its turn has ended (C6)', async () => {
      const facet = scripted((turnId) => [delta(turnId, 'Half'), end(turnId), delta(turnId, ' and late'), message(turnId, 'A late whole message.')]);
      await withApp(facet, async (app) => {
        await turn(app);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(chatOf(app).at(-1)).toEqual(['assistant', 'final', 'partial', 'item-1', 'Half']);
        expect(app.chat.dropped()).toMatchObject({ 'turn-ended': 1 });
      });
    });
  });
});

// ── M20a: what a session does ─────────────────────────────────────────────────────────────────

describeFacetContract('the example provider, telling what it does', () =>
  Promise.resolve({ facet: exampleSessionFacet({ work: true }), history: true, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describeFacetContract('the example provider, telling what it does, in deltas, naming its answer, with no history', () =>
  Promise.resolve({ facet: exampleSessionFacet({ work: true, messages: 'deltas', answer: 'named', history: false }), history: false, ...START, prompt: 'Say hello.', dispose: () => Promise.resolve() }),
);

describe('what a session does, on the example provider (M20a: V14; C53)', () => {
  const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
  async function played(options: Parameters<typeof exampleSessionFacet>[0]): Promise<AgentEvent[]> {
    const session = exampleSessionFacet(options).start(START);
    const seen = collect(session);
    session.send({ turnId: 'turn-1', prompt: 'Say hello.', effort: 'quick', speed: null, messageId: 'message-1' });
    const events = [...await seen.ended('turn-1')];
    await session.close();
    return events;
  }

  it('tells an activity started and ended, a worker with the item that started it, and the worker’s own work under its id', async () => {
    const events = await played({ work: true });
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(workFaults(events)).toEqual([]);
    expect(of(events, 'activity-started').map((event) => [event.itemId, event.activityType, event.workerId ?? null, event.pairedWorkerId ?? null])).toEqual([
      ['example-read-1', 'read', null, null],
      ['example-launch-1', 'worker', null, 'example-worker-1'],
      ['example-search-1', 'search', 'example-worker-1', null],
    ]);
    expect(of(events, 'activity-ended').map((event) => [event.itemId, event.status, event.workerId ?? null])).toEqual([
      ['example-read-1', 'completed', null],
      ['example-search-1', 'completed', 'example-worker-1'],
      ['example-launch-1', 'completed', null],
    ]);
    // The item that started the worker ends just before the worker's own end is said (C23).
    const types = events.map((event) => event.type);
    expect(types.indexOf('worker-ended')).toBe(events.findIndex((event) => event.type === 'activity-ended' && event.itemId === 'example-launch-1') + 1);
    // What the worker said is a message of its own, and not the turn's answer.
    expect(of(events, 'message').filter((event) => event.workerId !== undefined)).toMatchObject([{ itemId: 'example-report-1', workerId: 'example-worker-1', text: EXAMPLE_REPORT }]);
    expect(of(events, 'message').filter((event) => event.role === 'assistant' && event.workerId === undefined).map((event) => event.itemId)).toEqual(['example-note-1', 'example-answer-1']);
  });

  it('tells none of it in its other forms, and declares nothing either way', async () => {
    const events = await played({});
    expect(events.some((event) => event.type === 'activity-started' || event.type === 'activity-ended' || event.type === 'worker-started')).toBe(false);
    expect(exampleDefinitionWithSessions({ work: true }).descriptor).toEqual(exampleDefinitionWithSessions().descriptor);
    for (const definition of [exampleDefinitionWithSessions({ work: true }), ...builtInProviders('0.0.0')]) expect(JSON.stringify(definition.descriptor)).not.toMatch(/activit|worker/i);
  });

  it('ends a worker still running, and the item that started it, as failed when its turn is stopped', async () => {
    const session = exampleSessionFacet({ work: true }).start(START);
    const seen = collect(session);
    session.send({ turnId: 'turn-1', prompt: 'Say hello.', effort: 'quick', speed: null, messageId: 'message-1' });
    // Stopped at the event itself, the worker's search starting: a poll would find the turn further on, or over.
    session.subscribe((event) => { if (event.type === 'activity-started' && event.itemId === 'example-search-1') session.stop(); });
    const events = await seen.ended('turn-1');
    expect(workFaults(events)).toEqual([]);
    expect(events.slice(-3)).toEqual([
      { type: 'activity-ended', turnId: 'turn-1', itemId: 'example-launch-1', status: 'failed' },
      { type: 'worker-ended', workerId: 'example-worker-1', outcome: 'failed' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true },
    ]);
    await session.close();
  });

  it('keeps nothing of a worker’s in its history: the conversation’s messages are the session’s own', async () => {
    const facet = exampleSessionFacet({ work: true });
    const session = facet.start(START);
    const seen = collect(session);
    session.send({ turnId: 'turn-1', prompt: 'Say hello.', effort: 'quick', speed: null, messageId: 'message-1' });
    await seen.ended('turn-1');
    const page = await (facet.history as HistoryFacet).read(EXAMPLE_REFERENCE, { size: 1, cursor: null, detail: 'full' }, new AbortController().signal);
    expect(page.kind === 'page' && page.messages.map((message) => message.itemId)).toEqual(['example-user-1', 'example-note-1', 'example-answer-1']);
    await session.close();
  });

  it.each([
    ['an end with no start', [{ type: 'activity-ended', turnId: 't', itemId: 'a', status: 'completed' }], 'an end with no start: a'],
    ['a start after its end', [{ type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'read', name: 'Read', summary: '' }, { type: 'activity-ended', turnId: 't', itemId: 'a', status: 'completed' }, { type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'read', name: 'Read', summary: '' }], 'a start after its end: a'],
    ['an end under another turn', [{ type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'read', name: 'Read', summary: '' }, { type: 'activity-ended', turnId: 'u', itemId: 'a', status: 'completed' }], 'an end under another turn than its start: a'],
    ['an end under another owner', [{ type: 'worker-started', workerId: 'w' }, { type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'read', name: 'Read', summary: '' }, { type: 'activity-ended', turnId: 't', itemId: 'a', workerId: 'w', status: 'completed' }], 'an end with no start: a'],
    ['an activity of a worker never started', [{ type: 'activity-started', turnId: 't', itemId: 'a', workerId: 'w', activityType: 'read', name: 'Read', summary: '' }], 'activity-started of a worker that was never started: a'],
    ['a message of a worker never started', [{ type: 'message', turnId: 't', role: 'assistant', itemId: 'm', phase: null, text: 'x', workerId: 'w' }], 'message of a worker that was never started: m'],
    ['a pairing with no worker', [{ type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'worker', name: 'Worker', summary: '', pairedWorkerId: 'w' }], 'a pairing with a worker that was never started: a'],
    ['a pairing on another item', [{ type: 'worker-started', workerId: 'w' }, { type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'read', name: 'Read', summary: '', pairedWorkerId: 'w' }], 'a pairing on an item that is no worker’s: a'],
  ] as const)('the contract’s own rule refuses %s', (_name, events, fault) => {
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(workFaults(events as readonly AgentEvent[])).toEqual([fault.replace('’', '\'')]);
  });

  it('takes a second start of an open item, which replaces it (C59), and a late end, as no fault', () => {
    const start: AgentEvent = { type: 'activity-started', turnId: 't', itemId: 'list', activityType: 'checklist', name: 'plan', summary: '', steps: [{ text: 'One', state: 'pending' }] };
    expect(workFaults([start, { ...start, steps: [{ text: 'One', state: 'completed' }] }])).toEqual([]);
    expect(workFaults([{ type: 'activity-started', turnId: 't', itemId: 'a', activityType: 'command', name: 'run', summary: '' }, { type: 'turn-ended', turnId: 't', outcome: 'interrupted', reported: true }, { type: 'activity-ended', turnId: 't', itemId: 'a', status: 'completed' }])).toEqual([]);
  });

  // Through main, as the app wires it: the runtime, the chat service and a conversation store on disk.
  it('reaches the chat as items of the session’s own, and the worker’s tab as items of the worker’s, with no CLI’s fake', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fatg-facet-work-'));
    const folder = path.join(root, 'project');
    mkdirSync(folder);
    const { descriptor } = exampleDefinitionWithSessions({ history: false });
    placeRecords(path.join(root, 'data'), folder, descriptor.id, [sessionEntry(1, descriptor.id, { model: 'example-large', effort: 'quick' })]);
    const app: App = launchApp({ dir: path.join(root, 'data'), descriptor, facet: () => exampleSessionFacet({ work: true, history: false, messages: 'deltas' }) });
    try {
      expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'accepted' });
      await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
      await app.service.settled();
      const shape = (item: ConversationItem) => (item.kind === 'activity' ? [item.providerItemId, item.activity?.type, item.activity?.status, item.state] : [item.providerItemId, item.role, item.phase, item.state]);
      expect(app.read(1).items.map(shape)).toEqual([
        ['example-user-1', 'user', null, 'complete'],
        ['example-read-1', 'read', 'completed', 'complete'],
        ['example-launch-1', 'worker', 'completed', 'complete'],
        ['example-note-1', 'assistant', 'commentary', 'complete'],
        ['example-answer-1', 'assistant', 'final', 'complete'],
      ]);
      const [read, launch] = app.read(1).items.filter((item) => item.kind === 'activity');
      expect(read?.activity).toMatchObject({ name: 'Read', summary: 'example.txt', output: EXAMPLE_READ, files: [{ path: 'example.txt', line: null }], duration: { provenance: 'local' } });
      // The worker's item: paired, under the agent list's label, its report as its output.
      expect(launch?.activity).toMatchObject({ workerId: 'example-worker-1', summary: app.summary(1)?.agents[0]?.label, output: EXAMPLE_REPORT });
      expect(app.read(1).items.every((item) => item.workerId === null)).toBe(true);
      const theirs = app.runtime.readWorker(S(1), 'example-worker-1');
      expect(theirs).toMatchObject({ status: 'read', workerId: 'example-worker-1', worker: { id: launch?.id }, older: null });
      expect(theirs.status === 'read' && theirs.items.map(shape)).toEqual([
        ['example-search-1', 'search', 'completed', 'complete'],
        ['example-report-1', 'assistant', null, 'complete'],
      ]);
      expect(theirs.status === 'read' && theirs.items.every((item) => item.workerId === 'example-worker-1')).toBe(true);
      // Each was pushed naming whose it is: the worker's with its id, the session's own with none (C32).
      const owners = new Map(app.pushes.flatMap((push) => ('item' in push ? [[push.item.providerItemId, push.workerId ?? null] as const] : [])));
      expect([...owners]).toEqual(expect.arrayContaining([['example-read-1', null], ['example-launch-1', null], ['example-search-1', 'example-worker-1'], ['example-report-1', 'example-worker-1'], ['example-answer-1', null]]));
    } finally { app.drop(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });
});

// ── M20b: a question beside a session ─────────────────────────────────────────────────────────

/** The example provider answering asides, as the shared tests take one. */
function asking(mode: 'whole' | 'streamed', options: ExampleSessionOptions = {}): () => Promise<FacetHarness> {
  return () => {
    const facet = exampleSessionFacet({ ...options, asides: mode });
    const capability = exampleAsides(mode);
    if (capability === 'none') throw new Error('the example provider was made to answer asides');
    return Promise.resolve({
      facet, history: options.history !== false, ...START, prompt: 'Say hello.',
      asides: { capability, question: 'What is the example for?', refuseNext: () => facet.asides.refuseNext(), holdNext: () => facet.asides.holdNext(), release: () => undefined },
      dispose: () => Promise.resolve(),
    });
  };
}

describeFacetContract('the example provider, answering an aside whole', asking('whole'), { asides: true });
describeFacetContract('the example provider, answering an aside as it is written', asking('streamed'), { asides: true });
describeFacetContract('the example provider, answering an aside while it tells what it does, in deltas, with no history', asking('streamed', { work: true, messages: 'deltas', answer: 'named', history: false }), { asides: true });

describe('a question beside a session, on the example provider (M20b: V14; C24–C26)', () => {
  const turn = { turnId: 'turn-1', prompt: 'Say hello.', effort: 'quick', speed: null, messageId: 'message-1' } as const;
  const request = (n: number, history: { question: string; response: string }[] = []) => ({ asideId: `aside-${n}`, turnId: `aside-turn-${n}`, text: 'What is the example for?', messageId: `aside-message-${n}`, history, throughTurn: null, effort: 'quick', speed: null });

  it('declares what it does: none unless it was made to answer, then whole or as it is written, from the conversation alone', () => {
    expect(exampleDefinitionWithSessions().descriptor.capabilities.asides).toBe('none');
    expect(exampleDefinitionWithSessions({ asides: 'whole' }).descriptor.capabilities.asides).toEqual({ followUp: true, streamed: false, tools: 'none' });
    expect(exampleDefinitionWithSessions({ asides: 'streamed' }).descriptor.capabilities.asides).toEqual({ followUp: true, streamed: true, tools: 'none' });
    // The member and the declaration go together, as a facet and `sessions` do.
    expect('ask' in exampleSessionFacet().start(START)).toBe(false);
    expect(['ask', 'stopAside'].every((member) => member in exampleSessionFacet({ asides: 'whole' }).start(START))).toBe(true);
  });

  it('answers under the aside’s own turn, with one message: whole in one form, opened and grown in the other', async () => {
    for (const mode of ['whole', 'streamed'] as const) {
      const session = exampleSessionFacet({ asides: mode }).start(START);
      const seen = collect(session);
      session.ask?.(request(1));
      const told = await seen.ended('aside-turn-1');
      expect(told.every((event) => 'asideId' in event && event.asideId === 'aside-1'), mode).toBe(true);
      const folded = foldDeltas(told);
      expect(folded.events.map((event) => event.type), mode).toEqual(['turn-started', 'message', 'turn-ended']);
      expect(folded.events[1], mode).toMatchObject({ role: 'assistant', phase: 'final', text: EXAMPLE_ASIDE_ANSWER, turnId: 'aside-turn-1' });
      expect(told.some((event) => event.type === 'message-delta'), mode).toBe(mode === 'streamed');
      if (mode === 'streamed') expect([...folded.streamed.values()]).toEqual([EXAMPLE_ASIDE_ANSWER]);
      await session.close();
    }
  });

  it('keeps nothing of an aside: a follow-up brings its earlier exchanges, and says how many it was given', async () => {
    const session = exampleSessionFacet({ asides: 'whole' }).start(START);
    const seen = collect(session);
    session.ask?.(request(1));
    await seen.ended('aside-turn-1');
    session.ask?.({ ...request(1, [{ question: 'What is the example for?', response: EXAMPLE_ASIDE_ANSWER }]), turnId: 'aside-turn-2' });
    const told = await seen.ended('aside-turn-2');
    expect(told.findLast((event) => event.type === 'message')).toMatchObject({ text: exampleFollowUpAnswer(1), asideId: 'aside-1', turnId: 'aside-turn-2' });
    await session.close();
  });

  it('takes two asides at once, and one question of an aside at a time', async () => {
    const session = exampleSessionFacet({ asides: 'whole' }).start(START);
    const seen = collect(session);
    session.ask?.(request(1));
    session.ask?.(request(2));
    // A second question of the first aside, while its first runs, is not taken: main asks one at a time.
    session.ask?.({ ...request(1), turnId: 'aside-turn-1b' });
    await Promise.all([seen.ended('aside-turn-1'), seen.ended('aside-turn-2')]);
    expect(seen.events.filter((event) => event.type === 'turn-ended').map((event) => ('asideId' in event ? event.asideId : null)).sort()).toEqual(['aside-1', 'aside-2']);
    expect(seen.events.some((event) => 'turnId' in event && event.turnId === 'aside-turn-1b')).toBe(false);
    await session.close();
  });

  it('leaves the session’s turn, asked beside, as it is told with no aside: the same events, and its history holds no word of an aside', async () => {
    const alone = exampleSessionFacet({ asides: 'whole' });
    const quiet = alone.start(START);
    const quietSeen = collect(quiet);
    quiet.send(turn);
    const plain = [...(await quietSeen.ended('turn-1'))];
    await quiet.close();

    const facet = exampleSessionFacet({ asides: 'whole' });
    const session = facet.start(START);
    const seen = collect(session);
    session.send(turn);
    session.ask?.(request(1));
    await Promise.all([seen.ended('turn-1'), seen.ended('aside-turn-1')]);
    expect(seen.events.filter((event) => !('asideId' in event) || event.asideId === undefined)).toEqual(plain);
    const page = await facet.history?.read(EXAMPLE_REFERENCE, { cursor: null, size: 10, detail: 'full' }, new AbortController().signal);
    expect(JSON.stringify(page)).not.toContain(EXAMPLE_ASIDE_ANSWER);
    expect(JSON.stringify(page)).not.toContain('What is the example for?');
    await session.close();
  });
});

// ── M21: a question the session asks ──────────────────────────────────────────────────────────

/** The example provider asking the user, as the shared tests take one. */
function questioning(mode: 'blocking' | 'both', options: ExampleSessionOptions = {}): () => Promise<FacetHarness> {
  return () => Promise.resolve({
    facet: exampleSessionFacet({ ...options, questions: mode }), history: options.history !== false, ...START, prompt: 'Say hello.',
    questions: { capability: mode, prompt: EXAMPLE_QUESTION_PROMPT },
    dispose: () => Promise.resolve(),
  });
}

describeFacetContract('the example provider, asking a question as a request', questioning('blocking'), { asides: false, questions: true });
describeFacetContract('the example provider, asking as a request and in a message, in deltas, while it tells what it does, with no history', questioning('both', { work: true, messages: 'deltas', answer: 'named', history: false }), { asides: false, questions: true });

describe('a question the session asks, on the example provider (M21: V12; C30)', () => {
  const turn = { turnId: 'turn-1', prompt: EXAMPLE_QUESTION_PROMPT, effort: 'quick', speed: null, messageId: 'message-1' } as const;

  it('declares what it does: none unless it was made to ask, and each built-in provider its own — Claude as a request, Codex as a request and in a message', () => {
    expect(exampleDefinitionWithSessions().descriptor.capabilities.questions).toBe('none');
    expect(exampleDefinitionWithSessions({ questions: 'blocking' }).descriptor.capabilities.questions).toBe('blocking');
    expect(exampleDefinitionWithSessions({ questions: 'both' }).descriptor.capabilities.questions).toBe('both');
    expect(Object.fromEntries(builtInProviders('0.0.0').map((definition) => [definition.descriptor.id, definition.descriptor.capabilities.questions]))).toEqual({ claude: 'blocking', codex: 'both' });
    // The member and the declaration go together, as `ask` and `asides` do.
    expect('answer' in exampleSessionFacet().start(START)).toBe(false);
    expect('answer' in exampleSessionFacet({ questions: 'blocking' }).start(START)).toBe(true);
  });

  it('asks only where its prompt says so: every other turn is told as a provider’s that asks nothing', async () => {
    const session = exampleSessionFacet({ questions: 'both' }).start(START);
    const seen = collect(session);
    session.send({ ...turn, prompt: 'Say hello.' });
    const told = await seen.ended('turn-1');
    expect(told.some((event) => event.type === 'question-raised')).toBe(false);
    expect(told.some((event) => event.type === 'message' && event.questions !== undefined)).toBe(false);
  });

  it('holds the request before it tells it: an answer given from inside its own emission is taken, as main’s refusal is', async () => {
    const session = exampleSessionFacet({ questions: 'blocking' }).start(START);
    const seen = collect(session);
    // As the registry does for a request it cannot place (C11).
    session.subscribe((event) => { if (event.type === 'question-raised') session.answer?.(event.requestId, null); });
    session.send(turn);
    const told = await seen.ended('turn-1');
    expect(told.filter((event) => event.type === 'notice').map((event) => (event.type === 'notice' ? event.kind : ''))).toEqual(['request-refused']);
    expect(told.at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'completed', reported: true });
    // And said once: each step of its script still came once.
    expect(told.filter((event) => event.type === 'message' && event.role === 'assistant')).toHaveLength(2);
  });

  it('says a held request dropped before the end its close makes, and nothing of it at a Stop (C22, C67)', async () => {
    const closing = exampleSessionFacet({ questions: 'blocking' }).start(START);
    const first = collect(closing);
    closing.send(turn);
    const raised = await first.first((event): event is Extract<AgentEvent, { type: 'question-raised' }> => event.type === 'question-raised', 'question-raised');
    await closing.close();
    expect(first.events.slice(-2)).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'dropped' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);

    const stopped = exampleSessionFacet({ questions: 'blocking' }).start(START);
    const second = collect(stopped);
    stopped.send(turn);
    await second.first((event): event is Extract<AgentEvent, { type: 'question-raised' }> => event.type === 'question-raised', 'question-raised');
    stopped.stop();
    expect((await second.ended('turn-1')).some((event) => event.type === 'question-resolved')).toBe(false);
  });

  // Through main, as the app wires it: the runtime, the request registry, the chat service and a conversation store on disk.
  describe('through main', () => {
    async function withApp(mode: 'blocking' | 'both', work: (app: App) => Promise<void>): Promise<void> {
      const root = mkdtempSync(path.join(tmpdir(), 'fatg-facet-questions-'));
      const folder = path.join(root, 'project');
      mkdirSync(folder);
      const { descriptor } = exampleDefinitionWithSessions({ history: false, questions: mode });
      const facet = exampleSessionFacet({ history: false, questions: mode });
      placeRecords(path.join(root, 'data'), folder, descriptor.id, [sessionEntry(1, descriptor.id, { model: 'example-large', effort: 'quick' })]);
      const app = launchApp({ dir: path.join(root, 'data'), descriptor, facet: () => facet });
      try { await work(app); } finally { await app.service.settled(); app.drop(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    }
    const cards = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'interaction');

    it('is a card of its turn while it waits, raising the session’s attention; answered from the card, it is confirmed and the turn completes', async () => {
      await withApp('blocking', async (app) => {
        expect(await app.runtime.send(S(1), EXAMPLE_QUESTION_PROMPT)).toEqual({ status: 'accepted' });
        await untilHolds(() => cards(app).length === 1, 'the card');
        const [card] = cards(app);
        expect(card).toMatchObject({ providerItemId: 'example-question-1', workerId: null, interaction: { mode: 'blocking', outcome: 'pending', questions: [EXAMPLE_QUESTION] } });
        expect(app.summary(1)).toMatchObject({ status: 'running', attention: { kind: 'question', count: 1 }, action: { kind: 'asking', label: 'Asking a question' } });
        // No message of the turn was said before the answer: it waits.
        expect(app.read(1).items.filter((item) => item.role === 'assistant')).toEqual([]);
        expect(await app.runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [1], text: 'to everyone' }])).toEqual({ status: 'answered' });
        await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
        const answered = cards(app)[0]?.interaction;
        expect(answered).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: 'to everyone', secret: false }] });
        expect(answered?.confirmedAt).not.toBeNull();
        expect(answered === null || answered === undefined ? null : outcomeWords(answered, false)).toBe('Answered');
        expect(app.read(1).items.map((item) => item.kind)).toEqual(['message', 'interaction', 'message', 'message']);
        expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
      });
    });

    it('withdraws the card at a Stop, by its turn’s end, and drops one that waited when the app quit', async () => {
      await withApp('blocking', async (app) => {
        await app.runtime.send(S(1), EXAMPLE_QUESTION_PROMPT);
        await untilHolds(() => cards(app).length === 1, 'the card');
        expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
        await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
        const withdrawn = cards(app)[0]?.interaction;
        expect(withdrawn).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
        expect(withdrawn === null || withdrawn === undefined ? null : outcomeWords(withdrawn, false)).toBe('Withdrawn: the reply ended');
        // A stale press on a card that waits no more.
        expect(await app.runtime.answer(S(1), cards(app)[0]?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'refused', reason: 'not-pending' });
        await app.runtime.send(S(1), EXAMPLE_QUESTION_PROMPT);
        await untilHolds(() => cards(app).length === 2, 'the second card');
        await app.runtime.stopAll();
        const dropped = cards(app)[1]?.interaction;
        expect(dropped === null || dropped === undefined ? null : outcomeWords(dropped, false)).toBe('Not answered: the session’s process ended');
      });
    });

    it('makes a card of the question its message carries, written with the message, for a provider that asks so, and none for one that does not', async () => {
      await withApp('both', async (app) => {
        await app.runtime.send(S(1), EXAMPLE_QUESTION_PROMPT);
        await untilHolds(() => cards(app).length === 1, 'the card');
        await app.runtime.answer(S(1), cards(app)[0]?.id ?? '', [{ question: 0, options: [0], text: null }]);
        await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
        const items = app.read(1).items;
        expect(items.map((item) => `${item.kind}:${item.providerItemId}`)).toEqual(['message:example-user-1', 'interaction:example-question-1', 'message:example-note-1', 'interaction:example-note-1', 'message:example-answer-1']);
        // Its model went on to answer in the same turn, so the card is passed at the turn's end (decision 0026, item 11).
        expect(items[3]?.interaction).toMatchObject({ mode: 'async', outcome: 'passed', questions: [{ text: EXAMPLE_ASKED[0]?.title, options: [{ label: 'Yes' }, { label: 'No' }], freeText: true }] });
        expect(items[2]?.questions).toEqual(EXAMPLE_ASKED);
      });
      await withApp('blocking', async (app) => {
        await app.runtime.send(S(1), EXAMPLE_QUESTION_PROMPT);
        await untilHolds(() => cards(app).length === 1, 'the card');
        await app.runtime.answer(S(1), cards(app)[0]?.id ?? '', [{ question: 0, options: [0], text: null }]);
        await untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');
        expect(cards(app)).toHaveLength(1);
      });
    });
  });
});

// ── M22: what a session may do ────────────────────────────────────────────────────────────────

/** The example provider with its two modes, as the shared tests take one. */
function permitting(change: 'restart' | 'idle', options: ExampleSessionOptions = {}): () => Promise<FacetHarness> {
  return () => {
    const facet = exampleSessionFacet({ ...options, modes: change });
    return Promise.resolve({
      facet, history: options.history !== false, ...START, prompt: 'Say hello.',
      ...(options.questions === undefined ? {} : { questions: { capability: options.questions, prompt: EXAMPLE_QUESTION_PROMPT } }),
      permissions: {
        capability: examplePermissions(change), mode: EXAMPLE_LOOK, asking: EXAMPLE_ASK, prompt: EXAMPLE_APPROVAL_PROMPT,
        session: { prompt: EXAMPLE_APPROVAL_PROMPT, again: EXAMPLE_APPROVAL_PROMPT },
        ...(change === 'idle' ? { idle: { from: EXAMPLE_LOOK, to: EXAMPLE_ASK } } : {}),
        mismatchNext: () => facet.permissions.mismatchNext(),
      },
      dispose: () => Promise.resolve(),
    });
  };
}

describeFacetContract('the example provider, with two modes changed by a restart', permitting('restart'), { asides: false, permissions: true });

// M22b (V7; C2, C14, C55): a third provider plans as Codex does, through its own module alone.
describeFacetContract('the example provider, planning', () => permitting('restart', { plans: true })().then((harness) => ({ ...harness, plans: { capability: EXAMPLE_PLANS, kind: 'item' as const, prompt: 'Plan a greeting.', mode: EXAMPLE_ASK } })), { asides: false, permissions: true, plans: true });
describeFacetContract('the example provider, with two modes changed on its live process, asking questions, in deltas, while it tells what it does, with no history', permitting('idle', { work: true, messages: 'deltas', answer: 'named', history: false, questions: 'blocking' }), { asides: false, questions: true, permissions: true });

describe('what a session may do, on the example provider (M22: V11, V15; C35, C39)', () => {
  const ASKING = { ...START, mode: EXAMPLE_ASK } as const;
  const LOOKING = { ...START, mode: EXAMPLE_LOOK } as const;
  const turn = { turnId: 'turn-1', prompt: EXAMPLE_APPROVAL_PROMPT, effort: 'quick', speed: null, messageId: 'message-1' } as const;
  const isAsked = (event: AgentEvent): event is Extract<AgentEvent, { type: 'approval-raised' }> => event.type === 'approval-raised';
  const kinds = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

  it('declares what it has: no mode unless it was made with them, then two under names of its own; and each built-in provider its five, a reading one first', () => {
    expect(exampleDefinitionWithSessions().descriptor.capabilities.permissions).toBeNull();
    for (const change of ['restart', 'idle'] as const) {
      const declared = exampleDefinitionWithSessions({ modes: change }).descriptor.capabilities.permissions;
      expect(declared).toEqual(examplePermissions(change));
      expect(declared?.modes.map((mode) => [mode.id, mode.reading, mode.asks])).toEqual([[EXAMPLE_LOOK, true, false], [EXAMPLE_ASK, false, true]]);
      expect(declared?.fallback).toBe(EXAMPLE_ASK);
    }
    // No name of a built-in's: what main does with a mode, it does by the declaration.
    const builtIn = Object.fromEntries(builtInProviders('0.0.0').map((definition) => [definition.descriptor.id, definition.descriptor.capabilities.permissions?.modes.map((mode) => mode.id)]));
    expect(builtIn).toEqual({ claude: ['read-only', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk'], codex: ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk'] });
    expect(Object.values(builtIn).flat()).not.toContain(EXAMPLE_LOOK);
    expect(Object.values(builtIn).flat()).not.toContain(EXAMPLE_ASK);
    // The members and the declaration go together, as `answer` and `questions` do: `setMode` only where a change is taken on a live process.
    const none = exampleSessionFacet();
    expect([none.modes, none.transition, none.onModesChanged]).toEqual([undefined, undefined, undefined]);
    expect(['decide', 'setMode'].map((member) => member in none.start(START))).toEqual([false, false]);
    const restart = exampleSessionFacet({ modes: 'restart' });
    expect(['decide', 'setMode'].map((member) => member in restart.start(ASKING))).toEqual([true, false]);
    expect(restart.transition?.(EXAMPLE_LOOK, EXAMPLE_ASK)).toBe('restart');
    const idle = exampleSessionFacet({ modes: 'idle' });
    expect(['decide', 'setMode'].map((member) => member in idle.start(ASKING))).toEqual([true, true]);
    expect([idle.transition?.(EXAMPLE_LOOK, EXAMPLE_ASK), idle.transition?.(EXAMPLE_ASK, EXAMPLE_LOOK)]).toEqual(['idle', 'idle']);
  });

  it('says its mode once, with the first thing its process starts, and asks only where its prompt says so', async () => {
    const facet = exampleSessionFacet({ modes: 'restart' });
    const session = facet.start(ASKING);
    const seen = collect(session);
    session.send({ ...turn, prompt: 'Say hello.' });
    const first = await seen.ended('turn-1');
    expect(kinds(first)).toEqual(['turn-started', 'in-force', 'session-started', 'message', 'action-changed', 'message', 'message', 'turn-ended']);
    expect(first[1]).toEqual({ type: 'in-force', turnId: 'turn-1', mode: EXAMPLE_ASK });
    session.send({ ...turn, turnId: 'turn-2', messageId: 'message-2', prompt: 'Say hello.' });
    expect((await seen.ended('turn-2')).slice(first.length).some((event) => event.type === 'in-force')).toBe(false);
    expect(seen.events.some(isAsked)).toBe(false);
    expect(facet.started).toEqual([EXAMPLE_ASK]);
    await session.close();
  });

  it('asks leave before it says anything, runs the action once it is approved, and tells one it was denied as declined by the user', async () => {
    for (const choice of ['approve', 'deny'] as const) {
      const session = exampleSessionFacet({ modes: 'restart' }).start(ASKING);
      const seen = collect(session);
      session.send(turn);
      const raised = await seen.first(isAsked, 'approval-raised');
      expect(raised).toEqual({ type: 'approval-raised', turnId: 'turn-1', requestId: 'example-approval-1', sourceId: 'example-action-1', request: EXAMPLE_APPROVAL });
      expect(seen.events.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
      await expect(session.decide?.(raised.requestId, choice)).resolves.toBe(true);
      const told = await seen.ended('turn-1');
      expect(kinds(told).slice(5)).toEqual(['approval-raised', 'approval-resolved', 'activity-started', 'activity-ended', 'message', 'message', 'turn-ended']);
      expect(told.find((event) => event.type === 'activity-ended')).toEqual(choice === 'approve'
        ? { type: 'activity-ended', turnId: 'turn-1', itemId: 'example-action-1', status: 'completed', exitCode: 0 }
        : { type: 'activity-ended', turnId: 'turn-1', itemId: 'example-action-1', status: 'declined', declinedBy: 'user' });
      await session.close();
    }
  });

  it('refuses the action under its reading mode with the notice and no request, as a provider does that was given no leave to ask', async () => {
    const session = exampleSessionFacet({ modes: 'restart' }).start(LOOKING);
    const seen = collect(session);
    session.send(turn);
    const told = await seen.ended('turn-1');
    expect(told.some(isAsked)).toBe(false);
    expect(told.filter((event) => event.type === 'notice')).toEqual([{ type: 'notice', turnId: 'turn-1', kind: 'request-refused' }]);
    expect(told.some((event) => event.type === 'activity-started')).toBe(false);
    expect(told.at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'completed', reported: true });
    await session.close();
  });

  it('holds a grant for its process alone: the same prompt runs unasked on it, and asks again on the next', async () => {
    const facet = exampleSessionFacet({ modes: 'restart' });
    const first = facet.start(ASKING);
    const seen = collect(first);
    first.send(turn);
    const raised = await seen.first(isAsked, 'approval-raised');
    await first.decide?.(raised.requestId, 'approve-session');
    const before = (await seen.ended('turn-1')).length;
    first.send({ ...turn, turnId: 'turn-2', messageId: 'message-2' });
    const unasked = (await seen.ended('turn-2')).slice(before);
    expect(unasked.some(isAsked)).toBe(false);
    expect(unasked.filter((event) => event.type === 'activity-ended')).toEqual([{ type: 'activity-ended', turnId: 'turn-2', itemId: 'example-action-2', status: 'completed', exitCode: 0 }]);
    await first.close();
    // A resume is another process: it was told nothing of the grant, and asks.
    const again = facet.resume({ ...ASKING, reference: EXAMPLE_REFERENCE, processKey: 'process-2' });
    const next = collect(again);
    again.send({ ...turn, turnId: 'turn-3', messageId: 'message-3' });
    expect(await next.first(isAsked, 'approval-raised')).toMatchObject({ requestId: 'example-approval-3' });
    await again.close();
  });

  it('holds the request before it tells it: a refusal given from inside its own emission is taken, as main’s is', async () => {
    const session = exampleSessionFacet({ modes: 'restart' }).start(ASKING);
    const seen = collect(session);
    // As the registry does for a request it cannot place.
    session.subscribe((event) => { if (event.type === 'approval-raised') void session.decide?.(event.requestId, null); });
    session.send(turn);
    const told = await seen.ended('turn-1');
    expect(told.filter((event) => event.type === 'notice').map((event) => (event.type === 'notice' ? event.kind : ''))).toEqual(['request-refused']);
    expect(told.some((event) => event.type === 'approval-resolved' || event.type === 'activity-started')).toBe(false);
    expect(told.at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'completed', reported: true });
    await session.close();
  });

  it('reports another mode when a test says so: the next start takes no prompt, and the one after it does', async () => {
    const facet = exampleSessionFacet({ modes: 'restart' });
    facet.permissions.mismatchNext();
    const refused = facet.start(ASKING);
    const seen = collect(refused);
    refused.send({ ...turn, prompt: 'Say hello.' });
    expect(await seen.ended('turn-1')).toEqual([{ type: 'notice', turnId: 'turn-1', kind: 'policy-mismatch' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' }]);
    await refused.close();
    // The provider never took that turn: its history holds none of it, and the next start is as any.
    const page = await facet.history?.read(EXAMPLE_REFERENCE, { cursor: null, size: 10, detail: 'none' }, new AbortController().signal);
    expect(page?.kind === 'page' ? page.turns.map((kept) => kept.turnId) : null).toEqual(['example-turn-0']);
    const taken = facet.start(ASKING);
    const next = collect(taken);
    taken.send({ ...turn, prompt: 'Say hello.' });
    expect((await next.ended('turn-1')).at(-1)).toMatchObject({ outcome: 'completed', reported: true });
    await taken.close();
  });

  it('changes its mode on a live process in its `idle` form, with the CLI’s own word where it refuses, and says which modes an account can use', async () => {
    const facet = exampleSessionFacet({ modes: 'idle' });
    const session = facet.start(LOOKING);
    const seen = collect(session);
    await expect(session.setMode?.(EXAMPLE_ASK)).resolves.toEqual({ confirmed: true });
    expect(seen.events).toEqual([{ type: 'in-force', mode: EXAMPLE_ASK }]);
    // Under the mode it now runs under, the prompt asks.
    session.send(turn);
    const raised = await seen.first(isAsked, 'approval-raised');
    // Never with a turn running.
    await expect(session.setMode?.(EXAMPLE_LOOK)).resolves.toEqual({ confirmed: false, detail: null });
    await session.decide?.(raised.requestId, 'approve');
    await seen.ended('turn-1');
    facet.permissions.refuseNextChange();
    await expect(session.setMode?.(EXAMPLE_LOOK)).resolves.toEqual({ confirmed: false, detail: EXAMPLE_CHANGE_REFUSED });
    await expect(session.setMode?.('example-other')).resolves.toEqual({ confirmed: false, detail: null });
    await session.close();

    let changed = 0;
    const off = facet.onModesChanged?.(() => { changed += 1; });
    expect(facet.modes?.().map((mode) => [mode.id, mode.available, mode.reason])).toEqual([[EXAMPLE_LOOK, true, null], [EXAMPLE_ASK, true, null]]);
    facet.permissions.withhold(EXAMPLE_ASK);
    expect(facet.modes?.().map((mode) => [mode.id, mode.available, mode.reason])).toEqual([[EXAMPLE_LOOK, true, null], [EXAMPLE_ASK, false, 'unvalidated']]);
    facet.permissions.withhold(null);
    expect(facet.modes?.().every((mode) => mode.available)).toBe(true);
    expect(changed).toBe(2);
    off?.();
    facet.permissions.withhold(EXAMPLE_ASK);
    expect(changed).toBe(2);
  });

  // Through main, as the app wires it: the hierarchy, the runtime, the request registry, the chat service and a conversation store on disk.
  describe('through main', () => {
    interface Made { readonly app: App; readonly facet: ExampleFacet; readonly dir: string; relaunch(): App }
    async function withApp(change: 'restart' | 'idle', work: (made: Made) => Promise<void>, options: { readonly userDefault?: string; readonly projectDefault?: string; readonly before?: (facet: ExampleFacet) => void } = {}): Promise<void> {
      const root = mkdtempSync(path.join(tmpdir(), 'fatg-facet-modes-'));
      const folder = path.join(root, 'project');
      mkdirSync(folder);
      const { descriptor } = exampleDefinitionWithSessions({ history: false, modes: change });
      const facet = exampleSessionFacet({ history: false, modes: change });
      options.before?.(facet);
      const dir = path.join(root, 'data');
      placeRecords(dir, folder, descriptor.id, [sessionEntry(1, descriptor.id, { model: 'example-large', effort: 'quick' })], options.projectDefault === undefined ? {} : { permissionModes: { [descriptor.id]: options.projectDefault } });
      const launch = (): App => launchApp({ dir, descriptor, facet: () => facet, ...(options.userDefault === undefined ? {} : { userDefault: () => options.userDefault ?? null }) });
      let app = launch();
      try { await work({ get app() { return app; }, facet, dir, relaunch: () => { app = launch(); return app; } }); } finally { await app.service.settled(); app.drop(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    }
    const cards = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'interaction');
    const approval = (item: ConversationItem | undefined) => (item === undefined ? null : approvalOf(item));
    const entry = (app: App) => app.service.snapshot().sessions.find((candidate) => candidate.record.id === S(1));
    const rest = (app: App): Promise<unknown> => untilHolds(() => !app.service.isRunning(S(1)), 'the session coming to rest');

    it('gives a chat the provider’s fallback under its own name, starts its process under it, and makes a card of what its turn asks; approved from the card, the action runs', async () => {
      await withApp('restart', async ({ app, facet }) => {
        expect(entry(app)?.mode).toEqual({ id: EXAMPLE_ASK, source: 'fallback' });
        expect(app.read(1).mode).toEqual({ id: EXAMPLE_ASK, source: 'fallback' });
        expect(await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT)).toEqual({ status: 'accepted' });
        await untilHolds(() => cards(app).length === 1, 'the card');
        expect(facet.started).toEqual([EXAMPLE_ASK]);
        const [card] = cards(app);
        expect(card).toMatchObject({ providerItemId: 'example-action-1', workerId: null, interaction: { kind: 'approval', outcome: 'pending', request: EXAMPLE_APPROVAL, grant: null } });
        // In fat-g's words, never the command's; and under the mode its process said it runs under.
        expect(app.summary(1)).toMatchObject({ status: 'running', mode: EXAMPLE_ASK, attention: { kind: 'approval', count: 1 }, action: { kind: 'approving', label: 'Waiting for your approval' } });
        expect(app.read(1).items.filter((item) => item.role === 'assistant')).toEqual([]);
        // Only what the request's own view lists, from the card that is pending.
        expect(app.runtime.decide(S(1), 'no-such-item', 'approve')).toEqual({ status: 'refused', reason: 'unknown-item' });
        expect(app.runtime.decide(S(1), card?.id ?? '', 'approve')).toEqual({ status: 'decided' });
        expect(app.runtime.decide(S(1), card?.id ?? '', 'deny')).toEqual({ status: 'refused', reason: 'not-pending' });
        await rest(app);
        const decided = approval(cards(app)[0]);
        expect(decided).toMatchObject({ outcome: 'approved', delivered: true, grant: null });
        expect(decided?.confirmedAt).not.toBeNull();
        expect(decided === null ? null : outcomeWords(decided, false)).toBe('Approved once');
        expect(app.read(1).items.map((item) => `${item.kind}:${item.providerItemId}`)).toEqual(['message:example-user-1', 'interaction:example-action-1', 'activity:example-action-1', 'message:example-note-1', 'message:example-answer-1']);
        expect(app.read(1).items[2]?.activity).toMatchObject({ status: 'completed' });
        expect(app.read(1).grants).toEqual([]);
        expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
      });
    });

    it('keeps a denial as the user’s, withdraws a card at a Stop, and drops one that waited when the app quit', async () => {
      await withApp('restart', async ({ app }) => {
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await untilHolds(() => cards(app).length === 1, 'the card');
        expect(app.runtime.decide(S(1), cards(app)[0]?.id ?? '', 'deny')).toEqual({ status: 'decided' });
        await rest(app);
        expect(approval(cards(app)[0])).toMatchObject({ outcome: 'denied', delivered: true });
        expect(app.read(1).items.find((item) => item.kind === 'activity')?.activity).toMatchObject({ status: 'declined', declinedBy: 'user' });

        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await untilHolds(() => cards(app).length === 2, 'the second card');
        expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
        await rest(app);
        const withdrawn = approval(cards(app)[1]);
        expect(withdrawn).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
        expect(withdrawn === null ? null : outcomeWords(withdrawn, false)).toBe('Withdrawn: the reply ended');
        expect(app.runtime.decide(S(1), cards(app)[1]?.id ?? '', 'approve')).toEqual({ status: 'refused', reason: 'not-pending' });

        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await untilHolds(() => cards(app).length === 3, 'the third card');
        await app.runtime.stopAll();
        const dropped = approval(cards(app)[2]);
        expect(dropped === null ? null : outcomeWords(dropped, false)).toBe('Not answered: the session’s process ended');
      });
    });

    it('lists a grant for the session while its process lives, asks nothing for what it covers, and ends it at a change of mode, which closes that process', async () => {
      await withApp('restart', async ({ app, facet }) => {
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await untilHolds(() => cards(app).length === 1, 'the card');
        const id = cards(app)[0]?.id ?? '';
        expect(app.runtime.decide(S(1), id, 'approve-session')).toEqual({ status: 'decided' });
        await rest(app);
        expect(approval(cards(app)[0])).toMatchObject({ outcome: 'approved-session', grant: { covers: 'make example-note.txt', live: true } });
        expect(app.read(1).grants).toMatchObject([{ itemId: id, covers: 'make example-note.txt', confirmed: true, live: true }]);
        // The CLI's own grant: the next request is the provider's to leave unasked, and it does.
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await rest(app);
        expect(cards(app)).toHaveLength(1);
        expect(app.read(1).items.filter((item) => item.kind === 'activity').map((item) => item.activity?.status)).toEqual(['completed', 'completed']);

        // A change of mode this provider takes by a restart: saved at once, the process closed, nothing launched.
        expect(await app.runtime.setMode(S(1), 'ask-first')).toEqual({ status: 'refused', reason: 'unknown-mode' });
        expect(await app.runtime.setMode(S(1), EXAMPLE_LOOK)).toEqual({ status: 'set' });
        expect(entry(app)?.mode).toEqual({ id: EXAMPLE_LOOK, source: 'chat' });
        expect(facet.started).toEqual([EXAMPLE_ASK]);
        expect(app.read(1).grants).toMatchObject([{ itemId: id, live: false }]);
        expect(app.summary(1)?.mode).toBeNull();
        // Under its reading mode the same prompt is refused, with the notice.
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await rest(app);
        expect(facet.started).toEqual([EXAMPLE_ASK, EXAMPLE_LOOK]);
        expect(cards(app)).toHaveLength(1);
        // The notice says the mode is why, by the provider's own name for it: no shared file knows that name.
        expect(app.read(1).items.filter((item) => item.notice === 'request-refused').map(itemText)).toEqual(['Example asked to act, and this chat is Look only: the request was refused. Change the chat’s mode to be asked instead.']);
        // Each turn keeps the mode it ran under.
        expect(app.read(1).turns.map((kept) => kept.mode)).toEqual([EXAMPLE_ASK, EXAMPLE_ASK, EXAMPLE_LOOK]);
        // Back under the mode that asks, on a third process: the grant is gone, and it asks again.
        expect(await app.runtime.setMode(S(1), EXAMPLE_ASK)).toEqual({ status: 'set' });
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await untilHolds(() => cards(app).length === 2, 'the second card');
        expect(app.read(1).grants).toMatchObject([{ live: false }]);
        expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
        await rest(app);
      });
    });

    it('takes the project’s default before the user’s, snapshots it with its source, and keeps it across a restart whatever the defaults say then', async () => {
      await withApp('restart', ({ app }) => {
        expect(entry(app)?.mode).toEqual({ id: EXAMPLE_LOOK, source: 'user' });
        return Promise.resolve();
      }, { userDefault: EXAMPLE_LOOK });
      await withApp('restart', async (made) => {
        expect(entry(made.app)?.mode).toEqual({ id: EXAMPLE_ASK, source: 'project' });
        await made.app.runtime.send(S(1), 'Say hello.');
        await rest(made.app);
        await made.app.quit();
        // The project's default is taken away: the chat keeps what it was made with.
        const records = JSON.parse(readFileSync(path.join(made.dir, 'records.json'), 'utf8')) as { projects: Record<string, unknown>[] };
        delete records.projects[0]?.['permissionModes'];
        writeFileSync(path.join(made.dir, 'records.json'), JSON.stringify(records));
        const again = made.relaunch();
        expect(entry(again)?.mode).toEqual({ id: EXAMPLE_ASK, source: 'project' });
        expect(again.read(1).mode).toEqual({ id: EXAMPLE_ASK, source: 'project' });
      }, { userDefault: EXAMPLE_LOOK, projectDefault: EXAMPLE_ASK });
    });

    it('falls to its reading mode where the account cannot use the fallback; and a chat whose own mode became unusable is blocked, with nothing substituted, until another is chosen', async () => {
      await withApp('restart', ({ app }) => {
        expect(entry(app)?.mode).toEqual({ id: EXAMPLE_LOOK, source: 'fallback' });
        expect(entry(app)?.block).toBeNull();
        return Promise.resolve();
      }, { before: (facet) => facet.permissions.withhold(EXAMPLE_ASK) });
      await withApp('restart', async ({ app, facet }) => {
        expect(entry(app)?.mode).toEqual({ id: EXAMPLE_ASK, source: 'fallback' });
        facet.permissions.withhold(EXAMPLE_ASK);
        app.service.availabilityChanged();
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_ASK, source: 'fallback' }, block: 'mode-unavailable' });
        expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'refused', reason: 'mode-unavailable' });
        expect(facet.started).toEqual([]);
        // The remedy's change is taken under that block, to a mode the account can use and to no other.
        expect(await app.runtime.setMode(S(1), EXAMPLE_ASK)).toEqual({ status: 'refused', reason: 'mode-unavailable' });
        expect(await app.runtime.setMode(S(1), EXAMPLE_LOOK)).toEqual({ status: 'set' });
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_LOOK, source: 'chat' }, block: null });
        expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'accepted' });
        await rest(app);
        expect(facet.started).toEqual([EXAMPLE_LOOK]);
      });
    });

    it('blocks Send after a start that reported another mode, says so in the chat, and sends again once a mode is taken', async () => {
      await withApp('restart', async ({ app, facet }) => {
        facet.permissions.mismatchNext();
        expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'accepted' });
        await untilHolds(() => entry(app)?.block === 'mode-unconfirmed', 'the block');
        await rest(app);
        expect(app.read(1).items.filter((item) => item.notice === 'policy-mismatch')).toHaveLength(1);
        expect(app.read(1).items.filter((item) => item.role === 'assistant')).toEqual([]);
        expect(app.summary(1)?.mode).toBeNull();
        expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'refused', reason: 'mode-unconfirmed' });
        // The same mode, taken again, is another try.
        expect(await app.runtime.setMode(S(1), EXAMPLE_ASK)).toEqual({ status: 'set' });
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_ASK, source: 'chat' }, block: null });
        expect(await app.runtime.send(S(1), 'Say hello.')).toEqual({ status: 'accepted' });
        await rest(app);
        expect(app.summary(1)?.mode).toBe(EXAMPLE_ASK);
        expect(app.read(1).items.filter((item) => item.role === 'assistant').length).toBeGreaterThan(0);
      });
    });

    it('changes the mode on the live process where the provider declares that: one process, the change saved once confirmed, and nothing saved of one the CLI refused', async () => {
      await withApp('idle', async ({ app, facet }) => {
        await app.runtime.send(S(1), 'Say hello.');
        await rest(app);
        expect(app.summary(1)?.mode).toBe(EXAMPLE_ASK);
        expect(await app.runtime.setMode(S(1), EXAMPLE_LOOK)).toEqual({ status: 'set' });
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_LOOK, source: 'chat' }, block: null, changingMode: false });
        expect(app.summary(1)?.mode).toBe(EXAMPLE_LOOK);
        // The same process took it: nothing was started again.
        expect(facet.started).toEqual([EXAMPLE_ASK]);
        await app.runtime.send(S(1), EXAMPLE_APPROVAL_PROMPT);
        await rest(app);
        expect(facet.started).toEqual([EXAMPLE_ASK]);
        expect(cards(app)).toEqual([]);
        expect(app.read(1).items.filter((item) => item.notice === 'request-refused')).toHaveLength(1);

        facet.permissions.refuseNextChange();
        expect(await app.runtime.setMode(S(1), EXAMPLE_ASK)).toEqual({ status: 'refused', reason: 'not-confirmed', detail: EXAMPLE_CHANGE_REFUSED });
        // Nothing saved: the chat's mode is as it was, and Send waits for a change to be taken.
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_LOOK, source: 'chat' }, block: 'mode-unconfirmed' });
        expect(app.read(1).mode).toEqual({ id: EXAMPLE_LOOK, source: 'chat' });
        expect(await app.runtime.setMode(S(1), EXAMPLE_ASK)).toEqual({ status: 'set' });
        expect(entry(app)).toMatchObject({ mode: { id: EXAMPLE_ASK, source: 'chat' }, block: null });
      });
    });
  });
});
