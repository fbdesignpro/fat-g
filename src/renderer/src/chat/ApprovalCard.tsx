// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, useContext, useId, useState } from 'react';
import { fileName } from '@shared/contracts/activity';
import type { ConversationItem, ConversationTurn } from '@shared/contracts/conversation';
import { type ApprovalChange, type ApprovalChoice, approvalOf, type ApprovalRequest, APPROVAL_WORDS, approvalWords, authorityWords, isDecided } from '@shared/contracts/interaction';
import { modeOf } from '@shared/contracts/permissions';
import { invoke } from '../ipc/client';
import { CodeText } from '../markdown/CodeText';
import { PathReference } from '../markdown/controls';
import { TabStopContext } from '../markdown/inert';
import { Chevron } from './ActivityRow';
import { APPROVAL_LABELS, approvalHead, changeTitle, DECIDE_FAILED_TEXT, decideRefusalText, grantWords, scopeWords, STOP_FAILED_TEXT } from './approval-words';
import { CardContext, type CardScope, CardTime, carrierOver, useSettledFocus } from './InteractionCard';
import styles from './Chat.module.css';

export interface ApprovalCardProps {
  readonly item: ConversationItem;
  /** Who asks, in the session's own list: its provider, by the name fat-g's words use (C14). A worker's tab names the worker instead. */
  readonly providerName: string;
  /** The element's id: what the list names as its current entry. */
  readonly id?: string;
  /** The keyboard's current entry: its own controls are stops in the tab order, and no other entry's are. */
  readonly current?: boolean;
  /** Message times are shown (M19, C41, C42). */
  readonly times?: { readonly today: number } | null;
  /** The item's own turn, where the list holds it: what says that a decision with no mark was never confirmed (M21, C68). */
  readonly carrier?: ConversationTurn | undefined;
}

/** One file of a change (C9, C48): an edit by match as the text it replaces and then the text it puts, its scope said with the first; any other as its one text. */
function Change({ change }: { readonly change: ApprovalChange }) {
  if (change.replace !== null) {
    return (
      <>
        <CodeText title={changeTitle(change, 'old')} copyLabel={APPROVAL_LABELS.copyChange} text={() => change.replace ?? ''}>
          <code>{change.replace}</code>
        </CodeText>
        {change.text !== null && (
          <CodeText title={changeTitle(change, 'new')} copyLabel={APPROVAL_LABELS.copyChange} text={() => change.text ?? ''}>
            <code>{change.text}</code>
          </CodeText>
        )}
      </>
    );
  }
  if (change.text === null) return <p className={styles.activityChange}>{changeTitle(change, 'whole')}. {APPROVAL_LABELS.noText}</p>;
  return (
    <CodeText title={changeTitle(change, 'whole')} copyLabel={APPROVAL_LABELS.copyChange} text={() => change.text ?? ''}>
      <code>{change.text}</code>
    </CodeText>
  );
}

/**
 * The whole action (C9, C48), drawn only once its disclosure is opened: a command, each file of a
 * change, or a tool's input, as text in the monospace font with a Copy button of its own. It is
 * text, whatever it holds: no control is made from it, and no file is read to fill it — what a
 * request did not carry is not shown. On a live card it is whole, up to its bound; on a restored
 * one it is what the store kept, and a line says so.
 */
function Detail({ request }: { readonly request: ApprovalRequest }) {
  const { detail } = request;
  return (
    <>
      {detail.kind === 'command' && (
        <CodeText title={APPROVAL_LABELS.command} copyLabel={APPROVAL_LABELS.copyCommand} text={() => detail.command}>
          <code>{detail.command}</code>
        </CodeText>
      )}
      {detail.kind === 'changes' && detail.changes.map((change, index) => <Change key={index} change={change} />)}
      {detail.kind === 'input' && detail.text !== '' && (
        <CodeText title={APPROVAL_LABELS.input} copyLabel={APPROVAL_LABELS.copyInput} text={() => detail.text}>
          <code>{detail.text}</code>
        </CodeText>
      )}
      {request.cut && <p className={styles.line} data-item-line="cut">{APPROVAL_WORDS.cut}</p>}
    </>
  );
}

interface ActionsProps {
  readonly item: ConversationItem;
  readonly request: ApprovalRequest;
  readonly scope: CardScope;
  readonly stop: number;
}

