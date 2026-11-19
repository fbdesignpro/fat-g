// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8's automated part (docs/planning/_archive/M22b.md, Design 7; C1, C23–C25, C58, C64, C67, C69, C72, C73):
// a plan in the page — its line in the list, the decision panel in the input's place, Review
// existing plan, a prompt's folded block, and the plan's tab with its watcher — on the chat region
// and the pane, over a fake bridge whose plan channels the tests answer.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./review-availability', () => ({ REVIEW_AVAILABLE: true }));
import type { ConversationItem } from '@shared/contracts/conversation';
import { type PlanBody, raisedPlan } from '@shared/contracts/interaction';
import { MAX_FEEDBACK_TEXT, type PlanCapability, type PlanRead, type PlanSummary, type PlanVersionView, planBlock, planFeedback, planPrompt, PLAN_WORDS } from '@shared/contracts/plans';
import type { SessionEntry } from '@shared/contracts/sessions';
import { WORKFLOW_WORDS } from '@shared/contracts/workflow';
import type { WorkflowView } from '@shared/contracts/workflow';
import { sampleDescriptor, sampleProvider } from '../../../../tests/support/app-state';
import { openPlan, PLAN_KIND } from '../artifacts/opener';
import { PlanWatcher } from '../artifacts/plan/PlanWatcher';
import { PLAN_TAB_WORDS } from '../artifacts/plan/words';
import { closeTab, resetTabs, setViewState, tabId, useTabs } from '../artifacts/tabs-store';
import { type AsideStage, asideStage, session } from '../test/asides';
import { chatItem, chatTurn } from '../test/chat';
import { MODES } from '../test/permissions';
import { choosePlan, composerOf, editDraft, flushDraft, resetComposers } from './composer/composer-store';
import { PLAN_PAGE_WORDS } from './plan-words';
import { plansRemoved, readPlanInfo, resetPlans } from './plans-store';
import { resetPromptTypes, usePromptTypes } from './prompt-type-store';
import { TOOLBAR_WORDS } from './Toolbar';

const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const TEXT = '# Tidy the notes\n\n1. Read them.\n2. Tidy them.';
const PLANNING: PlanCapability = { modes: ['ask-first'], unavailable: 'Read only takes no plan turn.' };
const planner = () => sampleProvider({ id: 'codex', displayName: 'Codex', descriptor: { ...sampleDescriptor({ id: 'codex', displayName: 'Codex' }), capabilities: { ...sampleDescriptor().capabilities, plans: PLANNING } } });
const under = (entry: SessionEntry, mode = 'ask-first', patch: Partial<SessionEntry> = {}): SessionEntry => ({ ...entry, mode: { id: mode, source: 'chat' }, ...patch });
const ONE = under(session('Create plan'));
const TWO = under(session('Other chat'));
const ID = ONE.record.id;

const version = (n: number, patch: Partial<PlanVersionView> = {}): PlanVersionView => ({ version: n, state: 'complete', at: 1_578_924_800_000 + n, cause: n === 1 ? 'plan-turn' : 'feedback', revises: n === 1 ? null : n - 1, providerId: 'codex', model: 'gpt-6-sol', sessionId: ID, chat: 'Create plan', length: TEXT.length, hash: HASH, integration: null, ...patch });
const flowOf = (patch: Partial<WorkflowView> = {}): WorkflowView => ({ planId: PLAN, state: 'ready', revision: 1, version: 1, participants: [ID], holder: null, operation: null, reviewId: null, busy: null, ...patch });
const read = (patch: Partial<PlanRead> = {}): PlanRead => ({ status: 'read', planId: PLAN, projectId: ONE.record.projectId, title: 'Tidy the notes', createdAt: 1, versions: [version(1)], workflow: flowOf(), version: 1, length: TEXT.length, hash: HASH, start: 0, text: TEXT, ...patch });
const lineItem = (body: Partial<PlanBody> = {}): ConversationItem => chatItem(ID, 'assistant', '', { kind: 'interaction', interaction: { ...raisedPlan({ planId: PLAN, version: 1, came: 'made', request: false }), ...body } });

let stage: AsideStage;
let plan: PlanRead;
beforeEach(() => {
  stage = asideStage();
  stage.providers = [planner()];
  resetPromptTypes();
  resetComposers();
  resetPlans();
  resetTabs();
  plan = read();
  stage.answers['plans:read'] = (request) => {
    const { start, length } = request as { start: number; length: number };
    return { ...plan, start, text: TEXT.slice(start, start + length) };
  };
  stage.answers['plans:decide'] = () => ({ status: 'decided' });
});
afterEach(() => { cleanup(); resetComposers(); });

