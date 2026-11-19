// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V7, the adapter's part (docs/planning/_archive/M22b.md, Design 5, 8; C13–C15, C53, C55, C59, C61, C80):
// a Codex plan turn on the real adapter and process layer against the replay fake, which replays
// K2's plan turns for a `turn/start` that names `collaborationMode`. No test here uses the real CLI.
//
// What the fake was sent is read from what it noted with the thread: each turn's
// `collaborationMode`, the mode it left the thread in, and each reply to a request. Every wait is on
// the event it waits for.
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import { NO_ANSWER } from '@shared/contracts/interaction';
import { PLANS_AVAILABLE } from '@shared/contracts/plans';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, type Harness, PROMPTS, promptOf, type ThreadEntry, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const MODEL = 'gpt-6-luna';
const MIB = 1024 * 1024;
/** K2's plan turn's words, under each workspace mode: the chain's first, and the three of `modes`. */
const WORDS = promptOf('m22b-codex-modes');
/** M21's plan turn, which asks before it plans. */
const ASKS = promptOf('m21-codex-plan');
const start = (h: Harness, mode: string, key = 'process-1'): Watched => watch(h.facet.start({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode, processKey: key }));
const resume = (h: Harness, mode: string, reference: string, key = 'process-2'): Watched => watch(h.facet.resume({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode, processKey: key, reference }));
const codex = (session: Watched): CodexSession => session.session as CodexSession;
const of = <T extends AgentEvent['type']>(session: Watched, type: T) => session.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const thread = (h: Harness): ThreadEntry & { readonly collaborations?: readonly unknown[]; readonly collaboration?: string } => { const [found] = Object.values(h.threads()); if (found === undefined) throw new Error('the fake has no thread'); return found; };
const named = (mode: string): unknown => ({ mode, settings: { model: MODEL, reasoning_effort: 'low', developer_instructions: null } });
const valid = (session: Watched): void => { for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true); };
/** Every request for leave declined as K2's were, until the turn has ended. */
async function declineAll(session: Watched, turnId: string): Promise<Extract<AgentEvent, { type: 'turn-ended' }>> {
  const answered = new Set<string>();
  for (;;) {
    const next = await session.until((event) => (event.type === 'turn-ended' && event.turnId === turnId) || (event.type === 'approval-raised' && !answered.has(event.requestId)), 60_000);
    if (next.type === 'turn-ended') return next;
    if (next.type === 'approval-raised') { answered.add(next.requestId); await codex(session).decide(next.requestId, 'deny'); }
  }
}
/** The plan's text as its deltas brought it, and as its completion gave it. */
function planOf(session: Watched): { readonly deltas: string; readonly completed: string | null; readonly itemIds: readonly string[] } {
  const deltas = of(session, 'plan-delta');
  const completed = of(session, 'plan-completed');
  return { deltas: deltas.map((event) => event.text).join(''), completed: completed.at(-1)?.text ?? null, itemIds: [...new Set(deltas.map((event) => event.itemId))] };
}

describe('a plan turn (V3; C13, C14)', () => {
  it.each([['sandbox-ok'], ['auto-reviewed'], ['berserk'], ['ask-first']])('under %s names the plan mode with the record’s model, the turn’s effort and null instructions, and streams its plan to the completed text — no activity', async (mode) => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const session = start(h, mode);
    session.send(WORDS, 1, 'low', { plan: true });
    expect(await declineAll(session, 'turn-1')).toMatchObject({ outcome: 'completed' });
    expect(thread(h).collaborations).toEqual([named('plan')]);
    const plan = planOf(session);
    expect(plan.itemIds).toHaveLength(1);
    // Its start opens it, empty; its completion is the authority, which the deltas added up to (K2).
    expect(of(session, 'plan-delta')[0]).toMatchObject({ turnId: 'turn-1', text: '' });
    expect(plan.completed).toBe(plan.deltas);
    expect(plan.completed).toMatch(/^## /);
    // A plan is no activity: its line and its tab stand for it (C23).
    expect(session.events.some((event) => event.type === 'activity-started' && event.name === 'plan')).toBe(false);
    valid(session);
  }, 90_000);

  it('names default on a turn of a thread that planned before, nothing on a thread that never planned (C55)', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const planned = start(h, 'sandbox-ok');
    planned.send(WORDS, 1, 'low', { plan: true });
    await declineAll(planned, 'turn-1');
    planned.send(PROMPTS.t1, 2, 'low', { plannedBefore: true });
    await declineAll(planned, 'turn-2');
    expect(thread(h).collaborations).toEqual([named('plan'), named('default')]);
    expect(thread(h).collaboration).toBe('default');
    const reference = planned.reference();
    await planned.session.close();
    // Never planned: as today.
    const plain = start(h, 'sandbox-ok', 'process-3');
    plain.send(PROMPTS.t1);
    await declineAll(plain, 'turn-1');
    const entries = Object.entries(h.threads());
    const other = entries.find(([id]) => id !== reference)?.[1] as { collaborations?: unknown[] } | undefined;
    expect(other?.collaborations).toEqual([null]);
  }, 90_000);

  it('names default on a resumed thread that planned, after a restart (C55)', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const first = start(h, 'ask-first');
    first.send(promptOf('m22b-codex-resumed-first'), 1, 'low', { plan: true });
    await declineAll(first, 'turn-1');
    const reference = first.reference() ?? '';
    await first.session.close();
    const again = resume(h, 'ask-first', reference);
    again.send(promptOf('m22b-codex-resumed-resumed'), 1, 'low', { plannedBefore: true });
    expect(await declineAll(again, 'turn-1')).toMatchObject({ outcome: 'completed' });
    expect(thread(h).collaborations).toEqual([named('plan'), named('default')]);
    expect(of(again, 'plan-delta')).toEqual([]);
  }, 90_000);
});

