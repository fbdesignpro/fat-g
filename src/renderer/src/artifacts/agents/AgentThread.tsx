// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useMemo, useState } from 'react';
import { shownLabel } from '@shared/contracts/instances';
import { findModel } from '@shared/contracts/catalog';
import { durationWords, statusWords } from '../../chat/activity-words';
import { WorkerOpenContext } from '../../chat/ActivityGroup';
import { subAgentName } from '../../chat/card-words';
import { AsideSourceContext, type AsideSourceScope } from '../../chat/ExplainControl';
import { CardContext, type CardScope } from '../../chat/InteractionCard';
import { MessageList } from '../../chat/MessageList';
import { OpenerContext } from '../../markdown/inert';
import { useDeclines, usePermissions } from '../../session-area/selected';
import { useSessionClock } from '../../sessions/session-clock';
import { useAppState } from '../../state/store';
import { createOpener, openAgent } from '../opener';
import { useWorkerChat } from './useWorkerChat';
import { THREAD_WORDS, threadTitle, WORKER_REFUSALS } from './words';
import styles from './Agents.module.css';

/** The attribute that marks a sub-agent's list: the chat's own mark is the chat's alone. */
export const WORKER_LIST_MARK = 'data-worker-list';

export interface AgentThreadProps {
  readonly sessionId: string;
  readonly workerId: string;
  /** The region's id, which its row's `aria-controls` names. */
  readonly id: string;
  /** The sub-agent's label as its row shows it, or as whoever chose it handed it. */
  readonly label: string | null;
  /**
   * A thread opened for a sub-agent the list no longer holds (M106, C24): it draws its own head in its
   * row's place — the label, the status and the duration its item reads — whose press folds it.
   */
  readonly onFold?: () => void;
}

/**
 * A sub-agent's thread (docs/planning/_archive/M106.md, Design 7; C22–C25, C42; docs/planning/_archive/M20a.md,
 * Design 9; C47–C50): what the sub-agent did and said, drawn under its row as the chat draws a
 * session's — its messages as Markdown, its activity in groups, in one list with the chat's entries
 * and its keyboard. It has no head of its own: its row says the label, the state, the time and the
 * model. It reads when it unfolds, follows the session's pushes that name this sub-agent while it is
 * unfolded, and holds nothing once folded (C22): it is unmounted then. It takes no prompt.
 *
 * A question the sub-agent asks, and an action it asks leave for, are cards in its list (M21, C37,
 * C42, C74, C79; M22, C11, C14, C36), drawn by the chat's own component, named "Sub-agent" with its
 * label, and answered from here; their raising is posted by the chat's region alone. An answer with
 * no mark reads unconfirmed only once the sub-agent no longer runs.
 *
 * Its text is drawn with the session's own opener, so a file it names opens as a tab beside it, and a
 * worker row of its own chooses that sub-agent in this tab (C4). A message of it is the source of an
 * aside as the session's are (M20b, C47).
 */
export function AgentThread({ sessionId, workerId, id, label, onFold }: AgentThreadProps) {
  const chat = useWorkerChat(sessionId, workerId);
  const { view, worker, refused } = chat;
  const body = worker?.activity ?? null;
  const running = body?.status === 'running';
  const now = useSessionClock(running && onFold !== undefined);
  const record = useAppState((state) => state.snapshot?.sessions?.sessions.find((entry) => entry.record.id === sessionId)?.record);
  const providerId = record?.providerId ?? '';
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const nameModel = useCallback((key: string): string => record === undefined ? key : findModel(catalog, record, key).name, [catalog, record]);
  const providerName = useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId);
  // Its session's provider and account (M22, C14, C56): what an approval's card names a mode by, and the account it says it belongs to.
  const account = useAppState((state) => (record === undefined ? null : shownLabel(state.snapshot?.providers ?? [], record)));
  const permissions = usePermissions(providerId);
  const declines = useDeclines(providerId);
  const opener = useMemo(() => createOpener(sessionId), [sessionId]);
  const onOpenWorker = useCallback((other: string, otherLabel: string): void => { openAgent(sessionId, other, otherLabel); }, [sessionId]);
  const sources = useMemo((): AsideSourceScope => ({ sessionId, workerId }), [sessionId, workerId]);
  // As tall as what it holds until it fills its bound, then framed at it (C40): by the sub-agent whose list filled it.
  const [fullOf, setFullOf] = useState<string | null>(null);
  const full = fullOf === workerId;
  const onFull = useCallback((filled: boolean): void => { setFullOf(filled ? workerId : null); }, [workerId]);

  const read = body?.summary;
  const named = threadTitle(label ?? read);
  // Whose questions the list's cards are (M21, C37, C79): the sub-agent's, and whether it still runs. Null until its item is read: nothing is called unconfirmed before then.
  const workerRunning = body === null ? null : running;
  const asker = subAgentName(label ?? read ?? null);
  const cards = useMemo((): CardScope => ({ sessionId, providerName, asker, running: false, workerRunning, account, permissions, declines }), [sessionId, providerName, asker, workerRunning, account, permissions, declines]);
  const duration = onFold !== undefined && worker !== null && body !== null ? durationWords(worker, body, now) : null;
  const nothing = refused === null && view !== null && view.items.length === 0 && view.older === null && !running;

  return (
    <>
      {onFold !== undefined && (
        <button type="button" className={styles.head} aria-expanded="true" aria-controls={id} data-agent-head={workerId} onMouseDown={(event) => event.preventDefault()} onClick={onFold}>
          <span className={styles.headLabel} title={named}>{named}</span>
          {body !== null && <span className={styles.headStatus}>{statusWords(body)}</span>}
          {duration !== null && <span className={styles.headDuration}>{duration}</span>}
        </button>
      )}
      <div id={id} className={full ? `${styles.thread} ${styles.full}` : styles.thread} role="region" aria-label={named} data-agent-thread={workerId} data-worker-status={body?.status}>
        {refused !== null && <p className={styles.state}>{WORKER_REFUSALS[refused]}</p>}
        {nothing && <p className={styles.state}>{THREAD_WORDS.empty}</p>}
        {refused === null && (
          <div className={styles.items}>
            <OpenerContext value={opener}>
              <WorkerOpenContext value={onOpenWorker}>
                <AsideSourceContext value={sources}>
                  <CardContext value={cards}>
                    <MessageList view={view} busy={chat.busy} copySource={{ kind: 'worker', sessionId, workerId }} modelName={nameModel(body?.model ?? record?.model ?? 'Assistant')} providerName={providerName} sessionId={sessionId} providerId={providerId} modelKey={record?.model ?? 'Assistant'} workerId={workerId} worker={worker} nameModel={nameModel} onShowEarlier={chat.showEarlier} onShowLatest={() => void chat.showLatest()} label={THREAD_WORDS.list} mark={WORKER_LIST_MARK} turnLines={false} announceQuestions={false} fit={!full} onFull={onFull} />
                  </CardContext>
                </AsideSourceContext>
              </WorkerOpenContext>
            </OpenerContext>
          </div>
        )}
      </div>
    </>
  );
}