async function open(items: ConversationItem[], entries: SessionEntry[] = [ONE], pane = false) {
  const chat = stage.chat(ONE);
  chat.items = items;
  chat.revision = 2;
  await stage.open(entries, entries[0], pane);
  await stage.settle();
}
const sent = (channel: 'plans:decide' | 'plans:bring' | 'plans:remove' | 'plans:list') => stage.sent(channel);

describe('the completed plan notice', () => {
  it('leaves the composer after the first post-implementation turn ends', async () => {
    const at = 2_000;
    stage.answers['plans:workflow'] = () => ({ status: 'read', workflow: { kind: 'implemented', sessionId: ID, chat: 'Create plan', at } });
    const implemented = chatItem(ID, 'assistant', 'Implemented.', { turnId: 'implementation', order: { turn: 1, item: 0 } });
    stage.chat(ONE).turns.set(implemented.turnId, chatTurn(implemented.turnId, { place: 1, time: { ...chatTurn(implemented.turnId).time, acceptedAt: 1_000, endReceivedAt: at } }));
    await open([implemented]);
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();

    const prompt = chatItem(ID, 'user', 'One follow-up.', { turnId: 'follow-up', order: { turn: 2, item: 0 } });
    const running = chatTurn(prompt.turnId, { place: 2, state: 'running', outcome: null, time: { ...chatTurn(prompt.turnId).time, acceptedAt: at + 1 } });
    stage.chat(ONE).turns.set(running.id, running);
    stage.push({ sessionId: ID, revision: 3, item: prompt, turn: running });
    await stage.settle();
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();

    const ended = { ...running, state: 'ended' as const, outcome: 'completed' as const, time: { ...running.time, endReceivedAt: at + 100 } };
    stage.chat(ONE).turns.set(ended.id, ended);
    stage.push({ sessionId: ID, revision: 4, item: chatItem(ID, 'assistant', 'Follow-up complete.', { turnId: ended.id, order: { turn: 2, item: 1 } }), turn: ended });
    await stage.settle();
    expect(screen.queryByText(WORKFLOW_WORDS.implementedHere)).toBeNull();
  });
});

describe('a plan’s line (C23)', () => {
  it('reads Plan: and the plan’s title as one button, its version where it has several, and what became of its decision', async () => {
    plan = read({ versions: [version(1), version(2)] });
    await open([lineItem({ outcome: 'executed', version: 2 })]);
    const line = document.querySelector('[data-plan-line]') as HTMLElement;
    // The button names it a plan's (M22e): no label stands before it. Its version is in its box (the maintainer).
    const box = within(line).getByRole('button', { name: 'Plan: Tidy the notes (v2)' });
    expect(line.textContent?.startsWith('Plan: Tidy the notes (v2)')).toBe(true);
    expect(line.textContent).toContain('Executed');
    expect(line.textContent).not.toContain('Codex');
    expect(line.textContent).not.toContain('gpt-6-sol');
    // Its light bulb, and nothing of a plan being written.
    expect(box.querySelector('svg')).not.toBeNull();
    expect(box.hasAttribute('data-writing')).toBe(false);
    expect(box.textContent).not.toContain(PLAN_PAGE_WORDS.writing);
  });

  it('draws its box dashed while Codex writes the plan, saying so, and solid once it is complete (the maintainer)', async () => {
    const writing = lineItem({ outcome: 'writing' });
    await open([writing]);
    const box = (): HTMLElement => document.querySelector('[data-plan-line] button') as HTMLElement;
    expect(box().hasAttribute('data-writing')).toBe(true);
    expect(box().textContent).toBe(`Plan: Tidy the notes${PLAN_PAGE_WORDS.writing}`);
    stage.push({ sessionId: ID, revision: 3, item: { ...writing, interaction: raisedPlan({ planId: PLAN, version: 1, came: 'made', request: false }) }, turn: chatTurn(writing.turnId) });
    await stage.settle();
    expect(box().hasAttribute('data-writing')).toBe(false);
    expect(box().textContent).toBe('Plan: Tidy the notes');
  });

  it('says a brought plan was brought, and a removed plan was removed, its button doing nothing', async () => {
    stage.answers['plans:read'] = () => ({ status: 'refused', reason: 'unknown-plan' });
    await open([lineItem({ came: 'brought', outcome: 'cancelled' })]);
    const line = document.querySelector('[data-plan-line]') as HTMLElement;
    expect(line.textContent).toContain(PLAN_PAGE_WORDS.brought);
    expect(within(line).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.removed }).disabled).toBe(true);
  });

  it('says its plan was removed once Settings removed every plan, read again with nothing pressed (the maintainer’s review)', async () => {
    plan = read({ versions: [version(1)] });
    await open([lineItem({ outcome: 'executed', version: 1 })]);
    const line = document.querySelector('[data-plan-line]') as HTMLElement;
    expect(within(line).getByRole('button', { name: 'Plan: Tidy the notes' })).not.toBeNull();
    stage.answers['plans:read'] = () => ({ status: 'refused', reason: 'unknown-plan' });
    act(() => { plansRemoved(); });
    await stage.settle();
    expect(within(line).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.removed }).disabled).toBe(true);
  });
});

