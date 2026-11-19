// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { Fragment, type CSSProperties, type KeyboardEvent, memo, type ReactNode, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CHAT_LINES } from '@shared/contracts/chat';
import { type ConversationItem, type ConversationTurn, entriesOf, turnElapsedMs } from '@shared/contracts/conversation';
import { approvalOf, askWords, heldByRequest, planOf, questionOf } from '@shared/contracts/interaction';
import { MODE_WORDS, modeOf, type PermissionCapability } from '@shared/contracts/permissions';
import type { TurnOutcome } from '@shared/contracts/sessions';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import announcer from '../ui/Announcer.module.css';
import { focusQuietly } from '../ui/focus';
import { startOfDay } from '../ui/format';
import { ActivityGroup, sameItems } from './ActivityGroup';
import { ApprovalCard } from './ApprovalCard';
import { CARD_WORDS, raisedWords } from './card-words';
import { CardContext, type CardKeys, CardKeysContext, InteractionCard } from './InteractionCard';
import { Message } from './Message';
import { conversationCopyText, type ConversationCopySource } from './copy-conversation';
import { SpeakerBar, TurnProgress } from './SpeakerBar';
import { RunFoot, type RunTimes, useRunOver } from './RunFoot';
import { type Speaker, speakerRuns, type SpeakerTimer } from './speakers';
import { useChatPresentation } from './presentation-store';
import { TurnLines } from './TurnLines';
import { PlanLine } from './PlanLine';
import { type ChatView, drawsEntry, shownRole } from './window';
import styles from './Chat.module.css';

/** How close to the end counts as being there, for the list to follow new messages. */
const AT_END_PX = 8;
const DAY_MS = 86_400_000;

/** At the foot, while something of this session could not be saved in this run (M18, C19). */
export const STORAGE_FAILING_TEXT = 'Part of this conversation could not be saved, and may be missing after a restart.';

/** The list's name, and the attribute that marks it: what a test and a probe find it by. */
export const LIST_LABEL = 'Messages';
export const LIST_MARK = 'data-chat-list';

/** A message, and how far its top is from the list's. */
interface Anchor {
  readonly element: HTMLElement;
  readonly offset: number;
}

const isAtEnd = (list: HTMLElement): boolean => list.scrollHeight - list.scrollTop - list.clientHeight <= AT_END_PX;

/** A fitted list that scrolls has outgrown its owner's bound; a framed one that does not would fit in it again (M106, C40). */
const sayFull = (list: HTMLElement, fit: boolean, onFull: (full: boolean) => void): void => {
  const over = list.scrollHeight > list.clientHeight;
  if (over === fit) onFull(over);
};

/** The first message some of which shows. The messages are in order, so the search halves. */
function firstVisible(list: HTMLElement): Anchor | null {
  const messages = list.querySelectorAll<HTMLElement>('article');
  const top = list.getBoundingClientRect().top;
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((messages[middle]?.getBoundingClientRect().bottom ?? top) > top) high = middle;
    else low = middle + 1;
  }
  const element = messages[low];
  return element === undefined ? null : { element, offset: element.getBoundingClientRect().top - top };
}

