// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, useContext, useId, useState } from 'react';
import type { ConversationItem } from '@shared/contracts/conversation';
import { PathReference } from '../markdown/controls';
import { useTabStop } from '../markdown/inert';
import { useSessionClock } from '../sessions/session-clock';
import { ActivityDetail } from './ActivityDetail';
import { ACTIVITY_LABELS, durationWords, hasDetail, NOT_RUN_WORDS, rowWords, statusWords } from './activity-words';
import { CARD_WORDS } from './card-words';
import { CardContext } from './InteractionCard';
import { useWorkerWaits } from './questions-store';
import styles from './Chat.module.css';

/**
 * The mark a disclosure shows: it points down while what it opens is shown. Drawn by the stylesheet
 * from a plain element: the chat's list, and a worker's, hold no image and no drawing of any kind,
 * so that nothing a conversation's text could ask for is ever mistaken for the page's own (M19, C31).
 */
export function Chevron({ open }: { readonly open: boolean }) {
  return <span className={styles.chevronMark} data-open={open ? '' : undefined} aria-hidden="true" />;
}

export interface ActivityRowProps {
  readonly item: ConversationItem;
  /** Opens a worker's tab, where the row may: null in a chat with no session and no pane (C46). */
  readonly onOpenWorker: ((workerId: string, label: string) => void) | null;
  /** Its leave never came: its card was withdrawn or dropped before any decision (M22, C110). Said as asked for, and not run. */
  readonly unrun?: boolean;
}

/**
 * One activity of a group, in one row (docs/planning/_archive/M20a.md, Design 8; C37–C41, C45): the kind's
 * word, what it is said of, its duration — counting from the page's clock while it runs — and its
 * status in words. A row with something to open has a disclosure of its own, which opens to its
 * detail; a wait has none. A thinking item has no row (C9): the group leaves it out.
 *
 * A file the row names, a read's and an edit's, is a control through the opener (C38), beside the
 * disclosure and never inside it: no control holds another (M19b, C57). A worker's row has an Open
 * button where a worker is paired with it (C40); a launch that failed reads its error and has none.
 * While a question of that worker's waits for an answer, its row says so in place of its status
 * (M21, C42, C73): the card is in the worker's tab, which the Open button shows. An approval of its
 * that waits is said the same way (M22, C36). An action that was refused leave reads declined, with
 * who declined it where that is known, and no exit code (M22, C76).
 *
 * Drawn again only when its own item changes (C44): an update to one activity leaves every other row.
 */
export const ActivityRow = memo(function ActivityRow({ item, onOpenWorker, unrun = false }: ActivityRowProps) {
  const body = item.activity;
  const [open, setOpen] = useState(false);
  const stop = useTabStop();
  const detailId = useId();
  const now = useSessionClock(body?.status === 'running');
  const scope = useContext(CardContext);
  const waits = useWorkerWaits(scope?.sessionId ?? null, body?.type === 'worker' ? body.workerId : null);
  if (body === null || body.type === 'thinking') return null;
  // Asked for and never run: declined, or never given leave (M22, C76, C110).
  const asked = unrun || body.status === 'declined';
  const words = rowWords(body, asked);
  const named = [words.word, words.file?.name ?? words.text ?? ''].filter((part) => part !== '').join(' ');
  const opens = hasDetail(body);
  const duration = durationWords(item, body, now, asked);
  const paired = body.type === 'worker' ? body.workerId : null;
  return (
    <li className={styles.activityRow} data-activity={body.type} data-status={body.status} data-not-run={unrun ? '' : undefined} data-waits={waits ?? undefined}>
      <div className={styles.activityHead}>
        {opens ? (
          <button type="button" className={styles.disclosure} aria-expanded={open} aria-controls={detailId} aria-label={(open ? ACTIVITY_LABELS.hide : ACTIVITY_LABELS.show)(named)} tabIndex={stop} onClick={() => setOpen((shown) => !shown)}>
            <Chevron open={open} />
          </button>
        ) : (
          <span className={styles.disclosureGap} aria-hidden="true" />
        )}
        {/* One run of text, its parts apart by real spaces: a row copies as it reads, "Ran rg 2 s Completed". */}
        <span className={styles.activityLine} data-row-line="">
          <span className={styles.activityWord}>{words.word}</span>
          {words.file !== null && <>{' '}<PathReference path={words.file.path} line={words.file.line}>{words.file.name}</PathReference></>}
          {words.text !== null && <>{' '}<span className={styles.activityText}>{words.text}</span></>}
          {words.more !== null && <>{' '}<span className={styles.activityMore}>{words.more}</span></>}
          {duration !== null && <>{' '}<span className={styles.activityTime}>{duration}</span></>}
          {' '}
          <span className={styles.activityStatus}>{waits === 'question' ? CARD_WORDS.rowWaits : waits === 'approval' ? CARD_WORDS.rowWaitsApproval : unrun ? NOT_RUN_WORDS : statusWords(body)}</span>
        </span>
        {paired !== null && onOpenWorker !== null && (
          <button type="button" className={styles.inlineButton} tabIndex={stop} data-open-worker={paired} onClick={() => onOpenWorker(paired, body.summary)}>
            {ACTIVITY_LABELS.openWorker}
          </button>
        )}
      </div>
      {/* Drawn only once opened (C44). */}
      {opens && open && (
        <div id={detailId} className={styles.activityDetail}>
          <ActivityDetail item={item} body={body} />
        </div>
      )}
    </li>
  );
});
