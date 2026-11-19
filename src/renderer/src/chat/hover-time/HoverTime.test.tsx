// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import { usePrefs } from '../../state/prefs-store';
import { chatItem } from '../../test/chat';
import { prefsSnapshot } from '../../test/prefs';
import { formatDateTime, formatTimeOfDay } from '../../ui/format';
import { Message } from '../Message';
import { HoverTimeHost } from './HoverTime';
import { HoverTimeHostContext } from './sources';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = Date.parse('2020-02-27T14:03:00Z');
const item = chatItem(ID, 'assistant', 'First paragraph.\n\nSecond paragraph.', { time: { receivedAt: AT, providerAt: null } });
const drawMessage = (message = item) => <Message item={message} modelName="Model" providerName="Codex" current named={false} />;
const frames = new Map<number, FrameRequestCallback>();
let serial = 0;

beforeEach(() => {
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); });
const sources = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-time-source]')];

describe('message time sources', () => {
  it('preserves block elements and a selection while the option changes', () => {
    const view = render(<HoverTimeHostContext value={false}>{drawMessage()}</HoverTimeHostContext>);
    const blocks = [...view.container.querySelectorAll('[data-md-block]')];
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(blocks[1]!);
    selection.addRange(range);
    view.rerender(<HoverTimeHostContext value>{drawMessage()}</HoverTimeHostContext>);
    expect([...view.container.querySelectorAll('[data-md-block]')]).toEqual(blocks);
    expect(selection.toString()).toBe('Second paragraph.');
    selection.removeAllRanges();
  });

  it('adds block sources only in the main host, without inline times or a header row', () => {
    const off = render(drawMessage());
    expect(sources(off.container)).toHaveLength(0);
    expect(screen.getByRole('article').hasAttribute('data-hover-time-at')).toBe(false);
    off.unmount();
    const on = render(<HoverTimeHostContext value>{drawMessage()}</HoverTimeHostContext>);
    const article = screen.getByRole('article');
    expect(article.getAttribute('data-hover-time-at')).toBe(String(AT));
    expect(article.title).toBe(formatDateTime(AT));
    expect(article.querySelector('time')).toBeNull();
    expect(article.firstElementChild?.getAttribute('data-head')).toBe('bare');
    expect(article.children[1]?.textContent).toBe('First paragraph.Second paragraph.');
    expect(sources(on.container).map((source) => source.dataset.timeSource)).toEqual(['message', 'block', 'block']);
    expect(article.querySelectorAll('[data-md-block]')).toHaveLength(2);
    expect(article.textContent).toContain('First paragraph.Second paragraph.');
  });

  it('preserves a plain prompt and its copy action, using one message source', async () => {
    const text = 'one  *literal*\n\ntwo\n  three';
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    const view = render(<HoverTimeHostContext value>{drawMessage(chatItem(ID, 'user', text, { time: item.time }))}</HoverTimeHostContext>);
    expect(sources(view.container).map((source) => source.dataset.timeSource)).toEqual(['message']);
    expect(screen.getByRole('article').querySelector('p')?.textContent).toBe(text);
    expect(screen.getByRole('article').children[1]?.textContent).toBe(text);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: CHAT_LINES.copyMessage })); await Promise.resolve(); });
    expect(write).toHaveBeenCalledWith(text);
  });

  it('uses history provenance once, invents no missing time, and leaves notices unchanged', () => {
    const imported = { ...item, time: { receivedAt: null, providerAt: AT } };
    const view = render(<HoverTimeHostContext value><Message item={imported} modelName="Model" providerName="Codex" firstOfTurn /></HoverTimeHostContext>);
    expect(screen.getByRole('article').title).toContain(CHAT_LINES.providerTime('Codex'));
    view.rerender(<HoverTimeHostContext value>{drawMessage(imported)}</HoverTimeHostContext>);
    expect(sources(view.container)).toHaveLength(0);
    view.rerender(<HoverTimeHostContext value>{drawMessage({ ...item, time: { receivedAt: null, providerAt: null } })}</HoverTimeHostContext>);
    expect(sources(view.container)).toHaveLength(0);
    view.rerender(<HoverTimeHostContext value>{drawMessage(chatItem(ID, 'notice', 'Notice', { notice: 'turn-failed', time: item.time }))}</HoverTimeHostContext>);
    expect(sources(view.container)).toHaveLength(0);
  });
});

