// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V11, V24, V35, V36 (docs/planning/_archive/M21.md, Design 7; C37–C46, C68, C78, C79) and M100b's V1–V5
// (C1–C23, C29, C30, C32, C33, C40–C42): a question's card, by itself — its header and its stepper, one question
// shown at a time, its numbered rows and their keys, what Submit and Decline send and refuse and when, and
// what a settled card says. On a fake bridge that answers the two channels as main does; the card in a
// list, with the list's keys and its announcement, is MessageList.test.tsx.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAnswerResult, ChatDismissResult } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { INTERACTION_OUTCOMES, MAX_ANSWER_TEXT, OUTCOME_WORDS, type QuestionBody } from '@shared/contracts/interaction';
import type { InvokeChannel } from '@shared/ipc/channels';
import { cardQuestion, chatCard, chatTurn } from '../test/chat';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { CARD_WORDS } from './card-words';
import { ADVANCE_MS, CardContext, type CardScope, InteractionCard } from './InteractionCard';
import { resetPromptFocus, usePromptFocus } from './prompt-focus';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const SCOPE: CardScope = { sessionId: SESSION, providerName: 'Claude', asker: null, running: false, workerRunning: null, declines: true };

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answers: { answer: ChatAnswerResult; dismiss: ChatDismissResult };

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  answers = { answer: { status: 'answered' }, dismiss: { status: 'dismissed' } };
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: channel === 'chat:answer' ? answers.answer : answers.dismiss });
  });
});
afterEach(() => { cleanup(); resetPromptFocus(); vi.useRealTimers(); });

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const card = (body: Partial<QuestionBody> = {}, overrides: Partial<ConversationItem> = {}): ConversationItem => chatCard(SESSION, 't1', body, overrides);
const two = (patch: Partial<QuestionBody> = {}) => card({ questions: [cardQuestion(), cardQuestion({ header: 'Form', text: 'In which form?', options: [{ label: 'A summary', description: null }, { label: 'The whole text', description: null }, { label: 'A table', description: null }] })], ...patch });
function show(item: ConversationItem, options: { readonly scope?: CardScope | null; readonly current?: boolean; readonly carrier?: ReturnType<typeof chatTurn>; readonly times?: { readonly today: number } } = {}) {
  const drawn = (
    <InteractionCard item={item} modelName="Sonnet" current={options.current ?? true} {...(options.carrier === undefined ? {} : { carrier: options.carrier })} {...(options.times === undefined ? {} : { times: options.times })} />
  );
  return render(options.scope === null ? drawn : <CardContext value={options.scope ?? SCOPE}>{drawn}</CardContext>);
}
const article = (): HTMLElement => screen.getByRole('article');
const header = (): HTMLElement => article().querySelector<HTMLElement>('[data-card-header]') as HTMLElement;
const controls = (): HTMLElement[] => [...article().querySelectorAll<HTMLElement>('input, textarea, button')];
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: /^Submit( all)?$/ });
const decline = (): HTMLButtonElement => screen.getByRole('button', { name: /^Decline( all)?$/ });
const next = (): HTMLButtonElement => screen.getByRole('button', { name: CARD_WORDS.next });
const radios = (): HTMLInputElement[] => screen.getAllByRole<HTMLInputElement>('radio');
/** The shown question (M100b, C48): every question is drawn, the others out of sight and reach. */
const shown = (): HTMLElement => article().querySelector<HTMLElement>('fieldset[data-shown]') as HTMLElement;
const rows = (): HTMLElement[] => [...shown().querySelectorAll<HTMLElement>('[data-card-row]')];
const picked = (): string[] => rows().filter((row) => row.hasAttribute('data-picked')).map((row) => row.dataset['cardRow'] ?? '');
const shownQuestion = (): HTMLElement => screen.getByRole('group', { name: /Which file|In which form|Anything|password|token/ });
const sent = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const outcome = (): string | null => article().querySelector('[data-card-outcome]')?.textContent ?? null;
const key = (target: Element, name: string) => fireEvent.keyDown(target, { key: name });

describe('a card that waits: its frame (V1; M100b, C1–C7)', () => {
  it('heads itself with the request’s number of questions on the attention colour, and says who asks in its name alone', () => {
    show(card());
    expect(header().textContent).toBe('1 Question');
    expect(header().hasAttribute('data-waiting')).toBe(true);
    expect(article().getAttribute('aria-label')).toBe('Sonnet asks a question');
    expect(article()).toMatchObject({ dataset: { mode: 'blocking', outcome: 'pending' } });
    // No head line (C7): nothing names the model or the time in the card's text.
    expect(article().textContent).not.toContain('Sonnet');
    expect(article().querySelector('time')).toBeNull();
    // One question: no stepper.
    expect(article().querySelector('[data-card-stepper]')).toBeNull();
    // No form anywhere: nothing submits by itself (C37, C47).
    expect(article().querySelector('form')).toBeNull();
    expect(submit().type).toBe('button');
    // One question: no "all" (C41).
    expect([submit().textContent, decline().textContent]).toEqual(['Submit', 'Decline']);
  });

  it('gives the time as the header’s tooltip where times are shown', () => {
    const item = card();
    show(item, { times: { today: 0 } });
    expect(header().title).not.toBe('');
    expect(article().textContent).not.toContain(header().title);
  });

  it('shows one question at a time, its stepper in the foot between Decline and Submit, keeping what was picked and typed, and puts the focus on the question moved to', () => {
    show(two());
    expect(header().textContent).toBe('2 Questions');
    // Several questions: each button says it acts on all of them (C41).
    expect([submit().textContent, decline().textContent]).toEqual(['Submit all', 'Decline all']);
    const stepper = screen.getByRole('group', { name: 'Question 1 of 2' });
    expect(stepper.textContent).toBe(CARD_WORDS.next);
    // In the foot's one row, between Decline and Submit (C51).
    expect([...(submit().parentElement as HTMLElement).children]).toEqual([decline(), stepper, submit()]);
    expect(within(stepper).queryByRole('button', { name: CARD_WORDS.previous })).toBeNull();
    expect(shownQuestion().textContent).toContain('Which file should I read?');
    fireEvent.click(radios()[1] as HTMLElement);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'and the third' } });
    fireEvent.click(next());
    expect(screen.getByRole('group', { name: 'Question 2 of 2' }).textContent).toBe(CARD_WORDS.previous);
    expect(shownQuestion().textContent).toContain('In which form?');
    expect(screen.queryByRole('button', { name: CARD_WORDS.next })).toBeNull();
    expect(document.activeElement).toBe(radios()[0]);
    expect(radios().some((radio) => radio.checked)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    expect(radios()[1]?.checked).toBe(true);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('and the third');
    expect(document.activeElement).toBe(radios()[0]);
  });
});

