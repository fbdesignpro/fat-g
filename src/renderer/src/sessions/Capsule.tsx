// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { normalizeSessionName, SESSION_NAME_MAX_GRAPHEMES } from '@shared/contracts/names';
import type { SessionFlag } from '@shared/contracts/session-flags';
import { groupOfSession, inPlan, MAX_LINE_INPUT, NEW_SESSION_TEXT, notStarted, planWaitShown, type SessionEntry, type SessionSummary, statusWords, workersText } from '@shared/contracts/sessions';
import { focusQuietly } from '../ui/focus';
import { useChatDrafts } from '../chat/chat-store';
import { useNewSession } from '../new-session/new-session-store';
import { menuStyles, Popup } from '../ui/Popup';
import { useMenu } from '../ui/useMenu';
import { cancelNewSession, CANCEL_NEW_SESSION } from './cancel-new-session';
import { Avatar, useBarColor } from './Avatar';
import { CapsuleStatus } from './CapsuleStatus';
import { canCleanUp } from './clean-up-target';
import { FlagMarks, setFlags, spokenFlags } from './flags';
import { SessionMenu } from './SessionMenu';
import styles from './Sessions.module.css';

export interface CapsuleProps {
  readonly entry: SessionEntry;
  /** What the session is shown by: its name, or its creation time while it has none (C8). */
  readonly name: string;
  readonly selected: boolean;
  readonly column: RefObject<HTMLElement | null>;
  /** `byPointer`: a press of the pointer, not a key — what hands the keyboard to the chat's prompt (M100b, C61). */
  readonly onSelect: (byPointer: boolean) => void;
  readonly onFlag: (flag: SessionFlag, on: boolean) => void;
  readonly onComplete: () => void;
  readonly onShelve: () => void;
  /** Null while removal is not offered (M18, C42). */
  readonly onRemove: (() => void) | null;
  /** A name the user typed (M26): normalized as main will, never empty, and only when it changed. */
  readonly onRename: (name: string) => void;
  /** Alt+Up and Alt+Down on the select button (C90). */
  readonly onStep: (direction: -1 | 1) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  /** Whether the press that just ended was a drag: its click selects nothing (C55). */
  readonly wasDragged: () => boolean;
  /** While this capsule is dragged: its copy follows the pointer, and its place is drawn empty. */
  readonly lifted: boolean;
  /** How far it moves out of the way of a dragged capsule, in pixels. */
  readonly shift: number;
  /** Its menu opened or closed (SessionMenu). */
  readonly onMenuChange?: (open: boolean) => void;
}

/**
 * An active session (M14, C40–C44; docs/planning/_archive/M100.md, Design 5; C24, C53): a box, one button that
 * selects it — the avatar at the box's full height, the name on at most two lines and under it the
 * status row — with the `…` button at its top right and the marks of its flags under it, both above
 * the bar. The button and the menu are siblings: nothing is nested inside another control, and the menu
 * does not select. The marks are no control: a press on them, or on the empty place under the `…`, is
 * the capsule's.
 *
 * The button's accessible name is the session's name, then its status or its attention in words —
 * a running session's whole label, its detail with it — so the attention is never signalled by
 * colour alone (C43, C52) — then its flags, which the marks never say.
 *
 * A session not started has no status row or flags. Its title begins with the draft's opening text,
 * behind "New session: ", until the secretary names it. A cross and a right-click menu cancel it.
 * Which of them show no capsule at all is
 * `SessionList`'s to say. One that takes part in a plan is drawn as a started one, its status row
 * saying the plan's state (decision 0029).
 */