/** The start of the local day, kept current over midnight: what tells a time of today from a date (C42). */
function useToday(): number {
  const [today, setToday] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    const timer = window.setTimeout(() => setToday(startOfDay(Date.now())), Math.max(1000, today + DAY_MS - Date.now() + 1000));
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

/** The one short notice at a live turn's end (C49): that the answer finished, or that it was stopped. */
function endWords(outcome: TurnOutcome | null): string {
  if (outcome === 'completed') return CHAT_LINES.answerFinished;
  return outcome === 'interrupted' || outcome === 'stopped' ? CHAT_LINES.answerStopped : CHAT_LINES.answerEnded;
}

export interface MessageListProps {
  readonly copySource?: ConversationCopySource;
  readonly sessionId?: string;
  readonly providerId?: string;
  readonly modelKey?: string;
  readonly workerId?: string;
  readonly worker?: ConversationItem | null;
  readonly view: ChatView | null;
  /** Something is being read, or put in: the list says so. */
  readonly busy: boolean;
  /** What an assistant's message is labelled with. */
  readonly modelName: string;
  readonly providerName: string;
  readonly onShowEarlier: () => void;
  readonly onShowLatest: () => void;
  /** Try again, for a history check that failed. */
  readonly onRetry?: () => void;
  /** What follows a message in the list, if anything: the offer to remove a session that did not reopen. */
  readonly afterMessage?: (item: ConversationItem) => ReactNode;
  /** False for a list that is no turn's own — a worker's (M20a, C48), whose items are of a turn of its session's: no turn's lines are drawn under them. */
  readonly turnLines?: boolean;
  /** The list's name, where it is not the chat's own: a worker's, beside it (M20a, C48). Two lists on the page are told apart by their names. */
  readonly label?: string;
  /** The attribute that marks it, where it is not the chat's own: a test and a probe find the chat's list by `data-chat-list`, and no other list carries it. */
  readonly mark?: string;
  /** A model's name by its key (M20b, C37): for an answer that names the model that wrote it. */
  readonly nameModel?: (key: string) => string;
  /** Content before the messages, inside the same scroll area: an aside's folded excerpt. */
  readonly head?: ReactNode;
  /** What follows the last entry, inside the list: an aside's line while its answer is awaited (M20b, C39). */
  readonly foot?: ReactNode;
  /**
   * False for a list that posts nothing when a question is raised (M21, C74): a worker's, whose
   * question the chat's own region posts whether or not the worker's tab is shown, so each is said once.
   */
  readonly announceQuestions?: boolean;
  /**
   * A turn whose end another line says in its place (M22e, C21): a review's turn, whose round, its
   * failure, a missing round or the card it asks on is said once, by the chat's review line.
   */
  readonly endSaidElsewhere?: (turnId: string) => boolean;
  /**
   * The list is as tall as what it holds, up to what its owner bounds, and scrolls past it: a
   * sub-agent's thread while it is short (M106, C40). Without it the list fills its frame (M19, C67).
   * A list sized from what it holds is laid out again at every change, about ten times the cost on a
   * long one (measured in M106's walk), so its owner frames it once it is full: `onFull` says when a
   * fitted list outgrows its bound, and when a framed one would fit in it again.
   */
  readonly fit?: boolean;
  readonly onFull?: (full: boolean) => void;
}

interface RowProps {
  readonly noticeHeader: ReactNode;
  /** The entry (M20a, C36): a message or a notice by itself, or the consecutive activities of a turn. */
  readonly items: readonly ConversationItem[];
  /** Its turn, when it is the last of its turn's entries the window holds: the turn's lines go after it. */
  readonly turn: ConversationTurn | undefined;
  readonly id: string;
  readonly current: boolean;
  readonly modelName: string;
  readonly providerName: string;
  readonly times: { readonly today: number } | null;
  readonly firstOfTurn: boolean;
  readonly after: ReactNode;
  readonly nameModel: ((key: string) => string) | undefined;
  /** For a question's card (M21, C68): the turn that carries its answer, where the list holds it. An approval's is its own turn (M22). */
  readonly carrier: ConversationTurn | undefined;
  /** For a group of activity (M22, C110): the ids of its items whose leave never came, joined by spaces. */
  readonly unrun: string;
  /** For a message: false where it is all of its answer's text, which the answer's foot copies (the maintainer). */
  readonly ownCopy: boolean;
}

/** An action's own item and its approval's card share the provider's id, under one turn and one owner (M22, C8). */
const actionKey = (item: ConversationItem): string => `${item.turnId} ${item.workerId ?? ''} ${item.providerItemId ?? ''}`;

/**
 * The actions whose leave never came (M22, C110), by their key: each one an approval's card was
 * raised for and withdrawn or dropped before any decision. Its provider may still say it failed or
 * did not finish; it did not run, and its row says what was asked.
 */
function unrunOf(items: readonly ConversationItem[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of items) {
    const body = approvalOf(item);
    if (body !== null && item.providerItemId !== null && (body.outcome === 'withdrawn' || body.outcome === 'dropped')) keys.add(actionKey(item));
  }
  return keys;
}

/**
 * The turn that carries an interaction's answer or decision, where the list holds it (M21, C68):
 * the item's own for a blocking question and for an approval, which always holds its turn (M22);
 * the turn its prompt started for an async question; none for any other item.
 */
function carrierOf(item: ConversationItem, turns: ReadonlyMap<string, ConversationTurn> | undefined): ConversationTurn | undefined {
  if (item.kind !== 'interaction') return undefined;
  if (approvalOf(item) !== null) return turns?.get(item.turnId);
  const question = questionOf(item);
  if (question === null) return undefined;
  if (question.mode === 'blocking') return turns?.get(item.turnId);
  return question.answeredBy === null ? undefined : turns?.get(question.answeredBy);
}

/** An answer of the list: a model's run, from its speaker's bar to the next (the maintainer). */
interface AnswerRun {
  /** Its last entry's id, after which its foot stands. */
  readonly last: string;
  readonly turnId: string;
  /** Its entries, by their first item's id: it holds the keyboard's current entry when one of them is that. */
  readonly ids: ReadonlySet<string>;
  /** Its messages, in order: every part of its text. */
  readonly messages: readonly ConversationItem[];
}

/**
 * The answers of the list, each by the id of every entry it holds. A run begins at each speaker's
 * bar; the window's first drawn entry always has one, and a prompt's run is no answer.
 */
function answerRunsOf(entries: readonly (readonly ConversationItem[])[], speakers: ReadonlyMap<string, Speaker>): ReadonlyMap<string, AnswerRun> {
  const answers = new Map<string, AnswerRun>();
  let run: { readonly turnId: string; readonly ids: Set<string>; readonly messages: ConversationItem[]; last: string } | null = null;
  const close = (): void => {
    const done = run;
    if (done !== null) for (const id of done.ids) answers.set(id, done);
  };
  for (const entry of entries) {
    const first = entry[0];
    if (first === undefined) continue;
    const speaker = speakers.get(first.id);
    if (speaker !== undefined) {
      close();
      run = speaker.role === 'assistant' ? { turnId: first.turnId, ids: new Set(), messages: [], last: first.id } : null;
    }
    if (run === null) continue;
    run.ids.add(first.id);
    run.last = first.id;
    if (shownRole(first) === 'assistant') run.messages.push(first);
  }
  close();
  return answers;
}

/**
 * The lines that say a chat's mode changed (M22, C83), by the id of the entry each stands before:
 * the first entry of a turn that ran under another mode than the turn before it. A turn that kept
 * no mode — one read from a provider's history, one of a provider that declares none — is passed
 * over, and the first turn the window holds draws none, since the one before it is not known here:
 * nothing is drawn where a chat's mode never changed. The mode is named by its provider's label.
 */
function modeLinesOf(entries: readonly (readonly ConversationItem[])[], turns: ReadonlyMap<string, ConversationTurn> | undefined, capability: PermissionCapability | null): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  if (turns === undefined || capability === null) return lines;
  let turnId: string | null = null;
  let last: string | null = null;
  for (const entry of entries) {
    const first = entry[0];
    if (first === undefined || first.turnId === turnId) continue;
    turnId = first.turnId;
    const mode = turns.get(turnId)?.mode ?? null;
    if (mode === null) continue;
    const label = last !== null && mode !== last ? modeOf(capability, mode)?.label : undefined;
    if (label !== undefined) lines.set(first.id, MODE_WORDS.line(label));
    last = mode;
  }
  return lines;
}