describe('a card that waits: its rows (V2, V3; M100b, C8–C17)', () => {
  it('numbers its options in order, its description under each, with Something else as the last row, and picks nothing at first', () => {
    show(card());
    expect(shownQuestion().textContent).toContain('Which file should I read?');
    expect(within(shownQuestion()).queryByText('File', { exact: true })).toBeNull();
    expect(rows().map((row) => row.dataset['cardRow'])).toEqual(['1', '2', '3']);
    expect(rows().map((row) => row.textContent)).toEqual(['1notes-1.txtThe first note', '2notes-2.txt', `3${CARD_WORDS.somethingElse}`]);
    expect(picked()).toEqual([]);
    expect(radios().some((radio) => radio.checked)).toBe(false);
    // The numeral is the eye's: the keyboard and assistive technology have the input, and its key.
    expect([...article().querySelectorAll('[data-card-row] [aria-hidden="true"]')].map((numeral) => numeral.textContent)).toEqual(['1', '2', '3']);
    expect(radios().map((radio) => radio.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2']);
    expect(screen.getByRole('textbox', { name: CARD_WORDS.somethingElse }).getAttribute('aria-keyshortcuts')).toBe('3');
  });

  it('picks a row by a press and by its number key, one at a time, and marks the Something else row while its field holds text', () => {
    show(card());
    fireEvent.click(radios()[0] as HTMLElement);
    expect(picked()).toEqual(['1']);
    key(radios()[0] as HTMLElement, '2');
    expect(picked()).toEqual(['2']);
    expect(radios()[1]?.checked).toBe(true);
    // Its key puts the focus in the field; a digit typed there is text.
    key(radios()[1] as HTMLElement, '3');
    const field = screen.getByRole<HTMLTextAreaElement>('textbox');
    expect(document.activeElement).toBe(field);
    key(field, '1');
    expect(picked()).toEqual(['2']);
    fireEvent.change(field, { target: { value: '   ' } });
    expect(picked()).toEqual(['2']);
    fireEvent.change(field, { target: { value: 'the third' } });
    expect(picked()).toEqual(['2', '3']);
    // A key past its rows is nothing.
    key(radios()[1] as HTMLElement, '7');
    expect(picked()).toEqual(['2', '3']);
  });

  it('toggles its rows where several may be chosen, and draws the field alone, unnumbered, where a question has no options', async () => {
    const item = card({ questions: [cardQuestion({ multiple: true, freeText: false }), cardQuestion({ text: 'Anything else?', header: null, options: [] })] });
    show(item);
    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes).toHaveLength(2);
    expect(screen.queryByRole('textbox')).toBeNull();
    key(boxes[0] as HTMLElement, '1');
    key(boxes[0] as HTMLElement, '2');
    expect(picked()).toEqual(['1', '2']);
    key(boxes[0] as HTMLElement, '1');
    expect(picked()).toEqual(['2']);
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(next());
    expect(rows()).toEqual([]);
    fireEvent.change(screen.getByRole('textbox', { name: CARD_WORDS.answer }), { target: { value: 'No.' } });
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toEqual([{ sessionId: SESSION, itemId: item.id, answers: [{ question: 0, options: [0, 1], text: null }, { question: 1, options: [], text: 'No.' }] }]);
  });

  // M100b, V15 (C12, C49): the two kinds of choice, side by side in one request, as the stream form's `question form` asks them.
  it('keeps one row picked on a single choice, and toggles rows on a multiple one, which alone says "Choose one or more"', async () => {
    const options = [{ label: 'Mixed', description: null }, { label: 'The table', description: null }, { label: 'The code fence', description: null }];
    const item = card({ questions: [cardQuestion({ text: 'Which first?', header: 'First', options, freeText: false }), cardQuestion({ text: 'Which after?', header: 'Then', options, multiple: true, freeText: false })] });
    show(item);
    // One choice: radios, no hint, and each pick replaces the last.
    expect(shown().querySelectorAll('input[type=radio]')).toHaveLength(3);
    expect(shown().querySelector('[data-card-hint]')).toBeNull();
    for (const number of ['1', '3', '2']) key(radios()[0] as HTMLElement, number);
    expect(picked()).toEqual(['2']);
    fireEvent.click(radios()[0] as HTMLElement);
    expect(picked()).toEqual(['1']);
    fireEvent.click(next());
    // Several: check boxes, the hint, and each pick toggles its own row.
    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes).toHaveLength(3);
    expect(shown().querySelector('[data-card-hint]')?.textContent).toBe(CARD_WORDS.several);
    for (const number of ['1', '3', '2']) key(boxes[0] as HTMLElement, number);
    expect(picked()).toEqual(['1', '2', '3']);
    key(boxes[0] as HTMLElement, '3');
    expect(picked()).toEqual(['1', '2']);
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toEqual([{ sessionId: SESSION, itemId: item.id, answers: [{ question: 0, options: [0], text: null }, { question: 1, options: [0, 1], text: null }] }]);
  });

  // M100b, V16 (C51): a box for each question in place of "1 / n", none for a request of one.
  it('draws a box for each question: not yet seen, seen, answered — a secret by its field alone — and the shown one marked', () => {
    const boxes = () => [...article().querySelectorAll<HTMLElement>('[data-card-stepper] [data-box]')].map((box) => `${box.dataset['box'] ?? ''}${box.hasAttribute('data-current') ? '*' : ''}`);
    const names = () => screen.getAllByRole('button', { name: /^Question \d+:/ }).map((box) => box.getAttribute('aria-label'));
    show(card({ questions: [cardQuestion(), cardQuestion({ text: 'In which form?' }), cardQuestion({ text: 'A token?', header: null, options: [], secret: true, freeText: false })] }));
    expect(boxes()).toEqual(['seen*', 'unseen', 'unseen']);
    expect(names()).toEqual(['Question 1: not answered', 'Question 2: not seen yet', 'Question 3: not seen yet']);
    fireEvent.click(radios()[0] as HTMLElement);
    expect(boxes()).toEqual(['answered*', 'unseen', 'unseen']);
    fireEvent.click(next());
    expect(boxes()).toEqual(['answered', 'seen*', 'unseen']);
    // A text that is all spaces is no answer; one typed is.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(boxes()).toEqual(['answered', 'seen*', 'unseen']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a summary' } });
    fireEvent.click(next());
    expect(boxes()).toEqual(['answered', 'answered', 'seen*']);
    // A secret is answered by its field holding a text, which the page keeps nowhere: only the fact is drawn.
    const secret = screen.getByLabelText<HTMLInputElement>(CARD_WORDS.secret);
    fireEvent.input(secret, { target: { value: 'hunter2' } });
    expect(boxes()).toEqual(['answered', 'answered', 'answered*']);
    expect(article().textContent).not.toContain('hunter2');
    fireEvent.input(secret, { target: { value: '' } });
    expect(boxes()).toEqual(['answered', 'answered', 'seen*']);
    // Back to the first: it keeps its answer, and the shown mark moves with it.
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    expect(boxes()).toEqual(['answered*', 'answered', 'seen']);
  });

  // M100b, V17 (C52): a box is a button that shows its question, out of the Tab order.
  it('shows a question at a press on its box, from any question to any other, keeping what was picked and marking it seen', () => {
    show(card({ questions: [cardQuestion(), cardQuestion({ text: 'In which form?' }), cardQuestion({ text: 'At what length?' })] }));
    const box = (n: number): HTMLButtonElement => screen.getByRole('button', { name: new RegExp(`^Question ${n}:`) });
    // Out of the Tab order: Previous and Next serve the keyboard. The shown one says it is the current step.
    expect([1, 2, 3].map((n) => [box(n).tabIndex, box(n).getAttribute('aria-current')])).toEqual([[-1, 'step'], [-1, null], [-1, null]]);
    fireEvent.click(radios()[1] as HTMLElement);
    fireEvent.click(box(3));
    expect(shown().textContent).toContain('At what length?');
    expect(document.activeElement).toBe(radios()[0]);
    expect([1, 2, 3].map((n) => box(n).getAttribute('aria-label'))).toEqual(['Question 1: answered', 'Question 2: not seen yet', 'Question 3: not answered']);
    expect(box(3).getAttribute('aria-current')).toBe('step');
    // The last question is shown, and the second never was: Submit waits for it (C58).
    expect(submit().disabled).toBe(true);
    fireEvent.click(box(2));
    expect(submit().disabled).toBe(false);
    fireEvent.click(box(1));
    expect(shown().textContent).toContain('Which file should I read?');
    expect(radios()[1]?.checked).toBe(true);
    // A press on the shown one does nothing.
    fireEvent.click(box(1));
    expect(shown().textContent).toContain('Which file should I read?');
    expect(requests).toEqual([]);
  });

  it('draws no stepper for a request of one question: no box, no Previous and no Next', () => {
    show(card());
    expect(article().querySelector('[data-card-stepper], [data-box]')).toBeNull();
    expect(screen.queryByRole('button', { name: CARD_WORDS.previous })).toBeNull();
    expect(screen.queryByRole('button', { name: CARD_WORDS.next })).toBeNull();
  });

  // M100b, V15 (C48): the card is as tall as its tallest question, so nothing under it moves between questions.
  it('draws every question in one stack, the shown one alone seen and reached, so its height is the tallest question’s', () => {
    show(two());
    const stack = shown().parentElement as HTMLElement;
    const all = [...stack.querySelectorAll<HTMLElement>(':scope > fieldset')];
    expect(all).toHaveLength(2);
    const state = () => all.map((fieldset) => [fieldset.hasAttribute('data-shown'), fieldset.getAttribute('aria-hidden'), fieldset.hasAttribute('inert')]);
    expect(state()).toEqual([[true, null, false], [false, 'true', true]]);
    // Out of reach: the other question's controls are in no role query and take no key.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(next());
    expect(state()).toEqual([[false, 'true', true], [true, null, false]]);
    expect(screen.getAllByRole('radio').map((radio) => radio.closest('fieldset'))).toEqual([all[1], all[1], all[1]]);
  });

  it('draws no Something else for a question that takes no free text (V35; C78)', () => {
    show(card({ questions: [cardQuestion({ freeText: false })] }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(rows().map((row) => row.dataset['cardRow'])).toEqual(['1', '2']);
  });

  it('masks a secret’s field, draws none of its options whatever it says of free text, and sends what was typed (C44, C78)', async () => {
    show(card({ questions: [cardQuestion({ secret: true, freeText: false })] }));
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(rows()).toEqual([]);
    const field = screen.getByLabelText<HTMLInputElement>(CARD_WORDS.secret);
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    fireEvent.change(field, { target: { value: 'hunter2' } });
    // A digit typed in it is text, and no row's.
    key(field, '1');
    // The page keeps none of it: it is the field's value, and nowhere in what is drawn.
    expect(article().textContent).not.toContain('hunter2');
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toMatchObject([{ answers: [{ question: 0, options: [], text: 'hunter2' }] }]);
  });

  it('moves to the next question at Enter on a row, and does nothing at Enter on the last', () => {
    show(two());
    key(radios()[0] as HTMLElement, 'Enter');
    expect(shownQuestion().textContent).toContain('In which form?');
    key(radios()[2] as HTMLElement, 'Enter');
    expect(shownQuestion().textContent).toContain('In which form?');
    expect(requests).toEqual([]);
  });

  it('takes no more than an answer’s bound in its field', () => {
    show(card());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').maxLength).toBe(MAX_ANSWER_TEXT);
  });

  it('makes its controls stops only while it is the list’s current entry (C43)', () => {
    const view = show(card(), { current: false });
    expect(controls().map((control) => control.tabIndex)).toEqual([-1, -1, -1, -1, -1]);
    view.rerender(<CardContext value={SCOPE}><InteractionCard item={card()} modelName="Sonnet" current /></CardContext>);
    expect(controls().every((control) => control.tabIndex === 0)).toBe(true);
  });
});

// M100b, V19 (C60), narrowed to the first answer on the last question's first visit.
describe('a card that waits: what a single choice’s pick leads to (V19; M100b, C60, C61)', () => {
  const options = [{ label: 'Mixed', description: null }, { label: 'The table', description: null }, { label: 'The code fence', description: null }];
  const three = () => card({ questions: [cardQuestion({ text: 'Which first?', options, freeText: false }), cardQuestion({ text: 'Which after?', options, multiple: true, freeText: false }), cardQuestion({ text: 'Which last?', options, freeText: false })] });
  /** A press of the pointer: a click with a count, as a key's has none. */
  const press = (element: Element) => fireEvent.click(element.closest('label') as HTMLElement, { detail: 1 });
  const later = () => act(() => { vi.advanceTimersByTime(ADVANCE_MS); });

  it('moves to the next question a moment after a press or a number key on a single choice, and not before', () => {
    vi.useFakeTimers();
    show(three());
    press(radios()[1] as HTMLElement);
    // The pick is seen first.
    expect(picked()).toEqual(['2']);
    expect(shown().textContent).toContain('Which first?');
    later();
    expect(shown().textContent).toContain('Which after?');
    // Several may be chosen: a press or a key toggles, and nothing moves.
    press(screen.getAllByRole('checkbox')[0] as HTMLElement);
    key(screen.getAllByRole('checkbox')[0] as HTMLElement, '3');
    later();
    expect(shown().textContent).toContain('Which after?');
    expect(picked()).toEqual(['1', '3']);
  });

  it('moves nothing for a pick the keyboard made in place — Space, the arrows — nor where the user went elsewhere meanwhile', () => {
    vi.useFakeTimers();
    show(three());
    // A click with no count is a key's: Space on a radio, or the arrows.
    fireEvent.click(radios()[0] as HTMLElement);
    later();
    expect(shown().textContent).toContain('Which first?');
    press(radios()[2] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /^Question 3:/ }));
    later();
    // The pick stood for the first question, which is no longer the one shown: nothing moved from the third.
    expect(shown().textContent).toContain('Which last?');
  });

  it.each(['pointer', 'number'] as const)('sends after the first last-question pick by %s when earlier answers were filled before arrival', async (method) => {
    vi.useFakeTimers();
    const item = three();
    show(item);
    key(radios()[0] as HTMLElement, '1');
    later();
    press(screen.getAllByRole('checkbox')[2] as HTMLElement);
    fireEvent.click(next());
    if (method === 'pointer') press(radios()[2] as HTMLElement);
    else key(radios()[0] as HTMLElement, '3');
    expect(sent('chat:answer')).toEqual([]);
    act(() => { vi.advanceTimersByTime(ADVANCE_MS - 1); });
    expect(sent('chat:answer')).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    await settle();
    expect(sent('chat:answer')).toEqual([{ sessionId: SESSION, itemId: item.id, answers: [{ question: 0, options: [0], text: null }, { question: 1, options: [2], text: null }, { question: 2, options: [2], text: null }] }]);
  });

  it.each([false, true])('requires Submit after reaching the last question with an earlier answer missing, even when it was answered there: %s', async (answerLast) => {
    vi.useFakeTimers();
    const item = three();
    show(item);
    key(radios()[0] as HTMLElement, '1');
    later();
    // The second is left blank: the last pick moves nothing and sends nothing.
    fireEvent.click(next());
    if (answerLast) key(radios()[0] as HTMLElement, '2');
    later();
    expect(shown().textContent).toContain('Which last?');
    expect(requests).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^Question 2:/ }));
    press(screen.getAllByRole('checkbox')[2] as HTMLElement);
    fireEvent.click(next());
    key(radios()[0] as HTMLElement, '3');
    later();
    expect(sent('chat:answer')).toEqual([]);
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toEqual([{ sessionId: SESSION, itemId: item.id, answers: [{ question: 0, options: [0], text: null }, { question: 1, options: [2], text: null }, { question: 2, options: [2], text: null }] }]);
  });

  it('requires Submit after leaving an eligible last question and returning before answering it', async () => {
    vi.useFakeTimers();
    show(two());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(next());
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    fireEvent.click(next());
    press(radios()[1] as HTMLElement);
    later();
    expect(sent('chat:answer')).toEqual([]);
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toHaveLength(1);
  });

  it.each(['pointer', 'number', 'in-place', 'same option', 'text'] as const)('cancels a pending submission when revising by %s', async (method) => {
    vi.useFakeTimers();
    show(two());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(next());
    press(radios()[0] as HTMLElement);
    if (method === 'pointer') press(radios()[1] as HTMLElement);
    else if (method === 'number') key(radios()[0] as HTMLElement, '2');
    else if (method === 'in-place') fireEvent.click(radios()[1] as HTMLElement);
    else if (method === 'same option') press(radios()[0] as HTMLElement);
    else fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A revision' } });
    later();
    expect(sent('chat:answer')).toEqual([]);
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toHaveLength(1);
    const lastAnswer = method === 'text' ? { question: 1, options: [0], text: 'A revision' } : { question: 1, options: [method === 'same option' ? 0 : 1], text: null };
    expect(sent('chat:answer')[0]).toMatchObject({ answers: [expect.anything(), lastAnswer] });
  });

  it('does not auto-submit when replacing or clearing a free-text answer with an option', () => {
    vi.useFakeTimers();
    show(two());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(next());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'An answer' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    press(radios()[1] as HTMLElement);
    later();
    expect(sent('chat:answer')).toEqual([]);
  });

  it('cancels a pending submission when navigating away and back within the delay', () => {
    vi.useFakeTimers();
    show(two());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(next());
    press(radios()[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    fireEvent.click(next());
    later();
    expect(sent('chat:answer')).toEqual([]);
  });

  it('cancels a pending advance when navigating away and back within the delay', () => {
    vi.useFakeTimers();
    show(three());
    press(radios()[0] as HTMLElement);
    fireEvent.click(next());
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    later();
    expect(shown().textContent).toContain('Which first?');
    expect(sent('chat:answer')).toEqual([]);
  });

  it.each(['pointer', 'number'] as const)('auto-submits a one-question card on its first pick by %s, and never retries automatically', async (method) => {
    vi.useFakeTimers();
    answers.answer = { status: 'refused', reason: 'storage-failed' };
    show(card());
    if (method === 'pointer') press(radios()[0] as HTMLElement);
    else key(radios()[0] as HTMLElement, '1');
    later();
    await settle();
    expect(sent('chat:answer')).toHaveLength(1);
    press(radios()[1] as HTMLElement);
    later();
    expect(sent('chat:answer')).toHaveLength(1);
  });

  it('keeps multiple-choice picks and in-place keyboard picks from auto-submitting on the last question', () => {
    vi.useFakeTimers();
    show(card({ questions: [cardQuestion({ multiple: true })] }));
    press(screen.getAllByRole('checkbox')[0] as HTMLElement);
    key(screen.getAllByRole('checkbox')[0] as HTMLElement, '2');
    later();
    expect(sent('chat:answer')).toEqual([]);
    cleanup();
    show(card());
    fireEvent.click(radios()[0] as HTMLElement);
    later();
    press(radios()[1] as HTMLElement);
    later();
    expect(sent('chat:answer')).toEqual([]);
  });

  it('hands the keyboard to the session’s prompt once its answer or its decline is taken, in the session’s own chat alone (C61)', async () => {
    show(card());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(submit());
    await settle();
    expect(usePromptFocus.getState().sessionId).toBe(SESSION);
    cleanup();
    resetPromptFocus();
    // Refused: nothing is asked.
    answers.answer = { status: 'refused', reason: 'storage-failed' };
    show(card());
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(submit());
    await settle();
    expect(usePromptFocus.getState().sessionId).toBeNull();
    cleanup();
    // A decline taken asks too.
    show(card());
    fireEvent.click(decline());
    await settle();
    expect(usePromptFocus.getState().sessionId).toBe(SESSION);
    cleanup();
    resetPromptFocus();
    // In a worker's tab, the session's prompt is not where the user is: nothing is asked.
    answers.answer = { status: 'answered' };
    show(card({}, { workerId: 'worker-1' }), { scope: { ...SCOPE, asker: 'Sub-agent reads the notes', workerRunning: true } });
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(submit());
    await settle();
    expect(usePromptFocus.getState().sessionId).toBeNull();
  });
});

