// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The Done flash covers the capsule and what shows the session,
// and only once it is full is main asked, the capsule's place a slot; a saved Done fades, then its slot closes; a refused one puts everything back;
// Clean up done flashes at each press and closes its empty places once the mode ends; and nothing but the
// wheel reaches the page meanwhile.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvokeChannel } from '@shared/ipc/channels';
import type { SessionEntry, SessionView } from '@shared/contracts/sessions';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { ProjectList } from '../projects/ProjectList';
import { DoneButton } from '../session-area/DoneButton';
import { AddProjectButton } from '../shell/AddProjectButton';
import { installDialogStandIn } from '../test/dialog';
import { usePrefs } from '../state/prefs-store';
import { prefsSnapshot } from '../test/prefs';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { runningNoticeText } from './SessionList';
import { closeCleanUpNotice, endCleanUp, startCleanUp, useCleanUp } from './clean-up';
import { DoneCovers } from './DoneCovers';
import { type CoverRect, DONE_FLASH, resetLeaving, setLeavingMotion, useLeaving } from './leaving';
import { SEQUENCE_ATTRIBUTE, watchSequenceLock } from './sequence-lock';
import type { MeasureCapsules } from './useCapsuleDrag';

const A = project('Calamari');
const s = (name: string, overrides: Partial<SessionView> = {}): SessionEntry => sessionEntry(name, SUMMARIES.idle, { projectId: A.id, ...overrides });
const first = s('First');
const second = s('Second');
const third = s('Third');
const completed = (entry: SessionEntry): SessionEntry => ({ ...entry, record: { ...entry.record, completedAt: 50 } });

const CHAT: CoverRect = { x: 400, y: 80, width: 600, height: 640 };
const PANE: CoverRect = { x: 1010, y: 80, width: 400, height: 640 };
const ROW = 61;
/** From the press until the green is gone. */
const FADED = DONE_FLASH.white + DONE_FLASH.fade;
/** The scene's duration, set on the root for every test: the slot's closing. */
const CLOSING = 320;

/** jsdom computes no layout: the capsules one under the other, the chat window and the pane beside it. */
function layout(this: Element): DOMRect {
  const box = (rect: CoverRect): DOMRect => ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect });
  if (this.matches('[data-chat-window]')) return box(CHAT);
  if (this.matches('[data-artifact-pane]')) return box(PANE);
  if (this.matches('li[data-session-id]')) return box({ x: 10, y: 100 + ROW * [...(this.parentElement?.children ?? [])].indexOf(this), width: 280, height: ROW });
  return box({ x: 0, y: 0, width: 0, height: 0 });
}

const measureCapsules: MeasureCapsules = () => ({ column: { top: 0, bottom: 600, left: 0, right: 320 }, listTop: 0, boxes: [] });

/** The column, Clean up done's button, and a chat window showing `shown` — Done, and a pane — as SessionWindow names it. */
function Harness({ shown }: { readonly shown: SessionEntry | null }) {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <AddProjectButton />
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} measureCapsules={measureCapsules} />
      </aside>
      <div data-chat-window="" data-shown-session={shown?.record.id}>{shown !== null && <DoneButton entry={shown} />}</div>
      {shown !== null && <div data-artifact-pane={shown.record.id} />}
      <DoneCovers />
    </>
  );
}

let bridge: FakeBridge;
let requests: string[];
let answer: (channel: InvokeChannel) => unknown;
let stopLock: () => void;

