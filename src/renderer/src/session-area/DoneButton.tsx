// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { FLAGS_KEPT_AT_DONE, SESSION_FLAGS, type SessionFlag } from '@shared/contracts/session-flags';
import { isActive, notStarted, type SessionEntry } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { type RunningAction, runningNoticeText, SESSION_FAILED_TEXT } from '../sessions/SessionList';
import { FLAG_WORDS, FlagIcon } from '../sessions/flags';
import { completeWithFlash } from '../sessions/leaving';
import { RESTORE_TEXT, SHELVE_TEXT, UNSHELVE_TEXT } from '../sessions/SessionMenu';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import styles from './SessionArea.module.css';

export const DONE_TEXT = 'Done';
/** What it says before anything has run (M26, round 2): the session is provisional, and this drops it. */
export const CANCEL_TEXT = 'Cancel';
/** What the column of the session's buttons is called. */
export const CORNER_LABEL = 'Done, shelf and tags';
/** What names the flags' buttons together. */
export const MARK_AS_TEXT = 'Mark as';

/** Each button's description, in its tooltip: what a press does. */
const DESCRIPTIONS = {
  done: 'Complete this session',
  cancel: 'Drop this session: nothing of it has run',
  shelve: 'Put this session on its project’s shelf',
  unshelve: 'Take this session off the shelf, back among the active ones',
  restore: 'Bring this session back among the active ones',
  starred: 'Mark as starred',
  toDo: 'Mark as to do (informational only)',
  toVerify: 'Mark as to verify (informational only)',
} as const;

type CornerChannel = 'sessions:remove' | 'sessions:complete' | 'sessions:shelve' | 'sessions:restore';

/** A shelf button: its word, what it asks of main, and what it is named by in the page. */
interface Gray { readonly word: string; readonly channel: 'sessions:shelve' | 'sessions:restore'; readonly kind: 'shelve' | 'unshelve' | 'restore' }
const SHELVE: Gray = { word: SHELVE_TEXT, channel: 'sessions:shelve', kind: 'shelve' };
const UNSHELVE: Gray = { word: UNSHELVE_TEXT, channel: 'sessions:restore', kind: 'unshelve' };
const RESTORE: Gray = { word: RESTORE_TEXT, channel: 'sessions:restore', kind: 'restore' };

/**
 * The session's buttons (docs/planning/_archive/M100.md, Design 4, 6; C31, C50, C92; the maintainer):
 * a column of square buttons, each an icon, at the chat window's top left, in a column of
 * the window's own beside the chat, so never over it. Each is named by its word, and its tooltip says
 * what a press does.
 *
 * First Done, a check, for a selected session that is not completed. It completes the session as the
 * capsule menu's Done does, through the same channel; it is grayed while the session runs, and a race
 * refused by main is explained beside the column (M14, C91, C96). Main clears the selection with the
 * mark, so the window empties under the Done flash (leaving.ts), which covers it and the session's
 * capsule as it goes. Until a turn has run it is Cancel instead, a cross, in a question
 * card's Decline colours (M26, round 2): a session that never ran is not filed under the completed
 * ones, so its press removes it — nothing was sent, and nothing of it is kept — and asks nothing
 * first. The first turn makes it Done.
 *
 * Then the session's way to and from the shelf, as its capsule's menu has it: Shelve, for an active
 * session — refused while it runs, as Done is, and taking the session out of the window as Done does —
 * Shelve is grayed while a turn runs, and a press of it then does nothing (the maintainer);
 * Unshelve, for a session on the shelf, and, for a completed one, Restore then Shelve, putting Restore
 * in the top position Done occupies for an active session. Unshelve and Restore put the session back in
 * the active list. Last, apart, the flags — Starred, To do and To verify, in the menu's order — each a
 * toggle of its flag, as the capsule's menu sets them. The star files nothing on the shelf. To the
 * keyboard the column is one stop, with Up and Down among its buttons.
 */