describe('a card that waits: its foot (V4, V14, V18; M100b, C21, C30, C32, C33, C41, C43, C51–C53, C57, C58)', () => {
  it('keeps Submit disabled until every question has been shown once, and available from then, back at an earlier one too (C58)', () => {
    show(two());
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(requests).toEqual([]);
    fireEvent.click(next());
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.previous }));
    expect(submit().disabled).toBe(false);
  });

  it('sends a question left blank as none — main sends it as "No answer" — and refuses a card with nothing answered (C30)', async () => {
    const item = two();
    show(item);
    fireEvent.click(next());
    fireEvent.click(submit());
    await settle();
    expect(screen.getByRole('status').textContent).toBe(CARD_WORDS.nothing);
    expect(requests).toEqual([]);
    // What the refusal said is about the answers as they were: a change to one takes it away.
    fireEvent.click(radios()[2] as HTMLElement);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toEqual([{ sessionId: SESSION, itemId: item.id, answers: [{ question: 0, options: [], text: null }, { question: 1, options: [2], text: null }] }]);
  });

  it('says nothing of how long the model has waited: no provider gives a time limit, and the header would be its place (C51)', () => {
    const now = Date.now();
    show(card(), { carrier: chatTurn('t1', { state: 'running', time: { acceptedAt: now - 65_000, providerStartedAt: null, providerEndedAt: null, endReceivedAt: null, providerDurationMs: null, elapsedMs: null } }) });
    expect(article().textContent).not.toMatch(/waits|min|\d s\b/);
    // One question: no stepper, and the foot's middle is empty.
    expect(article().querySelector('[data-card-stepper]')).toBeNull();
    const foot = [...(decline().parentElement as HTMLElement).children];
    expect(foot.map((child) => (child === decline() ? 'decline' : child === submit() ? 'submit' : child.textContent))).toEqual(['decline', '', 'submit']);
  });

  it('draws the heavy rules around numbered rows alone: a field alone and a secret stand without them (C43)', () => {
    show(card({ questions: [cardQuestion(), cardQuestion({ text: 'Anything else?', header: null, options: [] }), cardQuestion({ text: 'A token?', header: null, options: [], secret: true, freeText: false })] }));
    const kind = () => shown().querySelector<HTMLElement>('[data-card-rows]')?.dataset['cardRows'];
    expect(kind()).toBe('numbered');
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.next }));
    expect(kind()).toBe('fields');
    fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.next }));
    expect(kind()).toBe('fields');
  });

  it('declines the whole request from any question with one press, and sends no answer', async () => {
    const item = two();
    show(item);
    fireEvent.click(radios()[0] as HTMLElement);
    decline().focus();
    fireEvent.click(decline());
    // On its way: said unavailable and not disabled, so the focus stays on it until the card settles.
    expect([decline().disabled, decline().getAttribute('aria-disabled'), document.activeElement === decline()]).toEqual([false, 'true', true]);
    await settle();
    expect(sent('chat:dismiss')).toEqual([{ sessionId: SESSION, itemId: item.id }]);
    expect(sent('chat:answer')).toEqual([]);
  });

  it('offers no Decline on a blocking card whose provider declines nothing (C33)', () => {
    show(card(), { scope: { ...SCOPE, declines: false } });
    expect(screen.queryByRole('button', { name: /^Decline/ })).toBeNull();
    expect(submit()).toBeTruthy();
  });

  it('keeps the focus on Submit while the answer is on its way: said unavailable, never disabled, and pressed once (C43)', async () => {
    show(card());
    fireEvent.click(radios()[0] as HTMLElement);
    submit().focus();
    fireEvent.click(submit());
    expect([submit().disabled, submit().getAttribute('aria-disabled')]).toEqual([false, 'true']);
    expect(document.activeElement).toBe(submit());
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toHaveLength(1);
    expect(submit().hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(submit());
  });

  it('says that a question was shortened, and is answered all the same (C46)', () => {
    show(card({ cut: true }));
    expect(article().querySelector('[data-item-line="cut"]')?.textContent).toBe(CARD_WORDS.cut);
    expect(submit().disabled).toBe(false);
  });

  it('keeps what was entered and says why when main refuses the answer, and says nothing for a stale press (C26, C49)', async () => {
    show(card({ mode: 'async', outcome: 'open' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a very long answer' } });
    answers.answer = { status: 'refused', reason: 'too-long' };
    fireEvent.click(submit());
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/too long to send as one message/);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('a very long answer');
    answers.answer = { status: 'refused', reason: 'not-pending' };
    fireEvent.click(submit());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    answers.answer = { status: 'refused', reason: 'storage-failed' };
    fireEvent.click(submit());
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/could not save your answer/);
  });
});