beforeAll(installDialogStandIn);
beforeEach(() => {
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  resetLeaving();
  endCleanUp();
  closeCleanUpNotice();
  setLeavingMotion(() => true);
  bridge = installFakeBridge();
  requests = [];
  answer = () => ({ status: 'saved' });
  bridge.setInvoke(async (channel) => {
    requests.push(channel);
    return { ok: true, value: answer(channel) };
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(layout);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  document.documentElement.style.setProperty('--duration-scene', `${CLOSING}ms`);
  stopLock = watchSequenceLock();
});
afterEach(() => {
  stopLock();
  document.documentElement.style.removeProperty('--duration-scene');
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLeaving();
  endCleanUp();
});

const show = (sessions: readonly SessionEntry[], selected: string | null = null) => showState({ projects: [A], sessions, selectedId: selected });
const later = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const press = async (element: Element, init: MouseEventInit = {}) => {
  await act(async () => {
    fireEvent.click(element, init);
    await vi.advanceTimersByTimeAsync(0);
  });
};
const drawnIds = () => [...(document.querySelector('ul[aria-label="Sessions of Calamari"]')?.children ?? [])].map((row) => (row as HTMLElement).dataset['sessionId'] ?? `slot:${(row as HTMLElement).dataset['heldSlot'] ?? ''}`);
const slot = () => document.querySelector<HTMLElement>('[data-held-slot]');
const covers = () => [...document.querySelectorAll<HTMLElement>('[data-done-cover]')].map((cover) => ({ x: cover.style.left, y: cover.style.top, width: cover.style.width, height: cover.style.height, check: cover.querySelector('[data-done-check]') !== null }));
const coverOf = (rect: CoverRect, check: boolean) => ({ x: `${rect.x}px`, y: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, check });
/** Each slot drawn: flashing (its check in it), empty, or closing. */
const capsuleCover = (id: string) => document.querySelector<HTMLElement>(`[data-done-capsule="${id}"]`);
const slotStates = () => [...document.querySelectorAll<HTMLElement>('[data-held-slot]')].map((held) => (held.hasAttribute('data-closing') ? 'closing' : capsuleCover(held.dataset['heldSlot'] ?? '')?.dataset['phase'] === 'flash' ? 'flash' : 'empty'));
const done = () => screen.getByRole('button', { name: 'Done' });
const locked = () => document.documentElement.hasAttribute(SEQUENCE_ATTRIBUTE);
const selectOf = (entry: SessionEntry) => document.querySelector(`[data-session-id="${entry.record.id}"] [data-select-session]`) as HTMLElement;

describe('a Done with the flash', () => {
  it('completes immediately without an animation when set to none', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ appearance: { ...prefsSnapshot().values.appearance, doneAnimation: 'none' } }) });
    show([first], first.record.id);
    render(<Harness shown={first} />);
    await press(done());
    expect(requests).toEqual(['sessions:complete']);
    expect(covers()).toHaveLength(0);
    expect(locked()).toBe(false);
  });

  it('fades without flashing when animation only is selected', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ appearance: { ...prefsSnapshot().values.appearance, doneAnimation: 'animation-only' } }) });
    show([first], first.record.id);
    render(<Harness shown={first} />);
    await press(done());
    expect(requests).toEqual(['sessions:complete']);
    expect(document.querySelector('[data-done-cover]')?.getAttribute('data-animation')).toBe('animation-only');
    expect(capsuleCover(first.record.id)?.dataset['animation']).toBe('animation-only');
    await later(DONE_FLASH.fade);
    expect(covers()).toHaveLength(0);
  });
  it('at the press, asks main, puts a slot in the capsule’s place and flashes, the check in the chat window', async () => {
    show([first, second, third], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    expect(requests).toEqual(['sessions:complete']);
    expect(drawnIds()).toEqual([first.record.id, `slot:${second.record.id}`, third.record.id]);
    expect(slot()?.style.height).toBe(`${ROW}px`);
    expect(slot()?.getAttribute('aria-hidden')).toBe('true');
    expect(slotStates()).toEqual(['flash']);
    // The large check stands in the chat window's cover alone.
    expect(covers()).toEqual([coverOf(CHAT, true), coverOf(PANE, false)]);
    expect(locked()).toBe(true);
  });

  it('holds the capsule’s place after main moves it, the completed ones waiting, then closes it once the green has faded', async () => {
    show([first, second, third], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    act(() => { show([first, completed(second), third]); });
    expect(drawnIds()).toEqual([first.record.id, `slot:${second.record.id}`, third.record.id]);
    expect(document.querySelector('[data-toggle-row]')).toBeNull();
    await later(FADED - 1);
    expect(covers()).toHaveLength(2);
    expect(slot()?.hasAttribute('data-closing')).toBe(false);
    await later(1);
    expect(covers()).toEqual([]);
    expect(slot()?.hasAttribute('data-closing')).toBe(true);
    expect(slot()?.style.height).toBe('0px');
    expect(slot()?.children).toHaveLength(0);
    expect(locked()).toBe(true);
    await later(CLOSING);
    expect(drawnIds()).toEqual([first.record.id, third.record.id]);
    expect(document.querySelector('[data-toggle-row]')).not.toBeNull();
    expect(locked()).toBe(false);
  });

  it('draws the capsule and chat on the same overlay, outside the clipped list, with matching phases and timings', async () => {
    show([first, second], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    const capsule = capsuleCover(second.record.id);
    const chat = document.querySelector<HTMLElement>('[data-done-cover]');
    expect(capsule).not.toBeNull();
    expect(capsule?.closest('aside')).toBeNull();
    expect(capsule?.parentElement).toBe(chat?.parentElement);
    expect(capsule?.style.left).toBe('10px');
    expect(capsule?.style.top).toBe(`${100 + ROW}px`);
    expect(capsule?.style.width).toBe('280px');
    expect(capsule?.style.height).toBe(`${ROW}px`);
    for (const name of ['--done-white', '--done-white-fade', '--done-fade']) {
      expect(capsule?.style.getPropertyValue(name)).toBe(chat?.style.getPropertyValue(name));
    }
    expect(capsuleCover(second.record.id)).toBe(capsule);
    expect(capsule?.dataset['phase']).toBe('flash');
    expect(chat?.dataset['phase']).toBe('flash');
    act(() => { show([first, completed(second)]); });
    await later(FADED - 1);
    expect(capsuleCover(second.record.id)).toBe(capsule);
    await later(1);
    expect(capsuleCover(second.record.id)).toBeNull();
    expect(covers()).toEqual([]);
  });

  it('is pressed by the capsule menu’s Done too, which covers no window while another session shows', async () => {
    show([first, second], first.record.id);
    render(<Harness shown={first} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Second' }));
    await press(screen.getByRole('menuitem', { name: 'Done' }));
    expect(requests).toEqual(['sessions:complete']);
    expect(drawnIds()).toEqual([first.record.id, `slot:${second.record.id}`]);
    expect(covers()).toEqual([]);
    await later(FADED + CLOSING);
    expect(slot()).toBeNull();
  });

  it('keeps a project’s list while only a slot is left in it', async () => {
    show([first], first.record.id);
    render(<Harness shown={first} />);
    await press(done());
    act(() => { show([completed(first)]); });
    expect(drawnIds()).toEqual([`slot:${first.record.id}`]);
  });

  it('puts everything back at once when main refuses, and Done says why', async () => {
    answer = () => ({ status: 'refused', reason: 'running', doing: 'turn' });
    show([first, second], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    expect(useLeaving.getState().leaving).toEqual({});
    expect(drawnIds()).toEqual([first.record.id, second.record.id]);
    expect(covers()).toEqual([]);
    expect(locked()).toBe(false);
    expect(screen.getByRole('status').textContent).toBe(runningNoticeText('completed', 'turn'));
  });

  it('leaves a later press alone when an earlier one’s time is up', async () => {
    let refuse = true;
    answer = () => (refuse ? { status: 'refused', reason: 'running', doing: 'turn' } : { status: 'saved' });
    show([first, second], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    await later(FADED / 2);
    refuse = false;
    await press(done());
    await later(FADED / 2 + CLOSING);
    expect(slot()?.hasAttribute('data-closing')).toBe(false);
    await later(FADED / 2 + CLOSING);
    expect(slot()).toBeNull();
  });

  it('plays nothing where the user asked for less motion: the Done is as it always was', async () => {
    setLeavingMotion(() => false);
    show([first, second], second.record.id);
    render(<Harness shown={second} />);
    await press(done());
    expect(requests).toEqual(['sessions:complete']);
    expect(useLeaving.getState().leaving).toEqual({});
    expect(locked()).toBe(false);
  });
});

describe('Clean up done with the flash', () => {
  const cleanUpButton = () => screen.getByRole('button', { name: 'Clean up done' });

  it('flashes each place pressed at once, the shown session’s window too, unlocked, leaves it empty until the mode ends, then closes them all', async () => {
    show([first, second, third], first.record.id);
    render(<Harness shown={first} />);
    await press(cleanUpButton());
    await press(selectOf(first));
    await press(selectOf(third));
    // The first capsule is already replaced by its held slot.
    expect(selectOf(first)).toBeNull();
    expect(locked()).toBe(false);
    expect(requests).toEqual(['sessions:complete', 'sessions:complete']);
    expect(drawnIds()).toEqual([`slot:${first.record.id}`, second.record.id, `slot:${third.record.id}`]);
    expect(slotStates()).toEqual(['flash', 'flash']);
    expect(covers()).toEqual([coverOf(CHAT, true), coverOf(PANE, false)]);
    expect(locked()).toBe(false);
    await later(FADED * 3);
    expect(slotStates()).toEqual(['empty', 'empty']);
    expect(covers()).toEqual([]);
    expect(slot()?.style.height).toBe(`${ROW}px`);
    // A press on an empty place does nothing, and the mode goes on.
    await press(document.querySelector('[data-held-slot]') as HTMLElement);
    expect(useCleanUp.getState().on).toBe(true);
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(useCleanUp.getState().on).toBe(false);
    expect(slotStates()).toEqual(['closing', 'closing']);
    expect(locked()).toBe(true);
    await later(CLOSING);
    expect(document.querySelectorAll('[data-held-slot]')).toHaveLength(0);
    expect(locked()).toBe(false);
  });

  it('closes its empty places when the window loses the focus, which ends the mode', async () => {
    show([first, second]);
    render(<Harness shown={null} />);
    await press(cleanUpButton());
    await press(selectOf(first));
    await later(FADED);
    expect(slotStates()).toEqual(['empty']);
    act(() => { fireEvent.blur(window); });
    expect(useCleanUp.getState().on).toBe(false);
    expect(slotStates()).toEqual(['closing']);
    await later(CLOSING);
    expect(slot()).toBeNull();
  });

  it('closes a place pressed just before the mode ends once its green is gone', async () => {
    show([first, second]);
    render(<Harness shown={null} />);
    await press(cleanUpButton());
    await press(selectOf(first));
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(locked()).toBe(true);
    expect(slotStates()).toEqual(['flash']);
    await later(FADED);
    expect(slotStates()).toEqual(['closing']);
    await later(CLOSING);
    expect(slot()).toBeNull();
    expect(locked()).toBe(false);
  });

  it('drops a refused session’s place and ends the mode, saying why; the others close', async () => {
    answer = () => ({ status: 'saved' });
    show([first, second]);
    render(<Harness shown={null} />);
    await press(cleanUpButton());
    await press(selectOf(first));
    // The first request is saved before the next is refused.
    answer = () => ({ status: 'refused', reason: 'running', doing: 'turn' });
    await press(selectOf(second));
    expect(useCleanUp.getState().on).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Second is running' })).not.toBeNull();
    expect(drawnIds()).toEqual([`slot:${first.record.id}`, second.record.id]);
    expect(locked()).toBe(true);
    await later(FADED + CLOSING);
    expect(slot()).toBeNull();
  });
});

describe('the lock', () => {
  const held = { slot: null, covers: [], phase: 'empty', animation: 'animation-flash', untilModeEnds: true, serial: 1 } as const;

  it('swallows presses, keys and Ctrl+wheel while a flash plays, but not the wheel; and nothing while Clean up done is on or only empty places wait on it', () => {
    expect(fireEvent.click(document.body)).toBe(true);
    act(() => useLeaving.setState({ leaving: { x: { ...held, phase: 'flash' } } }));
    expect(locked()).toBe(true);
    expect(fireEvent.click(document.body)).toBe(false);
    expect(fireEvent.pointerDown(document.body)).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: 'Enter' })).toBe(false);
    expect(fireEvent.contextMenu(document.body)).toBe(false);
    expect(fireEvent.wheel(document.body, { deltaY: 40 })).toBe(true);
    expect(fireEvent.wheel(document.body, { deltaY: 40, ctrlKey: true })).toBe(false);
    act(() => useLeaving.setState({ leaving: { x: held } }));
    expect(locked()).toBe(false);
    act(startCleanUp);
    act(() => useLeaving.setState({ leaving: { x: { ...held, phase: 'flash' } } }));
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true);
    act(() => useLeaving.setState({ leaving: {} }));
    expect(fireEvent.click(document.body)).toBe(true);
  });
});
