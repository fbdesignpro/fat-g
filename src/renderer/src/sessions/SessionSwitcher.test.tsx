// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The recent sessions switcher (docs/planning/_archive/M100.md, Design 5; C93): Ctrl+Tab and its keys, what
// is selected and when, what is said, and where the focus goes.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { CREATED_AT, SUMMARIES, sessionEntry } from '../../../../tests/support/sessions';
import { useChatDrafts } from '../chat/chat-store';
import { showDetached } from '../chat/detached-store';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { type FocusWatch, watchFocus } from '../test/focus';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { announce, Announcer } from '../ui/Announcer';
import { useVisitedSessions } from './recent';
import { SessionSwitcher, SWITCHER_LABEL } from './SessionSwitcher';

let bridge: FakeBridge;
let selects: string[];
/** Every focus the page gave while a test ran: what says whether the list was lit (../test/focus.ts). */
let focus: FocusWatch;

const A = project('Calamari');
const B = project('website');

const at = (minutes: number): number => CREATED_AT + minutes * 60_000;
const late = sessionEntry('Late', SUMMARIES.ready, { projectId: A.id, lastActiveAt: at(9) });
const mid = sessionEntry('Mid', SUMMARIES.idle, { projectId: B.id, lastActiveAt: at(5) });
const old = sessionEntry('Old', SUMMARIES.questions, { projectId: A.id, lastActiveAt: at(1) });
const ALL = [late, mid, old];

/**
 * A stand-in for the chat region: the selected session's area, with an input in its prompt area —
 * or, where the session cannot take a prompt, the reason in its place, as ChatArea draws it.
 */
function Chat({ blocked = false }: { readonly blocked?: boolean }) {
  const selectedId = useAppState((state) => state.snapshot?.sessions?.selectedId ?? null);
  if (selectedId === null) return null;
  return (
    <div data-chat-session={selectedId}>
      <div data-chat-list="" tabIndex={0} />
      <div data-prompt-area="">{blocked ? <p>Its mode was not confirmed.</p> : <textarea aria-label={`Message ${selectedId}`} />}</div>
    </div>
  );
}

function show(sessions: readonly SessionEntry[], selected: SessionEntry | null): void {
  act(() => {
    showState({ projects: [A, B], sessions, selectedId: selected?.record.id ?? null });
  });
}

function setUp(sessions: readonly SessionEntry[] = ALL, selected: SessionEntry | null = mid, blocked = false): void {
  show(sessions, selected);
  render(
    <>
      <Announcer />
      <SessionSwitcher />
      <Chat blocked={blocked} />
      <button type="button">Elsewhere</button>
    </>,
  );
}

/** The key pressed where the focus is; false when the switcher kept it from the page. */
const key = (name: string, init: { readonly ctrlKey?: boolean; readonly shiftKey?: boolean; readonly altKey?: boolean } = {}): boolean => {
  let passed = true;
  act(() => {
    passed = fireEvent.keyDown(document.activeElement ?? document.body, { key: name, ...init });
  });
  return passed;
};
const release = (): void => {
  act(() => {
    fireEvent.keyUp(document.activeElement ?? document.body, { key: 'Control' });
  });
};
const tab = (shiftKey = false): boolean => key('Tab', { ctrlKey: true, shiftKey });

const switcher = (): HTMLElement | null => screen.queryByRole('listbox', { name: SWITCHER_LABEL });
const rows = (): string[] => within(switcher() ?? document.body).queryAllByRole('option').map((row) => row.textContent ?? '');
const highlighted = (): string => within(switcher() ?? document.body).queryAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true')?.textContent ?? '';
const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

beforeEach(() => {
  bridge = installFakeBridge();
  selects = [];
  focus = watchFocus();
  bridge.setInvoke((channel: InvokeChannel, request) => {
    if (channel === 'sessions:select') selects.push((request as { id: string }).id);
    return Promise.resolve({ ok: true, value: { status: 'saved' } });
  });
  useVisitedSessions.setState({ ids: [] });
  useChatDrafts.setState({ drafts: {} });
  showDetached(null);
  announce('');
});
afterEach(() => {
  focus.undo();
  cleanup();
});

