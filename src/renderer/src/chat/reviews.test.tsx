// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3's page part (docs/planning/_archive/M22e.md, Design 3–7; C1, C5, C7–C9, C12, C21, C28–C31, C33, C34, C52, C53,
// C55): a review in the page — Review by model's popup on the plan's panel, a round's answer split at
// its block with the findings list in its place, the marks, the notes, the record's notices, the
// triage panel, Cancel and Triage, an anchor's link, Explain, the target popup, and the plan line's
// review state — on the chat region and the pane, over a fake bridge whose review channels the tests
// answer.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./review-availability', () => ({ REVIEW_AVAILABLE: true }));
import type { ConversationItem } from '@shared/contracts/conversation';
import { type PlanBody, raisedPlan } from '@shared/contracts/interaction';
import { type PlanCapability, planBlock, planPrompt, type PlanRead, type PlanVersionView } from '@shared/contracts/plans';
import { type Finding, type IntegrationOffer, integrationText, reviewPrompt, type ReviewRoundView, type ReviewSummary, type ReviewView, sendNotesPrompt } from '@shared/contracts/review';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { WorkflowView } from '@shared/contracts/workflow';
import { sampleDescriptor, sampleProvider } from '../../../../tests/support/app-state';
import { openPlanAt, PLAN_KIND } from '../artifacts/opener';
import { resetTabs, useTabs } from '../artifacts/tabs-store';
import { type AsideStage, asideStage, session } from '../test/asides';
import { chatItem, chatTurn } from '../test/chat';
import { MODES } from '../test/permissions';
import { installDialogStandIn } from '../test/dialog';
import { NOTE_WRITE_MS } from './FindingsList';
import { PLAN_PAGE_WORDS } from './plan-words';
import { resetPlans } from './plans-store';
import { resetPromptTypes } from './prompt-type-store';
import { reviewCloseText, REVIEW_WORDS } from './review-words';
import { resetReviews } from './reviews-store';

const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const REVIEW = 'b2c3d4e5-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const TEXT = '# Tidy the notes\n\n## Steps\n\n1. Read them.\n2. Tidy them.';
const PLANNING: PlanCapability = { modes: ['ask-first'], unavailable: 'Read only takes no plan turn.' };
const provider = () => {
  const base = sampleProvider({ id: 'codex', displayName: 'Codex', descriptor: { ...sampleDescriptor({ id: 'codex', displayName: 'Codex' }), capabilities: { ...sampleDescriptor().capabilities, plans: PLANNING, permissions: MODES } } });
  return base;
};
const under = (entry: SessionEntry, mode = 'ask-first'): SessionEntry => ({ ...entry, mode: { id: mode, source: 'chat' } });
const CHAT = under(session('Create plan'));
const REVIEWER = under(session('Review of Plan: Tidy the notes v1'), 'read-only');

const version = (n: number, patch: Partial<PlanVersionView> = {}): PlanVersionView => ({ version: n, state: 'complete', at: 1_578_924_800_000 + n, cause: 'plan-turn', revises: null, providerId: 'codex', model: 'gpt-6-sol', sessionId: CHAT.record.id, chat: 'Create plan', length: TEXT.length, hash: HASH, integration: null, ...patch });
const flowOf = (participants: readonly string[] = [CHAT.record.id]): WorkflowView => ({ planId: PLAN, state: 'ready', revision: 1, version: 1, participants, holder: null, operation: null, reviewId: null, busy: null });
const planRead = (patch: Partial<PlanRead> = {}): PlanRead => ({ status: 'read', planId: PLAN, projectId: CHAT.record.projectId, title: 'Tidy the notes', createdAt: 1, versions: [version(1)], workflow: flowOf(), version: 1, length: TEXT.length, hash: HASH, start: 0, text: TEXT, ...patch });
const lineItem = (body: Partial<PlanBody> = {}): ConversationItem => chatItem(CHAT.record.id, 'assistant', '', { kind: 'interaction', interaction: { ...raisedPlan({ planId: PLAN, version: 1, came: 'made', request: false }), ...body } });

const finding = (id: string, patch: Partial<Finding> = {}): Finding => ({ id, tier: Number(id.charAt(1)), category: 'PROD', title: `Title ${id}`, example: `Example ${id}.`, description: `Description ${id}.`, correction: `Correction ${id}.`, anchor: { heading: 'Steps', quote: 'Read them.' }, ...patch });
const FINDINGS = [finding('T1.1'), finding('T1.2'), finding('T3.1')];
const block = (issues: readonly Finding[]): string => `\`\`\`json\n${JSON.stringify({ version: 2, appraisal: 'One line on the plan.', issues }, null, 2)}\n\`\`\``;
const round = (answerId: string, patch: Partial<ReviewRoundView> = {}): ReviewRoundView => ({
  turnId: 'turn-1', answerId, appraisal: 'One line on the plan.', findings: FINDINGS, marks: { 'T1.1': 'open', 'T1.2': 'open', 'T3.1': 'open' }, notes: {}, revised: [], live: true, ...patch,
});
const OFFERS: readonly IntegrationOffer[] = [
  { target: { sessionId: CHAT.record.id }, name: 'Create plan', roles: ['own', 'started'], route: 'decision', reason: null },
  { target: { sessionId: REVIEWER.record.id }, name: 'Review of Plan: Tidy the notes v1', roles: ['reviewer'], route: null, reason: 'Read only takes no plan turn. Its mode is chosen in its header.' },
  { target: 'new', name: null, roles: ['new'], route: 'plan-turn', reason: null },
];
function review(patch: Partial<ReviewView> = {}): ReviewView {
  return {
    reviewId: REVIEW, planId: PLAN, version: 1,
    reviewer: { sessionId: REVIEWER.record.id, providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', chat: 'Review of Plan: Tidy the notes v1' },
    startedFrom: CHAT.record.id, startedAt: 1, endedAt: 2, state: 'findings', failure: null, staleBy: null, closed: null, instruction: 2,
    turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'round', reason: null, answerId: 'answer-1', continues: null }],
    rounds: [round('answer-1')], integrations: [], live: true, concludable: false, offers: OFFERS, anchors: { 'T1.1': { line: 5 }, 'T1.2': null, 'T3.1': { line: 5 } }, integrationUnits: 1_000,
    ...patch,
  };
}

