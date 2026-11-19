// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { AsideMarker } from '@shared/contracts/aside';
import { CHAT_LINES } from '@shared/contracts/chat';
import { type ConversationItem, itemCut, itemText } from '@shared/contracts/conversation';
import { isImageName } from '@shared/contracts/files';
import { feedbackOf, readPlanBlock, readPlanPrompt } from '@shared/contracts/plans';
import { fencedBlocks, integrationIds, readFindings, type ReviewRoundView, type ReviewTurnKind, sentNoteIds, type SetAside, setAsideShown } from '@shared/contracts/review';
import { openPlan } from '../artifacts/opener';
import { BlockControlContext, type BlockInfo, type ReferenceGatherer, ReferenceGathererContext, TabStopContext } from '../markdown/inert';
import { MarkdownText } from '../markdown/MarkdownText';
import { CopyButton } from '../ui/CopyButton';
import { formatDateTime, formatTimeOfDay } from '../ui/format';
import { useAsides, useSourceMarkers } from './asides-store';
import { EXPLAIN_BUTTONS_VISIBLE } from './aside-actions';
import { AsideMarkerButton, AsideSourceContext, type AsideSourceScope, BlockExplain, useAsidePassages } from './ExplainControl';
import { FindingsList } from './FindingsList';
import { targetName } from './image-files';
import { ImageFileStrip } from './ImageFileStrip';
import { MessageAttachments } from './MessageAttachments';
import { DELIVERY_WORDS } from '@shared/contracts/composer';
import { ReviewContext, type ReviewScope, reviewNotice } from './review-context';
import { REVIEW_WORDS } from './review-words';
import { PLAN_PAGE_WORDS } from './plan-words';
import { MISSING, planName, usePlanInfo } from './plans-store';
import { messageSource, sourceAttributes, type SourceOf } from './selection-report';
import { shownRole } from './window';
import { usePrefs } from '../state/prefs-store';
import styles from './Chat.module.css';
import { HoverMessageTimeContext, HoverTimeHostContext, HoverTimeSource, hoverTimeBlock } from './hover-time/sources';

const DAY_MS = 86_400_000;
/** The most image files a message's text names that are drawn under it (decision 0022, item 15). */
export const MAX_NAMED_IMAGES = 20;
/** A round whose answer set nothing aside: the same objects each time, so its list draws again only for what changed. */
const NONE_SET_ASIDE: readonly SetAside[] = [];
const NONE_KEPT: readonly string[] = [];

export interface MessageProps {
  readonly item: ConversationItem;
  readonly modelName: string;
  readonly providerName: string;
  /** The element's id: what the list names as its current message (C50). */
  readonly id?: string;
  /** The keyboard's current message (C50): its own controls are stops in the tab order, and no other message's are. */
  readonly current?: boolean;
  /** Message times are shown (C41, C42): `today` is the start of the local day, in milliseconds, so that a time of today is a time of day alone. */
  readonly times?: { readonly today: number } | null;
  /** It is its turn's first item in the list: for one read from history, its turn's start is shown on it, and on no other (C42). */
  readonly firstOfTurn?: boolean;
  readonly after?: ReactNode;
  /** The notice's speaker label, kept inside its box with the message. */
  readonly noticeHeader?: ReactNode;
  /** A model's name by its key (M20b, C37): what an answer is labelled with where it names the model that wrote it. Without it, such an answer is labelled by the key. */
  readonly nameModel?: (key: string) => string;
  /**
   * It says who speaks (M100, round 9, C82): true where it is the first of its speaker's run in the
   * list, false where the speaker is the one the message before it had. Its accessible name is its
   * label either way, so what is read out never leaves a message unattributed.
   */
  readonly named?: boolean;
  /**
   * It has a Copy button of its own: false where it is all of its answer's text, which the answer's
   * foot copies (the maintainer), so that one press is not offered twice.
   */
  readonly ownCopy?: boolean;
}

