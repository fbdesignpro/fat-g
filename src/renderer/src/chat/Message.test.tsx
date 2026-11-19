// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14, V15, V26 (docs/planning/_archive/M19.md; C18, C29, C30, C38–C40, C42, C64): one item of a
// conversation, by itself — its head's one row, what its Copy takes, its time, and its lines.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { chatItem } from '../test/chat';
import { formatDateTime, formatTimeOfDay, startOfDay } from '../ui/format';
import { Message } from './Message';

const S = '11111111-1111-4111-8111-111111111111';
let written: string[];
beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
});
afterEach(cleanup);

const show = (item: ConversationItem, props: Partial<Parameters<typeof Message>[0]> = {}) => render(<Message item={item} modelName="GPT-6 Sol" providerName="Codex" {...props} />);
const article = () => screen.getByRole('article');
/** A prompt's Copy button, or an assistant's message's, which is a part of its answer (the maintainer). */
const COPY_NAME = new RegExp(`^(${CHAT_LINES.copyMessage}|${CHAT_LINES.copyPart})$`);
const copy = () => within(article()).getByRole('button', { name: COPY_NAME });
const press = (button: HTMLElement) => act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); });

it('keeps queue attribution accessible without adding a label below the speaker bar', () => {
  show(chatItem(S, 'user', 'Queued request', { fromQueue: true }), { named: false });
  expect(article().getAttribute('aria-label')).toBe('You (from queue)');
  expect(article().firstElementChild?.textContent).not.toContain('You (from queue)');
  cleanup();
  show(chatItem(S, 'user', 'Direct request'));
  expect(article().getAttribute('aria-label')).toBe('You');
});

describe('Copy (V14; C38–C40)', () => {
  it('is on every prompt and every assistant’s message, commentary included, and on no notice', () => {
    for (const [item, name] of [
      [chatItem(S, 'user', 'a prompt'), CHAT_LINES.copyMessage],
      [chatItem(S, 'assistant', 'commentary', { phase: 'commentary' }), CHAT_LINES.copyPart],
      [chatItem(S, 'assistant', 'an answer'), CHAT_LINES.copyPart],
      [chatItem(S, 'notice', 'a notice', { notice: 'turn-failed' }), null],
    ] as const) {
      show(item);
      expect(within(article()).queryAllByRole('button', { name: COPY_NAME }).map((button) => button.getAttribute('aria-label')), item.role ?? 'notice').toEqual(name === null ? [] : [name]);
      cleanup();
    }
  });

  it('copies a message’s stored text, the Markdown source as its provider sent it, whatever is drawn of it (C30)', async () => {
    const source = '# A heading\n\nSome **strong** text, a [link](https://example.com) and:\n\n```js\nconst a = 1;\n```\n\n&amp; an entity.';
    show(chatItem(S, 'assistant', source));
    expect(article().querySelector('h1')?.textContent).toBe('A heading');
    await press(copy());
    expect(written).toEqual([source]);
    // A prompt's, as it was typed.
    cleanup();
    const typed = 'look at src/notes_1.txt  and *this*\n  indented';
    show(chatItem(S, 'user', typed));
    await press(copy());
    expect(written).toEqual([source, typed]);
  });

  it('copies of a message that is being written what the page holds of it at the press, and of a partial one as far as it goes', async () => {
    const item = chatItem(S, 'assistant', 'Half an', { state: 'streaming' });
    const view = show(item);
    view.rerender(<Message item={{ ...item, blocks: [{ type: 'text', text: 'Half an answer so far', cut: false }] }} modelName="GPT-6 Sol" providerName="Codex" />);
    await press(copy());
    expect(written).toEqual(['Half an answer so far']);
    view.rerender(<Message item={{ ...item, state: 'partial', blocks: [{ type: 'text', text: 'Half an answer, and no more', cut: false }] }} modelName="GPT-6 Sol" providerName="Codex" />);
    await press(copy());
    expect(written.at(-1)).toBe('Half an answer, and no more');
  });

  it('follows the label and the time in its head, in that order, and is a stop in the tab order only in the current message (C40, C50)', () => {
    const at = Date.parse('2020-01-27T14:03:00');
    show(chatItem(S, 'assistant', 'an answer', { time: { receivedAt: at, providerAt: null } }), { times: { today: startOfDay(at) } });
    const head = article().firstElementChild;
    expect([...(head?.children ?? [])].map((child) => child.tagName)).toEqual(['P', 'TIME', 'SPAN']);
    expect(head?.children[0]?.textContent).toBe('GPT-6 Sol');
    expect(head?.children[2]?.contains(copy())).toBe(true);
    // Drawn as an icon in the message's margin (the maintainer): no word of its own, its name beside it at once.
    expect([copy().textContent, copy().hasAttribute('title')]).toEqual(['', false]);
    // There for the keyboard and for assistive technology at all times: in the DOM, never hidden from either.
    expect(copy().closest('[hidden], [aria-hidden="true"], [inert]')).toBeNull();
    expect(copy().tabIndex).toBe(-1);
    cleanup();
    show(chatItem(S, 'assistant', 'an answer'), { current: true });
    expect(copy().tabIndex).toBe(0);
    expect(article().hasAttribute('data-current')).toBe(true);
  });
});