let stage: AsideStage;
let held: ReviewView | null;
let summaries: readonly ReviewSummary[];
beforeEach(() => {
  installDialogStandIn();
  stage = asideStage();
  stage.providers = [provider()];
  resetPromptTypes();
  resetPlans();
  resetTabs();
  resetReviews();
  held = review();
  summaries = [];
  stage.answers['plans:read'] = (request) => { const { start, length } = request as { start: number; length: number }; return { ...planRead(), start, text: TEXT.slice(start, start + length) }; };
  stage.answers['reviews:read'] = (request) => ('sessionId' in (request as object) ? { status: 'session', review: (request as { sessionId: string }).sessionId === REVIEWER.record.id ? held : null } : { status: 'listed', reviews: summaries });
  stage.answers['reviews:mark'] = (request) => { const { mark } = request as { mark: string }; return { status: 'saved', marks: { 'T1.1': mark } }; };
  stage.answers['reviews:note'] = () => ({ status: 'saved' });
  stage.answers['reviews:close'] = () => ({ status: 'closed' });
  stage.answers['reviews:send'] = () => ({ status: 'sent' });
  stage.answers['reviews:start'] = () => ({ status: 'started', reviewId: REVIEW, sessionId: REVIEWER.record.id });
  stage.answers['reviews:explain'] = () => ({ status: 'accepted', asideId: 'aside-1' });
  stage.answers['reviews:integrate'] = () => ({ status: 'sent', integrationId: 'integration-1', sessionId: CHAT.record.id });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** The reviewer's chat: its prompt, and its answer, which holds the round's block. */
async function openReviewer(answer = `A short appraisal.\n\n${block(FINDINGS)}`, pane = false) {
  const chat = stage.chat(REVIEWER);
  chat.items = [chatItem(REVIEWER.record.id, 'user', 'Review the plan…', { id: 'prompt-1', plan: { planId: PLAN, version: 1, intent: 'review' } }), chatItem(REVIEWER.record.id, 'assistant', answer, { id: 'answer-1' })];
  chat.revision = 2;
  await stage.open([REVIEWER, CHAT], REVIEWER, pane);
  await stage.settle();
}
const list = (): HTMLElement => document.querySelector('[data-findings]') as HTMLElement;
const row = (id: string): HTMLElement => document.querySelector(`[data-finding="${id}"]`) as HTMLElement;

describe('Review by model (C1, C52)', () => {
  it('opens the model dialog on the chat’s preset, shows the review note, and starts the review', async () => {
    const chat = stage.chat(CHAT);
    chat.items = [lineItem()];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
    const button = within(panel).getByRole('button', { name: REVIEW_WORDS.review });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: REVIEW_WORDS.popup });
    expect(dialog.textContent).toContain(REVIEW_WORDS.plan('Tidy the notes', 1));
    expect(within(dialog).getByRole('region', { name: 'Presets' })).not.toBeNull();
    expect(within(dialog).getByRole('region', { name: 'Recent' })).not.toBeNull();
    expect(within(dialog).queryByRole('radiogroup', { name: 'Model' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Custom model & effort' }));
    // Custom starts on the chat's own model and level.
    expect(within(dialog).getByRole('radio', { name: 'GPT-6 Sol' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true');
    const effort = within(dialog).getByRole('radiogroup', { name: 'Effort' });
    expect(effort.parentElement?.contains(within(dialog).getByRole('button', { name: REVIEW_WORDS.start }))).toBe(true);
    expect(effort.parentElement?.contains(within(dialog).getByRole('button', { name: 'Cancel' }))).toBe(true);
    expect(dialog.textContent).toContain(REVIEW_WORDS.cost);
    expect(dialog.querySelector('[data-model-dialog-selection]')).toBeNull();
    expect(dialog.textContent).not.toContain('Read only: Reads files and runs nothing that changes them');
    expect(dialog.textContent).not.toContain(MODES.inherited);
    fireEvent.click(within(dialog).getByRole('button', { name: REVIEW_WORDS.start }));
    await stage.settle();
    // With the workflow's revision the panel was drawn from (decision 0029), and the preset chosen.
    expect(stage.sent('reviews:start')).toEqual([{ sessionId: CHAT.record.id, planId: PLAN, version: 1, revision: 1, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null } }]);
    expect(screen.queryByRole('dialog', { name: REVIEW_WORDS.popup })).toBeNull();
  });

  it('starts the review on another model and level when they are chosen, and says a refusal in the dialog, which stays', async () => {
    stage.answers['reviews:start'] = () => ({ status: 'refused', reason: 'model-not-listed' });
    stage.chat(CHAT).items = [lineItem()];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    fireEvent.click(screen.getByRole('button', { name: REVIEW_WORDS.review }));
    const dialog = screen.getByRole('dialog', { name: REVIEW_WORDS.popup });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Custom model & effort' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'GPT-6 Luna' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Low' }));
    expect(dialog.textContent).toContain(REVIEW_WORDS.cost);
    fireEvent.click(within(dialog).getByRole('button', { name: REVIEW_WORDS.start }));
    await stage.settle();
    expect(stage.sent('reviews:start')).toEqual([{ sessionId: CHAT.record.id, planId: PLAN, version: 1, revision: 1, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-luna', effort: 'low', speed: null } }]);
    expect(within(dialog).getByRole('alert').textContent).toBe('That model is no longer listed.');
    // Custom's Cancel returns to the shortcuts; their Cancel closes the dialog.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.textContent).toContain(REVIEW_WORDS.cost);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: REVIEW_WORDS.popup })).toBeNull();
    expect(stage.sent('reviews:start')).toHaveLength(1);
  });

  it('disables Start review, saying why, for an account whose reading mode is not available', async () => {
    stage.providers = [{ ...provider(), modes: [{ id: 'read-only', available: false, reason: 'platform', setup: false, records: false, unconfined: false, places: null }] }];
    stage.chat(CHAT).items = [lineItem()];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    fireEvent.click(screen.getByRole('button', { name: REVIEW_WORDS.review }));
    const dialog = screen.getByRole('dialog', { name: REVIEW_WORDS.popup });
    expect(within(dialog).getByRole('status').textContent).toBe(REVIEW_WORDS.readingUnavailable('Codex'));
    const start = within(dialog).getByRole('button', { name: REVIEW_WORDS.start });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    await stage.settle();
    expect(stage.sent('reviews:start')).toEqual([]);
  });

  it('is disabled, saying why, on a version a newer complete one has replaced (C52)', async () => {
    stage.answers['plans:read'] = (request) => { const { start, length } = request as { start: number; length: number }; return { ...planRead({ versions: [version(1), version(2)] }), start, text: TEXT.slice(start, start + length) }; };
    stage.chat(CHAT).items = [lineItem()];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    const button = screen.getByRole('button', { name: REVIEW_WORDS.review });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(REVIEW_WORDS.stale(2));
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a round in the reviewer’s chat (C5, C7, C53)', () => {
  it('draws the answer’s text before its block, then the list in the block’s place: the appraisal, a box per tier with findings', async () => {
    await openReviewer();
    const answer = document.querySelector('[data-findings]')?.closest('article') as HTMLElement;
    expect(answer.textContent).toContain('A short appraisal.');
    expect(answer.textContent).not.toContain('"version": 2');
    expect(list().textContent).toContain('One line on the plan.');
    expect([...list().querySelectorAll('[data-tier]')].map((tier) => tier.getAttribute('data-tier'))).toEqual(['1', '3']);
    expect(within(row('T1.1')).getByRole('button', { name: 'Accept T1.1' })).not.toBeNull();
    expect(within(row('T1.1')).getByRole('button', { name: 'Refuse T1.1' })).not.toBeNull();
    expect(within(row('T1.1')).queryByRole('button', { name: 'Explain T1.1' })).toBeNull();
    expect(within(row('T1.1')).getByRole('button', { name: 'Note on T1.1' })).not.toBeNull();
    expect(row('T1.1').textContent).toContain('Example T1.1.');
    expect(row('T1.1').textContent).toContain('Correction T1.1.');
    // The controls are chrome: a drawing's text sees the finding's words alone.
    expect(row('T1.1').querySelector('[data-chrome] button')).not.toBeNull();
  });

  it('draws a tier’s findings by number, whatever order the block gave', async () => {
    const moved = [finding('T1.1'), finding('T3.3', { was: 'T2.1' }), finding('T3.1'), finding('T3.2')];
    held = review({ rounds: [round('answer-1', { findings: moved, marks: { 'T1.1': 'open', 'T3.3': 'open', 'T3.1': 'open', 'T3.2': 'open' } })], anchors: {} });
    await openReviewer(`A short appraisal.\n\n${block(moved)}`);
    expect([...list().querySelectorAll('[data-finding]')].map((one) => one.getAttribute('data-finding'))).toEqual(['T1.1', 'T3.1', 'T3.2', 'T3.3']);
  });

  it('folds the review prompt by its fields to one line, unfolding to the prompt with the plan’s tab button', async () => {
    await openReviewer();
    const request = document.querySelector('[data-review-prompt]') as HTMLDetailsElement;
    expect(request.open).toBe(false);
    expect(request.querySelector(':scope > summary')?.textContent).toBe(REVIEW_WORDS.request('Plan: Tidy the notes', 1));
    request.open = true;
    const prompt = request.querySelector('[data-plan-prompt]') as HTMLElement;
    expect(prompt.getAttribute('data-plan-prompt')).toBe(PLAN);
    expect(within(prompt).getByRole('button', { name: 'Plan: Tidy the notes' })).not.toBeNull();
  });

  it('folds a review prompt that lost its fields by its words, the instruction and the schema under the line', async () => {
    const chat = stage.chat(REVIEWER);
    const text = reviewPrompt({ title: 'Tidy the notes', planId: PLAN, version: 1, text: '# Tidy the notes', token: '0123456789ab', folder: 'C:\\project' });
    chat.items = [chatItem(REVIEWER.record.id, 'user', text, { id: 'prompt-1' })];
    chat.revision = 1;
    await stage.open([REVIEWER, CHAT], REVIEWER);
    await stage.settle();
    const request = document.querySelector('[data-review-prompt]') as HTMLDetailsElement;
    expect(request.querySelector(':scope > summary')?.textContent).toBe(REVIEW_WORDS.request('Plan: Tidy the notes', 1));
    const prompt = request.querySelector('[data-plan-prompt]') as HTMLElement;
    expect(prompt.textContent).toContain('Review the plan in the block below');
    expect(prompt.textContent).toContain('Findings schema (JSON Schema):');
  });

  it('folds a Send notes prompt the record names to one line naming its findings, and leaves a plain one with the same words as it is', async () => {
    const notes = sendNotesPrompt({ findings: FINDINGS, marks: {}, notes: { 'T1.1': 'Shorter.' } });
    held = review({ turns: [...review().turns, { turnId: 'turn-2', promptId: 'prompt-2', kind: 'notes', outcome: 'no-round', reason: null, answerId: 'answer-2', continues: null }] });
    const chat = stage.chat(REVIEWER);
    chat.items = [
      chatItem(REVIEWER.record.id, 'user', 'Review the plan…', { id: 'prompt-1', plan: { planId: PLAN, version: 1, intent: 'review' } }),
      chatItem(REVIEWER.record.id, 'assistant', `A short appraisal.\n\n${block(FINDINGS)}`, { id: 'answer-1' }),
      chatItem(REVIEWER.record.id, 'user', notes, { id: 'prompt-2' }),
      chatItem(REVIEWER.record.id, 'assistant', 'Shorter it is.', { id: 'answer-2' }),
      chatItem(REVIEWER.record.id, 'user', notes, { id: 'prompt-3' }),
    ];
    chat.revision = 5;
    await stage.open([REVIEWER, CHAT], REVIEWER);
    await stage.settle();
    const folded = [...document.querySelectorAll('[data-notes-prompt]')] as HTMLDetailsElement[];
    expect(folded).toHaveLength(1);
    expect(folded[0]?.open).toBe(false);
    expect(folded[0]?.querySelector(':scope > summary')?.textContent).toBe(REVIEW_WORDS.notesSent(['T1.1']));
    expect(folded[0]?.textContent).toContain('Findings schema (JSON Schema):');
  });

  // The maintainer: an integration's prompt is one line, the findings it sent under it.
  it.each([
    ['before the block, in a new chat or the plan’s own', (text: string) => `${text}\n\n${planBlock(PLAN, 1, TEXT, '0123456789ab')}`],
    ['after the block, a brought plan’s feedback', (text: string) => planPrompt({ decision: 'feedback', planId: PLAN, version: 1, text: TEXT, feedback: text, token: '0123456789ab' })],
    ['alone, a Claude request’s answer', (text: string) => text],
  ])('folds an integration’s prompt to one line naming the findings it sent, its words %s', async (_where, compose) => {
    const text = integrationText({ title: 'Tidy the notes', version: 1, findings: FINDINGS, marks: { 'T1.1': 'accepted', 'T1.2': 'accepted', 'T3.1': 'rejected' }, notes: { 'T3.1': 'Out of scope.' } });
    stage.chat(CHAT).items = [chatItem(CHAT.record.id, 'user', compose(text), { id: 'prompt-1', plan: { planId: PLAN, version: 1, intent: 'revise' } })];
    stage.chat(CHAT).revision = 1;
    await stage.open([CHAT], CHAT);
    await stage.settle();
    const folded = document.querySelector('[data-integration-prompt]') as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector(':scope > summary')?.textContent).toBe(REVIEW_WORDS.planFeedback(['T1.1', 'T1.2'], ['T3.1']));
    expect(REVIEW_WORDS.planFeedback(['T1.1', 'T1.2'], ['T3.1'])).toBe('Plan feedback: T1.1, T1.2 accepted; T3.1 refused');
    const prompt = folded.querySelector('[data-plan-prompt]') as HTMLElement;
    expect(prompt.textContent).toContain('Description T1.1.');
    expect(within(prompt).getByRole('button', { name: 'Plan: Tidy the notes' })).not.toBeNull();
  });

  it('leaves a plan’s feedback the user wrote as it is', async () => {
    stage.chat(CHAT).items = [chatItem(CHAT.record.id, 'user', planPrompt({ decision: 'feedback', planId: PLAN, version: 1, text: null, feedback: 'Shorter, please.', token: '0123456789ab' }), { id: 'prompt-1', plan: { planId: PLAN, version: 1, intent: 'revise' } })];
    stage.chat(CHAT).revision = 1;
    await stage.open([CHAT], CHAT);
    await stage.settle();
    expect(document.querySelector('[data-integration-prompt]')).toBeNull();
    expect(document.querySelector('[data-plan-prompt]')?.textContent).toContain('Shorter, please.');
  });

  it('says from the record why a first answer brought no round, and that a later one brought none (C55)', async () => {
    held = review({ state: 'failed', failure: 'no-block', rounds: [], turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'failed', reason: 'no-block', answerId: 'answer-1', continues: null }], live: false, offers: [] });
    await openReviewer('Findings in prose.');
    expect(document.querySelector('[data-review-notice]')?.textContent).toBe(REVIEW_WORDS.failed('no-block'));
    expect(document.querySelector('[data-findings]')).toBeNull();
  });

  // The maintainer: what an answer set aside is said under the appraisal, in fat-g's words.
  it('says which findings the answer set aside: one standing as the round before had it, and one left out', async () => {
    const { correction: _correction, ...garbled } = finding('T1.1');
    const { id: _id, ...unnumbered } = finding('T4.1');
    await openReviewer(`A short appraisal.\n\n${block([garbled, finding('T1.2'), finding('T3.1'), unnumbered] as Finding[])}`);
    expect(list().querySelector('[data-findings-kept]')?.textContent).toBe(REVIEW_WORDS.keptAsBefore(['T1.1']));
    expect(list().querySelector('[data-findings-kept]')?.textContent).toBe('T1.1 could not be read in this answer and stands as in the round before.');
    expect(list().querySelector('[data-findings-left-out]')?.textContent).toBe('Left out: finding 4 has no id like T1.1.');
    // fat-g's words, not the finding's: a selection and a copy of the drawing see none of them.
    expect(list().querySelector('[data-findings-left-out]')?.hasAttribute('data-chrome')).toBe(true);
    expect(row('T1.1')).not.toBeNull();
  });

  it('draws no line where the answer set nothing aside, nor an appraisal the block left empty', async () => {
    held = review({ rounds: [round('answer-1', { appraisal: '' })] });
    await openReviewer();
    expect(list().querySelector('[data-findings-kept], [data-findings-left-out]')).toBeNull();
    expect(list().textContent).not.toContain('One line on the plan.');
  });

  it('says what was wrong with a refused block, read again from the answer, and the kind alone where it reads otherwise now', async () => {
    const failed = (reason: 'invalid' | 'over-bound') => review({ state: 'failed', failure: reason, rounds: [], turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'failed', reason, answerId: 'answer-1', continues: null }], live: false, offers: [] });
    held = failed('invalid');
    await openReviewer('A short appraisal.\n\n```json\n{"version": 2, "issues": [\n```');
    expect(document.querySelector('[data-review-notice]')?.textContent).toBe('The review failed: the findings block is not valid JSON');
    cleanup();
    resetReviews();
    const { correction: _correction, ...broken } = finding('T1.1');
    held = failed('invalid');
    await openReviewer(`A short appraisal.\n\n${block([broken] as Finding[])}`);
    expect(document.querySelector('[data-review-notice]')?.textContent).toBe('The review failed: none of its findings could be read: T1.1 has no correction');
    cleanup();
    resetReviews();
    // An earlier build's refusal for a length, whose answer this one reads as a round: its kind's words.
    held = failed('over-bound');
    await openReviewer(`A short appraisal.\n\n${block([finding('T1.1', { correction: 'x'.repeat(601) })])}`);
    expect(document.querySelector('[data-review-notice]')?.textContent).toBe(REVIEW_WORDS.failed('over-bound'));
  });

  it('says that the answer was cut, where that is what left its block unreadable', async () => {
    held = review({ state: 'failed', failure: 'invalid', rounds: [], turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'failed', reason: 'invalid', answerId: 'answer-1', continues: null }], live: false, offers: [] });
    const chat = stage.chat(REVIEWER);
    chat.items = [chatItem(REVIEWER.record.id, 'user', 'Review the plan…', { id: 'prompt-1', plan: { planId: PLAN, version: 1, intent: 'review' } }), chatItem(REVIEWER.record.id, 'assistant', 'A long appraisal.\n\n```json\n{"version": 2, "issues": [', { id: 'answer-1', cut: true })];
    chat.revision = 2;
    await stage.open([REVIEWER, CHAT], REVIEWER);
    await stage.settle();
    expect(document.querySelector('[data-review-notice]')?.textContent).toBe('The review failed: the answer was cut at the length fat-g keeps, and its findings block with it');
  });

  it('draws a line in the block’s place while the review’s turn waits, never the JSON half written, then the list', async () => {
    held = review({ state: 'running', rounds: [], turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'waiting', reason: null, answerId: null, continues: null }], live: false, offers: [] });
    const chat = stage.chat(REVIEWER);
    chat.items = [
      chatItem(REVIEWER.record.id, 'user', 'Review the plan…', { id: 'prompt-1', turnId: 'turn-1', plan: { planId: PLAN, version: 1, intent: 'review' } }),
      chatItem(REVIEWER.record.id, 'assistant', 'A short appraisal.\n\n```json\n{\n  "version": 2,\n  "appraisal": "One li', { id: 'answer-1', turnId: 'turn-1', state: 'streaming' }),
    ];
    chat.turns.set('turn-1', chatTurn('turn-1', { place: 1, state: 'running', outcome: null }));
    chat.revision = 2;
    await stage.open([REVIEWER, CHAT], REVIEWER);
    await stage.settle();
    const answer = document.querySelector('[data-role="assistant"]') as HTMLElement;
    expect(answer.querySelector('[data-review-pending]')?.textContent).toBe(REVIEW_WORDS.creating);
    expect(answer.textContent).toContain('A short appraisal.');
    expect(answer.textContent).not.toContain('"version"');
    // The round recorded: the list in the block's place, and no line.
    held = review();
    chat.items = [chat.items[0] as ConversationItem, chatItem(REVIEWER.record.id, 'assistant', `A short appraisal.\n\n${block(FINDINGS)}`, { id: 'answer-1', turnId: 'turn-1' })];
    chat.revision = 3;
    act(() => { stage.bridge.push('reviews:changed', { reviewId: REVIEW, planId: PLAN, sessionId: REVIEWER.record.id }); });
    await stage.settle();
    expect(document.querySelector('[data-review-pending]')).toBeNull();
    expect(list()).not.toBeNull();
  });

  it('says a review turn’s end once, by the review’s line in place of the list’s (C21)', async () => {
    held = review({ state: 'running', rounds: [], turns: [{ turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', outcome: 'waiting', reason: null, answerId: null, continues: null }], live: false, offers: [] });
    const chat = stage.chat(REVIEWER);
    chat.items = [chatItem(REVIEWER.record.id, 'user', 'Review the plan…', { id: 'prompt-1', turnId: 'turn-1', plan: { planId: PLAN, version: 1, intent: 'review' } })];
    chat.turns.set('turn-1', chatTurn('turn-1', { place: 1, state: 'running', outcome: null }));
    chat.revision = 1;
    await stage.open([REVIEWER, CHAT], REVIEWER);
    await stage.settle();
    const status = (): string[] => screen.getAllByRole('status').map((region) => region.textContent ?? '').filter((text) => text !== '');
    // The turn ends with its answer, then the review records its round.
    chat.items = [...chat.items, chatItem(REVIEWER.record.id, 'assistant', `A short appraisal.\n\n${block(FINDINGS)}`, { id: 'answer-1', turnId: 'turn-1' })];
    chat.turns.set('turn-1', chatTurn('turn-1', { place: 1, state: 'ended', outcome: 'completed' }));
    stage.changed(REVIEWER);
    await stage.settle();
    // The panel says the review runs, and nothing announces the turn's end before its round.
    expect(status()).toEqual([REVIEW_WORDS.running]);
    held = review();
    act(() => { stage.bridge.push('reviews:changed', { reviewId: REVIEW, planId: PLAN, sessionId: REVIEWER.record.id }); });
    await stage.settle();
    expect(status()).toEqual([REVIEW_WORDS.arrived]);
  });
});

describe('marks and notes (C28, C30)', () => {
  it('accepts a row by a click, returns it by another, refuses by Refuse, marks a tier, and takes Space on a row', async () => {
    await openReviewer();
    fireEvent.click(row('T1.1').querySelector('[data-field="description"]') as Element);
    await stage.settle();
    fireEvent.click(within(row('T1.1')).getByRole('button', { name: 'Refuse T1.1' }));
    await stage.settle();
    fireEvent.click(within(list()).getByRole('button', { name: REVIEW_WORDS.acceptAllLabel(1) }));
    await stage.settle();
    fireEvent.keyDown(row('T3.1'), { key: ' ' });
    await stage.settle();
    expect(stage.sent('reviews:mark')).toEqual([
      { reviewId: REVIEW, findingId: 'T1.1', mark: 'accepted' },
      { reviewId: REVIEW, findingId: 'T1.1', mark: 'rejected' },
      { reviewId: REVIEW, tier: 1, mark: 'accepted' },
      { reviewId: REVIEW, findingId: 'T3.1', mark: 'accepted' },
    ]);
  });

  it('marks nothing by a click that ends with text selected (0021), nor by a press on a control’s words', async () => {
    await openReviewer();
    const words = row('T1.2').querySelector('[data-field="example"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(words);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(words);
    await stage.settle();
    selection?.removeAllRanges();
    expect(stage.sent('reviews:mark')).toEqual([]);
  });

  it('returns an accepted row to undecided by a click, as drawn by the marks main gave back', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'open', 'T3.1': 'open' } })] });
    await openReviewer();
    expect(row('T1.1').getAttribute('data-mark')).toBe('accepted');
    fireEvent.click(row('T1.1').querySelector('[data-field="example"]') as Element);
    await stage.settle();
    expect(stage.sent('reviews:mark')).toEqual([{ reviewId: REVIEW, findingId: 'T1.1', mark: 'open' }]);
    expect(row('T1.1').getAttribute('data-mark')).toBe('open');
  });

  it('writes a note as it is typed, at most every 300 ms, and at blur', async () => {
    await openReviewer();
    fireEvent.click(within(row('T1.2')).getByRole('button', { name: 'Note on T1.2' }));
    const field = within(row('T1.2')).getByRole('textbox', { name: REVIEW_WORDS.noteField('T1.2') });
    vi.useFakeTimers();
    fireEvent.change(field, { target: { value: 'Why' } });
    fireEvent.change(field, { target: { value: 'Why T1?' } });
    expect(stage.sent('reviews:note')).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(NOTE_WRITE_MS); await Promise.resolve(); });
    vi.useRealTimers();
    expect(stage.sent('reviews:note')).toEqual([{ reviewId: REVIEW, findingId: 'T1.2', note: 'Why T1?' }]);
    fireEvent.change(field, { target: { value: 'Why T1, really?' } });
    fireEvent.blur(field);
    await stage.settle();
    expect(stage.sent('reviews:note').at(-1)).toEqual({ reviewId: REVIEW, findingId: 'T1.2', note: 'Why T1, really?' });
  });

  it('draws an earlier round inert: its frozen marks, its notes as sent, and no control', async () => {
    held = review({ rounds: [round('answer-0', { turnId: 'turn-0', live: false, marks: { 'T1.1': 'accepted' }, notes: { 'T1.1': 'Sent.' } }), round('answer-1')] });
    const chat = stage.chat(REVIEWER);
    chat.items = [chatItem(REVIEWER.record.id, 'assistant', block(FINDINGS), { id: 'answer-0' }), chatItem(REVIEWER.record.id, 'assistant', block(FINDINGS), { id: 'answer-1' })];
    await stage.open([REVIEWER], REVIEWER);
    await stage.settle();
    const [earlier] = document.querySelectorAll('[data-findings]');
    expect(earlier?.hasAttribute('data-live')).toBe(false);
    expect(earlier?.querySelectorAll('button[aria-label^="Accept"]')).toHaveLength(0);
    expect(earlier?.querySelector('[data-finding-note-text]')?.textContent).toBe('Sent.');
  });
});