/**
 * One entry with its turn's lines: a message, a group of activity (M20a, C36), a question's card
 * (M21, C37), or an approval's (M22, C36), told from a question's by its body's kind. Drawn again only
 * when something of its own changed (C65; M20a, C44): an update to one message, or to one activity,
 * leaves every other entry as it is. The entries are made again at each change, so two are the same
 * when they hold the very same items.
 */
const Row = memo(function Row({ items, turn, id, current, modelName, providerName, times, firstOfTurn, after, noticeHeader, nameModel, carrier, unrun, ownCopy }: RowProps) {
  const [first] = items;
  return (
    <>
      {first === undefined ? null : first.kind === 'activity'
        ? <ActivityGroup items={items} id={id} current={current} unrun={unrun} />
        : first.kind === 'interaction'
          // A plan's line (M22b, C23): its own row, no card.
          ? planOf(first) !== null
            ? <PlanLine item={first} id={id} current={current} times={times} />
            : approvalOf(first) !== null
            ? <ApprovalCard item={first} providerName={providerName} id={id} current={current} times={times} carrier={carrier} />
            : <InteractionCard item={first} modelName={modelName} id={id} current={current} times={times} carrier={carrier} />
          : <Message item={first} modelName={modelName} providerName={providerName} id={id} current={current} times={times} firstOfTurn={firstOfTurn} after={after} noticeHeader={noticeHeader} named={false} ownCopy={ownCopy} {...(nameModel === undefined ? {} : { nameModel })} />}
      {turn !== undefined && <TurnLines turn={turn} providerName={providerName} />}
    </>
  );
}, (before, after) => sameItems(before.items, after.items) && before.turn === after.turn && before.id === after.id && before.current === after.current && before.modelName === after.modelName
  && before.providerName === after.providerName && before.times === after.times && before.firstOfTurn === after.firstOfTurn && before.after === after.after && before.nameModel === after.nameModel
  && before.carrier === after.carrier && before.unrun === after.unrun && before.ownCopy === after.ownCopy && before.noticeHeader === after.noticeHeader);

