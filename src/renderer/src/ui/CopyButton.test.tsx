// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14 (docs/planning/_archive/M19.md; C38–C40): the Copy button by itself — what it writes, what it says for
// a moment, what it announces, and what it does when the clipboard refuses.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY_ANNOUNCED, COPY_SAID_MS, COPY_WORDS, CopyButton } from './CopyButton';

let written: string[];
let refuse: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  written = [];
  refuse = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => (refuse ? Promise.reject(new Error('denied')) : (written.push(text), Promise.resolve())) } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = () => screen.getByRole('button', { name: 'Copy message' });
const press = () => act(async () => { fireEvent.click(button()); await Promise.resolve(); await Promise.resolve(); });

describe('the Copy button (V14)', () => {
  it('is a button named for what it copies, reading Copy, with nothing announced before it is pressed', () => {
    render(<CopyButton label="Copy message" text={() => 'the text'} />);
    expect(button().textContent).toBe(COPY_WORDS.copy);
    expect(button().getAttribute('type')).toBe('button');
    expect(button().getAttribute('title')).toBe('Copy message');
    expect(screen.getByRole('status').textContent).toBe('');
    // A stop in the tab order unless told otherwise.
    expect(button().hasAttribute('tabindex')).toBe(false);
  });

  it('writes plain text, the text it is asked for at the press, and says for a moment that it copied', async () => {
    let text = 'as it is now';
    render(<CopyButton label="Copy message" text={() => text} />);
    text = 'as it is at the press';
    await press();
    expect(written).toEqual(['as it is at the press']);
    expect(button().textContent).toBe(COPY_WORDS.copied);
    expect(screen.getByRole('status').textContent).toBe(COPY_ANNOUNCED.copied);
    expect(button().closest('[data-copy]')?.getAttribute('data-copy')).toBe('copied');
    // For a moment: then it reads Copy again, and says nothing.
    act(() => { vi.advanceTimersByTime(COPY_SAID_MS - 1); });
    expect(button().textContent).toBe(COPY_WORDS.copied);
    act(() => { vi.advanceTimersByTime(1); });
    expect(button().textContent).toBe(COPY_WORDS.copy);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says that it could not, and announces it, when the clipboard refuses', async () => {
    refuse = true;
    render(<CopyButton label="Copy message" text={() => 'x'} />);
    await press();
    expect(written).toEqual([]);
    expect(button().textContent).toBe(COPY_WORDS.failed);
    expect(screen.getByRole('status').textContent).toBe(COPY_ANNOUNCED.failed);
    // The next press may work: it is tried again.
    refuse = false;
    await press();
    expect(written).toEqual(['x']);
    expect(button().textContent).toBe(COPY_WORDS.copied);
  });

  it('drawn as an icon, holds no word and no element, and shows its name at once in place of a title (the maintainer)', async () => {
    render(<CopyButton look="icon" label="Copy message" text={() => 'the text'} />);
    expect([button().textContent, button().childNodes.length, button().hasAttribute('title')]).toEqual(['', 0, false]);
    const tip = () => document.querySelector('[data-name-tip]')?.textContent ?? null;
    expect(tip()).toBeNull();
    fireEvent.pointerEnter(button());
    expect(tip()).toBe('Copy message');
    fireEvent.pointerLeave(button());
    expect(tip()).toBeNull();
    // Pressed, it says what became of the copy as the word does: by its state, its name and its announcement.
    await press();
    expect(written).toEqual(['the text']);
    expect(button().closest('[data-copy]')?.getAttribute('data-copy')).toBe('copied');
    expect(screen.getByRole('status').textContent).toBe(COPY_ANNOUNCED.copied);
    act(() => button().focus());
    expect(tip()).toBe(COPY_WORDS.copied);
    act(() => { vi.advanceTimersByTime(COPY_SAID_MS); });
    expect([button().closest('[data-copy]')?.getAttribute('data-copy'), tip()]).toEqual(['idle', 'Copy message']);
  });

  it('takes its place in the tab order from its owner, and stays a button either way', () => {
    render(<CopyButton label="Copy message" text={() => 'x'} tabIndex={-1} />);
    expect(button().tabIndex).toBe(-1);
  });

  it('waits for an asynchronous transcript before writing it and reporting success', async () => {
    let finish!: (text: string) => void;
    render(<CopyButton look="conversation" label="Copy message" text={() => new Promise<string>((resolve) => { finish = resolve; })} />);
    await press();
    expect(written).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => { finish('The entire transcript.'); await Promise.resolve(); });
    expect(written).toEqual(['The entire transcript.']);
    expect(screen.getByRole('status').textContent).toBe(COPY_ANNOUNCED.copied);
  });

  it('shows the conversation tooltip above its button', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 200, left: 100, top: 200, right: 116, bottom: 212, width: 16, height: 12, toJSON: () => ({}) });
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20);
    render(<CopyButton look="conversation" label="Copy message" text={() => 'text'} />);
    fireEvent.pointerEnter(button());
    expect((document.querySelector('[data-name-tip]') as HTMLElement).style.top).toBe('168px');
    bounds.mockRestore();
    width.mockRestore();
    height.mockRestore();
  });

  it('leaves the clipboard alone and reports failure when a transcript cannot be read', async () => {
    render(<CopyButton look="conversation" label="Copy message" text={() => Promise.reject(new Error('read failed'))} />);
    await press();
    expect(written).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe(COPY_ANNOUNCED.failed);
  });
});