describe('Skip on a plan turn’s question (C53)', () => {
  it('replies "No answer" under each question’s id; Codex takes it and the turn goes on, with no plan', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'read-only');
    session.send(ASKS, 1, 'low', { plan: true });
    const raised = await session.until((event) => event.type === 'question-raised', 30_000);
    if (raised.type !== 'question-raised') throw new Error(raised.type);
    codex(session).decline(raised.requestId);
    expect(await session.ended('turn-1', 60_000)).toMatchObject({ outcome: 'completed' });
    expect(thread(h).replies).toEqual([{ id: expect.any(Number) as number, result: { answers: { notes_file: { answers: [NO_ANSWER] } } } }]);
    expect(of(session, 'question-resolved').map((event) => event.reason)).toEqual(['confirmed']);
    expect(of(session, 'plan-completed')).toEqual([]);
    // A second Skip of the same request is counted, and nothing is written.
    codex(session).decline(raised.requestId);
    expect(codex(session).counts.questions.unheld).toBe(1);
    expect(thread(h).replies).toHaveLength(1);
    valid(session);
  }, 90_000);
});

describe('best effort (C13, C80)', () => {
  it('opens the process again with the plain handshake where the experimental one is refused: plans read unavailable for the account, and the session goes on as ever', async () => {
    const h = harness = await codexHarness();
    h.control({ experimentalRefused: true });
    expect(h.facet.plans?.()).toEqual(PLANS_AVAILABLE);
    const session = start(h, 'read-only');
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1', 60_000)).toMatchObject({ outcome: 'completed' });
    expect(h.facet.plans?.()).toEqual({ available: false, reason: 'cli-refuses' });
    expect(thread(h).collaborations).toEqual([null]);
    // A plan turn is then not sent; a later process asks for the experimental API no more.
    session.send(WORDS, 2, 'low', { plan: true });
    expect(await session.ended('turn-2', 30_000)).toMatchObject({ outcome: 'failed' });
    expect(thread(h).collaborations).toEqual([null]);
    await session.session.close();
    h.control({});
    const next = start(h, 'read-only', 'process-2');
    next.send(PROMPTS.t1, 1, 'low', { plannedBefore: true });
    expect(await next.ended('turn-1', 60_000)).toMatchObject({ outcome: 'completed' });
    const entries = Object.values(h.threads()) as { collaborations?: unknown[] }[];
    expect(entries.map((entry) => entry.collaborations)).toEqual([[null], [null]]);
  }, 90_000);

  it('marks plans unavailable where a turn that names a collaboration mode is refused, that turn failing at its send', async () => {
    const h = harness = await codexHarness();
    h.control({ collaborationRefused: true });
    const session = start(h, 'read-only');
    session.send(WORDS, 1, 'low', { plan: true });
    expect(await session.ended('turn-1', 60_000)).toMatchObject({ outcome: 'failed' });
    expect(session.events).toContainEqual({ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' });
    expect(h.facet.plans?.()).toEqual({ available: false, reason: 'cli-refuses' });
  }, 60_000);
});

describe('the plan’s size and its process (C59–C61)', () => {
  it('takes a plan of over a megabyte whole: its deltas and its completion', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready', planLarge: true });
    const session = start(h, 'sandbox-ok');
    session.send(WORDS, 1, 'low', { plan: true });
    await declineAll(session, 'turn-1');
    const plan = planOf(session);
    expect(plan.completed?.length).toBeGreaterThan(MIB);
    expect(plan.completed).toBe(plan.deltas);
    valid(session);
  }, 90_000);

  it('leaves a plan whose completion is a line past the limit with what its deltas brought, and the turn goes on to its end', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready', planOverLine: true });
    const session = start(h, 'sandbox-ok');
    session.send(WORDS, 1, 'low', { plan: true });
    expect(await declineAll(session, 'turn-1')).toMatchObject({ outcome: 'completed' });
    const plan = planOf(session);
    expect(plan.completed).toBeNull();
    expect(plan.deltas).toMatch(/^## /);
    valid(session);
  }, 90_000);

  it('ends the turn as lost where the process ends while the plan is being written', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready', exitWhilePlanning: 1 });
    const session = start(h, 'sandbox-ok');
    session.send(WORDS, 1, 'low', { plan: true });
    const ended = await session.ended('turn-1', 60_000);
    expect(ended.outcome).not.toBe('completed');
    expect(of(session, 'plan-completed')).toEqual([]);
    expect(of(session, 'plan-delta').length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('the descriptor (C2, C5, C53)', () => {
  it('declares the decline, and a plan turn under every mode', async () => {
    const h = harness = await codexHarness();
    expect(h.provider.descriptor.capabilities).toMatchObject({ declines: true, plans: { modes: ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk'] } });
  });
});
