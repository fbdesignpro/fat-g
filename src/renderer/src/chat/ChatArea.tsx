// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type BlockedMode, blockWords, REMOVE_CHAT_TEXT, removeUnsure } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { planOf } from '@shared/contracts/interaction';
import { planTurnBlocked } from '@shared/contracts/plans';
import type { ReviewView } from '@shared/contracts/review';
import type { WorkflowView } from '@shared/contracts/workflow';
import { availabilityOf, MODE_WORDS, modeOf } from '@shared/contracts/permissions';
import { inPlan, isModeBlock, notStarted, type SendBlock, type SessionEntry, sessionDisplayName } from '@shared/contracts/sessions';
import { cancelNewSession } from '../sessions/cancel-new-session';
import { useNewSession } from '../new-session/new-session-store';
import { createOpener, openAgent, openPlan } from '../artifacts/opener';
import { invoke } from '../ipc/client';
import { OpenerContext } from '../markdown/inert';
import { openProjectDialog } from '../projects/project-dialog-store';
import { askModeMenu } from '../session-area/mode-menu-store';
import { holdText, ModelBlock } from '../session-area/ModelBlock';
import { ContextMeter } from '../session-area/ContextMeter';
import { ModeMenu } from '../session-area/ModeMenu';
import { sessionAccount, useDeclines, usePermissions, useSessionCatalog } from '../session-area/selected';
import { StatusBar } from '../session-area/StatusBar';
import { openSandboxSetup } from '../settings/sandbox-setup-store';
import { openSettings } from '../settings/settings-store';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import announcer from '../ui/Announcer.module.css';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { WorkerOpenContext } from './ActivityGroup';
import { sendRefusalText } from './card-words';
import { Composer } from './Composer';
import { type ComposerInput, useComposer } from './composer/composer-store';
import composerStyles from './composer/Composer.module.css';
import { useFileDrop } from './composer/useFileDrop';
import { useFootFocus } from './foot-focus';
import { ConversationsNote, type NoteClasses } from './ConversationsNote';
import { AsideSourceContext, type AsideSourceScope } from './ExplainControl';
import { CardContext, type CardScope } from './InteractionCard';
import { MessageList } from './MessageList';
import { PlanPanel } from './PlanPanel';
import { PlanLock, PlanStatusLine } from './PlanWorkflow';
import { PLAN_PAGE_WORDS } from './plan-words';
import { MISSING, usePlanInfo } from './plans-store';
import { usePromptType } from './prompt-type-store';
import { ReviewContext, type ReviewScope } from './review-context';
import { REVIEW_WORDS } from './review-words';
import { ReviewPanel } from './ReviewPanel';
import { useSessionReview } from './reviews-store';
import { SelectionMenu } from './SelectionMenu';
import { Toolbar } from './Toolbar';
import { useChat } from './useChat';
import { useSessionWorkflow } from './workflow-store';
import styles from './Chat.module.css';

export const SEND_FAILED_TEXT = 'fat-g could not send the message.';
export const REMOVE_FAILED_TEXT = 'fat-g could not remove the session.';

/** Why a Send was refused, in fat-g's words (Design 13): one table with a card's answer, whose words are in card-words.ts (M21, C38). */
export { sendRefusalText };

const NOTE_CLASSES: NoteClasses = { note: styles.note, problem: styles.problem, actions: styles.noteActions, button: styles.button };

