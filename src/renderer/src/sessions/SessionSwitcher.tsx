// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { type SessionEntry, sessionLabel, statusWords } from '@shared/contracts/sessions';
import { useChatDrafts } from '../chat/chat-store';
import { CHAT_MARK } from '../chat/foot-focus';
import { showDetached } from '../chat/detached-store';
import { LIST_MARK } from '../chat/MessageList';
import { selectSession } from './select';
import { useShownChat } from '../session-area/selected';
import { useAppState } from '../state/store';
import { announce } from '../ui/Announcer';
import { focusQuietly } from '../ui/focus';
import { Avatar } from './Avatar';
import { recentSessions, useRecentTracking, useVisitedSessions } from './recent';
import styles from './SessionSwitcher.module.css';

export const SWITCHER_LABEL = 'Recent sessions';

interface Open {
  /** The rows, as they were ordered when it opened: the order holds while it is open. */
  readonly ids: readonly string[];
  /** The highlighted row. */
  readonly at: number;
  /** The session whose chat was shown when it opened, or null. */
  readonly shown: string | null;
}

/** What is said of a row as the highlight reaches it. */
export function switcherRowWords(entry: SessionEntry, projectName: string | null, index: number, count: number, current: boolean): string {
  const parts = [sessionLabel(entry), ...(projectName === null ? [] : [projectName]), statusWords(entry.summary), ...(current ? ['current'] : []), `${index + 1} of ${count}`];
  return parts.join(', ');
}

function projectNameOf(projects: readonly ProjectEntryView[] | undefined, projectId: string): string | null {
  const project = projects?.find((candidate) => candidate.kind === 'project' && candidate.id === projectId);
  return project?.kind === 'project' ? project.name : null;
}

/**
 * The list as Ctrl+Tab opens it, or null when it does not: with a modal dialog open, the page
 * behind it is not the user's; with no session but the shown one, there is nowhere to go. The row
 * after the shown session is highlighted — the last, going back.
 */
function opening(back: boolean, shown: string | null): Open | null {
  if (document.querySelector('dialog[open]') !== null) return null;
  const snapshot = useAppState.getState().snapshot;
  const rows = recentSessions(useVisitedSessions.getState().ids, snapshot?.sessions?.sessions ?? [], snapshot?.records?.projects ?? [], useChatDrafts.getState().drafts);
  if (!rows.some((entry) => entry.record.id !== shown)) return null;
  const ids = rows.map((entry) => entry.record.id);
  return { ids, at: back ? ids.length - 1 : ids[0] === shown ? 1 : 0, shown };
}

/** Says the highlighted row, as it is now. */
function say(state: Open): void {
  const snapshot = useAppState.getState().snapshot;
  const id = state.ids[state.at];
  const entry = snapshot?.sessions?.sessions.find((candidate) => candidate.record.id === id);
  if (entry === undefined) return;
  announce(switcherRowWords(entry, projectNameOf(snapshot?.records?.projects, entry.record.projectId), state.at, state.ids.length, id === state.shown));
}

/**
 * The keyboard goes to the opened session's input, or to its message list where a reason stands in
 * the input's place. The list takes it quietly (ui/focus.ts): a session opened from here shows no
 * ring around its conversation, and marks no message, until a key is pressed in the list.
 */
function focusChat(id: string): void {
  const chat = document.querySelector<HTMLElement>(`[${CHAT_MARK}="${id}"]`);
  const prompt = chat?.querySelector<HTMLElement>('[data-prompt-area] textarea') ?? null;
  if (prompt !== null) {
    prompt.focus({ preventScroll: true });
    return;
  }
  focusQuietly(chat?.querySelector<HTMLElement>(`[${LIST_MARK}]`));
}