/**
 * A pending card's choices (C13, C56): the ones its request lists and no other — Approve once, the
 * session grant in its own words where the request is eligible for one, and Deny — and Stop, which
 * is the session's own. None is marked as the one to press, none has the focus at arrival, and
 * nothing is sent until one is pressed. A refusal is said under them; a stale press says nothing by
 * itself, since the item's push brings the card's state on any page (M21, C71).
 *
 * While a decision is on its way the choices are said unavailable and take no second press, and are
 * never disabled: a disabled button cannot hold the focus, which the page's body would take before
 * the card settles and hands it to its list.
 */
function Actions({ item, request, scope, stop }: ActionsProps) {
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A card that settles takes its controls away, and hands the focus to its list (M21, C39, C43).
  const actions = useSettledFocus();

  const decide = (choice: ApprovalChoice): void => {
    if (sending) return;
    setProblem(null);
    setSending(true);
    invoke('chat:decide', { sessionId: scope.sessionId, itemId: item.id, choice }).then(
      (answer) => { if (answer.status === 'refused') setProblem(decideRefusalText(answer.reason, scope.providerName)); },
      () => { setProblem(DECIDE_FAILED_TEXT); },
    ).finally(() => { setSending(false); });
  };

  const stopSession = (): void => {
    setProblem(null);
    invoke('chat:stop', { sessionId: scope.sessionId }).then(
      // A session that no longer runs has nothing to stop: its end brings the card's state.
      (answer) => { if (answer.status === 'refused' && answer.reason !== 'not-running') setProblem(STOP_FAILED_TEXT); },
      () => { setProblem(STOP_FAILED_TEXT); },
    );
  };

  const offered = (choice: ApprovalChoice): boolean => request.choices.includes(choice);
  return (
    <>
      <div className={styles.cardActions} ref={actions}>
        {offered('approve') && (
          <button type="button" className={styles.button} data-approval-choice="approve" aria-disabled={sending || undefined} tabIndex={stop} onClick={() => decide('approve')}>
            {APPROVAL_WORDS.approve}
          </button>
        )}
        {/* The CLI's own session grant, by what it covers (C56): a choice of its own, and never the active one. */}
        {offered('approve-session') && request.grant !== null && (
          <button type="button" className={`${styles.button} ${styles.approvalGrant}`} data-approval-choice="approve-session" aria-disabled={sending || undefined} tabIndex={stop} onClick={() => decide('approve-session')}>
            {APPROVAL_WORDS.approveSession(request.grant.covers)}
          </button>
        )}
        {offered('deny') && (
          <button type="button" className={styles.button} data-approval-choice="deny" aria-disabled={sending || undefined} tabIndex={stop} onClick={() => decide('deny')}>
            {APPROVAL_WORDS.deny}
          </button>
        )}
        <button type="button" className={styles.button} data-approval-stop="" tabIndex={stop} onClick={stopSession}>
          {APPROVAL_WORDS.stop}
        </button>
      </div>
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </>
  );
}

/**
 * An action the session asks leave for, as a card (docs/planning/_archive/M22.md, Design 10; C9, C13, C14,
 * C36, C48, C56, C92): one entry of the list at the item's place, drawn from the item alone, as a
 * question's card is (M21) and under the same `CardContext`.
 *
 * Its head says who asks and for what — the provider, or the sub-agent in a worker's tab — the
 * account where the provider runs more than one, and the time. Its body: the one line that names
 * the action; the working folder and the paths the request names, each path a control through the
 * session's opener, which main answers for a file outside the project's folders as it does any
 * other; that the CLI said a path is outside them; an edit's scope; the model's own reason, labelled
 * as the model's and drawn as text; what the CLI's own offers would grant beyond this action, which
 * fat-g never passes back; and the whole action behind a disclosure, drawn only once opened.
 *
 * While it waits, on a list that can decide, it holds its request's choices and Stop. Nothing is
 * active at arrival, and the focus stays where it was. Once settled it is inert and stays: its
 * outcome in words, never by colour alone — with what a grant covers and whether it ended, only
 * where its reply was delivered — and its detail still to be opened, said shortened where the store
 * kept it so. A list with no `CardContext`, a chat without a session, draws every card inert.
 */