describe('the decision panel (C24, C58, C72)', () => {
  it.each([
    { decision: 'execute', request: false },
    { decision: 'execute', request: true },
    { decision: 'cancel', request: false },
    { decision: 'cancel', request: true },
  ] as const)('releases Plan after $decision succeeds, saves the choice, and sends a normal follow-up (request: $request)', async ({ decision, request }) => {
    const pending = lineItem({ request });
    await open([pending]);
    act(() => {
      choosePlan(ID, true);
      choosePlan(TWO.record.id, true);
      editDraft(ID, 'And check edge cases.');
    });
    await flushDraft(ID);
    fireEvent.click(screen.getByRole('button', { name: PLAN_PAGE_WORDS[decision] }));
    await stage.settle();
    expect(composerOf(ID).intent.plan).toBe(false);
    expect(usePromptTypes.getState().types[ID]).toBeUndefined();
    expect(composerOf(TWO.record.id).intent.plan).toBe(true);
    await flushDraft(ID);
    expect(stage.sent('chat:draft').at(-1)).toMatchObject({ sessionId: ID, prompt: 'And check edge cases.', intent: { plan: false } });

    stage.push({ sessionId: ID, revision: 3, item: { ...pending, interaction: { ...raisedPlan({ planId: PLAN, version: 1, came: 'made', request }), outcome: decision === 'execute' ? 'executed' : 'cancelled' } }, turn: chatTurn(pending.turnId) });
    await stage.settle();
    expect(screen.getByRole('button', { name: TOOLBAR_WORDS.plan, pressed: false })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await stage.settle();
    expect(stage.sent('chat:send')).toEqual([expect.objectContaining({ sessionId: ID, prompt: 'And check edge cases.' })]);
    expect(stage.sent('chat:send')[0]).not.toHaveProperty('mode');
    expect(stage.sent('chat:send')[0]).not.toHaveProperty('plan');
  });

  it.each([
    ['execute', 'refused'], ['execute', 'failed'],
    ['cancel', 'refused'], ['cancel', 'failed'],
  ] as const)('keeps Plan pressed when %s is %s', async (decision, outcome) => {
    stage.answers['plans:decide'] = () => {
      if (outcome === 'failed') throw new Error('Unavailable');
      return { status: 'refused', reason: 'not-pending' };
    };
    await open([lineItem()]);
    act(() => { choosePlan(ID, true); });
    fireEvent.click(screen.getByRole('button', { name: PLAN_PAGE_WORDS[decision] }));
    await stage.settle();
    expect(composerOf(ID).intent.plan).toBe(true);
    expect(usePromptTypes.getState().types[ID]).toBe('plan');
  });

  it('keeps Plan pressed after feedback', async () => {
    await open([lineItem()]);
    act(() => { choosePlan(ID, true); });
    fireEvent.change(screen.getByRole('textbox', { name: PLAN_PAGE_WORDS.feedbackLabel }), { target: { value: 'Shorter.' } });
    fireEvent.click(screen.getByRole('button', { name: PLAN_PAGE_WORDS.sendFeedback }));
    await stage.settle();
    expect(composerOf(ID).intent.plan).toBe(true);
  });

  it('stands in the bar’s and the input’s place while the newest line waits, and sends each decision', async () => {
    const provider = planner();
    stage.providers = [{ ...provider, descriptor: { ...provider.descriptor, capabilities: { ...provider.descriptor.capabilities, permissions: MODES } } }];
    await open([lineItem()]);
    const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
    expect(document.querySelector('[data-model-block] [data-session-model]')).not.toBeNull();
    expect(document.querySelector('[data-status-bar]')).not.toBeNull();
    expect(document.querySelector('[data-composer-section]')).toBeNull();
    expect(document.querySelector('[data-session-mode]')).not.toBeNull();
    expect(document.querySelector('[data-session-mode]')?.closest('[data-prompt-area]')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: TOOLBAR_WORDS.label })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message to Codex' })).toBeNull();
    // The plan's box names the version the decision stands on (the maintainer), and opens its tab.
    expect(within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.titled('Plan: Tidy the notes', 1) }).querySelector('svg')).not.toBeNull();
    // The existing Review by model control stays available when the provider lists a reading mode.
    expect(within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.review }).getAttribute('aria-disabled')).toBeNull();
    // Nothing is focused on its arrival.
    expect(panel.contains(document.activeElement)).toBe(false);
    // Execute says its word alone (the maintainer): the mode it runs under is the menu's above.
    const execute = within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.execute });
    expect(execute.textContent).toBe(PLAN_PAGE_WORDS.execute);
    expect(execute.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(execute);
    await stage.settle();
    // Discard plan is a trash button, named by its label alone.
    const discard = within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.cancel });
    expect(discard.textContent).toBe('');
    expect(discard.querySelector('svg')).not.toBeNull();
    fireEvent.click(discard);
    await stage.settle();
    fireEvent.click(within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.leave }));
    await stage.settle();
    const field = within(panel).getByRole('textbox', { name: PLAN_PAGE_WORDS.feedbackLabel });
    const send = within(panel).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.sendFeedback });
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Shorter.' } });
    fireEvent.click(send);
    await stage.settle();
    // Each names the plan and the workflow's revision the panel was drawn from (decision 0029).
    expect(sent('plans:decide')).toEqual([
      { sessionId: ID, planId: PLAN, revision: 1, decision: 'execute' },
      { sessionId: ID, planId: PLAN, revision: 1, decision: 'cancel' },
      { sessionId: ID, planId: PLAN, revision: 1, decision: 'leave' },
      { sessionId: ID, planId: PLAN, revision: 1, decision: 'feedback', text: 'Shorter.' },
    ]);
  });

  // The maintainer: a feedback past its bound is kept whole and said, never cut.
  it('keeps a feedback past its bound whole, says how far over it is, and sends nothing until it fits', async () => {
    await open([lineItem()]);
    const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
    const field = within(panel).getByRole<HTMLTextAreaElement>('textbox', { name: PLAN_PAGE_WORDS.feedbackLabel });
    const send = within(panel).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.sendFeedback });
    expect(field.maxLength).toBe(-1);
    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_FEEDBACK_TEXT + 12) } });
    expect(field.value).toHaveLength(MAX_FEEDBACK_TEXT + 12);
    const over = panel.querySelector('[data-plan-feedback-over]');
    expect(over?.textContent).toBe(PLAN_PAGE_WORDS.feedbackTooLong(12));
    expect(field.getAttribute('aria-describedby')).toBe(over?.id);
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_FEEDBACK_TEXT) } });
    expect(panel.querySelector('[data-plan-feedback-over]')).toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('holds feedback, with its reason, where the chat’s mode takes no plan turn, and Execute where it reads only (C72, C81)', async () => {
    // The provider's modes, which say which of them reads only.
    const provider = planner();
    stage.providers = [{ ...provider, descriptor: { ...provider.descriptor, capabilities: { ...provider.descriptor.capabilities, permissions: MODES } } }];
    const readOnly = under(session('Create plan'), 'read-only');
    stage.chat(readOnly).items = [lineItem()];
    await stage.open([readOnly], readOnly);
    await stage.settle();
    const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
    expect(panel.textContent).toContain(PLANNING.unavailable);
    fireEvent.change(within(panel).getByRole('textbox', { name: PLAN_PAGE_WORDS.feedbackLabel }), { target: { value: 'More.' } });
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.sendFeedback }).disabled).toBe(true);
    // Read only carries out no plan (C81): Execute is not offered, its reason under the field; Cancel is.
    const execute = within(panel).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.execute });
    expect(execute.disabled).toBe(true);
    expect(document.getElementById(execute.getAttribute('aria-describedby') ?? '')?.textContent).toBe(PLAN_PAGE_WORDS.readsOnly('Read only'));
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.cancel }).disabled).toBe(false);
  });

  it('says a refusal under it, in fat-g’s words', async () => {
    stage.answers['plans:decide'] = () => ({ status: 'refused', reason: 'not-pending' });
    await open([lineItem()]);
    const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
    fireEvent.click(within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.execute }));
    await stage.settle();
    expect(within(panel).getByRole('status').textContent).toContain('decision was taken already');
  });

  it('is not there for a line that is decided, nor for one still being written, nor while its turn runs', async () => {
    await open([lineItem({ outcome: 'executed' }), lineItem({ outcome: 'writing' })]);
    expect(screen.queryByRole('group', { name: PLAN_PAGE_WORDS.panel })).toBeNull();
    cleanup();
    const running = under(session('Create plan'), 'ask-first', { summary: { ...ONE.summary, status: 'running' } });
    stage.chat(running).items = [lineItem()];
    await stage.open([running], running);
    await stage.settle();
    expect(screen.queryByRole('group', { name: PLAN_PAGE_WORDS.panel })).toBeNull();
  });
});

