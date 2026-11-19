// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The quit confirmation (docs/planning/_archive/M14.md, V22; C76, C100, C101).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quitWords } from '@shared/contracts/quit';
import type { SessionEntry, SessionSummary } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionEntry, SUMMARIES } from '../../../tests/support/sessions';
import { QuitConfirm } from './QuitConfirm';
import { installDialogStandIn } from './test/dialog';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge';
import { project } from './test/records';
import { showState } from './test/sessions';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: { status: 'answered' } };
  });
});
afterEach(cleanup);

const A = project('Calamari');
const s = (name: string, summary: SessionSummary): SessionEntry => sessionEntry(name, summary, { projectId: A.id });
const RUNNING = [s('one', SUMMARIES.runningThinking), s('two', SUMMARIES.runningWorkers), s('idle', SUMMARIES.idle), s('ready', SUMMARIES.ready)];
/** `question`: null for a snapshot that has never held the field. */
const ask = (sessions: readonly SessionEntry[] = RUNNING, question: boolean | null = true) => showState({ projects: [A], sessions, ...(question === null ? {} : { quitQuestion: question }) });
const dialog = () => screen.queryByRole('dialog', { name: 'Quit fat-g?' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
    await flush();
  });
};

describe('the quit confirmation (V22)', () => {
  it('is shown while the snapshot’s question is set, and not otherwise', () => {
    ask(RUNNING, null);
    render(<QuitConfirm />);
    expect(dialog()).toBeNull();
    act(() => void ask(RUNNING, false));
    expect(dialog()).toBeNull();
    act(() => void ask());
    expect(dialog()).not.toBeNull();
    act(() => void ask(RUNNING, false));
    expect(dialog()).toBeNull();
  });

  it('names how many chats are working, and says that replies and sub-agents stop', () => {
    ask();
    render(<QuitConfirm />);
    expect(dialog()?.textContent).toContain('2 chats are still working. Quitting stops their current replies and any sub-agents.');
  });

  it('counts a session waiting on its workers as running (C114)', () => {
    ask([s('waiting', SUMMARIES.waitingOnWorkers), s('idle', SUMMARIES.idle)]);
    render(<QuitConfirm />);
    expect(dialog()?.textContent).toContain('1 chat is still working. Quitting stops its current reply and any sub-agents.');
  });

  it('replaces a running warning with saved-plan reassurance when the plan becomes ready', () => {
    ask([s('planning', SUMMARIES.runningThinking)]);
    render(<QuitConfirm />);
    const plan = { ...SUMMARIES.idle, attention: { kind: 'plan' as const, count: 1, acknowledged: false } };
    act(() => void ask([s('planning', { ...plan, status: 'running', action: { kind: 'plan-ready', label: 'Plan ready' } })]));
    expect(dialog()?.textContent).toContain('1 chat has a plan ready for review.');
    expect(dialog()?.textContent).toContain('Your saved plan will still be ready for review when you return.');
    expect(dialog()?.textContent).not.toContain('still working');
    act(() => void ask([s('planning', plan), s('working', SUMMARIES.waitingOnWorkers)]));
    expect(dialog()?.textContent).toContain('1 chat has a plan ready for review.');
    expect(dialog()?.textContent).toContain('1 chat is still working.');
    expect(within(dialog() as HTMLElement).getAllByRole('paragraph')).toHaveLength(2);
  });

  it('follows the count as the sessions of the same snapshot change', () => {
    ask();
    render(<QuitConfirm />);
    act(() => void ask([s('one', SUMMARIES.runningThinking), s('two', SUMMARIES.ready)]));
    expect(dialog()?.textContent).toContain('1 chat is still working.');
    act(() => void ask([s('one', SUMMARIES.runningThinking), s('two', SUMMARIES.runningThinking), s('three', SUMMARIES.questions)]));
    expect(dialog()?.textContent).toContain('3 chats are still working.');
  });

  it('stays with none left, and asks only whether to quit', () => {
    ask();
    render(<QuitConfirm />);
    act(() => void ask([s('one', SUMMARIES.ready), s('two', SUMMARIES.error)]));
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('No chat is still working.');
    expect(within(dialog() as HTMLElement).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Quit']);
  });

  it('has Cancel as its default: it holds the focus when the question opens', () => {
    ask();
    render(<QuitConfirm />);
    expect(document.activeElement).toBe(within(dialog() as HTMLElement).getByRole('button', { name: 'Cancel' }));
  });

  it('uses the words main’s native box uses', () => {
    ask();
    render(<QuitConfirm />);
    const words = quitWords({ working: 2, planReady: 0 });
    expect(within(dialog() as HTMLElement).getByRole('heading').textContent).toBe(words.title);
    expect(dialog()?.textContent).toContain(words.body);
    expect(within(dialog() as HTMLElement).getAllByRole('button').map((button) => button.textContent)).toEqual([words.cancel, words.confirm]);
  });

  it.each([['Quit', true], ['Cancel', false]])('sends one answer from %s, however often it is pressed', async (name, quit) => {
    ask();
    render(<QuitConfirm />);
    const button = within(dialog() as HTMLElement).getByRole('button', { name });
    await click(button);
    await click(button);
    expect(requests).toEqual([['app:answerQuit', { quit }]]);
  });

  it('answers no on Escape, once', async () => {
    ask();
    render(<QuitConfirm />);
    // The dialog's own close, as Escape causes it.
    await act(async () => {
      (dialog() as HTMLDialogElement).close();
      await flush();
    });
    expect(requests).toEqual([['app:answerQuit', { quit: false }]]);
  });

  it('closes when main clears the question, sending nothing more — and a later question is a new one', async () => {
    ask();
    render(<QuitConfirm />);
    await click(within(dialog() as HTMLElement).getByRole('button', { name: 'Quit' }));
    act(() => void ask(RUNNING, false));
    expect(dialog()).toBeNull();
    expect(requests).toHaveLength(1);
    act(() => void ask());
    await click(within(dialog() as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([['app:answerQuit', { quit: true }], ['app:answerQuit', { quit: false }]]);
  });

  it('lets the buttons be pressed again when the answer could not be sent', async () => {
    bridge.setInvoke(async (channel, request) => {
      requests.push([channel, request]);
      return { ok: false, error: 'unavailable' };
    });
    ask();
    render(<QuitConfirm />);
    const button = within(dialog() as HTMLElement).getByRole('button', { name: 'Quit' });
    await click(button);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await click(button);
    expect(requests).toHaveLength(2);
  });
});
