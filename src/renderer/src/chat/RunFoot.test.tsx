// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An answer's foot by itself (the maintainer): what it says of the answer's time, and
// what its Copy button copies. Its place in the list, and when it is a stop, are MessageList's tests.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import { chatItem } from '../test/chat';
import { formatDayTime, formatTimeOfDay } from '../ui/format';
import { RunFoot, type RunTimes, runTimeLine, useRunOver } from './RunFoot';
import { RUN_OVER_ATTRIBUTE } from './run-over';

const at = (day: number, hours: number, minutes: number, seconds = 0): number => new Date(2020, 0, day + 22, hours, minutes, seconds).getTime();
const SINCE = at(30, 8, 53);
const END = at(30, 8, 55, 32);
const NOW = at(30, 9, 0, 32);
const ended: RunTimes = { running: false, since: SINCE, endedAt: END, elapsedMs: 152_000 };

describe('runTimeLine', () => {
  it('says when an answer ran, for how long, and how long ago it completed', () => {
    expect(runTimeLine(ended, NOW)).toBe(`${formatTimeOfDay(SINCE)} → ${formatTimeOfDay(END)} (2m32s) · completed 5 minutes ago`);
  });

  it('says while it runs when it started, and how long ago', () => {
    expect(runTimeLine({ running: true, since: SINCE, endedAt: null, elapsedMs: null }, NOW)).toBe(`${formatTimeOfDay(SINCE)} · started 7 minutes ago`);
  });

  it('dates a time of another day, and the end by its time alone on its start’s day', () => {
    const since = at(29, 23, 58);
    expect(runTimeLine({ ...ended, since, endedAt: at(30, 0, 1) }, NOW)).toBe(`${formatDayTime(since, NOW)} → ${formatTimeOfDay(at(30, 0, 1))} (2m32s) · completed 8 hours ago`);
    expect(runTimeLine({ ...ended, since: at(28, 8, 53), endedAt: at(28, 8, 55, 32) }, NOW)).toBe(`${formatDayTime(at(28, 8, 53), NOW)} → ${formatTimeOfDay(at(28, 8, 55, 32))} (2m32s) · completed 2 days ago`);
    // No year in this year's dates (the maintainer).
    expect(runTimeLine({ ...ended, since: at(28, 8, 53), endedAt: at(28, 8, 55, 32) }, NOW)).not.toContain('2020');
  });

  it('says only what is known: no end for a turn that never gave one, no duration where none was measured, nothing at all for nothing', () => {
    expect(runTimeLine({ running: false, since: SINCE, endedAt: null, elapsedMs: null }, NOW)).toBe(formatTimeOfDay(SINCE));
    expect(runTimeLine({ ...ended, elapsedMs: null }, NOW)).toBe(`${formatTimeOfDay(SINCE)} → ${formatTimeOfDay(END)} · completed 5 minutes ago`);
    expect(runTimeLine({ ...ended, since: null }, NOW)).toBe(`${formatTimeOfDay(END)} (2m32s) · completed 5 minutes ago`);
    expect(runTimeLine({ running: false, since: null, endedAt: null, elapsedMs: null }, NOW)).toBeNull();
    expect(runTimeLine({ running: true, since: null, endedAt: null, elapsedMs: null }, NOW)).toBeNull();
  });
});