describe('Review existing plan (C64, C67)', () => {
  const summary = (patch: Partial<PlanSummary> = {}): PlanSummary => ({ planId: PLAN, title: 'Tidy the notes', createdAt: 1, versions: 1, latest: version(1), complete: version(1), state: 'ready', participants: 1, ...patch });

  it.each([false, true])('keeps Review focusable but unavailable with no usable plan (unfinished: %s)', async (unfinished) => {
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: unfinished ? [summary({ complete: null, latest: version(1, { state: 'unfinished' }) })] : [] });
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = screen.getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    expect(review.getAttribute('aria-disabled')).toBe('true');
    expect(review.disabled).toBe(false);
    expect(review.title).toBe(unfinished ? PLAN_PAGE_WORDS.listNoComplete : PLAN_PAGE_WORDS.listEmpty);
    fireEvent.click(review);
    fireEvent.keyDown(review, { key: 'ArrowDown' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sent('plans:bring')).toEqual([]);
  });

  it('enables Review after a plan completes and disables it when the last plan is removed', async () => {
    let listed: readonly PlanSummary[] = [];
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: listed });
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = () => screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    expect(review().getAttribute('aria-disabled')).toBe('true');
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 1, state: 'drafting', partial: { before: 0, append: '# Plan' } }); });
    await stage.settle();
    expect(sent('plans:list')).toHaveLength(1);
    listed = [summary()];
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 1, state: 'complete' }); });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(review());
    await stage.settle();
    expect(screen.getByRole('menuitem', { name: /Tidy the notes/ })).toBeTruthy();

    listed = [];
    stage.answers['plans:read'] = () => ({ status: 'refused', reason: 'unknown-plan' });
    act(() => { readPlanInfo(PLAN); });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(review());
  });

  it('refreshes the available plans after a bulk removal', async () => {
    let listed: readonly PlanSummary[] = [summary()];
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: listed });
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = () => screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    expect(review().getAttribute('aria-disabled')).toBeNull();
    listed = [];
    act(() => { plansRemoved(); });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBe('true');
  });

  it('does not re-enable Review when an older menu read arrives after the last plan was removed', async () => {
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: [summary()] });
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = () => screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    let answerMenu: ((value: unknown) => void) | undefined;
    stage.answers['plans:list'] = () => new Promise<unknown>((resolve) => { answerMenu = resolve; });
    fireEvent.click(review());
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: [] });
    act(() => { plansRemoved(); });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBe('true');
    answerMenu?.({ status: 'listed', plans: [summary()] });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores an older empty list that arrives after a completed plan was found', async () => {
    const replies: ((value: unknown) => void)[] = [];
    stage.answers['plans:list'] = () => new Promise<unknown>((resolve) => { replies.push(resolve); });
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = () => screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    expect(review().getAttribute('aria-disabled')).toBe('true');
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 1, state: 'complete' }); });
    expect(replies).toHaveLength(2);
    replies[1]?.({ status: 'listed', plans: [summary()] });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBeNull();
    replies[0]?.({ status: 'listed', plans: [] });
    await stage.settle();
    expect(review().getAttribute('aria-disabled')).toBeNull();
  });

  it('allows retrying through the menu when the initial availability check failed', async () => {
    stage.answers['plans:list'] = () => { throw new Error('Unavailable'); };
    await open([chatItem(ID, 'user', 'A prompt')]);
    const review = screen.getByRole<HTMLButtonElement>('button', { name: PLAN_PAGE_WORDS.reviewMenu });
    expect(review.getAttribute('aria-disabled')).toBeNull();
    expect(review.title).toBe(PLAN_PAGE_WORDS.listFailed);
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: [summary()] });
    fireEvent.click(review);
    await stage.settle();
    expect(screen.getByRole('menuitem', { name: /Tidy the notes/ })).toBeTruthy();
  });

  it('lists the project’s plans, and brings the chosen one’s latest complete version into the chat, its tab opened', async () => {
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: [summary(), summary({ planId: 'b0000000-0000-4000-8000-000000000002', title: 'Half a plan', complete: null, latest: version(1, { state: 'unfinished', chat: null }) })] });
    stage.answers['plans:bring'] = () => ({ status: 'brought', itemId: 'line-1' });
    await open([chatItem(ID, 'user', 'A prompt')], [ONE], true);
    fireEvent.click(screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu }));
    await stage.settle();
    expect(sent('plans:list')).toEqual([{ projectId: ONE.record.projectId }, { projectId: ONE.record.projectId }]);
    const rows = screen.getAllByRole('menuitem');
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual(['Tidy the notes', 'Half a plan']);
    expect(rows[1]?.textContent).toContain('its chat was removed');
    expect(rows[1]?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(rows[0] as HTMLElement);
    await stage.settle();
    expect(sent('plans:bring')).toEqual([{ sessionId: ID, planId: PLAN, version: 1, hash: HASH }]);
    expect(useTabs.getState().sessions[ID]?.tabs.map((tab) => tab.kind)).toEqual([PLAN_KIND]);
  });

  it('says why where a decision waits in the chat, and brings nothing', async () => {
    stage.answers['plans:list'] = () => ({ status: 'listed', plans: [summary()] });
    const waiting = under(session('Create plan'), 'ask-first', { planPending: true });
    stage.chat(waiting).items = [chatItem(ID, 'user', 'A prompt')];
    await stage.open([waiting], waiting);
    await stage.settle();
    fireEvent.click(screen.getByRole('button', { name: PLAN_PAGE_WORDS.reviewMenu }));
    await stage.settle();
    expect(screen.getByRole('note').textContent).toContain('A plan holds this chat');
    fireEvent.click(screen.getAllByRole('menuitem')[0] as HTMLElement);
    await stage.settle();
    expect(sent('plans:bring')).toEqual([]);
  });
});