export function Capsule({ entry, name, selected, column, onSelect, onFlag, onComplete, onShelve, onRemove, onRename, onStep, onPointerDown, wasDragged, lifted, shift, onMenuChange }: CapsuleProps) {
  const { record, summary } = entry;
  const barColor = useBarColor(record.providerId);
  const [renaming, setRenaming] = useState(false);
  const select = useRef<HTMLButtonElement>(null);
  const draft = useChatDrafts((state) => state.drafts[record.id] ?? '');
  const sent = useNewSession((state) => state.sent.has(record.id));
  const { open: cancelOpen, setOpen: setCancelOpen, close: closeCancel, button: cancelButton, menuProps: cancelMenuProps } = useMenu();
  const [cancelling, setCancelling] = useState(false);
  const [cancelProblem, setCancelProblem] = useState(false);
  const cancel = async (): Promise<void> => {
    if (cancelling) return;
    setCancelling(true);
    setCancelProblem(false);
    closeCancel(false);
    try { if (!await cancelNewSession(record.id)) setCancelProblem(true); }
    catch { setCancelProblem(true); }
    finally { setCancelling(false); }
  };
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) return;
    refocus.current = false;
    focusQuietly(select.current);
  }, [renaming]);
  /** The field's end: its name kept where it says something new, and the focus back on the capsule after a key. */
  const finish = (typed: string | null, byKey: boolean): void => {
    if (typed !== null) {
      const next = normalizeSessionName(typed);
      if (next !== '' && next !== name) onRename(next);
    }
    refocus.current = byKey;
    setRenaming(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    onStep(event.key === 'ArrowUp' ? -1 : 1);
  };

  const fresh = notStarted(entry) && !inPlan(summary) && entry.planPending !== true && !sent;
  // The name it was given before anything ran, "New session: " and all (`sessionLabel`), or none yet.
  const typed = fresh && record.name === null ? normalizeSessionName(draft.slice(0, MAX_LINE_INPUT)) : '';
  const given = fresh ? record.name !== null ? name : typed === '' ? null : `${NEW_SESSION_TEXT}: ${typed}` : null;

  return (
    <li
      className={styles.capsule}
      data-session-id={record.id}
      data-group={groupOfSession(record)}
      data-selected={selected || undefined}
      data-lifted={lifted || undefined}
      data-clean-up-target={canCleanUp(entry) || undefined}
      onContextMenu={fresh && onRemove !== null ? (event) => { event.preventDefault(); setCancelOpen(true); } : undefined}
      style={{ ...(barColor === undefined ? {} : { '--bar-color': barColor }), ...(shift === 0 ? {} : { transform: `translateY(${shift}px)` }), ...(fresh ? {} : { '--flag-count': setFlags(record).length }) }}
    >
      {renaming ? (
        <div className={styles.select} data-renaming="">
          <Avatar providerId={record.providerId} avatar={entry.avatar} size="capsule" effort={summary.effort} fast={record.speed !== null} />
          <RenameField name={name} onDone={finish} />
        </div>
      ) : (
      <button
        ref={select}
        type="button"
        className={styles.select}
        aria-label={fresh ? given ?? `${NEW_SESSION_TEXT}, ${name}` : `${name}, ${spokenStatus(summary)}${spokenFlags(record)}`}
        aria-current={selected ? 'true' : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        data-select-session={record.id}
        onClick={(event) => {
          // A click a key made has no count (`detail` 0): only the pointer's hands the keyboard on.
          if (!wasDragged()) onSelect(event.detail > 0);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <Avatar providerId={record.providerId} avatar={entry.avatar} size="capsule" effort={summary.effort} fast={record.speed !== null} />
        {fresh ? (
          <span className={styles.newSession}>
            <span>{given ?? NEW_SESSION_TEXT}</span>
          </span>
        ) : (
          <span className={styles.body}>
            <span className={styles.name}>{name}</span>
            <CapsuleStatus summary={summary} providerId={record.providerId} />
          </span>
        )}
      </button>
      )}
      {fresh ? onRemove !== null && <div className={styles.side}>
        <button ref={cancelButton} type="button" className={styles.sideButton} aria-label={`${CANCEL_NEW_SESSION}: ${given ?? name}`} title={CANCEL_NEW_SESSION} disabled={cancelling} onClick={() => void cancel()}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
        </button>
      </div> : (
        <div className={styles.side}>
          <SessionMenu sessionId={record.id} name={name} completed={false} column={column} flags={record} onFlag={onFlag} onComplete={onComplete} onShelve={onShelve} onRemove={onRemove} onRename={() => setRenaming(true)} onOpenChange={onMenuChange} />
          <FlagMarks record={record} />
        </div>
      )}
      {fresh && cancelProblem && <p className={styles.problem} role="status">This new session could not be cancelled.</p>}
      {fresh && cancelOpen && onRemove !== null && <Popup anchor={cancelButton}>
        <div {...cancelMenuProps} aria-label={`Actions for ${given ?? NEW_SESSION_TEXT}`} className={menuStyles.menu}>
          <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} disabled={cancelling} onClick={() => void cancel()}>{CANCEL_NEW_SESSION}</button>
        </div>
      </Popup>}
    </li>
  );
}

/**
 * The session's name as a field (M26): the whole name selected, Enter or leaving it keeps what it
 * holds, Escape keeps nothing. At most the session title's bound; main normalizes it again.
 */
function RenameField({ name, onDone }: { readonly name: string; readonly onDone: (typed: string | null, byKey: boolean) => void }) {
  const done = useRef(false);
  const end = (typed: string | null, byKey: boolean): void => {
    if (done.current) return;
    done.current = true;
    onDone(typed, byKey);
  };
  return (
    <input
      className={styles.renameField}
      aria-label="Session name"
      defaultValue={name}
      maxLength={SESSION_NAME_MAX_GRAPHEMES}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); end(event.currentTarget.value, true); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(null, true); }
      }}
      onBlur={(event) => end(event.currentTarget.value, false)}
    />
  );
}

/** The status in words, with the worker count a sighted reader gets in the bar. */
function spokenStatus(summary: SessionSummary): string {
  const words = statusWords(summary);
  return summary.attention === null && planWaitShown(summary) === null && summary.activeWorkers > 0 ? `${words}, ${workersText(summary.activeWorkers)}` : words;
}
