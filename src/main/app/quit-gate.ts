// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The quit gate (docs/planning/_archive/M14.md, Design 7; C76, C99–C104): quitting while a session runs asks
// first. It stands in front of the shutdown (shutdown.ts) at the two events a quit can begin with —
// the Main window's `close` and `before-quit` — because a native close runs
// close → closed → window-all-closed → before-quit (lifecycle.ts), and a question at `before-quit`
// alone would come after the windows are gone.
//
//   Main window `close`, confirmed                  passes
//   Main window `close`, macOS                      passes: asks nothing, ends nothing (C104)
//   Main window `close`, elsewhere, none running    sets confirmed, passes (C102)
//   Main window `close`, elsewhere, running         prevents it, asks
//   `before-quit`, confirmed                        passes to the shutdown
//   `before-quit`, none running                     sets confirmed, passes
//   `before-quit`, running                          prevents it, asks: nothing of the shutdown starts (C99)
//
// The question goes to the Main page through the app state (C100). When the page cannot show it, or
// on a second attempt while its question waits, main asks in a native message box with the same
// words (C103). The first answer settles it and closes the other. A yes is for good; a no is for
// this attempt only. Electron-free: its app, windows and dialog arrive as functions, so it is tested
// with fakes (as shutdown.ts is).
import { quitWords, type QuitActivity, type QuitWords } from '@shared/contracts/quit';

export interface QuitGateDeps {
  /** Running sessions, including a provider blocked on a plan decision or waiting for workers. */
  readonly running: () => number;
  /** Active work and saved plans awaiting a decision, from the live summaries. */
  readonly activity: () => QuitActivity;
  /** Whether the Main page can show a question: its window is open, loaded and answering (C103). */
  readonly pageCanAsk: () => boolean;
  /** Sets or clears `quitQuestion` in the app state (C100). */
  readonly setQuestion: (asked: boolean) => void;
  /** The native message box. Resolves true for Quit; the signal closes it when the page answers first. */
  readonly askNatively: (words: QuitWords, signal: AbortSignal) => Promise<boolean>;
  /** `app.quit()`. */
  readonly quit: () => void;
  /** Whether closing the Main window quits the app: everywhere but macOS (C104). */
  readonly closeQuits: boolean;
}

interface Preventable {
  preventDefault(): void;
}

/**
 * Whether the Main page can show a question (C103), from what Electron says of its window: opened
 * and closed, `did-start-loading` and `did-finish-load`, `render-process-gone`, `unresponsive` and
 * `responsive`. The window manager reports each; the gate asks `canAsk`.
 */
export interface PageWatch {
  opened(): void;
  closed(): void;
  loading(): void;
  loaded(): void;
  gone(): void;
  unresponsive(): void;
  responsive(): void;
  canAsk(): boolean;
}

export function createPageWatch(): PageWatch {
  let open = false;
  let loaded = false;
  let responsive = true;
  return {
    opened() { open = true; loaded = false; responsive = true; },
    closed() { open = false; loaded = false; },
    loading() { loaded = false; },
    loaded() { loaded = true; },
    gone() { loaded = false; },
    unresponsive() { responsive = false; },
    responsive() { responsive = true; },
    canAsk: () => open && loaded && responsive,
  };
}

export interface QuitBoxOptions {
  type: 'question';
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

/** The native message box's options: the words of the page's question, with Cancel as the default (C103). */
export function quitBoxOptions(words: QuitWords): QuitBoxOptions {
  return { type: 'question', message: words.title, detail: words.body, buttons: [words.cancel, words.confirm], defaultId: 0, cancelId: 0, noLink: true };
}
/** The index of Quit among `quitBoxOptions`' buttons. */
export const QUIT_BOX_CONFIRM = 1;

export interface QuitGate {
  /** The Main window's `close`. Prevents it while the question is open. */
  mainClose(event: Preventable): void;
  /** `before-quit`. True when the quit may go on, and the shutdown is handed the event. */
  beforeQuit(event: Preventable): boolean;
  /** The page's answer. False when no question is asked (C101). */
  answer(quit: boolean): boolean;
  /** Quit after another workflow has explicitly confirmed stopping running work. */
  confirmAndQuit(): void;
  /** Set by a yes, or by a close or quit that passed unasked; never cleared (C102). */
  readonly confirmed: boolean;
}

export function createQuitGate(deps: QuitGateDeps): QuitGate {
  let confirmed = false;
  /** The open question: whether the page shows it, and the native box when one is open. */
  let question: { readonly page: boolean; readonly box: AbortController | null } | null = null;

  /** The first answer settles the question and closes the other way of asking. */
  function settle(quit: boolean): boolean {
    const open = question;
    if (open === null) return false;
    question = null;
    open.box?.abort();
    if (open.page) deps.setQuestion(false);
    if (quit) {
      confirmed = true;
      // Both paths go on through `before-quit`, with the windows still open.
      deps.quit();
    }
    return true;
  }

  function ask(): void {
    if (question === null && deps.pageCanAsk()) {
      question = { page: true, box: null };
      deps.setQuestion(true);
      return;
    }
    // One native box at a time: a third attempt finds it open.
    if (question !== null && question.box !== null) return;
    const box = new AbortController();
    question = { page: question?.page ?? false, box };
    const answered = (quit: boolean): void => {
      if (question?.box === box) settle(quit);
    };
    // A box that cannot be shown answers no: nothing is ended without a yes.
    deps.askNatively(quitWords(deps.activity()), box.signal).then(answered, () => answered(false));
  }

  /** Whether an event may pass, asking when it may not. */
  function pass(event: Preventable): boolean {
    if (confirmed) return true;
    if (deps.running() === 0) {
      // Unasked: a turn starting just after cannot raise the question with no window left (C102).
      confirmed = true;
      return true;
    }
    event.preventDefault();
    ask();
    return false;
  }

  return {
    mainClose(event) {
      if (!deps.closeQuits && !confirmed) return;
      pass(event);
    },
    beforeQuit: pass,
    answer: settle,
    /** A caller already confirmed stopping work, as the full-data reset does twice. */
    confirmAndQuit() {
      confirmed = true;
      question?.box?.abort();
      if (question?.page === true) deps.setQuestion(false);
      question = null;
      deps.quit();
    },
    get confirmed() {
      return confirmed;
    },
  };
}