describe('the triage panel (C8, C31, C44)', () => {
  it('stands in the input’s place; Integrate waits while a finding is undecided, saying how many', async () => {
    await openReviewer();
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    expect(screen.queryByRole('textbox', { name: 'Message to Codex' })).toBeNull();
    expect(document.querySelector('[data-model-block] [data-session-model]')).not.toBeNull();
    expect(document.querySelector('[data-status-bar]')).not.toBeNull();
    expect(document.querySelector('[data-composer-section]')).toBeNull();
    expect(document.querySelector('[data-session-mode]')).not.toBeNull();
    expect(document.querySelector('[data-session-mode]')?.closest('[data-prompt-area]')).toBeNull();
    expect(panel.textContent).toContain(REVIEW_WORDS.waiting(3));
    expect(within(panel).getByRole('button', { name: REVIEW_WORDS.integrateLater }).getAttribute('aria-disabled')).toBe('true');
    expect(panel.contains(document.activeElement)).toBe(false);
  });

  it('counts the accepted, refused and undecided findings and the notes written, above its action', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'rejected', 'T3.1': 'open' }, notes: { 'T1.2': 'Not here.', 'T3.1': '' } })] });
    await openReviewer();
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    const counts = panel.querySelector('[data-review-counts]') as HTMLElement;
    expect(counts.textContent).toBe(REVIEW_WORDS.counts(1, 1, 1, 1));
    expect(counts.textContent).toBe('1 accepted · 1 refused · 1 undecided · 1 note');
    // Above the action and Cancel, and no announcement of its own.
    expect(counts.compareDocumentPosition(within(panel).getByRole('button', { name: REVIEW_WORDS.sendNotes })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(counts.getAttribute('role')).toBeNull();
  });

  it('offers Send notes where a finding waits and a note is written, and sends them', async () => {
    held = review({ rounds: [round('answer-1', { notes: { 'T1.2': 'Why?' } })] });
    await openReviewer();
    fireEvent.click(within(screen.getByRole('group', { name: REVIEW_WORDS.panel })).getByRole('button', { name: REVIEW_WORDS.sendNotes }));
    await stage.settle();
    expect(stage.sent('reviews:send')).toEqual([{ reviewId: REVIEW }]);
  });

  it('is a hard stop: no way to hide it, Cancel review closes it, and the composer comes back once it is closed (decision 0029)', async () => {
    await openReviewer();
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    expect(within(panel).queryByRole('button', { name: REVIEW_WORDS.cancel })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message to Codex' })).toBeNull();
    expect(within(list()).queryByRole('button', { name: 'Triage' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: REVIEW_WORDS.cancelReview }));
    await stage.settle();
    expect(stage.sent('reviews:close')).toEqual([{ reviewId: REVIEW, as: 'cancel' }]);
    held = review({ state: 'closed', closed: 'cancelled', live: false, rounds: [round('answer-1', { live: false })] });
    act(() => { stage.bridge.push('reviews:changed', { reviewId: REVIEW, planId: PLAN, sessionId: REVIEWER.record.id }); });
    await stage.settle();
    expect(screen.queryByRole('group', { name: REVIEW_WORDS.panel })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message to Codex' })).not.toBeNull();
  });

  it('stands while a turn of it runs, saying so, with Cancel review beside it', async () => {
    held = review({ turns: [...review().turns, { turnId: 'turn-2', promptId: 'prompt-2', kind: 'notes', outcome: 'waiting', reason: null, answerId: null, continues: null }] });
    await openReviewer();
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    expect(panel.textContent).toContain(REVIEW_WORDS.running);
    expect(within(panel).getByRole('button', { name: REVIEW_WORDS.cancelReview })).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message to Codex' })).toBeNull();
  });

  it('offers Integrate N once every finding is decided; its popup offers the plan’s chat and a new chat, and integrates', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'accepted', 'T3.1': 'rejected' } })] });
    await openReviewer();
    fireEvent.click(within(screen.getByRole('group', { name: REVIEW_WORDS.panel })).getByRole('button', { name: REVIEW_WORDS.integrate(2) }));
    const popup = screen.getByRole('dialog', { name: REVIEW_WORDS.targets });
    expect(within(popup).getByText(REVIEW_WORDS.targets)).toBeTruthy();
    const rows = [...popup.querySelectorAll('[data-target]')];
    // The reviewer's own chat, where the popup stands, is not offered: under Read only it writes no plan.
    expect(rows.map((one) => one.textContent)).toEqual([REVIEW_WORDS.usingOwn, REVIEW_WORDS.usingNew]);
    expect(rows.map((one) => one.getAttribute('data-target'))).toEqual([CHAT.record.id, 'new']);
    expect(rows[0]?.hasAttribute('title')).toBe(false);
    fireEvent.click(within(popup).getByRole('button', { name: REVIEW_WORDS.integrateAction }));
    await stage.settle();
    expect(stage.sent('reviews:integrate')).toEqual([{ reviewId: REVIEW, target: { sessionId: CHAT.record.id } }]);
    // Sent into another chat: that chat is selected at once, and the reviewer's is marked Done.
    expect(stage.sent('sessions:select')).toEqual([{ id: CHAT.record.id }]);
    expect(stage.sent('sessions:complete')).toEqual([{ id: REVIEWER.record.id }]);
  });

  it('hands a new session over to the model dialog, one way: its Integrate sends on the model chosen and closes the decision', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'accepted', 'T3.1': 'rejected' } })] });
    stage.answers['reviews:integrate'] = () => ({ status: 'sent', integrationId: 'integration-1', sessionId: 'c0ffee00-0000-4000-8000-000000000001' });
    await openReviewer();
    fireEvent.click(within(screen.getByRole('group', { name: REVIEW_WORDS.panel })).getByRole('button', { name: REVIEW_WORDS.integrate(2) }));
    const popup = screen.getByRole('dialog', { name: REVIEW_WORDS.targets });
    fireEvent.click(popup.querySelector('[data-target="new"] input') as Element);
    // The target popup is gone; the model dialog stands on the reviewer's preset.
    expect(screen.queryByRole('dialog', { name: REVIEW_WORDS.targets })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: REVIEW_WORDS.integrateNew });
    expect(within(dialog).queryByRole('radiogroup', { name: 'Model' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Custom model & effort' }));
    expect(within(dialog).getByRole('radio', { name: 'GPT-6 Sol' }).getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('[data-integrate-sends]')?.textContent).toBe(REVIEW_WORDS.sends('Tidy the notes', 1, 2, 0, null));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'GPT-6 Luna' }));
    fireEvent.click(within(dialog).getByRole('button', { name: REVIEW_WORDS.integrateAction }));
    await stage.settle();
    expect(stage.sent('reviews:integrate')).toEqual([{ reviewId: REVIEW, target: { preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-luna', effort: 'high', speed: null } } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stage.sent('sessions:select')).toEqual([{ id: 'c0ffee00-0000-4000-8000-000000000001' }]);
    expect(stage.sent('sessions:complete')).toEqual([{ id: REVIEWER.record.id }]);
  });

  it('sends nothing when the model dialog of a new session is cancelled', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'accepted', 'T3.1': 'rejected' } })] });
    await openReviewer();
    fireEvent.click(within(screen.getByRole('group', { name: REVIEW_WORDS.panel })).getByRole('button', { name: REVIEW_WORDS.integrate(2) }));
    fireEvent.click(screen.getByRole('dialog', { name: REVIEW_WORDS.targets }).querySelector('[data-target="new"] input') as Element);
    fireEvent.click(within(screen.getByRole('dialog', { name: REVIEW_WORDS.integrateNew })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stage.sent('reviews:integrate')).toEqual([]);
  });

  it('selects nothing and completes nothing when the integration goes into the reviewer’s own chat', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'accepted', 'T1.2': 'accepted', 'T3.1': 'rejected' } })] });
    stage.answers['reviews:integrate'] = () => ({ status: 'sent', integrationId: 'integration-1', sessionId: REVIEWER.record.id });
    await openReviewer();
    fireEvent.click(within(screen.getByRole('group', { name: REVIEW_WORDS.panel })).getByRole('button', { name: REVIEW_WORDS.integrate(2) }));
    const popup = screen.getByRole('dialog', { name: REVIEW_WORDS.targets });
    fireEvent.click(within(popup).getByRole('button', { name: REVIEW_WORDS.integrateAction }));
    await stage.settle();
    expect(stage.sent('reviews:integrate')).toHaveLength(1);
    expect(stage.sent('sessions:select')).toEqual([]);
    expect(stage.sent('sessions:complete')).toEqual([]);
  });

  it('a review that found nothing offers one way back: the review concluded, the plan’s chat selected with its tab', async () => {
    held = review({ rounds: [round('answer-1', { findings: [], marks: {} })], anchors: {}, concludable: true });
    await openReviewer(`Nothing to change.

${block([])}`);
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    expect(panel.querySelector('[data-review-counts]')?.textContent).toBe(REVIEW_WORDS.clean);
    expect(within(panel).queryByRole('button', { name: REVIEW_WORDS.integrate(0) })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: REVIEW_WORDS.backToPlan }));
    await stage.settle();
    // Main marks the reviewer Done as it concludes the review.
    expect(stage.sent('reviews:close')).toEqual([{ reviewId: REVIEW, as: 'conclude' }]);
    expect(stage.sent('sessions:select')).toEqual([{ id: CHAT.record.id }]);
    expect(useTabs.getState().sessions[CHAT.record.id]?.tabs.find((one) => one.kind === PLAN_KIND)?.viewState).toMatchObject({ version: 1 });
  });

  it('offers the same way back where every finding is refused (decision 0029)', async () => {
    held = review({ rounds: [round('answer-1', { marks: { 'T1.1': 'rejected', 'T1.2': 'rejected', 'T3.1': 'rejected' } })], concludable: true });
    await openReviewer();
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    expect(panel.querySelector('[data-review-counts]')?.textContent).toBe(REVIEW_WORDS.allRefused);
    fireEvent.click(within(panel).getByRole('button', { name: REVIEW_WORDS.backToPlan }));
    await stage.settle();
    expect(stage.sent('reviews:close')).toEqual([{ reviewId: REVIEW, as: 'conclude' }]);
  });

  it('goes back to a chat taking part in the plan, and leaves nothing when the review is not concluded', async () => {
    const other = 'c0ffee00-0000-4000-8000-000000000009';
    stage.answers['plans:read'] = (request) => { const { start, length } = request as { start: number; length: number }; return { ...planRead({ workflow: flowOf([other]) }), start, text: TEXT.slice(start, start + length) }; };
    stage.answers['reviews:close'] = () => ({ status: 'refused', reason: 'not-concludable' });
    held = review({ rounds: [round('answer-1', { findings: [], marks: {} })], anchors: {}, concludable: true });
    await openReviewer(`Nothing to change.

${block([])}`);
    const panel = screen.getByRole('group', { name: REVIEW_WORDS.panel });
    fireEvent.click(within(panel).getByRole('button', { name: REVIEW_WORDS.backToPlan }));
    await stage.settle();
    expect(panel.textContent).toContain(reviewCloseText('not-concludable'));
    expect(stage.sent('sessions:select')).toEqual([]);
    stage.answers['reviews:close'] = () => ({ status: 'closed' });
    fireEvent.click(within(panel).getByRole('button', { name: REVIEW_WORDS.backToPlan }));
    await stage.settle();
    expect(stage.sent('sessions:select')).toEqual([{ id: other }]);
  });

  it('stands not once it is handed to an integration: the list names the chat it went to', async () => {
    held = review({ state: 'closed', closed: 'handed', live: false, integrations: [{ integrationId: 'integration-1', sessionId: CHAT.record.id, chat: 'Create plan', route: 'decision', state: 'sent', reason: null, accepted: ['T1.1'], produced: null, at: 3 }], rounds: [round('answer-1', { live: false })] });
    await openReviewer();
    expect(screen.queryByRole('group', { name: REVIEW_WORDS.panel })).toBeNull();
    expect(within(list()).getByRole('button', { name: REVIEW_WORDS.integratingIn('Create plan') })).not.toBeNull();
  });
});

