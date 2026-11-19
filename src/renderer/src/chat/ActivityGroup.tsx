// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createContext, memo, useContext, useMemo } from 'react';
import type { ConversationItem } from '@shared/contracts/conversation';
import { lastPart } from '@shared/contracts/files';
import { TabStopContext } from '../markdown/inert';
import { useSessionClock } from '../sessions/session-clock';
import { formatElapsed } from '../ui/format';
import { ActivityRow, Chevron } from './ActivityRow';
import { ACTIVITY_LABELS, groupSpan, groupWords, rowsOf } from './activity-words';
import { setGroupOpen, useGroupChoices } from './chat-store';
import { AsideSourceContext } from './ExplainControl';
import { imageRead } from './image-files';
import { ImageFileStrip } from './ImageFileStrip';
import styles from './Chat.module.css';

/**
 * What a worker row's Open button calls (docs/planning/_archive/M20a.md, Design 8, 9; C40, C47): given by
 * whoever has a pane to open a worker's tab in — a session's chat, a worker's own tab — and by no
 * one for a chat without a session (C46), whose worker rows then have no Open button.
 */
export const WorkerOpenContext = createContext<((workerId: string, label: string) => void) | null>(null);

export interface ActivityGroupProps {
  /** The consecutive activities of a turn between two messages: one entry of the list (C31, C36). */
  readonly items: readonly ConversationItem[];
  /** The element's id: what the list names as its current entry (C42). */
  readonly id?: string;
  /** The keyboard's current entry: its own controls are stops in the tab order, and no other entry's are. */
  readonly current?: boolean;
  /** The ids of its items whose leave never came — their cards withdrawn or dropped before any decision (M22, C110) — joined by spaces: a string, so the group is drawn again only when it changes. */
  readonly unrun?: string;
}

/** Two lists that hold the very same items: a group is drawn again only when one of its own changed (C44). */
export const sameItems = (a: readonly ConversationItem[], b: readonly ConversationItem[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * A group of activity (docs/planning/_archive/M20a.md, Design 8; C36, C42–C45): what a session did between
 * two of its messages, as one entry of the list. Its summary line says, in fat-g's words, what was
 * done and how long it took — "Read 3 files, searched twice, ran 1 command · 14 s" — and is the
 * control that opens it to its rows.
 *
 * Closed until the reader opens it: no ending of an action opens it by itself (maintainer).
 * A group that opened when an item failed, never finished or was declined (round 9,
 * C83) unrolled under a reader who was reading something else, and one that opened at an action's
 * start and closed again at its end flickered through its rows. What became of an action is said
 * by the line instead — "Ran 2 commands, 1 failed" — and its row is a press away. The reader's
 * own opening or closing is kept for the run, and no later item undoes it.
 *
 * A closed group draws its line alone (C44), an open one its rows, and a row its detail only once
 * opened. It is given its items and nothing else of the chat (C43): the opener and the way to open
 * a worker's tab reach it as they reach a message, so a worker's tab draws its groups with it too.
 *
 * A group whose items are all thinking draws nothing (C9).
 *
 * The images its agent read are drawn under its line, open or closed (decision 0022, item 15): a
 * picture the agent looked at is the user's to see too, as the CLIs' own apps show it, and the fold
 * stays as the reader left it. A press on one opens it in the pane.
 */
export const ActivityGroup = memo(function ActivityGroup({ items, id, current = false, unrun = '' }: ActivityGroupProps) {
  const rows = useMemo(() => rowsOf(items), [items]);
  const notRun = useMemo(() => new Set(unrun === '' ? [] : unrun.split(' ')), [unrun]);
  const key = items[0]?.id ?? '';
  const chosen = useGroupChoices((state) => state.choices[key]);
  const onOpenWorker = useContext(WorkerOpenContext);
  const sessionId = useContext(AsideSourceContext)?.sessionId ?? null;
  const images = useMemo(() => [...new Set(rows.flatMap(({ body }) => { const path = imageRead(body); return path === null ? [] : [path]; }))].map((path) => ({ target: path, name: lastPart(path) })), [rows]);
  const running = rows.some((row) => row.body.status === 'running');
  const now = useSessionClock(running);
  if (rows.length === 0) return null;
  const open = chosen ?? false;
  // A group of actions that were only asked for — declined, or never given leave — took no time of their own to tell (M22, C107, C110).
  const span = rows.every(({ item, body }) => body.status === 'declined' || notRun.has(item.id)) ? null : groupSpan(rows, now);
  return (
    <article id={id} className={styles.group} data-role="activity" data-current={current ? '' : undefined} data-open={open ? '' : undefined} aria-label={ACTIVITY_LABELS.group} aria-busy={running ? true : undefined}>
      <TabStopContext value={current}>
        <button type="button" className={styles.groupHead} aria-expanded={open} tabIndex={current ? 0 : -1} onClick={() => setGroupOpen(key, !open)}>
          <Chevron open={open} />
          {/* One run of text, so the space before its time is kept when it is copied. */}
          <span className={styles.groupWords}>
            {groupWords(rows, notRun)}
            {span !== null && <span className={styles.groupSpan}> · {formatElapsed(span.ms)}</span>}
          </span>
        </button>
        {sessionId !== null && <ImageFileStrip sessionId={sessionId} targets={images} missing tabIndex={current ? 0 : -1} />}
        {open && (
          <ul className={styles.activityRows}>
            {rows.map(({ item }) => <ActivityRow key={item.id} item={item} onOpenWorker={onOpenWorker} unrun={notRun.has(item.id)} />)}
          </ul>
        )}
      </TabStopContext>
    </article>
  );
}, (before, after) => before.id === after.id && before.current === after.current && sameItems(before.items, after.items));