describe('RunFoot', () => {
  const written: string[] = [];
  beforeEach(() => {
    written.length = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  const parts = [chatItem('c', 'assistant', 'Let me look.', { phase: 'commentary' }), chatItem('c', 'assistant', 'The tides are in **tides.js**.')];
  const copyAll = () => screen.getByRole('button', { name: CHAT_LINES.copyAnswer });

  it('copies every part of the answer’s text, in order, a blank line between two', async () => {
    render(<RunFoot messages={parts} current={false} {...ended} />);
    await act(async () => { fireEvent.click(copyAll()); await Promise.resolve(); });
    expect(written).toEqual(['Let me look.\n\nThe tides are in **tides.js**.']);
  });

  it('is a stop only while its answer holds the keyboard’s current entry', () => {
    const { rerender } = render(<RunFoot messages={parts} current={false} {...ended} />);
    expect(copyAll().tabIndex).toBe(-1);
    rerender(<RunFoot messages={parts} current {...ended} />);
    expect(copyAll().tabIndex).toBe(0);
  });

  it('offers the conversation immediately left of the message, with the same keyboard access', async () => {
    const read = vi.fn(() => Promise.resolve('You:\n\nQuestion\n\nAssistant:\n\nAnswer'));
    const { rerender } = render(<RunFoot messages={parts} copyConversation={read} current={false} {...ended} />);
    const conversation = screen.getByRole('button', { name: CHAT_LINES.copyConversation });
    expect(screen.getAllByRole('button')).toEqual([conversation, copyAll()]);
    expect(conversation.tabIndex).toBe(-1);
    expect(read).not.toHaveBeenCalled();
    rerender(<RunFoot messages={parts} copyConversation={read} current {...ended} />);
    expect(conversation.tabIndex).toBe(0);
    await act(async () => { fireEvent.click(conversation); await Promise.resolve(); });
    expect(written).toEqual(['You:\n\nQuestion\n\nAssistant:\n\nAnswer']);
  });

  it('says how long ago anew every half minute, and has no Copy button for an answer with no text, nor a row with nothing to show', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { container, rerender } = render(<RunFoot messages={[]} current={false} {...ended} />);
    expect(container.textContent).toContain('completed 5 minutes ago');
    expect(screen.queryByRole('button')).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.textContent).toContain('completed 6 minutes ago');
    rerender(<RunFoot messages={[]} current={false} running={false} since={null} endedAt={null} elapsedMs={null} />);
    expect(container.querySelector('[data-run-foot]')).toBeNull();
  });
});

/** A list as MessageList lays it out, each child at its `data-top`: a prompt's run, an answer told in two parts with its foot, and a prompt. */
function Harness() {
  const list = useRef<HTMLDivElement>(null);
  useRunOver(list);
  return (
    <div ref={list} data-testid="list">
      <div data-speaker="" data-top="0" />
      <article id="p1" data-top="20"><p>A prompt.</p></article>
      <div id="bar" data-speaker="" data-top="40" />
      <article id="a1" data-top="60"><p>The first part.</p></article>
      <article id="a2" data-top="100"><p>The second part.</p></article>
      <div id="f1" data-run-foot="" data-top="130" />
      <div data-speaker="" data-top="150" />
      <article id="p2" data-top="170"><p>Another prompt.</p></article>
    </div>
  );
}

describe('useRunOver (the maintainer)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('marks an answer’s foot from the top of its bar to the foot, the space between its parts included, and no foot over a prompt’s run', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const top = Number(this.getAttribute('data-top') ?? 0);
      return { x: 0, y: top, top, bottom: top + 20, left: 0, right: 300, width: 300, height: 20, toJSON: () => ({}) };
    });
    render(<Harness />);
    const list = screen.getByTestId('list');
    const marked = () => [...list.querySelectorAll(`[${RUN_OVER_ATTRIBUTE}]`)].map((element) => element.id);
    const move = (target: Element, y: number) => act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: y })); });
    const at = (selector: string) => list.querySelector(selector) as Element;
    move(at('#a1 p'), 65);
    expect(marked()).toEqual(['f1']);
    // The space between its two parts is the list's own: the answer is the part above the pointer's.
    move(list, 90);
    expect(marked()).toEqual(['f1']);
    // Its bar, and the space between its foot and the next bar.
    move(at('#bar'), 45);
    expect(marked()).toEqual(['f1']);
    move(list, 145);
    expect(marked()).toEqual(['f1']);
    // The space above its bar is the prompt's run's, and a prompt's run has no foot.
    move(list, 35);
    expect(marked()).toEqual([]);
    move(at('#a2 p'), 105);
    move(at('#p2 p'), 175);
    expect(marked()).toEqual([]);
    move(at('#a2 p'), 105);
    act(() => { list.dispatchEvent(new MouseEvent('pointerleave')); });
    expect(marked()).toEqual([]);
  });

  it('marks none in the list’s space below its last child, where it holds nothing more', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const top = Number(this.getAttribute('data-top') ?? 0);
      return { x: 0, y: top, top, bottom: top + 20, left: 0, right: 300, width: 300, height: 20, toJSON: () => ({}) };
    });
    render(<Harness />);
    const list = screen.getByTestId('list');
    const foot = list.querySelector('#f1') as Element;
    // The list ends with its foot: within the foot's height it is the answer's; below it, nothing's.
    act(() => { list.querySelector('#p2')?.remove(); list.lastElementChild?.remove(); });
    act(() => { list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 145 })); });
    expect(foot.hasAttribute(RUN_OVER_ATTRIBUTE)).toBe(true);
    act(() => { list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 300 })); });
    expect(foot.hasAttribute(RUN_OVER_ATTRIBUTE)).toBe(false);
  });
});