describe('anchors and Explain (C33, C34, C41)', () => {
  it('opens the plan’s tab at the passage main found, and at the version’s start, said, where it found none', async () => {
    await openReviewer();
    fireEvent.click(within(row('T1.1')).getByRole('button', { name: REVIEW_WORDS.anchor('Steps', 'Read them.') }));
    const tab = useTabs.getState().sessions[REVIEWER.record.id]?.tabs.find((one) => one.kind === PLAN_KIND);
    expect(tab?.viewState).toMatchObject({ version: 1, line: 5 });
    fireEvent.click(within(row('T1.2')).getByRole('button', { name: REVIEW_WORDS.anchor('Steps', 'Read them.') }));
    expect(useTabs.getState().sessions[REVIEWER.record.id]?.tabs.find((one) => one.kind === PLAN_KIND)?.viewState).toMatchObject({ version: 1, missing: true });
  });

  it('hides Explain on findings while keeping the other review controls available', async () => {
    await openReviewer();
    expect(within(row('T1.2')).queryByRole('button', { name: 'Explain T1.2' })).toBeNull();
    expect(within(row('T1.2')).getByRole('button', { name: 'Accept T1.2' })).not.toBeNull();
    expect(within(row('T1.2')).getByRole('button', { name: 'Refuse T1.2' })).not.toBeNull();
    expect(within(row('T1.2')).getByRole('button', { name: 'Note on T1.2' })).not.toBeNull();
    expect(stage.sent('reviews:explain')).toEqual([]);
  });
});