export const ApprovalCard = memo(function ApprovalCard({ item, providerName, id, current = false, times = null, carrier }: ApprovalCardProps) {
  const scope = useContext(CardContext);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const body = approvalOf(item);
  if (body === null) return null;
  const { request } = body;
  const waiting = body.outcome === 'pending';
  const head = approvalHead(request.kind, scope?.asker ?? providerName, waiting);
  // A decision with no mark reads unconfirmed once what carries it is over, as an answer does (M21, C68).
  const words = approvalWords(body, isDecided(body.outcome) && body.confirmedAt === null && carrierOver(item, scope, carrier));
  const grant = grantWords(body);
  // A mode is named by the label its provider declares: the page holds no mode table (C39).
  const capability = scope?.permissions ?? null;
  const label = (mode: string | null): string | null => modeOf(capability, mode)?.label ?? null;
  // What else the CLI's offers would grant (C22, C56): a mode the card already names as the one that would stop the question is not said twice.
  const also = request.authority.filter((entry) => !(entry.kind === 'mode' && entry.mode !== null && entry.mode === request.modeThatWouldStop));
  const wouldStop = label(request.modeThatWouldStop);
  const edits = request.detail.kind === 'changes' ? request.detail.changes.filter((change) => change.all !== null) : [];
  const several = request.detail.kind === 'changes' && request.detail.changes.length > 1;
  const at = times === null ? null : item.time.receivedAt;
  return (
    <article id={id} className={styles.card} data-role="interaction" data-interaction="" data-kind="approval" data-approval={request.kind} data-outcome={body.outcome} data-current={current ? '' : undefined} aria-label={head}>
      <TabStopContext value={current}>
        <div className={styles.head}>
          <p className={styles.label}>{head}</p>
          {scope?.account != null && <span className={styles.time} data-approval-account="">{APPROVAL_LABELS.account(scope.account)}</span>}
          {at !== null && times !== null && <CardTime at={at} today={times.today} />}
        </div>
        <p className={styles.approvalSummary} data-approval-summary="">{request.summary}</p>
        {request.folder !== null && (
          <p className={styles.approvalMeta} data-approval-folder="">
            {APPROVAL_LABELS.folder} <span className={styles.approvalPath}>{request.folder}</span>
          </p>
        )}
        {request.targets.length > 0 && (
          <ul className={styles.approvalTargets} aria-label={APPROVAL_LABELS.targets}>
            {request.targets.map((target, index) => (
              <li key={index}>
                <PathReference path={target}>{target}</PathReference>
              </li>
            ))}
          </ul>
        )}
        {request.outside && <p className={styles.approvalOutside} data-approval-outside="">{APPROVAL_LABELS.outside}</p>}
        {edits.map((change, index) => (
          <p key={index} className={styles.approvalMeta} data-approval-scope={change.all === true ? 'every' : 'first'}>
            {several && `${fileName(change.path)}: `}{scopeWords(change.all === true)}
          </p>
        ))}
        {request.reason !== null && request.reason !== '' && (
          <div className={styles.approvalReason} data-approval-reason="">
            <p className={styles.cardHeader}>{APPROVAL_WORDS.reason}</p>
            <p className={styles.text}>{request.reason}</p>
          </div>
        )}
        {also.length > 0 && (
          <p className={styles.approvalMeta} data-approval-authority="">
            {APPROVAL_WORDS.authority} {also.map((entry) => authorityWords(entry, label(entry.mode))).join(', ')}
          </p>
        )}
        {wouldStop !== null && <p className={styles.approvalMeta} data-approval-would-stop="">{APPROVAL_WORDS.wouldStop(wouldStop)}</p>}
        <button
          type="button"
          className={`${styles.groupHead} ${styles.approvalDetailHead}`}
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={open ? APPROVAL_LABELS.hide : APPROVAL_LABELS.show}
          tabIndex={current ? 0 : -1}
          data-approval-detail=""
          onClick={() => setOpen((shown) => !shown)}
        >
          <Chevron open={open} />
          <span className={styles.groupWords}>{APPROVAL_WORDS.detail}</span>
        </button>
        {/* Drawn only once opened (C48): a change of a million characters costs nothing until it is asked for. */}
        {open && (
          <div id={detailId} className={styles.approvalDetail}>
            <Detail request={request} />
          </div>
        )}
        {waiting && scope !== null && <Actions item={item} request={request} scope={scope} stop={current ? 0 : -1} />}
        {words !== null && <p className={styles.cardOutcome} data-card-outcome="">{grant === null ? words : `${words}: ${grant}`}</p>}
      </TabStopContext>
    </article>
  );
});