describe('a prompt fat-g composed for a plan (C69)', () => {
  it('draws its words, its block as one folded line of its version, and the plan’s button naming it, never the block’s lines', async () => {
    const token = '0123456789ab';
    const prompt = planPrompt({ decision: 'execute', planId: PLAN, version: 1, text: TEXT, feedback: null, token });
    await open([chatItem(ID, 'user', prompt, { plan: { planId: PLAN, version: 1, intent: 'execute' } })]);
    const shown = document.querySelector('[data-plan-prompt]') as HTMLElement;
    expect(shown.textContent).toContain('Implement the plan in the block below.');
    expect(shown.querySelector('summary')?.textContent).toBe(PLAN_PAGE_WORDS.sentText(1));
    expect(within(shown).getByRole('button', { name: 'Plan: Tidy the notes' })).not.toBeNull();
    expect(shown.textContent).not.toContain('<fat-g-plan');
    expect(shown.querySelector('details')?.open).toBe(false);
    // Unfolded, the text the prompt carried.
    expect(shown.querySelector('pre')?.textContent).toBe(TEXT);
    // The plan's own chat's prompt carries no text.
    expect(planBlock(PLAN, 1, '', token)).not.toContain(TEXT);
  });

  // The maintainer: the user's words, and fat-g's request with them folded under "Feedback as sent".
  it.each([
    ['a Claude request took, with no block', planFeedback('Shorter, please.'), false],
    ['the plan’s own chat sent as a plan turn', planPrompt({ decision: 'feedback', planId: PLAN, version: 1, text: null, feedback: planFeedback('Shorter, please.'), token: '0123456789ab' }), true],
    ['a brought plan’s chat sent with the plan’s text', planPrompt({ decision: 'feedback', planId: PLAN, version: 1, text: TEXT, feedback: planFeedback('Shorter, please.'), token: '0123456789ab' }), true],
  ])('draws a feedback %s as the user’s words, with the feedback as sent folded under them', async (_how, prompt, blocked) => {
    await open([chatItem(ID, 'user', prompt, { plan: { planId: PLAN, version: 1, intent: 'revise' } })]);
    const shown = document.querySelector('[data-plan-prompt]') as HTMLElement;
    // Outside the folds, the user's words alone: neither of fat-g's requests.
    expect([...shown.querySelectorAll(':scope > p')].map((paragraph) => paragraph.textContent)).toEqual(['Shorter, please.']);
    const sent = shown.querySelector('[data-feedback-sent]') as HTMLDetailsElement;
    expect(sent.open).toBe(false);
    expect(sent.querySelector('summary')?.textContent).toBe(PLAN_PAGE_WORDS.feedbackSent);
    sent.open = true;
    expect(sent.querySelector('pre')?.textContent).toContain(planFeedback('Shorter, please.'));
    expect(sent.querySelector('pre')?.textContent).not.toContain('<fat-g-plan');
    expect(sent.querySelector('pre')?.textContent?.includes(PLAN_WORDS.broughtFeedback)).toBe(prompt.startsWith(PLAN_WORDS.broughtFeedback));
    // The block's fold stands where the prompt carried one.
    expect([...shown.querySelectorAll('summary')].some((summary) => summary.textContent === PLAN_PAGE_WORDS.sentText(1))).toBe(blocked);
    expect(within(shown).queryByRole('button', { name: 'Plan: Tidy the notes' })).toBeNull();
  });

  it('unfolds a prompt cut at the store’s bound, its closing line lost, to the text that was kept', async () => {
    const prompt = planPrompt({ decision: 'execute', planId: PLAN, version: 1, text: TEXT, feedback: null, token: '0123456789ab' });
    const cut = prompt.slice(0, prompt.indexOf('</fat-g-plan'));
    await open([chatItem(ID, 'user', cut, { plan: { planId: PLAN, version: 1, intent: 'execute' }, cut: true })]);
    const shown = document.querySelector('[data-plan-prompt]') as HTMLElement;
    expect(shown.querySelector('summary')?.textContent).toBe(PLAN_PAGE_WORDS.sentText(1));
    expect(shown.textContent).not.toContain('<fat-g-plan');
    expect(shown.querySelector('pre')?.textContent?.trim()).toBe(TEXT);
  });
});

