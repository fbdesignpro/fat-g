// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The quit gate (docs/planning/_archive/M14.md: V27, V28, and V33's quit question), with a fake app that emits
// Electron's events in its order (src/main/app/lifecycle.ts):
//   the Main window is closed:   close → closed → window-all-closed → before-quit → will-quit
//   app.quit():                  before-quit → close → closed → will-quit
// and the real shutdown behind the gate, so "nothing of the shutdown starts" is checked on it.
import { describe, expect, it, vi } from 'vitest';
import { quitWords, type QuitWords } from '@shared/contracts/quit';
import { createPageWatch, createQuitGate, QUIT_BOX_CONFIRM, quitBoxOptions } from './quit-gate';
import { createShutdown } from './shutdown';

interface Options {
  readonly running?: number;
  readonly working?: number;
  readonly planReady?: number;
  readonly closeQuits?: boolean;
  /** What becomes of the Main page before the test starts. By default it is open, loaded and answering. */
  readonly page?: 'ready' | 'none' | 'loading' | 'crashed' | 'unresponsive';
  /** Runs when the windows have closed: a turn starting just then. */
  readonly onWindowsClosed?: (h: { setRunning(count: number): void }) => void;
}

function setUp({ running: initial = 1, working, planReady = 0, closeQuits = true, page = 'ready', onWindowsClosed }: Options = {}) {
  const log: string[] = [];
  let running = initial;
  const windows = { main: page !== 'none', pet: page !== 'none' };
  const state = { question: false, asked: 0, quit: false };
  const boxes: { readonly words: QuitWords; readonly signal: AbortSignal; answer(quit: boolean): void }[] = [];

  const watch = createPageWatch();
  if (page !== 'none') {
    watch.opened();
    watch.loading();
    if (page !== 'loading') watch.loaded();
    if (page === 'crashed') watch.gone();
    if (page === 'unresponsive') watch.unresponsive();
  }

  const prevented = () => {
    const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    return event;
  };
  const closeWindows = (): void => {
    windows.main = false;
    windows.pet = false; // the Main window's `closed` destroys the Pet
    watch.closed();
    log.push('windows closed');
    onWindowsClosed?.({ setRunning: (count) => { running = count; } });
  };

  const shutdown = createShutdown({
    beginQuit: () => log.push('shutdown: begin'),
    closeAdmission: () => undefined,
    killAll: () => { log.push('shutdown: processes ended'); return Promise.resolve({ ok: true }); },
    // What the sessions' settling does at its end: the running records end as stopped.
    settle: () => { log.push(`shutdown: ${running} turn(s) ended as stopped`); running = 0; return Promise.resolve(); },
    emergency: () => ({ ok: true }),
    resumeQuit: () => app.quit(),
    failure: () => log.push('shutdown: failed'),
  });

  const app = {
    /** `app.quit()`: before-quit, then every window's close, then will-quit. A prevented event stops it. */
    quit(): void {
      const event = prevented();
      log.push('before-quit');
      if (gate.beforeQuit(event)) shutdown.beforeQuit(event);
      if (event.defaultPrevented) return;
      if (windows.main) {
        const close = prevented();
        gate.mainClose(close);
        if (close.defaultPrevented) return;
        closeWindows();
      }
      state.quit = true;
      log.push('will-quit');
    },
    /** The ×, Alt+F4 or the system menu on the Main window. */
    closeMain(): void {
      const close = prevented();
      log.push('close');
      gate.mainClose(close);
      if (close.defaultPrevented) return;
      closeWindows();
      // window-all-closed quits the app everywhere but macOS.
      if (closeQuits) app.quit();
    },
  };

  const gate = createQuitGate({
    running: () => running,
    activity: () => ({ working: working ?? running, planReady }),
    pageCanAsk: () => watch.canAsk(),
    setQuestion: (asked) => { state.question = asked; if (asked) state.asked += 1; },
    askNatively: (words, signal) => new Promise<boolean>((resolve) => { boxes.push({ words, signal, answer: (quit) => resolve(quit) }); }),
    quit: () => app.quit(),
    closeQuits,
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const shutdownStarted = () => log.some((line) => line.startsWith('shutdown'));
  return { app, gate, log, windows, state, boxes, watch, settle, shutdownStarted, setRunning: (count: number) => { running = count; } };
}

// ── V27 ───────────────────────────────────────────────────────────────────────────────────────
describe('asking before a quit (V27; C76, C99, C100, C102)', () => {
  it.each(['closeMain', 'quit'] as const)('asks at %s when a provider only waits for a plan decision', (begin) => {
    const h = setUp({ running: 1, working: 0, planReady: 1 });
    h.app[begin]();
    expect(h.state.question).toBe(true);
    expect(h.windows.main).toBe(true);
    expect(h.shutdownStarted()).toBe(false);
    h.gate.answer(false);
    expect(h.state.quit).toBe(false);
  });

  it('does not add a question when only idle saved plans remain', () => {
    const h = setUp({ running: 0, planReady: 1 });
    h.app.quit();
    expect(h.gate.confirmed).toBe(true);
    expect(h.state.question).toBe(false);
    expect(h.boxes).toHaveLength(0);
  });

  it('uses the same plan reassurance in a native fallback, without warning about active work', () => {
    const h = setUp({ running: 1, working: 0, planReady: 1, page: 'crashed' });
    h.app.quit();
    expect(h.boxes[0]?.words).toEqual(quitWords({ working: 0, planReady: 1 }));
    expect(h.boxes[0]?.words.body).not.toContain('still working');
    expect(h.shutdownStarted()).toBe(false);
  });

  it.each([['the Main window’s close', 'closeMain'], ['app.quit()', 'quit']] as const)('asks at %s while a session runs, before any window closes, and starts nothing of the shutdown', (_name, begin) => {
    const h = setUp();
    h.app[begin]();
    expect(h.state.question).toBe(true);
    expect(h.windows).toEqual({ main: true, pet: true });
    expect(h.shutdownStarted()).toBe(false);
    expect(h.state.quit).toBe(false);
    expect(h.boxes).toHaveLength(0);
  });

  it.each([['the Main window’s close', 'closeMain'], ['app.quit()', 'quit']] as const)('asks nothing at %s when no session runs, and quits', async (_name, begin) => {
    const h = setUp({ running: 0 });
    h.app[begin]();
    await h.settle();
    expect(h.state.asked).toBe(0);
    expect(h.boxes).toHaveLength(0);
    expect(h.state.quit).toBe(true);
  });

  it('keeps every window, source and record as it was after a no, and asks again at the next attempt', async () => {
    const h = setUp();
    h.app.closeMain();
    expect(h.gate.answer(false)).toBe(true);
    await h.settle();
    expect(h.state.question).toBe(false);
    expect(h.windows).toEqual({ main: true, pet: true });
    expect(h.shutdownStarted()).toBe(false);
    expect(h.gate.confirmed).toBe(false);
    h.app.quit();
    expect(h.state.question).toBe(true);
    expect(h.state.asked).toBe(2);
    expect(h.windows.main).toBe(true);
  });

  it.each([['the ×', 'closeMain'], ['the menu’s Quit', 'quit']] as const)('quits after one question on a yes from %s, the records ended before any window closes', async (_name, begin) => {
    const h = setUp({ running: 2 });
    h.app[begin]();
    expect(h.gate.answer(true)).toBe(true);
    await h.settle();
    expect(h.state.quit).toBe(true);
    expect(h.state.asked).toBe(1);
    expect(h.boxes).toHaveLength(0);
    expect(h.state.question).toBe(false);
    const ended = h.log.indexOf('shutdown: 2 turn(s) ended as stopped');
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(h.log.indexOf('windows closed'));
    // The confirmed quit went on through before-quit, and the windows' own close passed the gate.
    expect(h.log.filter((line) => line === 'will-quit')).toHaveLength(1);
  });

  it('does not question at before-quit a close that passed unasked, even if a turn starts just after (C102)', async () => {
    const h = setUp({ running: 0, onWindowsClosed: (app) => app.setRunning(1) });
    h.app.closeMain();
    await h.settle();
    expect(h.state.asked).toBe(0);
    expect(h.boxes).toHaveLength(0);
    expect(h.state.quit).toBe(true);
    // The turn that started with no window left is ended in the drain, like any other.
    expect(h.log).toContain('shutdown: 1 turn(s) ended as stopped');
  });

  it('refuses an answer while no question is asked (C101)', () => {
    const h = setUp();
    expect(h.gate.answer(true)).toBe(false);
    expect(h.state.quit).toBe(false);
    h.app.quit();
    expect(h.gate.answer(false)).toBe(true);
    expect(h.gate.answer(true)).toBe(false);
    expect(h.state.quit).toBe(false);
  });

  it('is asked once more by the question, not by a count: the page takes the number from its own snapshot (C100)', () => {
    const h = setUp({ running: 3 });
    h.app.quit();
    h.setRunning(0);
    // The question stays: with none left it asks only whether to quit.
    expect(h.state.question).toBe(true);
  });

  // V33: a session whose turn has ended while its workers run is still running — the count is the service's.
  it('counts whatever the session service counts as running', () => {
    const waitingOnWorkers = setUp({ running: 1 });
    waitingOnWorkers.app.quit();
    expect(waitingOnWorkers.state.question).toBe(true);
  });
});

// ── V28 ───────────────────────────────────────────────────────────────────────────────────────
describe('the native message box (V28; C103)', () => {
  it.each([
    ['there is no Main window', 'none'],
    ['its page is not loaded', 'loading'],
    ['its page has crashed', 'crashed'],
    ['its page is unresponsive', 'unresponsive'],
  ] as const)('asks when %s, with the page’s words', (_name, page) => {
    const h = setUp({ page, running: 2 });
    h.app.quit();
    expect(h.state.asked).toBe(0);
    expect(h.boxes).toHaveLength(1);
    expect(h.boxes[0]?.words).toEqual(quitWords({ working: 2, planReady: 0 }));
    expect(h.shutdownStarted()).toBe(false);
  });

  it('has Cancel as its default button, and the same words as the page', () => {
    const words = quitWords({ working: 2, planReady: 0 });
    const options = quitBoxOptions(words);
    expect(options.buttons).toEqual([words.cancel, words.confirm]);
    expect(options.buttons[options.defaultId]).toBe('Cancel');
    expect(options.buttons[options.cancelId]).toBe('Cancel');
    expect(options.buttons[QUIT_BOX_CONFIRM]).toBe('Quit');
    expect([options.message, options.detail]).toEqual([words.title, words.body]);
  });

  it('settles the question with its answer: a yes quits, a no keeps everything', async () => {
    const no = setUp({ page: 'crashed' });
    no.app.closeMain();
    no.boxes[0]?.answer(false);
    await no.settle();
    expect(no.state.quit).toBe(false);
    expect(no.windows.main).toBe(true);
    expect(no.shutdownStarted()).toBe(false);

    const yes = setUp({ page: 'crashed' });
    yes.app.closeMain();
    yes.boxes[0]?.answer(true);
    await yes.settle();
    expect(yes.state.quit).toBe(true);
    expect(yes.log.indexOf('shutdown: 1 turn(s) ended as stopped')).toBeLessThan(yes.log.indexOf('windows closed'));
  });

  it('asks on a second close while the page’s question is unanswered, and its answer settles both', async () => {
    const h = setUp();
    h.app.closeMain();
    expect([h.state.question, h.boxes.length]).toEqual([true, 0]);
    h.app.closeMain();
    expect([h.state.question, h.boxes.length]).toEqual([true, 1]);
    // A third attempt finds the box open.
    h.app.quit();
    expect(h.boxes).toHaveLength(1);
    h.boxes[0]?.answer(true);
    await h.settle();
    expect(h.state.question).toBe(false);
    expect(h.state.quit).toBe(true);
  });

  it('is closed through its signal when the page answers first, and its late answer changes nothing', async () => {
    const h = setUp();
    h.app.closeMain();
    h.app.closeMain();
    expect(h.boxes[0]?.signal.aborted).toBe(false);
    expect(h.gate.answer(false)).toBe(true);
    expect(h.boxes[0]?.signal.aborted).toBe(true);
    h.boxes[0]?.answer(true);
    await h.settle();
    expect(h.state.quit).toBe(false);
    expect(h.windows.main).toBe(true);
  });

  it('answers no when it cannot be shown at all', async () => {
    const quit = vi.fn();
    const gate = createQuitGate({ running: () => 1, activity: () => ({ working: 1, planReady: 0 }), pageCanAsk: () => false, setQuestion: vi.fn(), askNatively: () => Promise.reject(new Error('no display')), quit, closeQuits: true });
    const event = { preventDefault: vi.fn() };
    expect(gate.beforeQuit(event)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quit).not.toHaveBeenCalled();
    expect(gate.answer(true)).toBe(false);
  });
});

describe('what the gate knows of the Main page (C103)', () => {
  it('can ask only an open, loaded, answering page', () => {
    const watch = createPageWatch();
    expect(watch.canAsk()).toBe(false);
    watch.opened();
    expect(watch.canAsk()).toBe(false);
    watch.loaded();
    expect(watch.canAsk()).toBe(true);
    watch.unresponsive();
    expect(watch.canAsk()).toBe(false);
    watch.responsive();
    expect(watch.canAsk()).toBe(true);
    watch.loading(); // a reload
    expect(watch.canAsk()).toBe(false);
    watch.loaded();
    watch.gone();
    expect(watch.canAsk()).toBe(false);
    watch.loaded();
    watch.closed();
    expect(watch.canAsk()).toBe(false);
    // A window opened again starts over (macOS, `activate`).
    watch.opened();
    expect(watch.canAsk()).toBe(false);
    watch.loaded();
    expect(watch.canAsk()).toBe(true);
  });
});

describe('macOS (V28; C104)', () => {
  it('asks nothing at the Main window’s close, ends nothing, and leaves the sessions running', async () => {
    const h = setUp({ closeQuits: false });
    h.app.closeMain();
    await h.settle();
    expect(h.windows.main).toBe(false);
    expect(h.state.asked).toBe(0);
    expect(h.boxes).toHaveLength(0);
    expect(h.shutdownStarted()).toBe(false);
    expect(h.state.quit).toBe(false);
    expect(h.gate.confirmed).toBe(false);
  });

  it('asks at a quit there — in the native box, with no window open', async () => {
    const h = setUp({ closeQuits: false });
    h.app.closeMain();
    h.app.quit();
    expect(h.boxes).toHaveLength(1);
    expect(h.shutdownStarted()).toBe(false);
    h.boxes[0]?.answer(true);
    await h.settle();
    expect(h.state.quit).toBe(true);
    expect(h.log).toContain('shutdown: 1 turn(s) ended as stopped');
  });

  it('asks in the page at a quit with the window open', () => {
    const h = setUp({ closeQuits: false });
    h.app.quit();
    expect(h.state.question).toBe(true);
    expect(h.windows.main).toBe(true);
  });
});

it('a twice-confirmed data reset bypasses another question but keeps the normal active-work drain', async () => {
  const h = setUp({ running: 1 });
  h.gate.confirmAndQuit();
  await h.settle();
  expect(h.gate.confirmed).toBe(true);
  expect(h.state.asked).toBe(0);
  expect(h.boxes).toHaveLength(0);
  expect(h.log).toContain('shutdown: 1 turn(s) ended as stopped');
  expect(h.state.quit).toBe(true);
});