// M19 (C79; the maintainer, from the acceptance): a provider that names the answer only at its
// turn's end says no phase for a text while it is written. Such a text is neither commentary nor
// answer yet, and is drawn as an answer is: commentary's own style, its smaller size, is its alone.
describe('a message whose phase is not said yet (C79)', () => {
  it('is drawn as an answer is while it is written: Markdown, with no phase of its own to style it by', () => {
    show(chatItem(S, 'assistant', 'The **answer**, as far as it', { phase: null, state: 'streaming' }));
    expect(article().getAttribute('data-role')).toBe('assistant');
    expect(article().hasAttribute('data-phase')).toBe(false);
    expect(article().getAttribute('data-state')).toBe('streaming');
    expect(article().querySelector('strong')?.textContent).toBe('answer');
  });

  it('takes its phase when its provider says it: commentary once whole, the answer once its turn’s end names it', () => {
    for (const phase of ['commentary', 'final'] as const) {
      show(chatItem(S, 'assistant', 'Whole.', { phase, state: 'complete' }));
      expect(article().getAttribute('data-phase')).toBe(phase);
      cleanup();
    }
    // Left as it was received, it keeps none, and its line says it is incomplete.
    show(chatItem(S, 'assistant', 'As far as it', { phase: null, state: 'partial' }));
    expect(article().hasAttribute('data-phase')).toBe(false);
    expect(article().querySelector('[data-item-line="incomplete"]')).not.toBeNull();
  });
});

describe('what is Markdown, and what is not (C29)', () => {
  it('reads an assistant’s message of either phase as Markdown, and leaves a prompt, a notice, its detail and a question’s lines as typed', () => {
    const text = '**strong** and `code`';
    for (const phase of ['commentary', 'final'] as const) {
      show(chatItem(S, 'assistant', text, { phase, questions: [{ title: '**Pick**', options: ['`a`'] }] }));
      expect(article().querySelector('strong')?.textContent).toBe('strong');
      expect(article().getAttribute('data-phase')).toBe(phase);
      // The question's lines are plain.
      expect(article().textContent).toContain('**Pick**');
      expect(article().textContent).toContain('`a`');
      cleanup();
    }
    show(chatItem(S, 'user', text));
    expect(article().querySelector('strong, code')).toBeNull();
    expect(article().textContent).toContain(text);
    cleanup();
    show(chatItem(S, 'notice', text, { notice: 'turn-failed', detail: text }));
    expect(article().querySelector('strong, code')).toBeNull();
  });
});

