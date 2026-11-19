// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10 (docs/planning/_archive/M23.md; C58, C59, C64–C67, C87): the command menu — opened by a leading `/` alone,
// read from main as it opens, filtered by the typed prefix, Up/Down and Enter or a click choosing a row
// that puts `/name ` at the draft's start, Escape closing it; a skill bound to the draft by main's
// selector and let go once its name is edited away; plain text for a row with no selector; rows drawn
// as text; and a labelled listbox whose count is said once.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandRow, MENU_WORDS } from '@shared/contracts/composer';
import type { InvokeChannel } from '@shared/ipc/channels';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { draftOf, useChatDrafts } from '../chat-store';
import { Announcer } from '../../ui/Announcer';
import { Composer } from '../Composer';
import { composerOf } from './composer-store';

const ID = '11111111-1111-4111-8111-111111111111';
let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
const ROWS: CommandRow[] = [
  { name: 'clear', description: MENU_WORDS.own['command-clear'], hint: null, group: 'fat-g', selector: null },
  { name: 'compact', description: 'Compact <b>the</b> conversation', hint: '[instructions]', group: 'commands', selector: null },
  { name: 'review', description: null, hint: null, group: 'commands', selector: null },
  { name: 'marker', description: 'A skill', hint: null, group: 'skills', selector: 'a'.repeat(32) },
];

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  useChatDrafts.setState({ drafts: {} });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (channel === 'chat:commands') return Promise.resolve({ ok: true, value: { status: 'read', rows: ROWS, note: null } });
    return Promise.resolve({ ok: true, value: { status: 'saved', draft: { revision: 0, text: '', intent: { plan: false, skill: null }, attachments: [] } } });
  });
});
afterEach(cleanup);

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); });

function show() {
  render(<><Announcer /><Composer sessionId={ID} providerName="Claude" running={false} loading={false} ready onSend={() => Promise.resolve(true)} onStop={() => undefined} problem={null} /></>);
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

const options = () => within(screen.getByRole('listbox', { name: MENU_WORDS.label })).getAllByRole('option');

describe('the command menu (V10; C58, C59, C65–C67)', () => {
  it('opens on a leading / alone, read from main, its rows as text in main’s order, and its count said once', async () => {
    const input = show();
    fireEvent.change(input, { target: { value: 'not /a command' } });
    await settle();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '/' } });
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:commands')).toEqual([['chat:commands', { sessionId: ID }]]);
    expect(options().map((option) => option.textContent)).toEqual([`/clear${MENU_WORDS.own['command-clear']}`, '/compact[instructions]Compact <b>the</b> conversation', '/review', `${MENU_WORDS.skills}/markerA skill`]);
    expect(document.querySelector('[data-command-menu] b')).toBeNull();
    expect(document.body.textContent).toContain(MENU_WORDS.count(4));
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('filters by the typed prefix, and chooses with Down and Enter, putting /name at the start', async () => {
    const input = show();
    fireEvent.change(input, { target: { value: '/' } });
    await settle();
    fireEvent.change(input, { target: { value: '/c' } });
    expect(options().map((option) => option.querySelector('span')?.textContent)).toEqual(['/clear', '/compact']);
    // The row reached is brought into the menu's view, a long list scrolling to it.
    const shown: string[] = [];
    const scroll = vi.fn(function (this: HTMLElement) { shown.push(this.id); });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scroll, configurable: true });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(shown.at(-1)).toBe(options()[1]?.id);
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(draftOf(ID)).toBe('/compact ');
    expect(screen.queryByRole('listbox')).toBeNull();
    // A command chosen is text: no skill is bound.
    expect(composerOf(ID).intent.skill).toBeNull();
  });

  it('binds a chosen skill by main’s selector, and lets it go once its name is edited away', async () => {
    const input = show();
    fireEvent.change(input, { target: { value: '/ma' } });
    await settle();
    fireEvent.mouseDown(options()[0] as HTMLElement);
    expect(draftOf(ID)).toBe('/marker ');
    expect(composerOf(ID).intent.skill).toEqual({ name: 'marker', selector: 'a'.repeat(32) });
    fireEvent.change(input, { target: { value: '/marker and the notes' } });
    expect(composerOf(ID).intent.skill).toEqual({ name: 'marker', selector: 'a'.repeat(32) });
    fireEvent.change(input, { target: { value: '/marke and the notes' } });
    expect(composerOf(ID).intent.skill).toBeNull();
  });

  it('closes on Escape, sending nothing, and opens again with the next change', async () => {
    const input = show();
    fireEvent.change(input, { target: { value: '/re' } });
    await settle();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(requests.filter(([channel]) => channel === 'chat:send')).toEqual([]);
    fireEvent.change(input, { target: { value: '/rev' } });
    await settle();
    expect(options().map((option) => option.querySelector('span')?.textContent)).toEqual(['/review']);
  });

  it('says no row matches where the prefix leaves none, and that nothing is listed where the list is empty', async () => {
    const input = show();
    fireEvent.change(input, { target: { value: '/zz' } });
    await settle();
    expect(screen.getByText(MENU_WORDS.none)).toBeTruthy();
    expect(screen.queryByText(MENU_WORDS.empty)).toBeNull();
    cleanup();
    useChatDrafts.setState({ drafts: {} });
    bridge.setInvoke((channel) => Promise.resolve(channel === 'chat:commands' ? { ok: true, value: { status: 'read', rows: [], note: null } } : { ok: true, value: {} }));
    const other = show();
    fireEvent.change(other, { target: { value: '/' } });
    await settle();
    expect(screen.getByText(MENU_WORDS.empty)).toBeTruthy();
    expect(screen.queryByText(MENU_WORDS.none)).toBeNull();
  });
});
