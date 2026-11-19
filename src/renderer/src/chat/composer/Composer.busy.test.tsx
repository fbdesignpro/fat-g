// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V15 (docs/planning/_archive/M23.md; C35, C37, C48, C50, C51, C54, C80, C88, C89): the composer while a turn
// runs — Send now and Queue in Send's place, the preference's at Send's own place on Enter and the
// other as a full secondary button to its left on Ctrl+Enter, each tooltip saying when its message arrives; Queue alone with
// Plan pressed, a skill chosen, or a CLI that never takes a message during a turn, a line above it
// saying why — and the queue's rows under the input: the first line, the images counted, "Sending…",
// Edit and Remove, a move by Alt+Down, a held Send now's tag, and a paused queue's reason with Resume.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BusyEnter, type ChatComposer, COMPOSER_WORDS, EMPTY_COMPOSER, NO_INTENT, type QueuedMessage, type SteerState } from '@shared/contracts/composer';
import type { InvokeChannel } from '@shared/ipc/channels';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { setDraft, useChatDrafts } from '../chat-store';
import { Composer } from '../Composer';
import { chooseCommand, takeComposer } from './composer-store';

const ID = '11111111-1111-4111-8111-111111111111';
let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  useChatDrafts.setState({ drafts: {} });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: { status: 'saved', draft: EMPTY_COMPOSER.draft } });
  });
});
afterEach(cleanup);

const entry = (id: string, text: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, text, intent: NO_INTENT, attachments: [], queuedAt: 1, sending: false, now: false, ...patch });
const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); });