/** What a message is labelled with (M20b, C7, C37): an answer another model wrote than the session's says which. */
export function messageLabel(item: ConversationItem, modelName: string, nameModel?: (key: string) => string, username = 'You'): string {
  const role = shownRole(item);
  if (role === 'user') return item.fromQueue === true ? `${username} (from queue)` : username;
  if (role !== 'assistant') return 'fat-g';
  return item.model === null ? modelName : nameModel?.(item.model) ?? item.model;
}

interface SourceProps {
  readonly text: string;
  readonly scope: AsideSourceScope | null;
  readonly source: SourceOf | null;
  readonly markers: readonly AsideMarker[];
}

/**
 * An assistant's text (M20b, C45, C46, C74): drawn as Markdown, and — where it is a source — marked
 * as one, with Explain this beside each of its blocks and its asides' passages painted in it.
 */
function AnswerBody({ text, scope, source, markers, current }: SourceProps & { readonly current: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  useAsidePassages(body, scope?.sessionId ?? null, source, markers, text);
  const sessionId = scope?.sessionId ?? null;
  // Something stands beside its blocks only where the session can be asked beside, or the message has an aside already.
  const mayAsk = useAsides((state) => source !== null && state.sessionId === sessionId && state.asking !== 'none');
  const hoverTime = useContext(HoverMessageTimeContext);
  const asideControls = (EXPLAIN_BUTTONS_VISIBLE && mayAsk) || markers.length > 0;
  const beside = hoverTime || asideControls;
  // One value for a text and its asides, so that no block is drawn again for it.
  const control = useCallback((block: BlockInfo): ReactNode => <><HoverTimeSource kind="block" />{asideControls && sessionId !== null && <BlockExplain sessionId={sessionId} text={text} block={block} markers={markers} />}</>, [sessionId, text, markers, asideControls]);
  return (
    <div ref={body} className={styles.body} {...(source === null ? {} : sourceAttributes(source))}>
      <TabStopContext value={current}>
        <BlockControlContext value={beside ? control : null}>
          <MarkdownText text={text} />
        </BlockControlContext>
      </TabStopContext>
    </div>
  );
}

/**
 * A round's answer (docs/planning/_archive/M22e.md, Design 4, 5; C5, C7, C29): split at its findings block as a
 * plan's prompt is at its block — the text before it, the findings list in its place, the text after
 * — under the one source the answer is, so that a finding's row is a place in its drawing (C54).
 */
function RoundBody({ text, round, review, scope, source, markers, current }: SourceProps & { readonly current: boolean; readonly round: ReviewRoundView; readonly review: ReviewScope }) {
  const body = useRef<HTMLDivElement>(null);
  useAsidePassages(body, scope?.sessionId ?? null, source, markers, text);
  const read = useMemo(() => readFindings(text, review.review.instruction), [text, review.review.instruction]);
  const before = read.verdict === 'findings' ? read.before : '';
  const after = read.verdict === 'findings' ? read.after : '';
  // The findings its answer set aside: left out, or standing as the round before had them (the maintainer).
  const setAside = useMemo(() => (read.verdict === 'findings' ? setAsideShown(read.setAside, read.block.issues, round.findings) : null), [read, round.findings]);
  return (
    <div ref={body} className={styles.body} {...(source === null ? {} : sourceAttributes(source))}>
      <TabStopContext value={current}>
        {before !== '' && <MarkdownText text={before} />}
        <FindingsList review={review.review} round={round} sessionId={review.sessionId} providerName={review.providerName} title={review.title} leftOut={setAside?.leftOut ?? NONE_SET_ASIDE} kept={setAside?.kept ?? NONE_KEPT} />
        {after !== '' && <MarkdownText text={after} />}
      </TabStopContext>
    </div>
  );
}

/**
 * An answer of a review's turn that waits (M22e; the maintainer's V6 review): its text up to its
 * findings block, and in the block's place a line that the review is being made — never the block's
 * JSON half written. Once the turn ends, its round draws the list, or, with none, the text is drawn
 * whole as it came (C5, C31).
 */
function PendingRoundBody({ text, kind, scope, source, markers, current }: SourceProps & { readonly current: boolean; readonly kind: ReviewTurnKind }) {
  const at = useMemo(() => fencedBlocks(text).findLast((block) => block.info === 'json')?.start ?? null, [text]);
  if (at === null) return <AnswerBody text={text} scope={scope} source={source} markers={markers} current={current} />;
  const before = text.slice(0, at).trimEnd();
  return (
    <>
      {before !== '' && <AnswerBody text={before} scope={scope} source={source} markers={markers} current={current} />}
      <p className={styles.reviewPending} data-review-pending="">{kind === 'notes' ? REVIEW_WORDS.updating : REVIEW_WORDS.creating}</p>
    </>
  );
}

/** A prompt's text (M20b, C45, C47): the text it is, marked as a source where it is one, with its asides' passages painted in it. */
function PromptBody({ text, scope, source, markers }: SourceProps) {
  const body = useRef<HTMLParagraphElement>(null);
  useAsidePassages(body, scope?.sessionId ?? null, source, markers, text);
  return <p ref={body} className={styles.text} {...(source === null ? {} : sourceAttributes(source))}>{text}</p>;
}

/** A Send notes prompt (M22e, C31): one line naming the findings it sent notes on, unfolding to the prompt as sent. */
function NotesPromptBody({ text, scope, source, markers, current }: SourceProps & { readonly current: boolean }) {
  const ids = useMemo(() => sentNoteIds(text) ?? [], [text]);
  return (
    <details className={styles.reviewPrompt} data-notes-prompt="">
      <summary tabIndex={current ? 0 : -1}>{REVIEW_WORDS.notesSent(ids)}</summary>
      <PromptBody text={text} scope={scope} source={source} markers={markers} />
    </details>
  );
}

/**
 * A prompt fat-g composed for a plan (docs/planning/_archive/M22b.md, Design 7; C69): its words as they were
 * sent, and its block drawn as one folded line naming the plan and its version, with a button that
 * opens the plan's tab — unfolding to the text the prompt carried, which the plan's own chat's
 * prompts carry none of. The block's own lines are never drawn. A prompt cut short at its bound, its
 * closing line lost, keeps its fields: the line names the plan, and unfolds to what was kept. A
 * feedback a Claude request took holds no block: its words are the whole of it.
 *
 * A feedback fat-g sent with its request (the maintainer) draws the user's own words, and
 * under them a fold of the feedback as sent: fat-g's words with the user's, the block's text apart.
 */
function PlanPromptBody({ item, text, current }: { readonly item: ConversationItem; readonly text: string; readonly current: boolean }) {
  const block = readPlanBlock(text);
  const fields = item.plan;
  const planId = block?.planId ?? fields?.planId ?? '';
  const version = block?.version ?? fields?.version ?? 0;
  const info = usePlanInfo(planId);
  const title = info === MISSING ? PLAN_PAGE_WORDS.removed : info?.title ?? PLAN_PAGE_WORDS.untitled;
  const name = planName(info);
  const sessionId = useContext(AsideSourceContext)?.sessionId ?? null;
  const opening = text.indexOf('<fat-g-plan ');
  const before = block?.before ?? (opening < 0 ? text : text.slice(0, opening)).trimEnd();
  const after = block?.after ?? '';
  // Cut at the store's bound, the block has lost its closing line: what was kept after its opening line is its text.
  const openingEnd = opening < 0 ? -1 : text.indexOf('\n', opening);
  const carried = block?.text ?? (openingEnd < 0 ? '' : text.slice(openingEnd + 1));
  const own = feedbackOf(before) ?? feedbackOf(after);
  const drawn = (
    <div className={styles.planPrompt} data-plan-prompt={planId}>
      {own !== null ? <p className={styles.text}>{own}</p> : before !== '' && <p className={styles.text}>{before}</p>}
      {own !== null && (
        <details className={styles.planBlock} data-feedback-sent="">
          <summary tabIndex={current ? 0 : -1}>{PLAN_PAGE_WORDS.feedbackSent}</summary>
          <pre className={styles.planBlockText}>{[before, after].filter((part) => part !== '').join('\n\n')}</pre>
        </details>
      )}
      {opening >= 0 && (
        <details className={styles.planBlock}>
          {/* The fold is the text the prompt carried; the button beside it names the plan (M22e). */}
          <summary tabIndex={current ? 0 : -1}>{PLAN_PAGE_WORDS.sentText(version)}</summary>
          {carried === '' ? null : <pre className={styles.planBlockText}>{carried}</pre>}
        </details>
      )}
      {own === null && sessionId !== null && planId !== '' && (
        <button type="button" className={styles.inlineButton} tabIndex={current ? 0 : -1} disabled={info === MISSING} onClick={() => openPlan(sessionId, planId, title, version)}>
          {name}
        </button>
      )}
      {own === null && after !== '' && <p className={styles.text}>{after}</p>}
    </div>
  );
  // A review's first prompt (M22e, C53) is one line naming the request, unfolding to the prompt as sent.
  if ((fields?.intent ?? readPlanPrompt(text)?.intent) === 'review') {
    return (
      <details className={styles.reviewPrompt} data-review-prompt={planId}>
        <summary tabIndex={current ? 0 : -1}>{REVIEW_WORDS.request(name, version)}</summary>
        {drawn}
      </details>
    );
  }
  // So is an integration's, its words before the block or, a brought plan's feedback, after it (the maintainer).
  const sent = integrationIds(before) ?? integrationIds(after);
  if (sent === null) return drawn;
  return (
    <details className={styles.reviewPrompt} data-integration-prompt={planId}>
      <summary tabIndex={current ? 0 : -1}>{REVIEW_WORDS.planFeedback(sent.accepted, sent.refused)}</summary>
      {drawn}
    </details>
  );
}

/**
 * The image files a finished answer names (decision 0022, item 15): each of its local references gives
 * its address while it is drawn and takes it back when it goes; those by an image's name, each once in
 * the order they came, are drawn under its text by what main answers for them. None while it is being
 * written, when a path is still half there.
 */
function useNamedImages(active: boolean): { readonly gatherer: ReferenceGatherer | null; readonly targets: readonly { readonly target: string; readonly name: string }[] } {
  const [addresses, setAddresses] = useState<readonly string[]>([]);
  const gatherer = useMemo((): ReferenceGatherer | null => {
    if (!active) return null;
    // How many of its references name each address: one of two that goes leaves it.
    const counts = new Map<string, number>();
    return {
      add(address) {
        const name = targetName(address, window.fatg.platform);
        if (name === null || !isImageName(name)) return () => undefined;
        const count = (counts.get(address) ?? 0) + 1;
        counts.set(address, count);
        if (count === 1) setAddresses((now) => (now.includes(address) ? now : [...now, address]));
        return () => {
          const left = (counts.get(address) ?? 1) - 1;
          if (left > 0) {
            counts.set(address, left);
            return;
          }
          counts.delete(address);
          setAddresses((now) => now.filter((one) => one !== address));
        };
      },
    };
  }, [active]);
  const targets = useMemo(() => addresses.slice(0, MAX_NAMED_IMAGES).map((target) => ({ target, name: targetName(target, window.fatg.platform) ?? target })), [addresses]);
  return { gatherer, targets };
}

/** The one time an item shows (C42): when fat-g took it, or — read from history, on its turn's first item — when its provider says the turn started. */
function shownTime(item: ConversationItem, firstOfTurn: boolean): { readonly at: number; readonly providers: boolean } | null {
  if (item.time.receivedAt !== null) return { at: item.time.receivedAt, providers: false };
  return firstOfTurn && item.time.providerAt !== null ? { at: item.time.providerAt, providers: true } : null;
}

/**
 * One item of a conversation (docs/planning/_archive/M15.md, Design 14; C59, C62, C63; M18.md, Design 1;
 * M19.md, Design 6, 7; C18, C29, C38–C42).
 *
 * Its head is one row: its label in words, its time where times are shown, and its Copy button — on
 * a prompt and on an assistant's message, never on a notice — which stands in the message's right
 * margin, out of the row, never over its text (the maintainer). An assistant's message, of either
 * phase, is drawn as Markdown, from its text alone; a prompt, a notice, a notice's detail and a
 * question's lines stay the text they are: a prompt read as Markdown would have its paths,
 * underscores and pasted code reshaped. None of it is a control but the Copy buttons.
 *
 * Under it, in fat-g's words and not part of its text: that it was cut to its bound, and that it
 * never finished. A message that is being written is drawn as any, as far as it goes. Under a
 * finished answer, a thumbnail of each image file its text names (decision 0022, item 15).
 *
 * A message or a notice. An item of a reserved kind draws nothing (M18, C3).
 *
 * Where it is drawn as a source (M20b, C45–C47, C74) — in a session's chat and in a worker's tab,
 * never in an aside's own — a message's text is marked as what a selection in it came from. An
 * assistant's has Explain this beside each of its blocks, and a prompt its asides' marker in its
 * head row; a notice, fat-g's own words, has neither.
 *
 * A message's question lines are drawn: a message whose list holds a card for it is not drawn at all
 * (MessageList.tsx; decision 0026, item 2), while an aside's message and a worker's, for which no
 * card ever exists, keep their plain lines.
 */
export const Message = memo(function Message({ item, modelName, providerName, id, current = false, times = null, firstOfTurn = false, after, noticeHeader, nameModel, named = true, ownCopy = true }: MessageProps) {
  const username = usePrefs((state) => state.snapshot?.values.chat.username ?? 'You');
  const hoverEnabled = useContext(HoverTimeHostContext);
  const role = shownRole(item);
  const scope = useContext(AsideSourceContext);
  const { id: itemId, workerId } = item;
  const source = useMemo(() => (scope === null || role === null || role === 'notice' ? null : messageSource(itemId, role, workerId)), [scope, role, itemId, workerId]);
  const markers = useSourceMarkers(scope?.sessionId ?? null, source);
  // A reviewer's chat (M22e, C5, C55): a round's answer draws its list, and the record says what became of a turn.
  const reviewing = useContext(ReviewContext);
  const round = reviewing === null || role !== 'assistant' ? null : reviewing.review.rounds.find((one) => one.answerId === itemId) ?? null;
  const notice = reviewing === null ? null : reviewNotice(reviewing.review, itemId, { text: itemText(item), cut: itemCut(item) });
  // A Send notes prompt is the review record's to name, by its turn (C25, C31); a plain-composer prompt is never one.
  const notes = reviewing !== null && role === 'user' && reviewing.review.turns.some((turn) => turn.kind === 'notes' && turn.promptId === itemId);
  // An answer of a review's turn that still waits: its block is not drawn while it is written.
  const pending = reviewing === null || role !== 'assistant' || round !== null ? undefined : reviewing.review.turns.find((turn) => turn.turnId === item.turnId && turn.outcome === 'waiting');
  const namedImages = useNamedImages(role === 'assistant' && item.state !== 'streaming' && scope !== null);
  if (role === null) return null;
  const label = messageLabel(item, modelName, nameModel, username);
  const showLabel = named;
  const text = itemText(item);
  const time = times === null ? null : shownTime(item, firstOfTurn);
  const hoverTime = hoverEnabled && role !== 'notice' ? shownTime(item, firstOfTurn) : null;
  const hoverTitle = hoverTime === null ? undefined : `${formatDateTime(hoverTime.at)}${hoverTime.providers ? ` — ${CHAT_LINES.providerTime(providerName)}` : ''}`;
  // Nothing of its head shows: no label, no time, and no aside's marker — the Copy button alone,
  // which shows on rollover, in the margin. Its row then takes no room of its own, so no empty line
  // stands between the entry before it and its text (round 9, C82).
  const bare = !showLabel && time === null && !(role === 'user' && scope !== null && markers.length > 0);
  const today = time !== null && times !== null && time.at >= times.today && time.at < times.today + DAY_MS;
  return (
    <HoverMessageTimeContext value={hoverTime !== null}>
      <article
        id={id}
        className={styles.message}
        data-role={role}
        data-phase={item.phase ?? undefined}
        data-state={item.state}
        data-current={current ? '' : undefined}
        data-hover-time-at={hoverTime?.at}
        title={hoverTitle}
        aria-label={label}
        aria-busy={item.state === 'streaming' ? true : undefined}
      >
        {noticeHeader}
        <div className={styles.head} data-head={bare ? 'bare' : ''}>
          {/* One label when the speaker changes and no more (round 9, C82); the accessible name says it on every message. */}
          {showLabel && <p className={styles.label}>{label}</p>}
          {time !== null && (
            <time className={styles.time} dateTime={new Date(time.at).toISOString()} title={time.providers ? CHAT_LINES.providerTime(providerName) : formatDateTime(time.at)}>
              {today ? formatTimeOfDay(time.at) : formatDateTime(time.at)}
            </time>
          )}
          {/* What the page holds of it when it is pressed: all of a message that is still being written, as far as it is (C38). */}
          {/* An answer's message is one part of the answer, whose foot copies it all (MessageList.tsx); a prompt is the whole message. */}
          {role !== 'notice' && ownCopy && <CopyButton look="icon" label={role === 'assistant' ? CHAT_LINES.copyPart : CHAT_LINES.copyMessage} text={() => text} tabIndex={current ? 0 : -1} />}
          {/* A prompt has no control beside its text: its asides' marker stands here, beside Copy (C74). */}
          {role === 'user' && scope !== null && markers.length > 0 && <AsideMarkerButton sessionId={scope.sessionId} markers={markers} tabIndex={current ? 0 : -1} />}
          <HoverTimeSource kind="message" />
        </div>
        <BlockControlContext value={hoverTime === null ? null : hoverTimeBlock}>
          <ReferenceGathererContext value={namedImages.gatherer}>
            {role === 'assistant' && round !== null && reviewing !== null ? <RoundBody text={text} round={round} review={reviewing} scope={scope} source={source} markers={markers} current={current} />
              : role === 'assistant' && pending !== undefined ? <PendingRoundBody text={text} kind={pending.kind} scope={scope} source={source} markers={markers} current={current} />
              : role === 'assistant' ? <AnswerBody text={text} scope={scope} source={source} markers={markers} current={current} />
              : role === 'user' && (item.plan != null || readPlanBlock(text) !== null) ? <PlanPromptBody item={item} text={text} current={current} />
              : role === 'user' && notes ? <NotesPromptBody text={text} scope={scope} source={source} markers={markers} current={current} />
              : role === 'user' ? <PromptBody text={text} scope={scope} source={source} markers={markers} />
                : <p className={styles.text}>{text}</p>}
          </ReferenceGathererContext>
        </BlockControlContext>
        {/* The image files a finished answer names, under its text (decision 0022, item 15). */}
        {scope !== null && namedImages.gatherer !== null && <ImageFileStrip sessionId={scope.sessionId} targets={namedImages.targets} missing={false} tabIndex={current ? 0 : -1} />}
        {/* A user's message's images, under its text (M23, C26). */}
        {role !== 'notice' && item.attachments !== undefined && item.attachments.length > 0 && <MessageAttachments images={item.attachments} current={current} />}
        {/* A message sent into a running turn (M23, C38–C44): what became of it, under it, until and once it settled. */}
        {role === 'user' && item.delivery != null && (
          <p className={styles.delivery} data-delivery={item.delivery.state}>
            {DELIVERY_WORDS[item.delivery.state]}
            {item.delivery.state === 'not-sent' && item.delivery.detail !== null && <span className={styles.deliveryDetail}> ({item.delivery.detail})</span>}
          </p>
        )}
        {item.detail !== null && item.detail !== '' && <p className={styles.detail}>{item.detail}</p>}
        {item.questions.length > 0 && (
          <div className={styles.questions}>
            {item.questions.map((question, index) => (
              <div key={index} className={styles.question}>
                <p className={styles.text}>{question.title}</p>
                {question.options.map((option, place) => (
                  <p key={place} className={styles.option}>{option}</p>
                ))}
              </div>
            ))}
          </div>
        )}
        {itemCut(item) && <p className={styles.line} data-item-line="cut">{CHAT_LINES.cut}</p>}
        {item.state === 'partial' && <p className={styles.line} data-item-line="incomplete">{CHAT_LINES.incomplete}</p>}
        {notice !== null && <p className={styles.line} data-review-notice="">{notice}</p>}
        {after}
      </article>
    </HoverMessageTimeContext>
  );
});