describe('the recent sessions switcher (C93)', () => {
  // M102 (V7; C4, C31): each row draws its session's avatar at 30 px: its small.
  it('draws each row’s avatar, its small over the placeholder', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    setUp(ALL.map((entry) => ({ ...entry, avatar: face })));
    expect(tab()).toBe(false);
    const images = [...(switcher()?.querySelectorAll('[data-avatar][data-size="thin"] img') ?? [])].map((image) => image.getAttribute('src'));
    expect(images).toEqual(Array.from({ length: 3 }, () => `app://media/avatars/${face.small}`));
    release();
  });

  // M103 (V6; C13, C14): each row its own session's, the one assigned beside the default face.
  it('draws on each row its own session’s avatar, an assigned one beside the default face', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    const assigned = { ref: { origin: 'user' as const, family: 'Mine', avatar: 'Op' }, portrait: 'c'.repeat(32), small: 'd'.repeat(32) };
    setUp(ALL.map((entry) => ({ ...entry, avatar: entry === late ? assigned : face })));
    expect(tab()).toBe(false);
    const images = [...(switcher()?.querySelectorAll('[data-avatar][data-size="thin"] img') ?? [])].map((image) => image.getAttribute('src'));
    // Mid is shown, so it comes first, then Late and Old.
    expect(images).toEqual([face.small, assigned.small, face.small].map((id) => `app://media/avatars/${id}`));
    release();
  });

  it('opens at Ctrl+Tab with the shown session first and the previous one highlighted, and a tap opens that one', () => {
    setUp();
    expect(switcher()).toBeNull();
    expect(tab()).toBe(false);
    expect(rows()).toEqual(['MidwebsiteIdle', 'LateCalamariReady', 'OldCalamari3 Questions']);
    expect(highlighted()).toBe('LateCalamariReady');
    expect(switcher()?.querySelector('[aria-current="true"]')?.textContent).toBe('MidwebsiteIdle');
    expect(selects).toEqual([]);
    release();
    expect(switcher()).toBeNull();
    expect(selects).toEqual([late.record.id]);
  });

  it('moves the highlight with Tab while Ctrl is held and opens the session it rests on at the release', () => {
    setUp();
    tab();
    tab();
    expect(highlighted()).toBe('OldCalamari3 Questions');
    // Past the last, back to the first.
    tab();
    expect(highlighted()).toBe('MidwebsiteIdle');
    tab();
    tab();
    release();
    expect(selects).toEqual([old.record.id]);
  });

  it('moves back with Shift+Tab, wrapping, and opens at the last row with Ctrl+Shift+Tab', () => {
    setUp();
    tab(true);
    expect(highlighted()).toBe('OldCalamari3 Questions');
    tab(true);
    expect(highlighted()).toBe('LateCalamariReady');
    tab();
    expect(highlighted()).toBe('OldCalamari3 Questions');
    release();
    expect(selects).toEqual([old.record.id]);
  });

  it('selects nothing for passing over a session, and nothing for opening the shown one', () => {
    setUp();
    tab();
    tab();
    tab();
    expect(highlighted()).toBe('MidwebsiteIdle');
    expect(selects).toEqual([]);
    release();
    expect(selects).toEqual([]);
  });

  it('closes with nothing changed at Escape and when the window loses the focus', () => {
    setUp();
    tab();
    expect(key('Escape')).toBe(false);
    expect(switcher()).toBeNull();
    release();
    tab();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(switcher()).toBeNull();
    release();
    expect(selects).toEqual([]);
  });

  it('opens the highlighted session at Enter, and the row clicked', () => {
    setUp();
    tab();
    expect(key('Enter')).toBe(false);
    expect(selects).toEqual([late.record.id]);
    release();
    expect(selects).toEqual([late.record.id]);
    tab();
    act(() => {
      fireEvent.click(within(switcher() ?? document.body).getByText('Old'));
    });
    expect(switcher()).toBeNull();
    expect(selects).toEqual([late.record.id, old.record.id]);
  });

  it('leaves plain Tab, Alt+Ctrl+Tab and the other keys to the page', () => {
    setUp();
    expect(key('Tab')).toBe(true);
    expect(key('Tab', { shiftKey: true })).toBe(true);
    // AltGr is Ctrl and Alt together on Windows.
    expect(key('Tab', { ctrlKey: true, altKey: true })).toBe(true);
    expect(key('Escape')).toBe(true);
    expect(key('Enter')).toBe(true);
    expect(switcher()).toBeNull();
  });

  it('does nothing with no session but the shown one, or while a modal dialog is open', () => {
    setUp([mid], mid);
    expect(tab()).toBe(true);
    expect(switcher()).toBeNull();
    cleanup();
    setUp();
    const dialog = document.body.appendChild(document.createElement('dialog'));
    dialog.setAttribute('open', '');
    expect(tab()).toBe(true);
    expect(switcher()).toBeNull();
    dialog.remove();
    expect(tab()).toBe(false);
    expect(switcher()).not.toBeNull();
  });

  it('puts the sessions visited in this run first, the latest first', () => {
    setUp(ALL, old);
    show(ALL, late);
    show(ALL, mid);
    tab();
    expect(rows()).toEqual(['MidwebsiteIdle', 'LateCalamariReady', 'OldCalamari3 Questions']);
    release();
    show(ALL, old);
    tab();
    expect(rows()).toEqual(['OldCalamari3 Questions', 'MidwebsiteIdle', 'LateCalamariReady']);
  });

  it('highlights the first row while a chat without a session is shown, since no row is shown', () => {
    setUp();
    act(() => {
      showState({ projects: [A, B], sessions: ALL, selectedId: mid.record.id, conversations: { status: { kind: 'ok' }, detached: 1 } });
      showDetached({ id: 'detached-1' } as never);
    });
    tab();
    expect(highlighted()).toBe('MidwebsiteIdle');
    release();
    expect(selects).toEqual([mid.record.id]);
  });

  it('says each row as the highlight reaches it: the name, the project, the status, and where it stands', () => {
    setUp();
    tab();
    expect(announced()).toBe('Late, Calamari, Ready, 2 of 3');
    tab();
    expect(announced()).toBe('Old, Calamari, 3 Questions, 3 of 3');
    tab();
    expect(announced()).toBe('Mid, website, Idle, current, 1 of 3');
  });

  it('gives the opened session’s input the focus once its chat is shown, and leaves the focus where it was at Escape', () => {
    setUp();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    tab();
    key('Escape');
    release();
    expect(document.activeElement).toBe(elsewhere);
    tab();
    release();
    expect(document.activeElement).toBe(elsewhere);
    // Main's push of the new selection: the chat is drawn, and the input takes the focus.
    show(ALL, late);
    const input = screen.getByRole('textbox', { name: `Message ${late.record.id}` });
    expect(document.activeElement).toBe(input);
    // The input is lit as ever: it is where what the reader types goes.
    expect(focus.quiet(input)).toBe(false);
  });

  it('gives the list the focus, and gives it quietly, where the opened session has no input row', () => {
    setUp(ALL, mid, true);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    tab();
    release();
    show(ALL, late);
    const list = document.querySelector('[data-chat-list]');
    expect(document.activeElement).toBe(list);
    // Nothing of the reader's asked for the list: it takes the keyboard unlit (ui/focus.ts).
    expect(focus.quiet(list)).toBe(true);
  });
});