function show(options: { readonly steer?: SteerState; readonly busyEnter?: BusyEnter; readonly planPressed?: boolean; readonly composer?: Partial<ChatComposer> } = {}) {
  takeComposer(ID, 1, { ...EMPTY_COMPOSER, steer: options.steer ?? 'open', ...options.composer });
  const onSendNow = vi.fn(() => Promise.resolve(true));
  render(<Composer sessionId={ID} providerName="Codex" running loading={false} ready onSend={() => Promise.resolve(true)} onStop={() => undefined} problem={null} onSendNow={onSendNow} busyEnter={options.busyEnter ?? 'send-now'} planPressed={options.planPressed ?? false} />);
  return { onSendNow, input: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Codex' }) };
}

const primary = () => document.querySelector<HTMLButtonElement>('[data-primary]') as HTMLButtonElement;
const queued = () => requests.filter(([channel]) => channel === 'chat:queue').map(([, request]) => request);

describe('the busy actions (V15; C35, C37, C80, C88)', () => {
  it('puts Queue beside Send now as a full secondary button, keeping Send now on Enter by default', async () => {
    const s = show();
    act(() => { setDraft(ID, 'Also the tests'); });
    expect(primary().textContent).toBe(COMPOSER_WORDS.sendNow);
    expect(primary().title).toBe('Send now (Enter): added to the current reply at the first opportunity');
    const other = screen.getByRole('button', { name: COMPOSER_WORDS.queue });
    expect(other.title).toBe('Queue (Ctrl+Enter): sent once the current reply and its sub-agents are done');
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(other.className).toBe(stop.className);
    expect([...primary().parentElement!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([COMPOSER_WORDS.queue, COMPOSER_WORDS.sendNow, 'Stop']);
    fireEvent.keyDown(s.input, { key: 'Enter' });
    await settle();
    expect(s.onSendNow).toHaveBeenCalledOnce();
    act(() => { setDraft(ID, 'And then this'); });
    fireEvent.keyDown(s.input, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(queued()).toEqual([expect.objectContaining({ sessionId: ID, op: 'append', prompt: 'And then this' })]);
    act(() => { setDraft(ID, 'Queue by button'); });
    fireEvent.click(other);
    await settle();
    expect(queued().at(-1)).toEqual(expect.objectContaining({ sessionId: ID, op: 'append', prompt: 'Queue by button' }));
  });

  it('swaps the two when Enter queues', async () => {
    const s = show({ busyEnter: 'queue' });
    act(() => { setDraft(ID, 'Later'); });
    expect(primary().textContent).toBe(COMPOSER_WORDS.queue);
    expect(primary().title).toBe('Queue (Enter): sent once the current reply and its sub-agents are done');
    const other = screen.getByRole('button', { name: COMPOSER_WORDS.sendNow });
    expect(other.title).toBe('Send now (Ctrl+Enter): added to the current reply at the first opportunity');
    expect(other.className).toBe(screen.getByRole('button', { name: 'Stop' }).className);
    expect([...primary().parentElement!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([COMPOSER_WORDS.sendNow, COMPOSER_WORDS.queue, 'Stop']);
    fireEvent.keyDown(s.input, { key: 'Enter' });
    await settle();
    expect(queued()).toHaveLength(1);
    act(() => { setDraft(ID, 'Now'); });
    fireEvent.keyDown(s.input, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(s.onSendNow).toHaveBeenCalledOnce();
    act(() => { setDraft(ID, 'Send by button'); });
    fireEvent.click(other);
    await settle();
    expect(s.onSendNow).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['with Plan pressed', { planPressed: true }, false, 'plan'],
    ['with a skill chosen', {}, true, 'skill'],
    ['where the CLI never takes a message during a turn', { steer: 'unsupported' }, false, 'unsupported'],
  ] as const)('stands Queue alone %s, says why above it, and no key sends now', async (_name, options, skill, cause) => {
    const s = show(options);
    act(() => { setDraft(ID, 'Later'); });
    if (skill) act(() => { chooseCommand(ID, { name: 'review', description: '', hint: null, group: 'skills', selector: 'a'.repeat(16) }); });
    expect(primary().textContent).toBe(COMPOSER_WORDS.queue);
    expect(screen.queryByRole('button', { name: COMPOSER_WORDS.sendNow })).toBeNull();
    // The line stands above Queue, and is what Queue's description reads.
    const line = document.querySelector('[data-withheld]');
    expect(line?.getAttribute('data-withheld')).toBe(cause);
    expect(line?.textContent).toBe(COMPOSER_WORDS.withheld(cause, 'Codex'));
    expect(document.getElementById(primary().getAttribute('aria-describedby') ?? '')).toBe(line);
    fireEvent.keyDown(s.input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(s.input, { key: 'Enter' });
    await settle();
    expect(s.onSendNow).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
  });

  it('offers Send now while the turn takes no message this instant, which main holds, and says no line', () => {
    show({ steer: 'wait' });
    expect(primary().textContent).toBe(COMPOSER_WORDS.sendNow);
    expect(document.querySelector('[data-withheld]')).toBeNull();
    expect(primary().hasAttribute('aria-describedby')).toBe(false);
  });

  it('takes the line away at once when its cause lifts', () => {
    show({ steer: 'unsupported' });
    expect(document.querySelector('[data-withheld]')).not.toBeNull();
    act(() => { takeComposer(ID, 2, { ...EMPTY_COMPOSER, steer: 'open' }); });
    expect(document.querySelector('[data-withheld]')).toBeNull();
    expect(primary().textContent).toBe(COMPOSER_WORDS.sendNow);
  });
});

describe('the queue’s rows (V9; C48, C50, C51, C54, C89)', () => {
  const image = { id: 'u1', hash: 'a'.repeat(64), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1, name: null };

  it('draws each entry’s first line, its images counted, and Sending… on the one being sent, which takes no Edit or Remove', () => {
    show({ composer: { queue: { entries: [entry('e1', 'First line\nsecond line', { sending: true }), entry('e2', 'Next', { attachments: [image, image] })], paused: null } } });
    const rows = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['First line, Sending…', 'Next, +2 images']);
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: COMPOSER_WORDS.edit })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: COMPOSER_WORDS.remove })).toBeTruthy();
  });

  it('removes, edits, and moves a row by Alt+Down, each asked of main', async () => {
    show({ composer: { queue: { entries: [entry('e1', 'A'), entry('e2', 'B'), entry('e3', 'C')], paused: null } } });
    const rows = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem');
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown', altKey: true });
    fireEvent.click(within(rows[2] as HTMLElement).getByRole('button', { name: COMPOSER_WORDS.remove }));
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: COMPOSER_WORDS.edit }));
    await settle();
    // The order main answers with brings the focused row into the rows' view.
    const shown: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(function (this: HTMLElement) { shown.push(this.getAttribute('data-queue-entry') ?? ''); }), configurable: true });
    (rows[0] as HTMLElement).focus();
    act(() => { takeComposer(ID, 2, { ...EMPTY_COMPOSER, steer: 'open', queue: { entries: [entry('e2', 'B'), entry('e1', 'A'), entry('e3', 'C')], paused: null } }); });
    expect(shown).toEqual(['e1']);
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    expect(requests).toEqual(expect.arrayContaining([
      ['chat:queue', { sessionId: ID, op: 'reorder', ids: ['e2', 'e1', 'e3'] }],
      ['chat:unqueue', { sessionId: ID, entryId: 'e3' }],
      ['chat:editQueued', expect.objectContaining({ sessionId: ID, entryId: 'e2' })],
    ]));
  });

  it('tags a held Send now, which stays first: it is not moved, and no row passes it', () => {
    show({ composer: { queue: { entries: [entry('e1', 'Now', { now: true }), entry('e2', 'B'), entry('e3', 'C')], paused: null } } });
    const rows = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([`${COMPOSER_WORDS.heldLabel}, Now`, 'B', 'C']);
    expect(rows[0]?.hasAttribute('data-held')).toBe(true);
    expect(within(rows[0] as HTMLElement).getByText(COMPOSER_WORDS.held)).toBeTruthy();
    // Edit and Remove stay on it.
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: COMPOSER_WORDS.remove })).toBeTruthy();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(rows[2] as HTMLElement, { key: 'ArrowUp', altKey: true });
    expect(requests.filter(([channel]) => channel === 'chat:queue')).toEqual([['chat:queue', { sessionId: ID, op: 'reorder', ids: ['e1', 'e3', 'e2'] }]]);
  });

  it('says why a paused queue stopped, in the send’s words, and Resume asks main', async () => {
    show({ composer: { queue: { entries: [entry('e1', 'Plan this')], paused: { reason: 'plans-unavailable' } } } });
    expect(screen.getByText(new RegExp(COMPOSER_WORDS.paused))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: COMPOSER_WORDS.resume }));
    await settle();
    expect(requests).toContainEqual(['chat:resumeQueue', { sessionId: ID }]);
  });
});