describe('an async card (V4; C38, C45; M100b, C32)', () => {
  const open = (patch: Partial<QuestionBody> = {}) => card({ mode: 'async', outcome: 'open', questions: [cardQuestion({ header: null }), cardQuestion({ header: null, text: 'In which form?' })], ...patch });

  it('says the model asked and went on, waits for nothing, and holds Decline whatever its provider declines', () => {
    show(open(), { scope: { ...SCOPE, declines: false } });
    expect(article().getAttribute('aria-label')).toBe('Sonnet asked a question and went on');
    expect(article().textContent).not.toContain('waits');
    expect(decline()).toBeTruthy();
  });

  it('disables Submit with Send’s reason while a turn runs, and leaves Decline usable', async () => {
    const item = open();
    show(item, { scope: { ...SCOPE, running: true } });
    fireEvent.click(next());
    expect(submit().disabled).toBe(true);
    const reason = document.getElementById(submit().getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('This chat is still working. Send again once it has finished.');
    fireEvent.click(decline());
    await settle();
    expect(sent('chat:dismiss')).toEqual([{ sessionId: SESSION, itemId: item.id }]);
  });

  it('leaves Submit usable while a turn runs that takes a message now, and says the answer goes into it (M23, C45)', async () => {
    const item = open();
    show(item, { scope: { ...SCOPE, running: true, sendsNow: true } });
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(next());
    expect(submit().disabled).toBe(false);
    const reason = document.getElementById(submit().getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe(CARD_WORDS.intoTurn(SCOPE.providerName));
    expect(article().textContent).not.toContain('Send again once it has finished');
    fireEvent.click(submit());
    await settle();
    expect(sent('chat:answer')).toHaveLength(1);
  });

  it('says nothing when a decline finds the card settled already, and says so when it could not be made', async () => {
    show(open());
    answers.dismiss = { status: 'refused', reason: 'not-open' };
    fireEvent.click(decline());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    answers.dismiss = { status: 'refused', reason: 'storage-failed' };
    fireEvent.click(decline());
    await settle();
    expect(screen.getByRole('status').textContent).toBe(CARD_WORDS.dismissFailed);
  });
});

describe('a settled card (V5, V19; C39, C68, C79; M100b, C23, C42, C64)', () => {
  const answered = (patch: Partial<QuestionBody> = {}, overrides: Partial<ConversationItem> = {}) => card({ outcome: 'answered', answers: [{ options: [1], text: 'and the third', secret: false }], settledAt: 5, confirmedAt: 6, ...patch }, overrides);
  const expand = () => fireEvent.click(screen.getByRole('button', { name: CARD_WORDS.showAnswers }));

  it.each(['blocking', 'async'] as const)('starts an answered %s card folded and toggles its questions, answers and shortening notice', (mode) => {
    show(answered({ mode, cut: true }));
    const toggle = screen.getByRole('button', { name: CARD_WORDS.showAnswers });
    const detail = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detail?.hidden).toBe(true);
    expect(article().textContent).toBe('1 Question — Answered');
    expand();
    expect(toggle.getAttribute('aria-label')).toBe(CARD_WORDS.hideAnswers);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detail?.hidden).toBe(false);
    expect(article().textContent).toContain('Which file should I read?');
    expect(article().textContent).toContain('and the third');
    expect(article().textContent).toContain(CARD_WORDS.cut);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(article().textContent).toBe('1 Question — Answered');
    expect(requests).toEqual([]);
  });

  it('folds when the answer arrives, keeps an expanded card through updates, and folds on remount', () => {
    const item = card();
    const done = answered({}, { id: item.id });
    const view = show(item);
    expect(screen.queryByRole('button', { name: CARD_WORDS.showAnswers })).toBeNull();
    view.rerender(<CardContext value={SCOPE}><InteractionCard item={done} modelName="Sonnet" current /></CardContext>);
    expect(article().textContent).toBe('1 Question — Answered');
    expand();
    view.rerender(<CardContext value={SCOPE}><InteractionCard item={{ ...done, time: { ...done.time, receivedAt: 7 } }} modelName="Sonnet" current /></CardContext>);
    expect(screen.getByRole('button', { name: CARD_WORDS.hideAnswers }).getAttribute('aria-expanded')).toBe('true');
    view.unmount();
    show(done);
    expect(screen.getByRole('button', { name: CARD_WORDS.showAnswers }).getAttribute('aria-expanded')).toBe('false');
  });

  it.each([false, true])('puts the fold arrow in the tab order only for the current card: %s', (current) => {
    show(answered(), { current });
    expect(screen.getByRole('button', { name: CARD_WORDS.showAnswers }).tabIndex).toBe(current ? 0 : -1);
  });

  // M100b, V19 (C64): the header says how the card ended, in a word or two, beside its count.
  it.each<[QuestionBody['outcome'], Partial<QuestionBody>, string, string]>([
    ['answered', { answers: [{ options: [0], text: null, secret: false }], confirmedAt: 6 }, OUTCOME_WORDS.answered, '1 Question — Answered'],
    ['withdrawn', { withdrawnBy: 'request' }, OUTCOME_WORDS.withdrawnByRequest, '1 Question — Withdrawn'],
    ['withdrawn', { withdrawnBy: 'turn' }, OUTCOME_WORDS.withdrawnByTurn, '1 Question — Withdrawn'],
    ['dropped', {}, OUTCOME_WORDS.dropped, '1 Question — Not answered'],
    ['dismissed', { mode: 'async' }, OUTCOME_WORDS.dismissed, '1 Question — Declined'],
    ['dismissed', { mode: 'blocking' }, OUTCOME_WORDS.declined, '1 Question — Declined'],
    ['passed', { mode: 'async' }, OUTCOME_WORDS.passed, '1 Question — Passed over'],
  ])('%s: its outcome in words, its header saying how it ended, and no answer controls', (outcomeName, patch, words, head) => {
    show(card({ outcome: outcomeName, settledAt: 5, ...patch }));
    if (outcomeName === 'answered') expand();
    expect(outcome()).toBe(words);
    expect(article().dataset['outcome']).toBe(outcomeName);
    expect(header().textContent).toBe(head);
    expect(header().hasAttribute('data-waiting')).toBe(false);
    // Inert: its answers as text, never as disabled controls that look answerable.
    expect(controls()).toEqual(outcomeName === 'answered' ? [screen.getByRole('button', { name: CARD_WORDS.hideAnswers })] : []);
    expect(article().querySelector('fieldset, [data-card-stepper], [data-card-row]')).toBeNull();
    expect(article().textContent).toContain('Which file should I read?');
  });

  it('covers every outcome of the closed list between the cards that wait and the cards that are settled', () => {
    expect([...INTERACTION_OUTCOMES].sort()).toEqual(['answered', 'dismissed', 'dropped', 'open', 'passed', 'pending', 'withdrawn']);
  });

  it('shows every question at once with its answer as text: the chosen labels, the typed text, a secret as the fact alone, and "No answer"', () => {
    show(card({
      mode: 'async', outcome: 'answered', settledAt: 5, confirmedAt: 6,
      questions: [cardQuestion(), cardQuestion({ text: 'The password?', header: null, options: [], secret: true }), cardQuestion({ text: 'In which form?', header: null })],
      answers: [{ options: [1], text: 'and the third', secret: false }, { options: [], text: null, secret: true }, null],
    }));
    expand();
    const lines = [...article().querySelectorAll('p')].map((line) => line.textContent);
    expect(lines).toEqual(['3 Questions — Answered', 'Which file should I read?', 'notes-2.txt', 'and the third', 'The password?', CARD_WORDS.secretGiven, 'In which form?', 'No answer', OUTCOME_WORDS.answered]);
  });

  it('shows what could have been answered, as text, on a card that was not', () => {
    show(card({ outcome: 'dropped', settledAt: 5 }));
    expect([...article().querySelectorAll('p')].map((line) => line.textContent)).toEqual(['1 Question — Not answered', 'Which file should I read?', 'notes-1.txt' + 'The first note', 'notes-2.txt', OUTCOME_WORDS.dropped]);
  });

  it('says the model did not confirm a blocking answer only once its own turn is over (V24; C68)', () => {
    const unmarked = answered({ confirmedAt: null });
    const first = show(unmarked, { carrier: chatTurn('t1', { state: 'running' }) });
    expect(outcome()).toBeNull();
    first.unmount();
    for (const state of ['ended', 'unfinished', 'unacknowledged'] as const) {
      const view = show(unmarked, { carrier: chatTurn('t1', { state }) });
      expect(outcome(), state).toBe(OUTCOME_WORDS.unconfirmed);
      expect(screen.getByRole('button', { name: CARD_WORDS.showAnswers }).getAttribute('aria-expanded')).toBe('false');
      view.unmount();
    }
    // Where the page does not hold the turn, it reads answered; and with its mark, always.
    const unheld = show(unmarked);
    expect(outcome()).toBeNull();
    unheld.unmount();
    show(answered(), { carrier: chatTurn('t1', { state: 'ended' }) });
    expect(outcome()).toBeNull();
  });

  it('says so for an async answer by the turn its prompt started, never by the turn that asked (V24; C68)', () => {
    const unmarked = answered({ mode: 'async', confirmedAt: null, answeredBy: 't2' });
    const running = show(unmarked, { carrier: chatTurn('t2', { state: 'running' }) });
    expect(outcome()).toBeNull();
    running.unmount();
    const lost = show(unmarked, { carrier: chatTurn('t2', { state: 'unacknowledged' }) });
    expect(outcome()).toBe(OUTCOME_WORDS.unconfirmed);
    lost.unmount();
    // The list does not hold the answering turn: answered, and nothing more is claimed.
    show(unmarked);
    expect(outcome()).toBeNull();
  });

  it('waits for a worker’s end before it says so of a worker’s answer: the parent’s turn ends while the worker runs (V36; C79)', () => {
    const unmarked = answered({ confirmedAt: null }, { workerId: 'worker-1' });
    const over = chatTurn('t1', { state: 'ended' });
    const runs = show(unmarked, { scope: { ...SCOPE, asker: 'Sub-agent reads the notes', workerRunning: true }, carrier: over });
    expect(article().getAttribute('aria-label')).toBe('Sub-agent reads the notes asked a question');
    expect(outcome()).toBeNull();
    runs.unmount();
    const unread = show(unmarked, { scope: { ...SCOPE, workerRunning: null }, carrier: over });
    expect(outcome()).toBeNull();
    unread.unmount();
    const ended = show(unmarked, { scope: { ...SCOPE, workerRunning: false }, carrier: over });
    expect(outcome()).toBe(OUTCOME_WORDS.unconfirmed);
    ended.unmount();
    // Confirmed by the worker's own result when it comes.
    show(answered({}, { workerId: 'worker-1' }), { scope: { ...SCOPE, workerRunning: false }, carrier: over });
    expect(outcome()).toBeNull();
  });
});

describe('a list that takes no answer (V5; C42; M100b, C23)', () => {
  it('draws a card inert whatever its outcome, as a settled one: a chat without a session takes no prompt', () => {
    show(card({ mode: 'async', outcome: 'open' }), { scope: null });
    expect(controls()).toEqual([]);
    expect(header().hasAttribute('data-waiting')).toBe(false);
    expect(article().textContent).toContain('Which file should I read?');
    expect(article().textContent).toContain('notes-2.txt');
    // Nothing became of it that fat-g can say.
    expect(outcome()).toBeNull();
  });

  it('draws nothing for an item whose body cannot be read', () => {
    const view = show({ ...card(), interaction: null });
    expect(view.container.querySelector('article')).toBeNull();
  });
});