describe('a message’s time (V15; C42)', () => {
  const at = Date.parse('2020-01-27T14:03:00');
  const today = startOfDay(at);

  it('is not shown unless times are shown', () => {
    show(chatItem(S, 'assistant', 'x', { time: { receivedAt: at, providerAt: null } }));
    expect(article().querySelector('time')).toBeNull();
  });

  it('is when fat-g took it: a time of day today, with the date on any other day, in the system’s locale and zone', () => {
    show(chatItem(S, 'user', 'x', { time: { receivedAt: at, providerAt: null } }), { times: { today } });
    const time = article().querySelector('time');
    expect(time?.textContent).toBe(formatTimeOfDay(at));
    expect(time?.getAttribute('datetime')).toBe(new Date(at).toISOString());
    cleanup();
    // The same message, read the day after, and one from the day before.
    for (const day of [today + 86_400_000, today - 86_400_000]) {
      show(chatItem(S, 'user', 'x', { time: { receivedAt: at, providerAt: null } }), { times: { today: day } });
      expect(article().querySelector('time')?.textContent).toBe(formatDateTime(at));
      cleanup();
    }
    // A notice has its time too.
    show(chatItem(S, 'notice', 'x', { notice: 'turn-failed', time: { receivedAt: at, providerAt: null } }), { times: { today } });
    expect(article().querySelector('time')?.textContent).toBe(formatTimeOfDay(at));
  });

  it('is, for an item read from history, its turn’s start as its provider gives it: once, on the turn’s first item, titled as the provider’s', () => {
    const imported = chatItem(S, 'user', 'made elsewhere', { origin: 'provider', time: { receivedAt: null, providerAt: at } });
    show(imported, { times: { today }, firstOfTurn: true });
    const time = article().querySelector('time');
    expect(time?.textContent).toBe(formatTimeOfDay(at));
    expect(time?.getAttribute('title')).toBe(CHAT_LINES.providerTime('Codex'));
    cleanup();
    // Its turn's other items show none.
    show(chatItem(S, 'assistant', 'the answer', { origin: 'provider', time: { receivedAt: null, providerAt: at } }), { times: { today }, firstOfTurn: false });
    expect(article().querySelector('time')).toBeNull();
    cleanup();
    // And none where the provider gave no time: nothing is filled in from the local clock.
    show(chatItem(S, 'user', 'x', { origin: 'provider', time: { receivedAt: null, providerAt: null } }), { times: { today }, firstOfTurn: true });
    expect(article().querySelector('time')).toBeNull();
  });
});

describe('the lines under a message (V7, V26; C18, C64)', () => {
  it('says that a partial message is incomplete, in fat-g’s words and not in its text, and draws it as any message, as far as it goes', () => {
    show(chatItem(S, 'assistant', 'Half an **answer**', { state: 'partial' }));
    expect(article().querySelector('[data-item-line="incomplete"]')?.textContent).toBe(CHAT_LINES.incomplete);
    expect(article().querySelector('strong')?.textContent).toBe('answer');
    expect(article().getAttribute('data-state')).toBe('partial');
  });

  it('says nothing of the kind for a message that is being written, or is complete', () => {
    for (const state of ['streaming', 'complete'] as const) {
      show(chatItem(S, 'assistant', 'text', { state }));
      expect(article().querySelector('[data-item-line="incomplete"]')).toBeNull();
      expect(article().getAttribute('aria-busy')).toBe(state === 'streaming' ? 'true' : null);
      cleanup();
    }
  });

  it('shows that a message was cut while it is still being written, as partial, and once complete (C64)', () => {
    for (const state of ['streaming', 'partial', 'complete'] as const) {
      show(chatItem(S, 'assistant', 'x'.repeat(50), { state, cut: true }));
      expect(article().querySelector('[data-item-line="cut"]')?.textContent, state).toBe(CHAT_LINES.cut);
      cleanup();
    }
    show(chatItem(S, 'assistant', 'whole', { state: 'streaming' }));
    expect(article().querySelector('[data-item-line="cut"]')).toBeNull();
  });
});