/**
 * The selected session's conversation (docs/planning/_archive/M15.md, Design 14; C58–C68): its messages,
 * across the whole chat content, and under them the prompt area (docs/planning/_archive/M100.md, Design 7, round
 * 8; C34, C76), now separated: the model block at the left — avatar, model id and effort — and
 * beside it the status bar, the prompt-type bar and framed input — or, when it cannot take a prompt, the
 * reason in words with its remedy. Keyed by the session in ChatRegion, so another session starts from
 * its own read.
 *
 * Its messages are drawn with the session's opener (docs/planning/_archive/M19b.md, Design 6; C21): a reference
 * to a file in an assistant's message opens the file as a tab beside the chat, and an external address
 * opens in the system's browser. Only an assistant's message is drawn as Markdown, so a prompt, a
 * notice and a question's lines are text as they were.
 *
 * What the session did between its messages is drawn in groups (docs/planning/_archive/M20a.md, Design 8; C36,
 * C38, C40): a file an activity names opens through the same opener, and a worker row's Open button
 * opens the worker's tab beside the chat.
 *
 * A question can be asked beside the session (docs/planning/_archive/M20b.md, Design 7, 8; C44, C46, C67): its
 * messages are sources, so a selection in one has Explain this in fat-g's own menu, and each block
 * of an answer has it beside it; the prompt-type bar above the input holds Side question. All of it
 * is there only where the session's read says it can be asked beside.
 *
 * A question the session asks is a card in the list (docs/planning/_archive/M21.md, Design 7; C37, C38): the
 * list is told whose questions it draws and whether the session runs, so a blocking card is
 * answered from it while it waits, and an async one sends its prompt when one could be sent.
 *
 * An action the session asks leave for is a card in the list too (docs/planning/_archive/M22.md, Design 10;
 * C14, C36, C46, C89): the list is told the account it belongs to and the modes its provider
 * declares, so a card names a mode by its label. A chat whose mode its account cannot use, or whose
 * mode no start confirmed, has the reason in place of its input, with Change mode — which opens the
 * mode control above the thick rule — and Set up beside it where the CLI's own setup is what the
 * mode needs.
 *
 * While the conversation store is refused (M18, C33), its note stands in place of both the list and
 * the input, with Start fresh, and nothing is read; the status bar still says what the session does.
 *
 * A plan its chats share (decision 0029) is drawn from the chat's part in the plan's workflow, never
 * from the newest plan line of its own conversation: the decision's panel while the plan is ready, what
 * holds it — a review, another chat's revision, a discard — in the input's place, and one line above
 * the input while another chat carries it out, once that was interrupted, and once it was implemented.
 */
interface ChatAreaProps {
  readonly entry: SessionEntry;
  readonly startModel?: ReactNode;
  readonly startPresetName?: string | undefined;
  readonly startBusy?: boolean;
  readonly onStarted?: () => void;
}

export function ChatArea({ entry, ...start }: ChatAreaProps) {
  const store = useAppState((state) => state.snapshot?.conversations?.status);
  if (store?.kind === 'refused' || entry.block === 'conversations-refused') {
    return (
      <div className={styles.area} data-chat-session={entry.record.id}>
        <div className={styles.listCell}>
          <ConversationsNote cause={store?.kind === 'refused' ? store.cause : null} classes={NOTE_CLASSES} />
          <ModeRow entry={entry} />
        </div>
        {/* What the session does is still said, where the input would stand. */}
        <div className={styles.promptArea} data-prompt-area="">
          <ModelBlock entry={entry} />
          <div className={styles.promptMain}>
            <StatusBar entry={entry} />
          </div>
        </div>
      </div>
    );
  }
  return <Conversation entry={entry} {...start} />;
}