/** A message of the session's own that carries questions a card of the list draws: the card stands for it (decision 0026, item 2). */
function isCarded(entry: readonly ConversationItem[], carded: ReadonlySet<string>): boolean {
  const [first] = entry;
  return entry.length === 1 && first !== undefined && first.kind === 'message' && first.role === 'assistant' && first.workerId === null
    && first.questions.length > 0 && first.providerItemId !== null && carded.has(first.providerItemId);
}

/**
 * The messages of a conversation (docs/planning/_archive/M15.md, Design 14; C61, C64, C93, C95; M18.md, Design 5;
 * C18, C20, C58; M19.md, Design 8; C45, C46, C48–C50, C65): the one part of the chat that scrolls,
 * and the first part of the shell whose text can be selected.
 *
 * It holds a window. Older pages come only from the control at its head, never from scrolling, and a
 * window that let go of its newest says so at its foot and offers the latest (C58).
 *
 * Its place (C20, C45): it keeps to the end while the reader is there, through every update of a
 * message that is being written. Otherwise the first visible message and its offset, noted as the
 * reader scrolls, are restored after every change — an older page, a window read again — so what
 * the reader looks at stays where it is. While a pointer is held down in the list nothing scrolls,
 * so a selection can be dragged across a message that grows. The focus is never moved, and nothing
 * here touches the input.
 *
 * Away from the end (C46), a control at its foot goes there, and says when something has arrived since.
 *
 * The keyboard (C50): the list is one stop in the tab order. It has a current message — the newest,
 * until Up or Down moves it — whose own controls alone are stops, so Tab goes from the list through
 * that message's controls and on to the input. The list's own controls stay stops as they are.
 *
 * What a session did between two of its messages is one entry of the list, a group (M20a, C36,
 * C42): an `article` as a message is, so it is an anchor of the list's place and a stop of Up and
 * Down as a message is, and its own controls are stops only while it is the current entry.
 *
 * A question the session asks is one entry too, its card (M21, C37, C40, C43): an `article`, an
 * anchor and a stop as a message is, its controls stops only while it is the current entry. The
 * message that carried an async question draws its question lines no more where the list holds the
 * card that follows it. An action the session asks leave for is such an entry as well (M22, C36).
 *
 * Before the first turn that ran under another mode than the one before it, a line of fat-g's says
 * the mode (M22, C83): a line and no item, so no stop of the keyboard's and no anchor of the list's.
 *
 * Under each answer — a model's run, from its speaker's bar to the next — its foot (RunFoot.tsx):
 * when it ran, and a Copy button for all of its text. No item either; its Copy button is a stop
 * while the answer holds the current entry, after that entry's own.
 *
 * What it announces (C49): nothing by itself — a message that is being written is not read out a
 * word at a time. The status region beside it says one line for the messages an older page put in,
 * and one short notice when a turn that ran here ends: never on a history load or a chat switch.
 * And one line, once, when a blocking question is raised here (M21, C43, C74) — the session's own,
 * or a worker's, whose tab may not be shown — with the focus left where it is; an approval is posted
 * the same way, by what it asks leave for (M22, C36).
 *
 * The lines that are not messages stand apart, can show together, and hide no message (C18): earlier
 * messages missing, older ones unread, a history check that failed, with Try again; and under a turn,
 * what is known of an end that never came and of what could not be saved (C16, C19).
 */
