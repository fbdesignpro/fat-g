// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12 (docs/planning/_archive/M20b.md; C41, C48, C53, C67): the row of buttons above the composer's input —
// its button Side question opens a new tab with the focus in its field.
// Since M100 (docs/planning/_archive/M100.md, V6; C37–C39, C58) the row is
// the prompt-type bar: Plan, Review and Side question grouped at the left, one toolbar
// stop, with the permission mode sharing their row.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./review-availability', () => ({ REVIEW_AVAILABLE: true }));
import { NEW_ASIDE_TITLE } from '@shared/contracts/aside';
import { ASIDE_KIND } from '../artifacts/opener';
import { ASIDE_WORDS } from '../artifacts/aside/words';
import { type AsideStage, asideStage, CLAUDE_ASIDES, CODEX_ASIDES, marker, session } from '../test/asides';
import { chatItem } from '../test/chat';
import { sampleDescriptor, sampleProvider } from '../../../../tests/support/app-state';
import { planRefusedWords, type PlanCapability } from '@shared/contracts/plans';
import type { SessionEntry } from '@shared/contracts/sessions';
import { resetPromptTypes, setPromptType, usePromptTypes } from './prompt-type-store';
import { TOOLBAR_WORDS } from './Toolbar';

const ONE = session('Create plan');
const TWO = session('Fix bug');
const ID = ONE.record.id;

/** A provider that plans under Ask first (M22b, C2, C5), and the chats under a mode of it. */
const PLANNING: PlanCapability = { modes: ['ask-first'], unavailable: 'Read only takes no plan turn.' };
const planner = (patch: Record<string, unknown> = {}) => sampleProvider({ id: 'codex', displayName: 'Codex', descriptor: { ...sampleDescriptor({ id: 'codex', displayName: 'Codex' }), capabilities: { ...sampleDescriptor().capabilities, plans: PLANNING } }, ...patch });
const under = (entry: SessionEntry, mode: string): SessionEntry => ({ ...entry, mode: { id: mode, source: 'chat' } });

let stage: AsideStage;
beforeEach(() => {
  stage = asideStage();
  resetPromptTypes();
});
afterEach(cleanup);

async function open(asking: typeof CODEX_ASIDES | 'none' = CODEX_ASIDES, pane = false) {
  const chat = stage.chat(ONE);
  chat.items = [chatItem(ID, 'user', 'A prompt', { id: 'prompt-1' }), chatItem(ID, 'assistant', 'An answer.', { id: 'answer-1' })];
  chat.revision = 2;
  chat.asking = asking;
  await stage.open([ONE, TWO], ONE, pane);
}
const toolbar = () => screen.queryByRole('toolbar', { name: TOOLBAR_WORDS.label });
const button = () => within(toolbar() as HTMLElement).getByRole('button', { name: TOOLBAR_WORDS.sideQuestion });
const menu = () => screen.queryByRole('menu', { name: 'Side questions' });

const names = () => within(toolbar() as HTMLElement).getAllByRole('button').map((each) => each.querySelector('[data-action-label]')?.textContent);
const tool = (name: string) => within(toolbar() as HTMLElement).getByRole('button', { name });

