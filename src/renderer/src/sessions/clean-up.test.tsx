// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// Clean up done (the maintainer): beside Add project, a mode in which each session pressed
// is marked done at once, until a right-click, Escape or a press anywhere that is not a session.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvokeChannel } from '@shared/ipc/channels';
import type { SessionEntry, SessionSummary, SessionView } from '@shared/contracts/sessions';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { closeProjectDialog, useProjectDialog } from '../projects/project-dialog-store';
import { ProjectList } from '../projects/ProjectList';
import { AddProjectButton } from '../shell/AddProjectButton';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState, type ShownState } from '../test/sessions';
import { announce, Announcer } from '../ui/Announcer';
import { closeCleanUpNotice, endCleanUp, useCleanUp } from './clean-up';
import { CLEAN_UP_DESCRIPTION, CLEAN_UP_TEXT } from './CleanUpButton';
import { runningNoticeText } from './SessionList';
import type { MeasureCapsules } from './useCapsuleDrag';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answer: (channel: InvokeChannel, request: unknown) => unknown;

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  answer = () => ({ status: 'saved' });
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: answer(channel, request) };
  });
  endCleanUp();
  closeCleanUpNotice();
  closeProjectDialog();
  announce('');
});
afterEach(cleanup);

/** jsdom computes no layout. */
const measureCapsules: MeasureCapsules = () => ({ column: { top: 0, bottom: 600, left: 0, right: 320 }, listTop: 0, boxes: [] });

function Harness() {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <AddProjectButton />
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} measureCapsules={measureCapsules} />
      </aside>
      <Announcer />
    </>
  );
}

const A = project('Calamari');
const s = (name: string | null, summary: SessionSummary = SUMMARIES.idle, overrides: Partial<SessionView> = {}): SessionEntry => sessionEntry(name, summary, { projectId: A.id, ...overrides });
const show = (sessions: readonly SessionEntry[], extra: Partial<ShownState> = {}) => showState({ projects: [A], sessions, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = () => screen.getByRole('button', { name: CLEAN_UP_TEXT });
const row = (entry: SessionEntry) => document.querySelector(`[data-session-id="${entry.record.id}"]`) as HTMLElement;
const selectOf = (entry: SessionEntry) => row(entry).querySelector('[data-select-session]') as HTMLElement;
const on = () => button().getAttribute('aria-pressed') === 'true';
const marked = () => document.documentElement.hasAttribute('data-clean-up');
const click = async (element: Element, init: MouseEventInit = {}) => {
  await act(async () => {
    fireEvent.click(element, init);
    await flush();
  });
};

describe('Clean up done', () => {
  it('stands after Add project and Search, and starts with a press: pressed, the page marked, and said', async () => {
    show([s('Fix login')]);
    render(<Harness />);
    const add = screen.getByRole('button', { name: 'Add project' });
    const search = screen.getByRole('button', { name: 'Search' });
    expect(add.nextElementSibling).toBe(search);
    expect(search.nextElementSibling).toBe(button());
    expect(on()).toBe(false);
    expect(marked()).toBe(false);
    await click(button());
    expect(on()).toBe(true);
    expect(marked()).toBe(true);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(CLEAN_UP_DESCRIPTION);
  });

  it('marks each session pressed done at once, selecting none, and stays on', async () => {
    const first = s('Fix login');
    const second = s('Other task');
    show([first, second]);
    render(<Harness />);
    await click(button());
    await click(selectOf(first));
    await click(row(second));
    expect(requests).toEqual([['sessions:complete', { id: first.record.id }], ['sessions:complete', { id: second.record.id }]]);
    expect(on()).toBe(true);
  });

  it('completes a session on the shelf too', async () => {
    const shelved = s('Parked', SUMMARIES.idle, { shelvedAt: 10 });
    show([s('Fix login'), shelved]);
    render(<Harness />);
    const [shelf] = within(document.querySelector('[data-toggle-row]') as HTMLElement).getAllByRole('button');
    await click(shelf as HTMLElement);
    await click(button());
    await click(selectOf(shelved));
    expect(requests).toEqual([['sessions:complete', { id: shelved.record.id }]]);
  });

  it('does nothing for a running, a completed or a never-run session, and stays on', async () => {
    const idle = s('Fix login');
    const running = s('Busy', SUMMARIES.runningThinking);
    const fresh = s('Draft', SUMMARIES.notStarted);
    const done = s('Old task', SUMMARIES.idle, { completedAt: 10 });
    show([idle, running, fresh, done]);
    render(<Harness />);
    const [, completed] = within(document.querySelector('[data-toggle-row]') as HTMLElement).getAllByRole('button');
    await click(completed as HTMLElement);
    expect([idle, running, fresh, done].map((entry) => row(entry).hasAttribute('data-clean-up-target'))).toEqual([true, false, false, false]);
    await click(button());
    for (const entry of [running, fresh, done]) await click(selectOf(entry));
    expect(requests).toEqual([]);
    expect(on()).toBe(true);
  });

  it('ignores the second click of a double-click: the first left the place green, or moved the rows up under the pointer', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    await click(button());
    await click(selectOf(entry), { detail: 2 });
    expect(requests).toEqual([]);
  });

  it('ends at a click anywhere else, which presses nothing', async () => {
    show([s('Fix login')]);
    render(<Harness />);
    await click(button());
    await click(screen.getByRole('button', { name: 'Add project' }));
    expect(on()).toBe(false);
    expect(marked()).toBe(false);
    expect(useProjectDialog.getState().open).toBe(false);
    expect(requests).toEqual([]);
  });

  it('ends at a second press of its button', async () => {
    show([s('Fix login')]);
    render(<Harness />);
    await click(button());
    await click(button());
    expect(on()).toBe(false);
  });

  it('ends at a right-click, which opens no menu, and at Escape', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    await click(button());
    let unprevented = true;
    act(() => { unprevented = fireEvent.contextMenu(selectOf(entry)); });
    expect(unprevented).toBe(false);
    expect(on()).toBe(false);
    await click(button());
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(on()).toBe(false);
    expect(requests).toEqual([]);
  });

  it('ends when the window loses the focus or is hidden, but not when an element in it does', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    await click(button());
    act(() => { fireEvent.blur(button()); });
    expect(on()).toBe(true);
    act(() => { fireEvent.blur(window); });
    expect(on()).toBe(false);
    await click(button());
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (visibility !== undefined) Object.defineProperty(Document.prototype, 'visibilityState', visibility);
    }
    expect(on()).toBe(false);
    expect(requests).toEqual([]);
  });

  it('ends when main refuses because the session started running, and says why', async () => {
    const entry = s('Fix login');
    answer = (channel) => (channel === 'sessions:complete' ? { status: 'refused', reason: 'running', doing: 'turn' } : { status: 'saved' });
    show([entry]);
    render(<Harness />);
    await click(button());
    await click(selectOf(entry));
    expect(on()).toBe(false);
    const notice = screen.getByRole('dialog', { name: 'Fix login is running' });
    expect(notice.textContent).toContain(runningNoticeText('completed', 'turn'));
  });

  it('does nothing while the records file is refused', async () => {
    show([], { recordsStatus: { kind: 'refused', cause: 'damaged' } });
    render(<Harness />);
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await click(button());
    expect(useCleanUp.getState().on).toBe(false);
  });
});
