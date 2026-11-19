// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 and V7, Claude's part (docs/planning/_archive/M22b.md, Design 4, 8; C5, C7–C11, C51, C61, C70, C77): a plan
// turn on the real adapter and process layer against the replay fake — plan mode set on the live
// process before the prompt and confirmed, the plan's request raised with the plan's text, each of
// the three decisions and what the CLI does after it, the mode set back at the turn's end, and the
// faults of a plan's request. The turns are K1's own, as tests/fixtures/claude/captures/ holds them
// (`m22b-plan-*`), and a fault is a captured frame with one named change. Every wait is on an event
// of the session's, or on what the fake noted of what it was sent.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { PLAN_CANCEL_MESSAGE, PLAN_MISSING_MESSAGE } from '../../../src/main/providers/claude/chat-wire';
import { claudeHarness, eventually, type Harness, type HarnessOptions, processGone, promptOf, under, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness, mode = 'ask-first') => watch(h.facet.start(under(h, mode)));
const claude = (s: Watched): ClaudeChatSession => s.session as ClaudeChatSession;
const of = <T extends AgentEvent['type']>(s: Watched, type: T): Extract<AgentEvent, { type: T }>[] => s.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const valid = (s: Watched): void => { for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 160)).toBe(true); };
/** The session's nth plan, once it has been raised. */
const planned = async (s: Watched, nth = 1): Promise<Extract<AgentEvent, { type: 'plan-raised' }>> => {
  await s.until(() => of(s, 'plan-raised').length >= nth);
  return of(s, 'plan-raised')[nth - 1] as Extract<AgentEvent, { type: 'plan-raised' }>;
};
/** A capture's plans, as the requests carried them. */
const capturedPlans = (name: string): string[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: { type?: string; request?: { tool_name?: string; input?: { plan?: string } } } }[] }).frames
  .filter((entry) => entry.dir === 'recv' && entry.frame.type === 'control_request' && entry.frame.request?.tool_name === 'ExitPlanMode')
  .map((entry) => entry.frame.request?.input?.plan ?? '');
const planPrompt = (h: Harness): string => promptOf('m22b-plan-ask-first', h.project);
const modesSet = (h: Harness): string[] => h.only().entry.modes.map((set) => `${set.mode}:${set.answered}`);
const plan = { plan: true } as const;

describe('a plan turn, and its plan raised (V3; C5, C7–C10)', () => {
  it('sets plan mode on the live process before the prompt, under each mode that acts, and raises the plan with the request’s own text', async () => {
    const h = await open();
    for (const [n, [mode, capture]] of ([['ask-first', 'm22b-plan-ask-first'], ['edits-ok', 'm22b-plan-edits-ok'], ['auto-reviewed', 'm22b-plan-auto-reviewed'], ['berserk', 'm22b-plan-berserk']] as const).entries()) {
      const s = start(h, mode);
      s.send(planPrompt(h), 1, 'low', plan);
      const raised = await planned(s);
      expect(raised, mode).toEqual({ type: 'plan-raised', turnId: 'turn-1', requestId: raised.requestId, sourceId: raised.sourceId, text: capturedPlans(capture)[0]?.replaceAll('<scratch>', h.project) });
      // Plan mode, set once and answered, before the prompt: the mode's own confirmation names no plan.
      expect(Object.values(h.sessions())[n]?.modes.map((set) => [set.mode, set.turn, set.answered]), mode).toEqual([['plan', false, 'success']]);
      expect(s.confirmed, mode).toEqual([mode]);
      // The plan's tool opens no activity: its line stands for it.
      expect(of(s, 'activity-started').filter((event) => event.name === 'ExitPlanMode'), mode).toEqual([]);
      valid(s);
      await s.session.close();
    }
  });

  it('takes no plan turn under Read only: nothing is set and nothing is sent (C70)', async () => {
    const h = await open();
    const s = start(h, 'read-only');
    s.send(planPrompt(h), 1, 'low', plan);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'failed', reported: false });
    expect(h.only().entry.modes).toEqual([]);
    expect(h.only().entry.turns).toEqual([]);
  });

  it('declares its plans: the four modes that act, Read only’s reason, every account able (C2, C5, C70)', async () => {
    const h = await open();
    expect(h.provider.descriptor.capabilities.plans?.modes).toEqual(['ask-first', 'edits-ok', 'auto-reviewed', 'berserk']);
    expect(h.provider.descriptor.capabilities.plans?.unavailable).toMatch(/Read only/);
    expect(h.facet.plans?.()).toEqual({ available: true });
  });
});