export function MessageList({ view, busy, modelName, providerName, onShowEarlier, onShowLatest, onRetry, afterMessage, turnLines = true, label = LIST_LABEL, mark = LIST_MARK, nameModel, head, foot, announceQuestions = true, endSaidElsewhere, fit = false, onFull, sessionId = '', providerId = '', modelKey, workerId, worker, copySource }: MessageListProps) {
  const list = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const pointerHeld = useRef(false);
  const listId = useId();
  // An answer's foot shows while the pointer is anywhere over the answer (the maintainer).
  useRunOver(list);
  const display = usePrefs((state) => state.snapshot?.values.chat);
  const noticeColor = useAppState((state) => state.snapshot?.catalog?.providers.find((provider) => provider.id === providerId)?.presentation.barColor);
  const copyConversation = useMemo(() => copySource === undefined ? undefined : () => conversationCopyText(copySource, modelName, nameModel, display?.username || 'You'), [copySource, modelName, nameModel, display?.username]);
  // The modes the list's provider declares, where its cards are given them (M22, C83): what a mode's line names it by.
  const capability = useContext(CardContext)?.permissions ?? null;
  // Each waiting question's card, by its item, for the number keys pressed on the list (M100b, C15).
  const [cardKeys] = useState<CardKeys>(() => new Map());
  const today = useToday();
  const times = useMemo(() => (display?.messageTimes === true ? { today } : null), [display?.messageTimes, today]);
  // The keyboard's current message, once it was moved off the newest (C50).
  const [chosen, setChosen] = useState<string | null>(null);
  // Away from the end (C46): how many arrivals the window had seen when the reader left it. Null at the end.
  const [leftAt, setLeftAt] = useState<number | null>(null);
  const change = view?.change;
  const arrivals = view?.arrivals ?? 0;

  // The newest page is shown from its end: the reader is there again.
  const [latestSeen, setLatestSeen] = useState<number | null>(null);
  if (change?.kind === 'latest' && change.serial !== latestSeen) {
    setLatestSeen(change.serial);
    setLeftAt(null);
  }

  /** The list's own size when last seen: a scroll that comes with a new size is the reflow's, not the reader's. */
  const size = useRef<{ readonly width: number; readonly height: number } | null>(null);
  const resized = (element: HTMLElement): boolean => {
    const was = size.current;
    size.current = { width: element.clientWidth, height: element.clientHeight };
    return was !== null && (was.width !== element.clientWidth || was.height !== element.clientHeight);
  };

  const note = (element: HTMLElement): void => {
    // The list changed size under a reader at its end — the pane opening beside it, the foot under it
    // changing (M22b, the maintainer's review): the browser's own scroll for the reflow comes before
    // the size is observed, and is not the reader leaving the end. They stay there.
    if (resized(element) && atEnd.current && !pointerHeld.current) {
      element.scrollTop = element.scrollHeight;
      anchor.current = firstVisible(element);
      return;
    }
    const there = isAtEnd(element);
    atEnd.current = there;
    anchor.current = firstVisible(element);
    setLeftAt((before) => (there ? null : before ?? arrivals));
  };

  /**
   * The reader's place seen again where what the list holds changed size with no scroll of its own —
   * a group or a row they closed, a frame that grew (M106's walk): a list that now ends in view has
   * them at its end, and "Go to the latest" goes. A list that still runs on past its view keeps them where they are.
   */
  const reckon = (element: HTMLElement): void => {
    if (atEnd.current || !isAtEnd(element)) return;
    atEnd.current = true;
    anchor.current = firstVisible(element);
    setLeftAt(null);
  };

  // A change of the list's own size — the pane opening beside it as a tab opens by itself, the foot
  // under it changing as a plan's panel takes the input's place (M22b, the maintainer's review) —
  // keeps a reader who was at the end there: the text reflows, and would otherwise leave them above
  // it, every later arrival then said "New below". A size change that brings no scroll of its own is
  // seen here; one that does, in the scroll's note above.
  useEffect(() => {
    const element = list.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      if (resized(element) && atEnd.current && !pointerHeld.current) element.scrollTop = element.scrollHeight;
      else reckon(element);
    });
    watch.observe(element);
    return () => { watch.disconnect(); };
  }, []);

  // Whether the list fills its owner's bound (M106, C40): a fitted list that scrolls has outgrown it,
  // and a framed one that does not would fit in it again. Seen as the list changes size, and after
  // each change of what it holds, which leaves a framed list's size as it was.
  useEffect(() => {
    const element = list.current;
    if (element === null || onFull === undefined) return;
    sayFull(element, fit, onFull);
  }, [change, fit, onFull]);
  useEffect(() => {
    const element = list.current;
    if (element === null || onFull === undefined || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => { sayFull(element, fit, onFull); });
    watch.observe(element);
    return () => { watch.disconnect(); };
  }, [fit, onFull]);

  useEffect(() => {
    // Wherever it is released: a pointer that went down in the list is up again.
    const released = (): void => { pointerHeld.current = false; };
    window.addEventListener('pointerup', released);
    window.addEventListener('pointercancel', released);
    return () => {
      window.removeEventListener('pointerup', released);
      window.removeEventListener('pointercancel', released);
    };
  }, []);

  useLayoutEffect(() => {
    const element = list.current;
    if (element === null || change === undefined) return;
    // While a pointer is held down in the list nothing scrolls (C45).
    if (pointerHeld.current && change.kind !== 'latest') return;
    const held = anchor.current;
    const there = held !== null && element.contains(held.element);
    // The newest page is shown from its end. An older page never moves the reader to the end; any
    // other change does while the reader is there — or when the place they were at is gone.
    if (change.kind === 'latest' || (change.kind !== 'older-page' && (atEnd.current || (change.kind === 'replace' && !there)))) {
      element.scrollTop = element.scrollHeight;
      atEnd.current = true;
    } else if (there) {
      const moved = held.element.getBoundingClientRect().top - element.getBoundingClientRect().top - held.offset;
      if (moved !== 0) element.scrollTop += moved;
      atEnd.current = isAtEnd(element);
    }
    anchor.current = firstVisible(element);
  }, [change]);

  const items = view?.items;
  // The messages whose questions a card of the list draws (M21, C40): by the provider's id, which the card shares with its message.
  const carded = useMemo(() => new Set((items ?? []).flatMap((item) => (item.kind === 'interaction' && questionOf(item)?.mode === 'async' && item.providerItemId !== null ? [item.providerItemId] : []))), [items]);
  // A message or a notice, or the consecutive activities of a turn (M20a, C36). A message of the
  // session's own whose questions a card draws is not drawn (decision 0026, item 2): its text is the
  // CLI's own copy of those questions, and the card stands for it.
  const entries = useMemo(() => entriesOf(items ?? []).filter((entry) => !isCarded(entry, carded)), [items, carded]);
  const history = view?.history;
  const checking = history?.state === 'not-checked' || history?.state === 'checking';
  const loaded = view?.loaded ?? null;
  const ended = view?.ended ?? null;
  // Each by its first item's id, which stays the entry's as a group grows.
  const drawn = useMemo(() => entries.flatMap((entry) => (drawsEntry(entry) && entry[0] !== undefined ? [entry[0]] : [])), [entries]);
  // The actions whose cards were withdrawn or dropped before any decision (M22, C110).
  const unrun = useMemo(() => unrunOf(items ?? []), [items]);
  // No line under a list that is no turn's own: a worker's items are of a turn of its session's.
  const turns = view?.turns;
  const modeLines = useMemo(() => modeLinesOf(turnLines ? entries : [], turns, capability), [turnLines, entries, turns, capability]);
  // A bar precedes each speaker run; worker timing belongs to the worker, never its parent turn.
  const projectedWorker = useChatPresentation((state) => state.sessionId === sessionId && workerId !== undefined ? state.value?.workers[workerId] : undefined);
  const defaultModel = projectedWorker?.model ?? worker?.activity?.model ?? modelKey ?? modelName;
  const defaultName = workerId === undefined ? modelName : nameModel?.(defaultModel) ?? modelName;
  const speakers = useMemo(() => speakerRuns(entries, defaultModel), [entries, defaultModel]);
  const workerTimer: SpeakerTimer | null = workerId === undefined ? null : { running: worker?.activity?.status === 'running', since: worker?.time.receivedAt ?? null, elapsedMs: worker?.activity?.duration?.ms ?? null };
  const timerOf = (turn: ConversationTurn | undefined): SpeakerTimer => workerTimer ?? { ...(turn === undefined ? {} : { turnId: turn.id }), running: turn?.state === 'running', since: turn?.time.acceptedAt ?? turn?.time.providerStartedAt ?? null, elapsedMs: turn === undefined ? null : turnElapsedMs(turn) };
  // Each answer's foot (the maintainer): its bar's times, with the end. A worker's ends as long after its start as it ran.
  const answers = useMemo(() => answerRunsOf(entries, speakers), [entries, speakers]);
  const timesOf = (turn: ConversationTurn | undefined): RunTimes => {
    const { running, since, elapsedMs } = timerOf(turn);
    const endedAt = workerTimer !== null ? (running || since === null || elapsedMs === null ? null : since + elapsedMs)
      : turn?.state === 'ended' ? turn.time.endReceivedAt ?? turn.time.providerEndedAt : null;
    return { running, since, endedAt, elapsedMs };
  };
  const activeTurn = [...(turns?.values() ?? [])].find((turn) => turn.state === 'running');
  const active = view?.latest === true && (workerTimer?.running ?? activeTurn !== undefined);
  // A held request pauses its owner; a turn's own requests also pause its elapsed-time counter.
  // Async questions leave the model working; another worker's request does not pause this list.
  const waiting = (items ?? []).some((item) => item.workerId === (workerId ?? null)
    && (workerId !== undefined || item.turnId === activeTurn?.id)
    && item.interaction?.outcome === 'pending' && heldByRequest(item.interaction));
  const tail = drawn.at(-1);
  const pending = active && (tail === undefined || shownRole(tail) === 'user');
  const currentId = chosen !== null && drawn.some((item) => item.id === chosen) ? chosen : drawn.at(-1)?.id ?? null;
  const domId = (itemId: string): string => `${listId}m${itemId}`;

  const toEnd = (): void => {
    const element = list.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    atEnd.current = true;
    anchor.current = firstVisible(element);
    setLeftAt(null);
  };

  /**
   * Up and Down, Home and End move the current message, and bring it into view (C50). Only from the
   * list itself: a control inside it keeps its keys. A number key goes on to the current entry,
   * where that is a question's card that waits (M100b, C15).
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || drawn.length === 0) return;
    if (/^[1-9]$/.test(event.key)) {
      if (currentId !== null && cardKeys.get(currentId)?.(Number(event.key)) === true) event.preventDefault();
      return;
    }
    const at = drawn.findIndex((item) => item.id === currentId);
    const to = event.key === 'ArrowUp' ? Math.max(0, at - 1) : event.key === 'ArrowDown' ? Math.min(drawn.length - 1, at + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? drawn.length - 1 : -1;
    if (to === -1) return;
    event.preventDefault();
    const next = drawn[to];
    if (next === undefined) return;
    // On the newest again, it follows the newest from here on.
    setChosen(to === drawn.length - 1 ? null : next.id);
    document.getElementById(domId(next.id))?.scrollIntoView?.({ block: 'nearest' });
  };

  // One line at a time: the older page's, the turn's end, or a question raised, whichever came last.
  const asked = announceQuestions ? view?.asked ?? null : null;
  const lines = [
    ...(ended === null || endSaidElsewhere?.(ended.turnId) === true ? [] : [{ serial: ended.serial, key: `ended-${ended.serial}`, text: endWords(ended.outcome) }]),
    ...(loaded === null ? [] : [{ serial: loaded.serial, key: `loaded-${loaded.serial}`, text: CHAT_LINES.earlierLoaded(loaded.count) }]),
    // A question by who asks it, the model; an approval by its provider and what it asks leave for (M22, C36). A worker's by its word.
    ...(asked === null ? [] : [{ serial: asked.serial, key: `asked-${asked.serial}`, text: asked.what === 'question' ? raisedWords(asked.worker ? CARD_WORDS.subAgent : modelName) : askWords(asked.what, asked.worker ? CARD_WORDS.subAgent : providerName) }]),
  ];
  const said = lines.reduce<(typeof lines)[number] | null>((latest, line) => (latest === null || line.serial > latest.serial ? line : latest), null);
  const away = leftAt !== null;
  const arrived = leftAt !== null && arrivals > leftAt;

  return (
    <>
      <div className={styles.listFrame}>
        <div
          ref={list}
          className={fit ? `${styles.list} ${styles.fitList}` : styles.list}
          style={noticeColor === undefined ? undefined : { '--bar-color': noticeColor } as CSSProperties}
          role="group"
          aria-label={label}
          aria-busy={busy}
          aria-activedescendant={currentId === null ? undefined : domId(currentId)}
          tabIndex={0}
          {...{ [mark]: '' }}
          onScroll={(event) => note(event.currentTarget)}
          onKeyDown={onKeyDown}
          onPointerDown={() => { pointerHeld.current = true; }}
          // A press inside it may have opened or closed something, which no scroll and no change of
          // its own size need follow: its place, and whether it fills its bound, seen again once drawn.
          onClick={(event) => {
            const element = event.currentTarget;
            requestAnimationFrame(() => {
              reckon(element);
              if (onFull !== undefined) sayFull(element, fit, onFull);
            });
          }}
        >
          {history?.state === 'failed' ? (
            <p className={styles.line}>
              {CHAT_LINES.historyFailed}{' '}
              <button type="button" className={styles.inlineButton} onClick={onRetry}>
                Try again
              </button>
            </p>
          ) : (
            // While the check runs it may still bring them: the input row says it is checking.
            history?.earlierMissing === true && !checking && <p className={styles.line}>{CHAT_LINES.earlierMissing}</p>
          )}
          {history?.olderUnread === true && <p className={styles.line}>{CHAT_LINES.olderUnread}</p>}
          {view !== null && view.older !== null && (
            <p className={styles.line}>
              <button type="button" className={styles.inlineButton} onClick={onShowEarlier}>
                {CHAT_LINES.showEarlier}
              </button>
            </p>
          )}
          {head}
          <CardKeysContext value={cardKeys}>
          {entries.map((entry, index) => {
            const first = entry[0] as ConversationItem;
            const modeLine = modeLines.get(first.id);
            const speaker = speakers.get(first.id);
            const answer = answers.get(first.id);
            // An answer's one part has no Copy button of its own: its foot's copies the same (the maintainer).
            const ownCopy = answer === undefined || answer.messages.length > 1;
            const header = speaker === undefined ? null : <SpeakerBar speaker={speaker} modelName={defaultName} defaultModel={defaultModel} providerId={providerId} sessionId={sessionId} timer={timerOf(turns?.get(first.turnId))} speed={workerId === undefined ? turns?.get(first.turnId)?.speed : undefined} nameModel={nameModel} />;
            return (
              <Fragment key={first.id}>
                {modeLine !== undefined && <p className={styles.line} data-mode-line="">{modeLine}</p>}
                {/* Who did what follows, where it is no message of theirs: the name stands before the work (round 9, C82). */}
                {first.kind !== 'notice' && header}
                <Row
                  noticeHeader={first.kind === 'notice' ? header : null}
                  items={entry}
                  // A turn's lines go after the last of its entries the window holds.
                  turn={!turnLines || entries[index + 1]?.[0]?.turnId === first.turnId ? undefined : view?.turns.get(first.turnId)}
                  id={domId(first.id)}
                  current={first.id === currentId}
                  modelName={defaultName}
                  providerName={providerName}
                  times={times}
                  firstOfTurn={entries[index - 1]?.[0]?.turnId !== first.turnId}
                  after={first.kind === 'activity' || first.kind === 'interaction' ? null : afterMessage?.(first) ?? null}
                  nameModel={nameModel}
                  // The item's own turn for a blocking question and an approval, the turn its prompt started for an async question (M21, C68).
                  carrier={carrierOf(first, view?.turns)}
                  unrun={first.kind === 'activity' ? entry.filter((item) => item.providerItemId !== null && unrun.has(actionKey(item))).map((item) => item.id).join(' ') : ''}
                  ownCopy={ownCopy}
                />
                {answer?.last === first.id && <RunFoot messages={answer.messages} current={currentId !== null && answer.ids.has(currentId)} showTime={display?.answerTimes !== false} {...(copyConversation === undefined ? {} : { copyConversation })} {...timesOf(turns?.get(answer.turnId))} />}
              </Fragment>
            );
          })}
          </CardKeysContext>
          {pending && <SpeakerBar speaker={{ role: 'assistant', model: defaultModel }} modelName={defaultName} defaultModel={defaultModel} providerId={providerId} sessionId={sessionId} timer={timerOf(activeTurn)} speed={workerId === undefined ? activeTurn?.speed : undefined} nameModel={nameModel} />}
          {active && !waiting && <TurnProgress />}
          {foot}
          {view?.storage === 'failing' && <p className={styles.line}>{STORAGE_FAILING_TEXT}</p>}
          {view !== null && !view.latest && (
            <p className={styles.line} data-newer={view.newer ? '' : undefined}>
              {view.newer ? CHAT_LINES.notLatestNew : CHAT_LINES.notLatest}{' '}
              <button type="button" className={styles.inlineButton} onClick={onShowLatest}>
                {CHAT_LINES.showLatest}
              </button>
            </p>
          )}
        </div>
        {/* Away from the end of a window that holds the newest (C46): the way back, and word of what arrived since. */}
        {view !== null && view.latest && away && (
          <button
            type="button"
            className={styles.toEnd}
            data-arrived={arrived ? '' : undefined}
            onClick={(event) => {
              // It leaves with its own press: where it had the focus, the list takes it — never the page's body.
              const held = event.currentTarget === document.activeElement;
              toEnd();
              if (held) focusQuietly(list.current);
            }}
          >
            {arrived ? CHAT_LINES.toEndNew : CHAT_LINES.toEnd}
          </button>
        )}
      </div>
      {/* Beside the list, not in it: the one line said for the messages an older page put in, and for a turn's end (C49). */}
      <p className={announcer.announcer} role="status">
        {said !== null && <span key={said.key}>{said.text}</span>}
      </p>
    </>
  );
}