describe('the gutter host', () => {
  it('positions a CSS-revealed keyboard source, responds to scrolling and clears on removal or disabling', async () => {
    const view = render(<div><HoverTimeHost><div data-chat-list="" tabIndex={0}>{drawMessage()}</div></HoverTimeHost></div>);
    const list = view.container.querySelector<HTMLElement>('[data-chat-list]')!;
    const layer = view.container.querySelector<HTMLElement>('[data-hover-time-layer]')!;
    const row = layer.querySelector<HTMLElement>('[data-hover-time-row]')!;
    const label = layer.querySelector('time')!;
    const source = sources(view.container).find((one) => one.dataset.timeSource === 'block')!;
    const second = sources(view.container).filter((one) => one.dataset.timeSource === 'block')[1]!;
    layer.style.setProperty('--space-2', '8px');
    source.style.setProperty('--hover-time-visible', '1');
    const paragraph = source.parentElement!.nextElementSibling as HTMLElement;
    paragraph.style.fontSize = '16px';
    paragraph.style.lineHeight = '24px';
    paragraph.style.fontFamily = 'sans-serif';
    const nextParagraph = second.parentElement!.nextElementSibling as HTMLElement;
    nextParagraph.style.fontSize = '24px';
    nextParagraph.style.lineHeight = '32px';
    let sourceTop = 120;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === layer) return new DOMRect(0, 0, 1000, 600);
      if (this === row) return new DOMRect(0, 0, 42, 24);
      if (this === source) return new DOMRect(0, sourceTop, 0, 0);
      if (this === second) return new DOMRect(0, 260, 0, 0);
      if (this === list) return new DOMRect(200, 10, 800, 500);
      return new DOMRect(216, 0, 700, 500);
    });
    vi.spyOn(source, 'getClientRects').mockReturnValue([new DOMRect(0, 120, 0, 0)] as unknown as DOMRectList);
    // jsdom has no CSS :focus-within propagation; expose the keyboard candidate at this DOM boundary.
    const query = view.container.firstElementChild!.querySelector.bind(view.container.firstElementChild!);
    vi.spyOn(view.container.firstElementChild!, 'querySelector').mockImplementation((selector: string) => /:hover|:focus/.test(selector) ? query('[data-hover-time-at]') : query(selector));
    flush();
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe(formatTimeOfDay(AT));
    expect(label.dateTime).toBe(new Date(AT).toISOString());
    expect([row.style.left, row.style.top]).toEqual(['208px', '120px']);
    expect([row.style.fontSize, row.style.lineHeight, row.style.fontFamily]).toEqual(['16px', '24px', 'sans-serif']);
    expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('M');
    // Pointer intent wins even when keyboard focus has revealed every block of this message.
    second.style.setProperty('--hover-time-visible', '1');
    const pointerSelector = '[data-md-control]:hover, [data-md-control]:has(+ :hover)';
    const firstMatches = source.parentElement!.matches.bind(source.parentElement!);
    const secondMatches = second.parentElement!.matches.bind(second.parentElement!);
    vi.spyOn(source.parentElement!, 'matches').mockImplementation((selector) => selector === pointerSelector ? false : firstMatches(selector));
    let overSecond = true;
    vi.spyOn(second.parentElement!, 'matches').mockImplementation((selector) => selector === pointerSelector ? overSecond : secondMatches(selector));
    vi.spyOn(second, 'getClientRects').mockReturnValue([new DOMRect(0, 260, 0, 0)] as unknown as DOMRectList);
    fireEvent.pointerOver(second.parentElement!.nextElementSibling!);
    flush();
    expect(label.hidden).toBe(false);
    expect(row.style.top).toBe('260px');
    expect([row.style.fontSize, row.style.lineHeight]).toEqual(['24px', '32px']);
    overSecond = false;
    sourceTop = -1;
    fireEvent.scroll(list);
    flush();
    expect(label.hidden).toBe(true);
    sourceTop = 150;
    fireEvent(window, new Event('resize'));
    flush();
    expect(row.style.top).toBe('150px');
    // A conversation switch removes its old registrations before the next geometry refresh.
    await act(async () => { view.rerender(<div><HoverTimeHost><div data-chat-list="" tabIndex={0} /></HoverTimeHost></div>); await Promise.resolve(); });
    flush();
    expect(label.hidden).toBe(true);
    view.rerender(<div><HoverTimeHost><div data-chat-list="" tabIndex={0}>{drawMessage()}</div></HoverTimeHost></div>);
    act(() => usePrefs.setState({ snapshot: prefsSnapshot({ chat: { ...prefsSnapshot().values.chat, hoverMessageTimes: false } }) }));
    expect(view.container.querySelector('[data-hover-time-layer]')).toBeNull();
    expect(sources(view.container)).toHaveLength(0);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});