describe('the three decisions (V3; C7, C11, C77)', () => {
  it('Execute: a plain allow of the request as it came, after which the CLI is back in the chat’s mode, the turn goes on under it, and nothing is set back', async () => {
    const h = await open();
    const s = start(h, 'ask-first');
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    expect(await claude(s).decidePlan(raised.requestId, { kind: 'execute' })).toBe(true);
    // The implementation's own request to act, under Ask first: the turn goes on under the chat's mode.
    const asked = await s.until((event) => event.type === 'approval-raised');
    expect(asked.type === 'approval-raised' && asked.request.tool).toBe('Edit');
    await claude(s).decide(asked.type === 'approval-raised' ? asked.requestId : '', 'approve');
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const answers = h.only().entry.answers;
    expect(answers[0]).toMatchObject({ behavior: 'allow', updatedInput: { plan: raised.text } });
    expect(answers[0]).not.toHaveProperty('updatedPermissions');
    expect(of(s, 'plan-resolved')).toEqual([{ type: 'plan-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
    // The CLI went back by itself (K1): the one set is plan's.
    expect(modesSet(h)).toEqual(['plan:success']);
    expect(s.notices()).toEqual([]);
    valid(s);
  });

  it('feedback: a deny in the user’s words, after which the model revises and asks again — the next version — and that one is executed', async () => {
    const h = await open();
    const s = start(h, 'auto-reviewed');
    s.send(planPrompt(h), 1, 'low', plan);
    const first = await planned(s);
    expect(await claude(s).decidePlan(first.requestId, { kind: 'feedback', text: 'Add a final step that reads the file back.' })).toBe(true);
    const second = await planned(s, 2);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.text).toBe(capturedPlans('m22b-plan-auto-reviewed')[1]?.replaceAll('<scratch>', h.project));
    expect(h.only().entry.answers[0]).toMatchObject({ behavior: 'deny', message: 'Add a final step that reads the file back.' });
    await claude(s).decidePlan(second.requestId, { kind: 'execute' });
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(modesSet(h)).toEqual(['plan:success']);
    expect(s.notices()).toEqual([]);
  });

  it('Cancel: a deny in fat-g’s words with the interrupt; the turn reads stopped with no notice, and the chat’s mode is set back', async () => {
    const h = await open();
    const s = start(h, 'ask-first');
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    expect(await claude(s).decidePlan(raised.requestId, { kind: 'cancel' })).toBe(true);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'interrupted', reported: true });
    expect(h.only().entry.answers[0]).toMatchObject({ behavior: 'deny', message: PLAN_CANCEL_MESSAGE });
    expect(s.notices()).toEqual([]);
    // Set back to the chat's own word, and confirmed by fat-g's id for it.
    await eventually(() => modesSet(h).length === 2);
    expect(modesSet(h)).toEqual(['plan:success', 'default:success']);
    await eventually(() => s.confirmed.length === 2);
    expect(s.confirmed).toEqual(['ask-first', 'ask-first']);
  });

  it('a Stop with a plan pending: the CLI takes the request back, and the launch’s own word is set back on the process launched with it, Berserk’s included (C6, C7, C51)', async () => {
    const h = await open();
    const s = start(h, 'berserk');
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    s.session.stop();
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'interrupted' });
    await eventually(() => modesSet(h).length === 2);
    expect(modesSet(h)).toEqual(['plan:success', 'bypassPermissions:success']);
    // The request went with the Stop, which its turn's end settles: no answer was ever sent.
    expect(h.only().entry.answers).toEqual([]);
    expect(of(s, 'plan-resolved').filter((event) => event.requestId === raised.requestId && event.reason === 'confirmed')).toEqual([]);
    await eventually(() => s.confirmed.length === 2);
    expect(s.confirmed).toEqual(['berserk', 'berserk']);
  });

  it('ends the process with the notice where the CLI does not take the mode set back (C7)', async () => {
    const h = await open();
    const s = start(h, 'edits-ok');
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    h.control({ modeRefused: 1 });
    await claude(s).decidePlan(raised.requestId, { kind: 'cancel' });
    await s.until((event) => event.type === 'notice' && event.kind === 'policy-mismatch');
    await processGone(h, s.session);
  });
});

describe('a plan’s request, one named thing changed (V3, V7; C9, C10, C61)', () => {
  it('refuses a request that carries no plan in fat-g’s words, with its notice, and raises none', async () => {
    const h = await open();
    h.control({ planEmpty: true });
    const s = start(h);
    s.send(planPrompt(h), 1, 'low', plan);
    await s.until((event) => event.type === 'notice' && event.kind === 'plan-missing');
    expect(of(s, 'plan-raised')).toEqual([]);
    await eventually(() => h.only().entry.answers.length >= 1);
    expect(h.only().entry.answers[0]).toMatchObject({ behavior: 'deny', message: PLAN_MISSING_MESSAGE });
  });

  it('takes a plan of a mebibyte whole, and refuses one past a session’s line with the plan’s own notice', async () => {
    const h = await open();
    h.control({ planMiB: true });
    const s = start(h);
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    expect(raised.text.length).toBe(1024 * 1024);
    await s.session.close();
    h.control({ planOverLine: true });
    const t = start(h);
    t.send(planPrompt(h), 1, 'low', plan);
    const notice = await t.until((event) => event.type === 'notice' && event.kind === 'plan-too-large');
    expect(notice).toMatchObject({ kind: 'plan-too-large', turnId: 'turn-1' });
    expect(of(t, 'plan-raised')).toEqual([]);
  });

  it('says a plan dropped where its process ends with it pending, before the turn’s end (C6)', async () => {
    const h = await open();
    h.control({ exitWhilePlanning: 1 });
    const s = start(h);
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    await s.until((event) => event.type === 'plan-resolved' && event.requestId === raised.requestId && event.reason === 'dropped');
    const types = s.types();
    expect(types.indexOf('plan-resolved')).toBeLessThan(types.indexOf('turn-ended'));
  });

  it('refuses a plan’s request after the turn’s own Execute: the turn plans no longer (C8)', async () => {
    const h = await open();
    // The plan's second request comes after the first's Execute: auto-reviewed's capture, executed at its first.
    const s = start(h, 'auto-reviewed');
    s.send(planPrompt(h), 1, 'low', plan);
    const raised = await planned(s);
    await claude(s).decidePlan(raised.requestId, { kind: 'execute' });
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    expect(of(s, 'plan-raised')).toHaveLength(1);
  });
});