function Conversation({ entry, startModel, startPresetName, startBusy = false, onStarted }: ChatAreaProps) {
  const [firstAccepted, setFirstAccepted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { record, summary } = entry;
  const sent = useNewSession((state) => state.sent.has(record.id));
  const chat = useChat(record.id);
  const { view } = chat;
  const catalog = useSessionCatalog(entry);
  const providerName = useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === record.providerId)?.displayName) ?? record.providerId;
  const modelName = catalog.usable ? catalog.inForce.name : summary.model;
  const permissions = usePermissions(record.providerId);
  const declines = useDeclines(record.providerId);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  // One value for the session (M19b, C16): a re-render of the chat gives every block the same opener, and none is drawn again for it.
  const opener = useMemo(() => createOpener(record.id), [record.id]);
  // One value for the session too (M20a, C40): what a worker row's Open button calls.
  // A worker row's Open chooses the sub-agent in the Sub-agents tab, its thread unfolded (M106, C4).
  const onOpenWorker = useCallback((workerId: string, label: string): void => { openAgent(record.id, workerId, label); }, [record.id]);
  // And one more (M20b, C45): whose text the list's messages are.
  const sources = useMemo((): AsideSourceScope => ({ sessionId: record.id, workerId: null }), [record.id]);
  // Running, a turn or its workers alone (C99): the button is Stop.
  const running = summary.status === 'running';
  // Whose questions the list's cards are (M21, C37, C38): the session's own, asked by its model. An
  // approval's card says its account too, and names a mode by its provider's label (M22, C14, C56).
  const account = catalog.label;
  // Where its running turn takes a message now, an async card's answer goes into it (M23, C45).
  const sendsNow = useComposer(record.id).main.steer === 'open';
  const cards = useMemo((): CardScope => ({ sessionId: record.id, providerName, asker: null, running, sendsNow, workerRunning: null, account, permissions, declines }), [record.id, providerName, running, sendsNow, account, permissions, declines]);
  // The next prompt is a plan turn while Plan is pressed and the chat takes one (M22b, C1, C5).
  const pressed = usePromptType(record.id) === 'plan';
  const providers = useAppState((state) => state.snapshot?.providers);
  const planning = pressed && planTurnBlocked(providers?.find((provider) => provider.id === record.providerId)?.descriptor.capabilities.plans, entry.mode?.id ?? null, sessionAccount(providers, record).account?.plans, providerName) === null;
  // The chat's part in its plan's shared workflow (decision 0029): its decision while the plan is
  // ready, on the version every chat decides; what holds the plan otherwise.
  const part = useSessionWorkflow(record.id);
  const flow = part?.kind === 'plan' && part.role === 'participant' ? part.workflow : null;
  const ready = flow !== null && flow.state === 'ready' && flow.version !== null ? (flow as WorkflowView & { readonly version: number }) : null;
  const locked = flow !== null && (flow.state === 'reviewing' || flow.state === 'cancelled' || (flow.state === 'revising' && flow.holder?.sessionId !== record.id)) ? flow : null;
  // Its own turn holds the plan's request on that version (M22b, C11): decided while the turn runs.
  const holdsRequest = useMemo(() => ready !== null && (view?.items ?? []).some((item) => {
    const body = planOf(item);
    return body !== null && body.request && body.outcome === 'pending' && body.planId === ready.planId && body.version === ready.version;
  }), [view, ready]);
  // Any other decision stands once the chat's turn has ended (M22b, C24): the turn that wrote it, say.
  const deciding = ready !== null && (holdsRequest || !running) ? ready : null;
  const history = view?.history.state;
  // Its earlier conversation is not checked yet, or is being checked (M18, C52): Send waits. A provider
  // with no history, and a check that failed, leave it usable.
  const loading = history === 'not-checked' || history === 'checking';
  // A reviewer's chat (M22e, C7, C8): its review's rounds drawn where their blocks were, and the
  // review's panel in the foot for as long as it is open.
  const review = useSessionReview(record.id) ?? null;
  const reviewInfo = usePlanInfo(review?.planId ?? '');
  const reviewTitle = reviewInfo === MISSING ? PLAN_PAGE_WORDS.removed : reviewInfo?.title ?? PLAN_PAGE_WORDS.untitled;
  const reviewing = useMemo((): ReviewScope | null => (review === null ? null : { review, sessionId: record.id, providerName, title: reviewTitle }), [review, record.id, providerName, reviewTitle]);
  // A review is a hard stop (the maintainer): its panel stands for as long as it is open.
  const reviewOpen = review !== null && (review.state === 'running' || review.state === 'findings') && review.staleBy === null;
  // Decision panels keep their controls and mode placement until their own layout pass.
  const composing = deciding === null && locked === null && !reviewOpen && (entry.block === null || running || startModel !== undefined);
  const said = useReviewArrivals(record.id, review, reviewTitle);
  // A review's turn ends in the review's own line, said once in place of the list's (C21).
  const reviewTurn = useCallback((turnId: string): boolean => review?.turns.some((turn) => turn.turnId === turnId) === true, [review]);

  // The chat column as a drop target for images (M23, C15): while the session can take a prompt.
  const drop = useFileDrop(record.id, entry.block === null && deciding === null && locked === null && !reviewOpen);

  const send = async (input: ComposerInput): Promise<boolean> => {
    setProblem(null);
    try {
      // From a window that let go of its newest, the latest is shown first (M18, C58).
      if (view !== null && !view.latest) await chat.showLatest();
      // The draft as it stands, with its images and a revision past every update handed over (M23, C86).
      // Plan as pressed goes with it, kept with the draft whether or not this turn is a plan turn (C87).
      const answer = await invoke('chat:send', { sessionId: record.id, prompt: input.prompt, revision: input.revision, attachments: [...input.attachments], ...(input.intent.plan ? { plan: true } : {}), ...(input.intent.skill === null ? {} : { skill: input.intent.skill }), ...(planning ? { mode: 'plan' as const } : {}) });
      if (answer.status === 'accepted') { setFirstAccepted(true); onStarted?.(); return true; }
      setProblem(sendRefusalText(answer.reason, providerName));
    } catch {
      setProblem(SEND_FAILED_TEXT);
    }
    return false;
  };

  /**
   * Into the running turn (M23, C36): main chooses and checks the route, holds it until the turn can
   * take it, and sends it as the next prompt where the turn ended first. Its intent goes with it, so
   * that main refuses a plan turn or a skill, which never go now, rather than drop them.
   */
  const sendNow = async (input: ComposerInput): Promise<boolean> => {
    setProblem(null);
    try {
      const answer = await invoke('chat:send', { sessionId: record.id, prompt: input.prompt, revision: input.revision, attachments: [...input.attachments], ...(input.intent.plan ? { plan: true } : {}), ...(input.intent.skill === null ? {} : { skill: input.intent.skill }), when: 'now' });
      if (answer.status === 'accepted') return true;
      setProblem(sendRefusalText(answer.reason, providerName));
    } catch {
      setProblem(SEND_FAILED_TEXT);
    }
    return false;
  };
  // What Enter does while a turn runs (M23, C80), and how many messages wait in the queue (C82).
  const busyEnter = usePrefs((state) => state.snapshot?.values.composer.busyEnter ?? 'send-now');
  const queued = useComposer(record.id).main.queue.entries.length;

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const answer = await invoke('sessions:remove', { id: record.id });
      if (answer.status !== 'saved') setProblem(REMOVE_FAILED_TEXT);
    } catch {
      setProblem(REMOVE_FAILED_TEXT);
    } finally {
      setBusy(false);
      setRemoving(false);
    }
  };

  // The one control in the list (C129): after a conversation that did not reopen.
  const afterMessage = (item: ConversationItem) => {
    if (item.notice !== 'session-not-reopened') return null;
    return (
      <button type="button" className={styles.inlineButton} onClick={() => setRemoving(true)}>
        Remove session
      </button>
    );
  };

  // The read itself said the store is refused, before the app state did.
  if (view?.storage === 'refused') {
    return (
      <div className={styles.area} data-chat-session={record.id}>
        <ConversationsNote cause={null} classes={NOTE_CLASSES} onFresh={() => void chat.showLatest()} />
      </div>
    );
  }

  return (
    <div className={drop.dropping ? `${styles.area} ${composerStyles.dropping}` : styles.area} data-chat-session={record.id} data-start-screen={startModel !== undefined || undefined} data-no-start-model={startModel === null || undefined} {...drop.handlers}>
      {startModel === undefined && <div className={styles.listCell}>
        <OpenerContext value={opener}>
          <WorkerOpenContext value={onOpenWorker}>
            <AsideSourceContext value={sources}>
              <CardContext value={cards}>
                <ReviewContext value={reviewing}>
                  <MessageList
                    view={view}
                    sessionId={record.id}
                    copySource={{ kind: 'session', sessionId: record.id }}
                    providerId={record.providerId}
                    modelKey={summary.model}
                    busy={chat.busy}
                    modelName={modelName}
                    providerName={providerName}
                    onShowEarlier={chat.showEarlier}
                    onShowLatest={() => void chat.showLatest()}
                    onRetry={() => void invoke('chat:loadHistory', { sessionId: record.id }).catch(() => undefined)}
                    afterMessage={afterMessage}
                    endSaidElsewhere={reviewTurn}
                  />
                </ReviewContext>
              </CardContext>
            </AsideSourceContext>
          </WorkerOpenContext>
        </OpenerContext>
        {!composing && <ModeRow entry={entry} />}
      </div>}
      <SelectionMenu sessionId={record.id} />
      <div className={styles.promptArea} data-prompt-area="">
        {startModel === undefined ? <ModelBlock entry={entry} /> : startModel}
        <div className={styles.promptMain}>
          {startModel === undefined && <StatusBar entry={entry} queued={queued} />}
          {deciding !== null ? (
            // The decision on the chat's plan, in the bar's and the input's place (M22b, C24): a plan pending in a reviewer's chat takes the foot first.
            <PlanPanel entry={entry} workflow={deciding} holdsRequest={holdsRequest} providerName={providerName} />
          ) : locked !== null ? (
            // What holds the plan, in the input's place (decision 0029): a review, another chat's revision, a discard.
            <PlanLock sessionId={record.id} workflow={locked} />
          ) : reviewOpen && review !== null ? (
            // A review, in the bar's and the input's place for as long as it is open (M22e, C8; decision 0029).
            <ReviewPanel entry={entry} review={review} providerName={providerName} title={reviewTitle} />
          ) : (
            <div className={styles.composerSection} data-composer-section={composing ? '' : undefined}>
              {/* Where the chat's plan is carried out, or was (decision 0029): one line above the input. */}
              <PlanStatusLine sessionId={record.id} part={part} providerName={providerName} turns={view?.turns} />
              <Toolbar sessionId={record.id} entry={entry} providerName={providerName} onProblem={setProblem} modeControl={composing ? <ModeRow entry={entry} /> : undefined} />
              {entry.block !== null && !running && (
                <Reason entry={entry} block={entry.block} providerName={providerName} problem={problem} />
              )}
              {(entry.block === null || running || startModel !== undefined) && <Composer
                sessionId={record.id}
                providerName={providerName}
                presetName={startPresetName}
                running={running}
                loading={loading}
                ready={view !== null && !startBusy && !cancelling && !entry.changingMode && (entry.block === null || running)}
                selectionKey={`${record.providerId}/${record.instanceId}/${record.model}`}
                onSend={send}
                onSendNow={sendNow}
                busyEnter={busyEnter}
                planPressed={pressed}
                onStop={() => void invoke('chat:stop', { sessionId: record.id }).catch(() => undefined)}
                onCancelNewSession={notStarted(entry) && !inPlan(entry.summary) && entry.planPending !== true && !sent && !firstAccepted && !cancelling ? () => {
                  setCancelling(true);
                  void cancelNewSession(record.id).then((saved) => {
                    if (!saved) setProblem('This new session could not be cancelled.');
                  }, () => setProblem('This new session could not be cancelled.')).finally(() => setCancelling(false));
                } : undefined}
                problem={problem}
                {...(planning ? { sendLabel: 'Plan' } : {})}
              />}
            </div>
          )}
        </div>
      </div>
      {/* A review's arrival, its failure, and a later answer with no round, each said once (M22e, C21). */}
      <p className={announcer.announcer} role="status">{said !== null && <span key={said.key}>{said.text}</span>}</p>
      <ConfirmDialog
        open={removing}
        title={`Remove ${sessionDisplayName(record)}?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(false)}
      >
        <p>{removeUnsure(providerName)}</p>
        <p>{REMOVE_CHAT_TEXT.session(providerName)}</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * What a review's arrivals say, once each (docs/planning/_archive/M22e.md, Design 4; C21, C33): its first round,
 * a later one, a failure, and a later answer with no round — and, at a round that arrives while the
 * chat is shown, the plan's tab opened beside the list at the reviewed version, selected, taking no
 * focus. What a read found on showing the chat says nothing and opens nothing.
 */
function useReviewArrivals(sessionId: string, review: ReviewView | null, title: string): { readonly key: string; readonly text: string } | null {
  const seen = useRef<{ readonly rounds: number; readonly failed: boolean; readonly noRounds: number; readonly asked: number } | null>(null);
  const [said, setSaid] = useState<{ readonly key: string; readonly text: string } | null>(null);
  useEffect(() => {
    if (review === null) return;
    const now = { rounds: review.rounds.length, failed: review.state === 'failed', noRounds: review.turns.filter((turn) => turn.outcome === 'no-round').length, asked: review.turns.filter((turn) => turn.outcome === 'asked').length };
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    if (now.rounds > before.rounds) {
      setSaid({ key: `round-${now.rounds}`, text: now.rounds === 1 ? REVIEW_WORDS.arrived : REVIEW_WORDS.roundArrived });
      openPlan(sessionId, review.planId, title, review.version);
    } else if (now.failed && !before.failed) setSaid({ key: 'failed', text: REVIEW_WORDS.failedSaid });
    else if (now.noRounds > before.noRounds) setSaid({ key: `none-${now.noRounds}`, text: REVIEW_WORDS.noRoundSaid });
    else if (now.asked > before.asked) setSaid({ key: `asked-${now.asked}`, text: REVIEW_WORDS.askedSaid });
  }, [sessionId, review, title]);
  return said;
}

/**
 * The mode control's row: alongside the actions above the normal composer. Decision panels
 * and blocked states retain its earlier placement at the foot of the message list.
 * Keyed by the session: what a menu remembers — a refused change — is that session's. The context
 * meter stands before the mode control, and goes where it goes (decision 0033). Empty, and not
 * drawn, for a session whose provider declares no mode and reports no context.
 */
function ModeRow({ entry }: { readonly entry: SessionEntry }) {
  const foot = useFootFocus();
  return (
    <div className={styles.modeRow} ref={foot}>
      <ContextMeter key={`context-${entry.record.id}`} entry={entry} />
      <ModeMenu key={entry.record.id} entry={entry} />
    </div>
  );
}

/**
 * In place of the input row (C68): why the session cannot take a prompt, and its remedy where there is one.
 *
 * The two mode blocks name the chat's mode and, for one its account cannot use, why (M22, C46). Their
 * remedy is a change of mode, which is taken under either block (C89): Change mode opens the mode
 * control above the thick rule, and Set up opens the setup's dialog where the mode waits for it.
 *
 * It leaves as the block ends — a setup that completed, a mode that was taken — and where the focus
 * was on one of its remedies then, the chat's list takes it, as it does when the input row leaves.
 *
 * A session held for a moved configuration folder is said in the hold's own words, which name the
 * variable that names the folder (M14b, C62): the model column that said them is gone (M100, C77).
 */
function Reason({ entry, block, providerName, problem }: { readonly entry: SessionEntry; readonly block: SendBlock; readonly providerName: string; readonly problem: string | null }) {
  const { record } = entry;
  const permissions = usePermissions(record.providerId);
  const providers = useAppState((state) => state.snapshot?.providers);
  const catalog = useSessionCatalog(entry);
  // What its own account can do with the chat's mode: main's word, read from the account's snapshot.
  const availability = entry.mode === null ? null : availabilityOf(sessionAccount(providers, record).account?.modes, entry.mode.id);
  const blocked: BlockedMode | null = isModeBlock(block) && entry.mode !== null && availability !== null
    ? { label: modeOf(permissions, entry.mode.id)?.label ?? entry.mode.id, reason: block === 'mode-unavailable' ? availability.reason : null }
    : null;
  const words = blockWords(block, providerName, blocked);
  const text = block === 'folder-moved' && entry.hold === 'folder-moved' ? holdText(entry.hold, catalog.variable) : words.text;
  const { remedy } = words;
  const foot = useFootFocus();
  return (
    <div className={styles.reason} role="note" data-chat-block={block} ref={foot}>
      <p className={styles.reasonText}>{text}</p>
      {remedy === 'settings' && (
        <button type="button" className={styles.button} onClick={() => openSettings({ provider: record.providerId, instanceId: record.instanceId })}>
          Settings
        </button>
      )}
      {remedy === 'edit-project' && (
        <button type="button" className={styles.button} onClick={() => openProjectDialog(record.projectId)}>
          Edit project
        </button>
      )}
      {remedy === 'change-mode' && (
        <button type="button" className={styles.button} data-change-mode="" onClick={() => askModeMenu(record.id)}>
          {MODE_WORDS.changeMode}
        </button>
      )}
      {remedy === 'change-mode' && block === 'mode-unavailable' && availability?.setup === true && (
        <button type="button" className={styles.button} data-set-up="" onClick={() => openSandboxSetup({ providerId: record.providerId, instanceId: record.instanceId })}>
          {MODE_WORDS.setUp}
        </button>
      )}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}