describe('the plan’s tab at a passage (C33, C41)', () => {
  it('marks the line’s block in the version shown, and says where the passage was not found', async () => {
    await openReviewer(undefined, true);
    act(() => { openPlanAt(REVIEWER.record.id, PLAN, 'Tidy the notes', 1, 5); });
    await stage.settle();
    const marked = document.querySelector('[data-plan-tab] [data-line-mark]');
    expect(marked?.textContent).toContain('Read them.');
    act(() => { openPlanAt(REVIEWER.record.id, PLAN, 'Tidy the notes', 1, null); });
    await stage.settle();
    expect(document.querySelector('[data-plan-passage-missing]')?.textContent).toBe(REVIEW_WORDS.notFound(1));
  });

  it('draws first the section of a long plan that holds the line, and marks the passage counted from that section’s start', async () => {
    const filler = Array.from({ length: 6_000 }, (_, n) => `Line ${n} of a long plan, padded to be long enough to pass the bound.`).join('\n\n');
    const long = `# Long\n\n${filler}\n\n## Far\n\nThe passage far below.`;
    const line = long.split('\n').findIndex((text) => text === 'The passage far below.') + 1;
    stage.answers['plans:read'] = (request) => { const { start, length } = request as { start: number; length: number }; return { ...planRead({ length: long.length }), length: long.length, start, text: long.slice(start, start + length) }; };
    // No section is near the view in jsdom: the one that holds the line is drawn all the same.
    vi.stubGlobal('IntersectionObserver', class { observe() { /* never near */ } disconnect() { /* nothing */ } });
    try {
      await openReviewer(undefined, true);
      act(() => { openPlanAt(REVIEWER.record.id, PLAN, 'Long', 1, line); });
      await stage.settle();
      expect(document.querySelector('[data-plan-tab] [data-line-mark]')?.textContent).toContain('The passage far below.');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the plan’s line (C12)', () => {
  it('names its version’s newest review’s state, and how many more', async () => {
    summaries = [
      { reviewId: 'r-2', version: 1, state: 'findings', staleBy: null, closed: null, accepted: 3, waiting: 2, findings: 6, integrating: false, reviewer: { sessionId: REVIEWER.record.id, chat: 'Review' }, startedAt: 2 },
      { reviewId: 'r-1', version: 1, state: 'failed', staleBy: null, closed: null, accepted: 0, waiting: 0, findings: 0, integrating: false, reviewer: { sessionId: REVIEWER.record.id, chat: 'Review' }, startedAt: 1 },
    ];
    stage.chat(CHAT).items = [lineItem({ outcome: 'cancelled' })];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    expect(document.querySelector('[data-plan-review]')?.textContent).toBe(`${REVIEW_WORDS.reviewed(3, 2)} ${REVIEW_WORDS.andMore(1)}`);
  });

  it('says a review that found nothing passed', async () => {
    summaries = [{ reviewId: 'r-1', version: 1, state: 'findings', staleBy: null, closed: null, accepted: 0, waiting: 0, findings: 0, integrating: false, reviewer: { sessionId: REVIEWER.record.id, chat: 'Review' }, startedAt: 1 }];
    stage.chat(CHAT).items = [lineItem({ outcome: 'cancelled' })];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    expect(document.querySelector('[data-plan-review]')?.textContent).toBe(REVIEW_WORDS.reviewedClean);
  });

  it('says a review its Cancel review closed was cancelled, whatever its marks (decision 0029)', async () => {
    summaries = [{ reviewId: 'r-1', version: 1, state: 'closed', staleBy: null, closed: 'cancelled', accepted: 0, waiting: 5, findings: 5, integrating: false, reviewer: { sessionId: REVIEWER.record.id, chat: 'Review' }, startedAt: 1 }];
    stage.chat(CHAT).items = [lineItem({ outcome: 'pending' })];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    expect(document.querySelector('[data-plan-review]')?.textContent).toBe(REVIEW_WORDS.reviewCancelled);
  });

  it('names no review on the line of a plan that is gone (decision 0029)', async () => {
    summaries = [{ reviewId: 'r-1', version: 1, state: 'findings', staleBy: null, closed: null, accepted: 0, waiting: 5, findings: 5, integrating: false, reviewer: { sessionId: REVIEWER.record.id, chat: 'Review' }, startedAt: 1 }];
    stage.answers['plans:read'] = () => ({ status: 'refused', reason: 'unknown-plan' });
    stage.chat(CHAT).items = [lineItem({ outcome: 'cancelled' })];
    await stage.open([CHAT], CHAT);
    await stage.settle();
    expect(document.querySelector('[data-plan-line] button')?.textContent).toBe(PLAN_PAGE_WORDS.removed);
    expect(document.querySelector('[data-plan-review]')).toBeNull();
  });
});