describe('the prompt-type bar (M100: V6; C37–C39)', () => {
  it('sits under the status bar with Plan, Review and finally Side question grouped at the left', async () => {
    await open();
    expect(names()).toEqual([TOOLBAR_WORDS.plan, TOOLBAR_WORDS.review, TOOLBAR_WORDS.sideQuestion]);
    expect(within(toolbar() as HTMLElement).queryByRole('button', { name: 'Spec sheet' })).toBeNull();
    expect(within(toolbar() as HTMLElement).queryByRole('button', { name: 'Milestone' })).toBeNull();
    for (const action of within(toolbar() as HTMLElement).getAllByRole('button')) {
      expect(action.querySelector('[aria-hidden="true"]')?.textContent).toBe('// ');
    }
    const field = screen.getByRole('textbox', { name: 'Message to Codex' });
    const bar = document.querySelector('[data-status-bar]') as HTMLElement;
    // After the status bar and the list in the document, before the input.
    expect(bar.compareDocumentPosition(toolbar() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((toolbar() as HTMLElement).compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Messages' }).compareDocumentPosition(toolbar() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([['a provider that streams an aside’s answer', CODEX_ASIDES], ['one that answers whole', CLAUDE_ASIDES]] as const)('holds Side question for %s', async (_name, asking) => {
    await open(asking);
    expect(names()).toContain(TOOLBAR_WORDS.sideQuestion);
  });

  it('holds no Side question where the session cannot be asked beside, and is there all the same', async () => {
    await open('none');
    expect(toolbar()).not.toBeNull();
    expect(screen.queryByRole('button', { name: TOOLBAR_WORDS.sideQuestion })).toBeNull();
    expect(names()).toEqual([TOOLBAR_WORDS.plan, TOOLBAR_WORDS.review]);
    // The composer is as it was.
    expect(screen.getByRole('textbox', { name: 'Message to Codex' })).not.toBeNull();
  });

  it('is the selected session’s: another session’s read brings its own Side question, or none', async () => {
    await open();
    expect(names()).toContain(TOOLBAR_WORDS.sideQuestion);
    // The second session has no conversation: its read says it cannot be asked beside.
    stage.show([ONE, TWO], TWO);
    await stage.settle();
    expect(names()).not.toContain(TOOLBAR_WORDS.sideQuestion);
    stage.show([ONE, TWO], ONE);
    await stage.settle();
    expect(names()).toContain(TOOLBAR_WORDS.sideQuestion);
  });

  it('is one stop for the keyboard, with Left and Right among its actions in display order', async () => {
    await open();
    const stops = () => [...(toolbar() as HTMLElement).querySelectorAll<HTMLElement>('[data-tool]')].map((stop) => stop.tabIndex);
    expect(stops()).toEqual([0, -1, -1]);
    tool(TOOLBAR_WORDS.plan).focus();
    fireEvent.keyDown(tool(TOOLBAR_WORDS.plan), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tool(TOOLBAR_WORDS.review));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(button());
    // Round from the last to the first, and back.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tool(TOOLBAR_WORDS.plan));
    fireEvent.keyDown(tool(TOOLBAR_WORDS.plan), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(button());
    // The bar's one stop is the button last focused.
    expect(stops()).toEqual([-1, -1, 0]);
  });

  it('toggles Plan, keeps it pressed for its session alone, and hands it to main only as its draft’s intent (C38; M23, C87)', async () => {
    stage.providers = [planner()];
    const chat = stage.chat(ONE);
    chat.items = [chatItem(ID, 'user', 'A prompt', { id: 'prompt-1' })];
    await stage.open([under(ONE, 'ask-first'), under(TWO, 'ask-first')], under(ONE, 'ask-first'));
    const plan = () => tool(TOOLBAR_WORDS.plan);
    expect(plan().getAttribute('aria-pressed')).toBe('false');
    // Its tooltip says what plan mode is.
    expect(document.getElementById(plan().getAttribute('aria-describedby') ?? '')?.textContent).toBe(TOOLBAR_WORDS.planTip);
    const before = stage.requests.length;
    fireEvent.click(plan());
    expect(plan().getAttribute('aria-pressed')).toBe('true');
    expect(usePromptTypes.getState().types).toEqual({ [ID]: 'plan' });
    // Another session's bar has none pressed; this one's is pressed again when it is back.
    stage.show([under(ONE, 'ask-first'), under(TWO, 'ask-first')], under(TWO, 'ask-first'));
    await stage.settle();
    expect(plan().getAttribute('aria-pressed')).toBe('false');
    stage.show([under(ONE, 'ask-first'), under(TWO, 'ask-first')], under(ONE, 'ask-first'));
    await stage.settle();
    expect(plan().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(plan());
    expect(plan().getAttribute('aria-pressed')).toBe('false');
    expect(usePromptTypes.getState().types).toEqual({});
    // The toggle's one request is its draft's, handed over as the switch left it (M23, C31, C87): what
    // else was asked meanwhile is the chats' own reads, and their reviews' (M22e).
    expect(stage.requests.slice(before).filter(([channel]) => !channel.startsWith('chat:read') && channel !== 'reviews:read' && channel !== 'plans:list' && channel !== 'plans:workflow')).toEqual([
      ['chat:draft', { sessionId: ID, op: 'text', revision: 1, prompt: '', intent: { plan: true, skill: null } }],
    ]);
  });

  it('draws Review unavailable without plan support, still reachable, its tooltip saying it comes later (C38)', async () => {
    await open();
    const later = tool(TOOLBAR_WORDS.review);
    expect(later.getAttribute('aria-disabled')).toBe('true');
    expect(later.hasAttribute('disabled')).toBe(false);
    expect(later.getAttribute('aria-pressed')).toBeNull();
    const tip = document.getElementById(later.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe(TOOLBAR_WORDS.later);
    expect(tip.hasAttribute('data-open')).toBe(false);
    fireEvent.focus(later);
    expect(tip.hasAttribute('data-open')).toBe(true);
    const before = stage.requests.length;
    fireEvent.click(later);
    expect(stage.requests).toHaveLength(before);
    expect(later.getAttribute('aria-pressed')).toBeNull();
  });

  it('draws the toolbar actions as text without decorative menu icons', async () => {
    await open();
    const review = tool(TOOLBAR_WORDS.review);
    expect(toolbar()?.querySelector('svg')).toBeNull();
    expect(review.textContent).toBe(`// ${TOOLBAR_WORDS.review}`);
  });
});

describe('Side question (C41, C53)', () => {
  it('opens a new side question directly when there are no saved asides', async () => {
    await open();
    expect(button().getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(button());
    expect(menu()).toBeNull();
    expect(stage.tabs(ONE)).toHaveLength(1);
  });

  it('opens a new, empty aside tab for New side question, with the focus in its field, and sends nothing', async () => {
    await open(CODEX_ASIDES, true);
    fireEvent.click(button());
    await stage.settle();
    const [tab] = stage.tabs(ONE);
    expect(stage.tabs(ONE)).toHaveLength(1);
    expect(tab?.kind).toBe(ASIDE_KIND);
    // The page made its id (C73), and it has no title of its own yet.
    expect(tab?.reference).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(screen.getByRole('tab').textContent).toContain(NEW_ASIDE_TITLE);
    expect(stage.sent('chat:ask')).toEqual([]);
    // The focus is in its field (C41, C53): the menu's button did not take it back.
    const field = screen.getByRole('textbox', { name: ASIDE_WORDS.field });
    expect(document.activeElement).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe('');
    expect(menu()).toBeNull();
  });

  it('opens another new tab at each New side question: a free question always starts a new aside (C50)', async () => {
    await open();
    for (let n = 0; n < 2; n += 1) {
      fireEvent.click(button());
    }
    const references = stage.tabs(ONE).map((tab) => tab.reference);
    expect(references).toHaveLength(2);
    expect(new Set(references).size).toBe(2);
  });

  it('opens fresh tabs directly even when the session has saved questions and explanations', async () => {
    stage.chat(ONE).asides = [
      marker('aside-1', 'tide table', { itemId: 'answer-1' }),
      marker('aside-2', 'Why is the sea salty?', null),
      marker('aside-3', '', null),
    ];
    await open();
    expect(button().getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(button());
    fireEvent.click(button());
    expect(menu()).toBeNull();
    expect(stage.tabs(ONE)).toHaveLength(2);
    expect(new Set(stage.tabs(ONE).map((tab) => tab.reference)).size).toBe(2);
    expect(stage.sent('chat:ask')).toEqual([]);
  });

  it('still opens a fresh tab after the saved questions change', async () => {
    await open();
    stage.chat(ONE).asides = [marker('aside-9', 'asked just now', null)];
    stage.changed(ONE);
    await stage.settle();
    fireEvent.click(button());
    expect(menu()).toBeNull();
    expect(stage.tabs(ONE)).toHaveLength(1);
    expect(stage.tabs(ONE)[0]?.reference).not.toBe('aside-9');
  });
});

// M22b (V8's automated part; C1, C2, C5, C13, C70): the toggle sends the next prompt as a plan turn,
// where the chat's mode and its account's CLI take one, and says why not where they do not.
describe('Plan (M22b; C1, C5, C13)', () => {
  const tip = (element: HTMLElement): string | null => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

  it.each([
    ['a provider that plans nothing', () => sampleProvider({ id: 'codex', displayName: 'Codex' }), 'ask-first', 'Codex does not support planning in fat-g.'],
    ['a mode its provider takes no plan turn under', () => planner(), 'read-only', PLANNING.unavailable],
    ['an account whose CLI refused plan mode', () => planner({ plans: { available: false, reason: 'cli-refuses' } }), 'ask-first', planRefusedWords('Codex')],
  ] as const)('is unavailable for %s, still reachable, its tooltip saying why, and stays as it was', async (_name, provider, mode, words) => {
    stage.providers = [provider()];
    await stage.open([under(ONE, mode)], under(ONE, mode));
    const plan = tool(TOOLBAR_WORDS.plan);
    expect(plan.getAttribute('aria-disabled')).toBe('true');
    expect(plan.getAttribute('aria-pressed')).toBe('false');
    fireEvent.focus(plan);
    expect(tip(plan)).toBe(words);
    fireEvent.click(plan);
    expect(usePromptTypes.getState().types).toEqual({});
  });

  it('is drawn unpressed where the chat takes no plan turn, the choice kept for where it does (the maintainer’s review)', async () => {
    stage.providers = [planner()];
    setPromptType(ID, 'plan');
    await stage.open([under(ONE, 'read-only')], under(ONE, 'read-only'));
    expect(tool(TOOLBAR_WORDS.plan).getAttribute('aria-disabled')).toBe('true');
    expect(tool(TOOLBAR_WORDS.plan).getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-primary]')?.textContent).toBe('Send');
    expect(usePromptTypes.getState().types).toEqual({ [ID]: 'plan' });
  });

  it('makes the next prompt a plan turn while pressed: Send reads Plan, and the prompt carries the mode', async () => {
    stage.providers = [planner()];
    await stage.open([under(ONE, 'ask-first')], under(ONE, 'ask-first'));
    fireEvent.click(tool(TOOLBAR_WORDS.plan));
    const field = screen.getByRole('textbox', { name: 'Message to Codex' });
    fireEvent.change(field, { target: { value: 'Plan the change.' } });
    // The send button, beside the microphone: the toggle is the bar's own.
    const send = document.querySelector<HTMLElement>('[data-primary]') as HTMLElement;
    expect(send.textContent).toBe('Plan');
    fireEvent.click(send);
    await stage.settle();
    expect(stage.sent('chat:send')).toEqual([expect.objectContaining({ sessionId: ID, prompt: 'Plan the change.', mode: 'plan' })]);
    // Released, the next one is an ordinary prompt.
    fireEvent.click(tool(TOOLBAR_WORDS.plan));
    fireEvent.change(field, { target: { value: 'Now plainly.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await stage.settle();
    expect(stage.sent('chat:send').at(-1)).toEqual(expect.objectContaining({ sessionId: ID, prompt: 'Now plainly.' }));
    expect(stage.sent('chat:send').at(-1)).not.toHaveProperty('mode');
  });

  it('keeps Review unavailable when the provider plans but the project has no complete plan', async () => {
    stage.providers = [planner()];
    await stage.open([under(ONE, 'ask-first')], under(ONE, 'ask-first'));
    const review = tool(TOOLBAR_WORDS.review);
    expect(review.getAttribute('aria-haspopup')).toBe('menu');
    expect(review.getAttribute('aria-disabled')).toBe('true');
  });
});