/**
 * The recent sessions switcher (docs/planning/_archive/M100.md, Design 5; C93). Ctrl+Tab opens a list of the
 * sessions in the order they were last used (`recent.ts`), the previous one highlighted; while Ctrl
 * is held Tab and Shift+Tab move the highlight, and releasing Ctrl opens the highlighted session, so
 * a tap goes back to the previous one. Ctrl+Shift+Tab opens it at the last row. Enter and a click
 * open a row; Escape and the window's losing the focus close it with nothing changed. Passing over
 * a session selects nothing, so its attention stays lit until it is opened. Plain Tab is never taken.
 *
 * The keys are heard on the window before anything in the page hears them. The keyboard focus stays
 * where it was while the list is open — each move is said through the announcer — and goes to the
 * opened session's input once its chat is shown.
 *
 * Mounted once, for the window: it also keeps the visits the list is made from.
 */
export function SessionSwitcher() {
  useRecentTracking();
  const [open, setOpen] = useState<Open | null>(null);
  /** The same as `open`, for the listeners, which outlive a render. */
  const live = useRef<Open | null>(null);
  const shown = useRef<string | null>(null);
  /** The session opened from the list, until its chat is shown. */
  const focusOn = useRef<string | null>(null);
  /** Opens a row by its place: the listeners' own step, for a click. */
  const pick = useRef<((index: number) => void) | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const shownChat = useShownChat();
  const shownId = shownChat.kind === 'session' ? shownChat.entry.record.id : null;
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  const projects = useAppState((state) => state.snapshot?.records?.projects);

  useEffect(() => {
    shown.current = shownId;
    if (shownId === null || focusOn.current !== shownId) return;
    focusOn.current = null;
    focusChat(shownId);
  }, [shownId]);

  useEffect(() => {
    const set = (next: Open | null): void => {
      live.current = next;
      setOpen(next);
    };
    const commit = (state: Open): void => {
      set(null);
      const id = state.ids[state.at];
      if (id === undefined || id === state.shown) return;
      focusOn.current = id;
      // As a capsule's press selects (SessionList): the session's chat in place of a chat without a session.
      showDetached(null);
      void selectSession(id).catch(() => undefined);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = live.current;
      if (event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) {
        const count = state?.ids.length ?? 0;
        const next = state === null ? opening(event.shiftKey, shown.current) : { ...state, at: (state.at + (event.shiftKey ? count - 1 : 1)) % count };
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (state === null) focusOn.current = null;
        set(next);
        say(next);
        return;
      }
      if (state === null) return;
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Enter') commit(state);
        else set(null);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control' && live.current !== null) commit(live.current);
    };
    const onBlur = (): void => {
      if (live.current !== null) set(null);
    };
    pick.current = (index) => {
      if (live.current !== null) commit({ ...live.current, at: index });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      pick.current = null;
    };
  }, []);

  // The highlighted row stays in view where the list scrolls.
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open?.at]);

  if (open === null) return null;
  const byId = new Map((sessions ?? []).map((entry) => [entry.record.id, entry]));
  return createPortal(
    <div className={styles.switcher}>
      <p className={styles.caption} aria-hidden="true">
        {SWITCHER_LABEL}
      </p>
      <div ref={list} className={styles.list} role="listbox" aria-label={SWITCHER_LABEL}>
        {open.ids.map((id, index) => {
          const entry = byId.get(id);
          if (entry === undefined) return null;
          const project = projectNameOf(projects, entry.record.projectId);
          return (
            <div
              key={id}
              className={styles.row}
              role="option"
              aria-selected={index === open.at}
              aria-current={id === open.shown ? 'true' : undefined}
              data-switcher-session={id}
              // The focus stays where it was: the list is the keys' and the pointer's, never the focus's.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick.current?.(index)}
            >
              <Avatar providerId={entry.record.providerId} avatar={entry.avatar} size="thin" />
              <span className={styles.text}>
                <span className={styles.name}>{sessionLabel(entry)}</span>
                {project !== null && <span className={styles.project}>{project}</span>}
              </span>
              <span className={styles.status}>{statusWords(entry.summary)}</span>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