export function DoneButton({ entry }: { readonly entry: SessionEntry }) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { record } = entry;
  const completed = record.completedAt !== null;
  // A shelved or a completed session has run: Cancel is an active one's alone.
  const fresh = notStarted(entry) && isActive(record);
  const running = entry.summary.status === 'running';
  const grays: readonly Gray[] = fresh ? [] : completed ? [RESTORE, SHELVE] : [record.shelvedAt !== null ? UNSHELVE : SHELVE];
  // The button the column's one stop is on: the last one focused, or the first.
  const [current, setCurrent] = useState<string | null>(null);
  const cells = [...(completed ? [] : ['done']), ...grays.map((gray) => gray.kind), ...(fresh ? [] : SESSION_FLAGS)];
  const stop = current !== null && cells.includes(current) ? current : cells[0];
  const cell = (id: string) => ({ 'data-corner-tool': id, tabIndex: id === stop ? 0 : -1, onFocus: () => setCurrent(id) });

  /** Up and Down move among the column's buttons, which are one stop together. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const found = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-corner-tool]')];
    const at = found.findIndex((tool) => tool === document.activeElement);
    if (at === -1 || found.length < 2) return;
    event.preventDefault();
    found[(at + (event.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length]?.focus();
  };

  /** A flag set or cleared: nothing waits on it, and a failure is said where the others' are. */
  const toggle = (flag: SessionFlag): void => {
    setSaid(null);
    invoke('sessions:setFlag', { id: record.id, flag, on: !record[flag] }).then(
      (answer) => { if (answer.status !== 'saved') setSaid(SESSION_FAILED_TEXT); },
      () => setSaid(SESSION_FAILED_TEXT),
    );
  };

  const run = (channel: CornerChannel, action: RunningAction): void => {
    if (busy) return;
    setSaid(null);
    setBusy(true);
    (channel === 'sessions:complete' ? completeWithFlash(entry) : invoke(channel, { id: record.id })).then(
      (answer) => {
        if (answer.status === 'refused' && answer.reason === 'running') setSaid(runningNoticeText(action, answer.doing));
        else if (answer.status !== 'saved') setSaid(SESSION_FAILED_TEXT);
      },
      () => setSaid(SESSION_FAILED_TEXT),
    ).finally(() => setBusy(false));
  };

  return (
    <div className={styles.done}>
      <div className={styles.rail} data-session-rail="" role="toolbar" aria-orientation="vertical" aria-label={CORNER_LABEL} onKeyDown={onKeyDown}>
        {!completed && (
          <RailButton {...cell('done')} data-audio={fresh ? undefined : "dedicated"} label={fresh ? CANCEL_TEXT : DONE_TEXT} description={fresh ? DESCRIPTIONS.cancel : <DoneDescription />} data-done={fresh ? 'cancel' : ''} busy={busy} unavailable={!fresh && running} onPress={() => run(fresh ? 'sessions:remove' : 'sessions:complete', fresh ? 'removed' : 'completed')}>
            {fresh ? <Icon path="M6 6L18 18M18 6L6 18" /> : <Icon path="M4.5 12.5L9.5 17.5L19.5 6.5" />}
          </RailButton>
        )}
        {grays.map((gray) => (
          <RailButton key={gray.kind} {...cell(gray.kind)} label={gray.word} description={DESCRIPTIONS[gray.kind]} data-audio="dedicated" data-shelve={gray.kind} busy={busy} unavailable={running && gray.kind === 'shelve'} onPress={() => run(gray.channel, 'shelved')}>
            <Icon path={SHELF_PATHS[gray.kind]} />
          </RailButton>
        ))}
        {!fresh && (
          <div className={styles.railFlags} role="group" aria-label={MARK_AS_TEXT}>
            {SESSION_FLAGS.map((flag) => (
              <RailButton key={flag} {...cell(flag)} label={FLAG_WORDS[flag].item} description={DESCRIPTIONS[flag]} pressed={record[flag]} data-corner-flag={flag} onPress={() => toggle(flag)}>
                <FlagIcon flag={flag} size={15} />
              </RailButton>
            ))}
          </div>
        )}
      </div>
      {said !== null && <p className={styles.doneNotice} role="status">{said}</p>}
    </div>
  );
}

/**
 * Done's description (the maintainer): what it does, then the flags it clears and the ones
 * it keeps, each by its mark and its word — read from the rule Done follows in main, so the two never
 * part. Each line ends in its own stop and space, so a screen reader reads three sentences.
 */
function DoneDescription() {
  const cleared = SESSION_FLAGS.filter((flag) => !FLAGS_KEPT_AT_DONE.includes(flag));
  return (
    <span className={styles.doneTip}>
      <span>{DESCRIPTIONS.done}. </span>
      {cleared.length > 0 && <span>Clears <FlagList flags={cleared} />. </span>}
      {FLAGS_KEPT_AT_DONE.length > 0 && <span>Keeps <FlagList flags={FLAGS_KEPT_AT_DONE} />.</span>}
    </span>
  );
}

/** Flags in words, each after its mark: "To do and To verify". */
function FlagList({ flags }: { readonly flags: readonly SessionFlag[] }) {
  return flags.map((flag, index) => (
    <span key={flag} className={styles.tipFlagWord}>
      {index === 0 ? '' : index === flags.length - 1 ? ' and ' : ', '}
      <span className={styles.tipFlag} aria-hidden="true"><FlagIcon flag={flag} size={10} /></span>
      {FLAG_WORDS[flag].item}
    </span>
  ));
}

/** The shelf's icons: a shelf with an arrow down onto it, one up from it, and a turn back for Restore. */
const SHELF_PATHS: Readonly<Record<Gray['kind'], string>> = {
  shelve: 'M12 3V12M8.5 8.5L12 12L15.5 8.5M3 16H21M5 16V20M19 16V20',
  unshelve: 'M12 12V3M8.5 6.5L12 3L15.5 6.5M3 16H21M5 16V20M19 16V20',
  restore: 'M9 14L4 9L9 4M4 9H15A5 5 0 0 1 15 19H11',
};

function Icon({ path }: { readonly path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d={path} stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

/** A square button of the column: its icon, named by its word, its description in a tooltip. */
function RailButton({ label, description, pressed, busy = false, unavailable = false, onPress, children, ...rest }: {
  readonly label: string;
  readonly description: ReactNode;
  readonly pressed?: boolean;
  readonly busy?: boolean;
  /** Grayed, its press doing nothing, its tooltip still shown. */
  readonly unavailable?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
  readonly tabIndex: number;
  readonly onFocus: () => void;
  readonly 'data-corner-tool': string;
  readonly 'data-done'?: string;
  readonly 'data-shelve'?: string;
  readonly 'data-corner-flag'?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const { onFocus, ...targetProps } = tooltip.targetProps;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.railButton}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={busy || unavailable || undefined}
        data-unavailable={busy || unavailable || undefined}
        {...rest}
        {...targetProps}
        onFocus={() => {
          onFocus();
          rest.onFocus();
        }}
        onClick={unavailable ? undefined : onPress}
      >
        {children}
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor} side="right">
        {description}
      </Tooltip>
    </>
  );
}