describe('the plan’s tab (C25, C60, C73)', () => {
  it.each([false, true])('opens the completed plan when its decision is read without a live push (request: %s)', async (request) => {
    await open([lineItem({ request })], [ONE], true);
    await stage.settle();
    expect(screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel })).not.toBeNull();
    expect(useTabs.getState().sessions[ID]?.selected).toBe(tabId(PLAN_KIND, PLAN));
    expect(document.querySelector('[data-plan-tab] h1')?.textContent).toBe('Tidy the notes');

    // Closing it while deciding is respected through subsequent renders of the panel.
    act(() => { closeTab(ID, tabId(PLAN_KIND, PLAN)); });
    fireEvent.change(screen.getByRole('textbox', { name: PLAN_PAGE_WORDS.feedbackLabel }), { target: { value: 'More detail.' } });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]).toBeUndefined();
  });

  it('reopens a streamed plan when its turn ends and the decision appears', async () => {
    const running = under(session('Create plan'), 'ask-first', { summary: { ...ONE.summary, status: 'running' } });
    stage.chat(running).items = [chatItem(ID, 'user', 'Make a plan.')];
    stage.chat(running).revision = 2;
    await stage.open([running], running, true);
    render(<PlanWatcher />);
    const writing = lineItem({ outcome: 'writing' });
    stage.push({ sessionId: ID, revision: 3, item: writing, turn: chatTurn(writing.turnId, { state: 'running' }) });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]?.selected).toBe(tabId(PLAN_KIND, PLAN));
    act(() => { closeTab(ID, tabId(PLAN_KIND, PLAN)); });

    const pending = { ...writing, interaction: raisedPlan({ planId: PLAN, version: 1, came: 'made', request: false }) };
    stage.push({ sessionId: ID, revision: 4, item: pending, turn: chatTurn(writing.turnId, { state: 'running' }) });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]).toBeUndefined();
    expect(screen.queryByRole('group', { name: PLAN_PAGE_WORDS.panel })).toBeNull();

    stage.show([ONE]);
    await stage.settle();
    expect(screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel })).not.toBeNull();
    expect(useTabs.getState().sessions[ID]?.selected).toBe(tabId(PLAN_KIND, PLAN));
    expect(document.querySelector('[data-plan-tab] h1')?.textContent).toBe('Tidy the notes');
  });

  it('reads its plan again when one of its lines changes, so a decision taken no longer waits (the maintainer’s review)', async () => {
    plan = read({ versions: [version(1), version(2)], workflow: flowOf({ version: 1 }) });
    await open([chatItem(ID, 'user', 'Make a plan.')], [ONE], true);
    render(<PlanWatcher />);
    await stage.settle();
    stage.push({ sessionId: ID, revision: 3, item: lineItem({ version: 2 }), turn: { id: 't1', state: 'running' } as never });
    await stage.settle();
    await stage.settle();
    const tab = (): HTMLElement => document.querySelector('[data-plan-tab]') as HTMLElement;
    expect(tab().textContent).toContain(PLAN_TAB_WORDS.waitsOn(1));
    // Its tab in the pane names it as the chat does (M22e).
    expect(useTabs.getState().sessions[ID]?.tabs.find((one) => one.kind === 'plan')?.title).toBe('Plan: Tidy the notes');
    // The plan's decisions stand on v2 now.
    plan = read({ versions: [version(1), version(2)], workflow: flowOf({ version: 2 }) });
    stage.push({ sessionId: ID, revision: 4, item: lineItem({ outcome: 'executed' }), turn: { id: 't1', state: 'running' } as never });
    await stage.settle();
    await stage.settle();
    expect(tab().textContent).not.toContain(PLAN_TAB_WORDS.waitsOn(1));
  });

  it('moves every tab of the plan, in every session, to its newer complete version, but one whose version the user chose (decision 0029)', async () => {
    render(<PlanWatcher />);
    act(() => { openPlan(TWO.record.id, PLAN, 'Tidy the notes', 1, false); });
    const state = (): { version?: number; pinned?: boolean } | null => useTabs.getState().sessions[TWO.record.id]?.tabs[0]?.viewState as { version?: number; pinned?: boolean } | null;
    plan = read({ versions: [version(1), version(2)] });
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 2, state: 'complete' }); });
    await stage.settle();
    expect(state()?.version).toBe(2);
    // A version the user chose in the tab's chooser stays as chosen.
    act(() => { setViewState(TWO.record.id, tabId(PLAN_KIND, PLAN), { version: 1, serial: 99, pinned: true }); });
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 3, state: 'complete' }); });
    await stage.settle();
    expect(state()).toMatchObject({ version: 1, pinned: true });
  });

  it('opens by itself when a plan’s line arrives, and reads the version range by range, its head naming it', async () => {
    await open([chatItem(ID, 'user', 'Make a plan.')], [ONE], true);
    // The session window draws the kinds' watchers; the stage draws the pane alone.
    render(<PlanWatcher />);
    await stage.settle();
    stage.push({ sessionId: ID, revision: 3, item: lineItem(), turn: { id: 't1', state: 'running' } as never });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]?.tabs.map((tab) => tab.kind)).toEqual([PLAN_KIND]);
    await stage.settle();
    const tab = document.querySelector('[data-plan-tab]') as HTMLElement;
    expect(tab.textContent).toContain('v1');
    const information = within(tab).getByRole('button', { name: 'Plan information' });
    fireEvent.pointerEnter(information);
    expect(document.getElementById(information.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Codex, gpt-6-sol');
    expect(within(tab).getByRole<HTMLSelectElement>('combobox', { name: PLAN_TAB_WORDS.versions }).disabled).toBe(true);
    expect(tab.querySelector('h1')?.textContent).toBe('Tidy the notes');
    expect(stage.sent('plans:read').some((request) => (request as { length: number }).length > 1)).toBe(true);
  });

  it('removes the plan after a confirmation that says how many chats take part in it', async () => {
    plan = read({ workflow: flowOf({ participants: [ID, TWO.record.id] }) });
    stage.answers['plans:remove'] = () => ({ status: 'removed', removed: 1, settled: 2 });
    await open([chatItem(ID, 'user', 'Make a plan.')], [ONE], true);
    // The session window draws the kinds' watchers; the stage draws the pane alone.
    render(<PlanWatcher />);
    await stage.settle();
    stage.push({ sessionId: ID, revision: 3, item: lineItem(), turn: { id: 't1', state: 'running' } as never });
    await stage.settle();
    await stage.settle();
    const bar = screen.getByRole('group', { name: 'Plan controls' });
    expect(within(bar).getAllByRole('button').at(-1)?.getAttribute('aria-label')).toBe(PLAN_TAB_WORDS.remove);
    fireEvent.click(within(bar).getByRole('button', { name: PLAN_TAB_WORDS.remove }));
    const dialog = screen.getByRole('dialog', { name: PLAN_TAB_WORDS.removeTitle('Tidy the notes') });
    expect(dialog.textContent).toContain(PLAN_TAB_WORDS.removeWaiting(2));
    act(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' })); });
    await stage.settle();
    expect(sent('plans:remove')).toEqual([{ planId: PLAN }]);
  });

  it('closes in every chat once its plan is gone — implemented, discarded or removed (decision 0029)', async () => {
    await open([chatItem(ID, 'user', 'Make a plan.')], [ONE], true);
    act(() => { openPlan(ID, PLAN, 'Tidy the notes', 1); openPlan(TWO.record.id, PLAN, 'Tidy the notes', 1, false); });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]?.tabs.map((tab) => tab.kind)).toEqual([PLAN_KIND]);
    stage.answers['plans:read'] = () => ({ status: 'refused', reason: 'unknown-plan' });
    act(() => { stage.bridge.push('plans:workflowChanged', { planId: PLAN, sessionIds: [ID] }); });
    await stage.settle();
    expect(useTabs.getState().sessions[ID]?.tabs ?? []).toEqual([]);
    expect(useTabs.getState().sessions[TWO.record.id]?.tabs ?? []).toEqual([]);
  });

  it('copies the entire selected source version, including a long plan and new streamed text', async () => {
    const long = '# Second version\n\n' + 'long text '.repeat(28_000);
    plan = read({ versions: [version(1), version(2, { length: long.length })] });
    stage.answers['plans:read'] = (raw) => {
      const request = raw as { version?: number; start: number; length: number };
      const selected = request.version ?? 2;
      const whole = selected === 1 ? TEXT : long;
      return { ...plan, version: selected, start: request.start, length: whole.length, text: whole.slice(request.start, request.start + request.length) };
    };
    const copy = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    await open([lineItem()], [ONE], true);
    render(<PlanWatcher />);
    await stage.settle();
    await stage.settle();
    const bar = screen.getByRole('group', { name: 'Plan controls' });
    const selector = within(bar).getByRole<HTMLSelectElement>('combobox', { name: PLAN_TAB_WORDS.versions });
    expect(selector.disabled).toBe(false);
    expect(within(bar).queryByRole('button', { name: 'Show in folder' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy entire text' }));
    await stage.settle();
    expect(copy).toHaveBeenLastCalledWith(TEXT);
    fireEvent.change(selector, { target: { value: '2' } });
    await stage.settle();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy entire text' }));
    await stage.settle();
    expect(copy).toHaveBeenLastCalledWith(long);
    act(() => { stage.bridge.push('plans:changed', { planId: PLAN, version: 2, state: 'drafting', partial: { before: long.length, append: '\nNew section.' } }); });
    await stage.settle();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy entire text' }));
    await stage.settle();
    expect(copy).toHaveBeenLastCalledWith(long + '\nNew section.');
  });
});
