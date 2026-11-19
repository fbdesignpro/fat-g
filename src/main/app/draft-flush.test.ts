// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7 (docs/planning/_archive/M23.md; C31): the page's unsent drafts, asked for before the Main page goes — at
// its window's close and at the quit — and waited for a bounded time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftFlush, DRAFT_FLUSH_WAIT_MS } from './draft-flush';

afterEach(() => { vi.useRealTimers(); });

describe('the draft flush', () => {
  it('resolves once the page answers its ask, and a second answer finds nothing open', async () => {
    const asked: number[] = [];
    const flush = createDraftFlush({ ask: (token) => { asked.push(token); return true; } });
    let done = false;
    const flushing = flush.flush().then(() => { done = true; });
    expect(asked).toEqual([1]);
    await Promise.resolve();
    expect(done).toBe(false);
    expect(flush.flushed(1)).toBe(true);
    await flushing;
    expect(done).toBe(true);
    expect(flush.flushed(1)).toBe(false);
    // A token never asked answers nothing.
    expect(flush.flushed(7)).toBe(false);
  });

  it('resolves at once where there is no page to ask, or the ask throws', async () => {
    await createDraftFlush({ ask: () => false }).flush();
    await createDraftFlush({ ask: () => { throw new Error('gone'); } }).flush();
  });

  it('resolves once the wait is over, though the page never answers, and its late answer finds nothing open', async () => {
    vi.useFakeTimers();
    const flush = createDraftFlush({ ask: () => true });
    let done = false;
    void flush.flush().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(DRAFT_FLUSH_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(flush.flushed(1)).toBe(false);
  });

  it('holds the Main window’s close while the page is asked, then closes it again, which passes', async () => {
    let answer: (() => void) | undefined;
    const flush = createDraftFlush({ ask: (token) => { answer = () => { flush.flushed(token); }; return true; } });
    const first = { preventDefault: vi.fn() };
    const close = vi.fn();
    flush.mainClose(first, close);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    // A second close while the ask is open is held too, and asks nothing more.
    const repeated = { preventDefault: vi.fn() };
    flush.mainClose(repeated, close);
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    answer?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    // The close that comes back passes; the one after it asks again.
    const again = { preventDefault: vi.fn() };
    flush.mainClose(again, close);
    expect(again.preventDefault).not.toHaveBeenCalled();
    const later = { preventDefault: vi.fn() };
    flush.mainClose(later, close);
    expect(later.preventDefault).toHaveBeenCalledOnce();
  });

  it('closes at once where the page cannot be asked', async () => {
    const flush = createDraftFlush({ ask: () => false });
    const close = vi.fn();
    flush.mainClose({ preventDefault: vi.fn() }, close);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
