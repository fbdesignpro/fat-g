// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createContext, type KeyboardEvent, memo, type RefObject, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationItem, ConversationTurn } from '@shared/contracts/conversation';
import { type AnswerEntry, type InteractionQuestion, MAX_ANSWER_TEXT, noneAnswered, outcomeWords, placeAnswers, type QuestionBody, questionOf } from '@shared/contracts/interaction';
import type { PermissionCapability } from '@shared/contracts/permissions';
import { invoke } from '../ipc/client';
import { focusQuietly } from '../ui/focus';
import { formatDateTime, formatTimeOfDay } from '../ui/format';
import { answerLines, answerRefusalText, CARD_WORDS, headWords, runningWords } from './card-words';
import { focusPrompt } from './prompt-focus';
import styles from './Chat.module.css';

const DAY_MS = 86_400_000;
/** How long a single choice's pick stands before the next question is shown, or the answer sent (M100b, C60). */
export const ADVANCE_MS = 200;

/**
 * Whose questions a list draws, and whether they can be answered from it (docs/planning/_archive/M21.md,
 * Design 7; C37, C38, C42, C79): given by a session's chat and by a worker's tab. A list given none
 * — a chat without a session, which takes no prompt — draws its cards inert.
 */
export interface CardScope {
  /** The session an answer and a dismissal name. The page holds no request id: main finds it by the card's item (C35). */
  readonly sessionId: string;
  readonly providerName: string;
  /** Who asks, where it is not the list's model: "Sub-agent" and its label, in a worker's tab (C37). */
  readonly asker: string | null;
  /** The session runs, a turn or its workers alone: an async card's answer is a prompt, and waits as Send does (C38). */
  readonly running: boolean;
  /** Its running turn takes a message now (M23, C45): an async card's answer goes into that turn, and does not wait. */
  readonly sendsNow?: boolean;
  /** In a worker's tab, whether the worker still runs (C79); null in the session's own list. */
  readonly workerRunning: boolean | null;
  /** The account's label, where its provider runs more than one (M22, C14): an approval's card says which account it belongs to. */
  readonly account?: string | null;
  /** The modes the session's provider declares (M22, C8, C56): what an approval's card names a mode by. The page holds no mode table of its own. */
  readonly permissions?: PermissionCapability | null;
  /** The provider declines a blocking question (M100b, C33): a blocking card offers Decline only then. */
  readonly declines?: boolean;
}

export const CardContext = createContext<CardScope | null>(null);

/**
 * Where a list's number keys go (M100b, C15): each waiting card by its item's id, while it can take
 * an answer. A card answers whether the key was its; the list passes a key on to its current entry.
 */
export type CardKeys = Map<string, (key: number) => boolean>;
export const CardKeysContext = createContext<CardKeys | null>(null);

export interface InteractionCardProps {
  readonly item: ConversationItem;
  /** What the session's own card is named by, as a message's label is (M15, C62). */
  readonly modelName: string;
  /** The element's id: what the list names as its current entry (C43). */
  readonly id?: string;
  /** The keyboard's current entry: its own controls are stops in the tab order, and no other entry's are. */
  readonly current?: boolean;
  /** Message times are shown (M19, C41, C42). */
  readonly times?: { readonly today: number } | null;
  /**
   * The turn that carries the answer, where the list holds it (C68): the item's own for a blocking
   * question, the turn its prompt started for an async one. What a blocking card's waiting time is
   * counted from, and what says that an answer with no mark was never confirmed.
   */
  readonly carrier?: ConversationTurn | undefined;
}

/**
 * Whether what carries an item's answer or decision is over (C68, C79): a worker's item its worker,
 * since the parent's turn ends while the worker runs and the worker's own result can still confirm
 * it; any other the turn that carries it. False while that runs, and where the page does not hold it.
 * An approval's card asks the same of its decision (M22, C12).
 */
export function carrierOver(item: Pick<ConversationItem, 'workerId'>, scope: CardScope | null, carrier: ConversationTurn | undefined): boolean {
  if (item.workerId !== null) return scope?.workerRunning === false;
  return carrier !== undefined && carrier.state !== 'running';
}

/**
 * Whether an answered item says the model did not confirm it (C68, C79): it has no mark, and what
 * carries its answer is no longer running. While that runs, or where the page does not hold it, it
 * reads answered.
 */
function isUnconfirmed(item: ConversationItem, body: QuestionBody, scope: CardScope | null, carrier: ConversationTurn | undefined): boolean {
  return body.outcome === 'answered' && body.confirmedAt === null && carrierOver(item, scope, carrier);
}

/**
 * A card that settles takes its controls away (C39). Where the focus was on one of them, it goes to
 * the list that holds the card, whose current entry the card still is — never to the page's body,
 * from which the next Tab would start at the top of the window (C43). Run before the controls leave
 * the page, while the focus is still theirs. Given to the element that holds the controls, by the
 * component that leaves with them; an approval's card hands its focus on the same way (M22, C36).
 *
 * It holds only where the pressed control can keep the focus until then: a button is never disabled
 * for a press that is on its way, since the browser takes the focus from a disabled one at once.
 */
export function useSettledFocus(): RefObject<HTMLDivElement | null> {
  const actions = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const card = actions.current?.closest('article') ?? null;
    return () => {
      if (card !== null && card.contains(document.activeElement)) focusQuietly(card.closest<HTMLElement>('[tabindex="0"]'));
    };
  }, []);
  return actions;
}

/** A card's time in its head (M19, C41, C42): a time of day today, with the date on any other day. */
export function CardTime({ at, today }: { readonly at: number; readonly today: number }) {
  const sameDay = at >= today && at < today + DAY_MS;
  return (
    <time className={styles.time} dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {sameDay ? formatTimeOfDay(at) : formatDateTime(at)}
    </time>
  );
}

/** A question as text (C39): its text, then what was answered, or what could have been. Short titles are hidden for now. */
function QuestionText({ question, lines }: { readonly question: InteractionQuestion; readonly lines: readonly { readonly text: string; readonly detail: string | null }[] }) {
  return (
    <div className={styles.cardQuestion}>
      <p className={styles.text}>{question.text}</p>
      {lines.map((line, place) => (
        <p key={place} className={styles.option}>
          {line.text}
          {line.detail !== null && <small className={styles.cardDescription}>{line.detail}</small>}
        </p>
      ))}
    </div>
  );
}

/**
 * A card that takes no answer (C39, C42; M100b, C23, C64): every question at once, each answer under
 * its question where it was answered, "No answer" where it was left so, and never a control.
 */
function Settled({ body }: { readonly body: QuestionBody }) {
  const answered = body.outcome === 'answered';
  return (
    <div className={styles.qSettled}>
      {body.questions.map((question, index) => (
        <QuestionText
          key={index}
          question={question}
          lines={answered ? answerLines(question, body.answers?.[index] ?? null).map((text) => ({ text, detail: null })) : question.secret ? [] : question.options.map((option) => ({ text: option.label, detail: option.description }))}
        />
      ))}
    </div>
  );
}

/** The row "Something else" stands in, where a question has options and takes free text (M100b, C13): after them. */
const elseRow = (question: InteractionQuestion): number | null => (!question.secret && question.freeText && question.options.length > 0 ? question.options.length : null);
const isTextField = (target: EventTarget | null): boolean => target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'password');

interface WaitingProps {
  readonly item: ConversationItem;
  readonly body: QuestionBody;
  readonly scope: CardScope;
  readonly stop: number;
}

/**
 * A card that waits for an answer (C37, C38, C44, C45, C78; M100b, C5, C6, C8–C17, C21, C30, C41, C43, C48–C53, C55–C58):
 * one question shown at a time, the stepper in its foot, its options as numbered rows — native radios, or check boxes
 * where several may be chosen, hidden from sight and not from the keyboard — "Something else" as the
 * last row where it takes free text, the field alone where it has no options, and for a secret a
 * masked field alone. Nothing is chosen at first; what was picked and typed for each question is
 * kept while the card is drawn; Submit waits for every question to have been shown once, and a
 * question left blank goes as "No answer". A first pick on the last question can submit on its
 * first visit alone, with every earlier answer already filled. Decline declines the whole request: to
 * the CLI on a blocking card, folded away on an async one. The controls stand in no form.
 */
function Waiting({ item, body, scope, stop }: WaitingProps) {
  const { questions } = body;
  const blocking = body.mode === 'blocking';
  const name = useId();
  const reasonId = useId();
  const [shown, setShown] = useState(0);
  const [chosen, setChosen] = useState<readonly (readonly number[])[]>(() => questions.map(() => []));
  const [texts, setTexts] = useState<readonly string[]>(() => questions.map(() => ''));
  // What the stepper's boxes show (C51): the questions shown so far, and the secrets that hold a text — never the text itself.
  const [seen, setSeen] = useState<readonly boolean[]>(() => questions.map((_, index) => index === 0));
  const [secretTyped, setSecretTyped] = useState<readonly boolean[]>(() => questions.map(() => false));
  // A secret's text is its field's alone (C44): read when Submit is pressed, and kept nowhere here.
  const secrets = useRef<(HTMLInputElement | null)[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // An async card's answer is a prompt: it waits while a turn runs, with Send's own reason (C38) —
  // but where that turn takes a message now, it goes into it, and Submit says so (M23, C45).
  const intoTurn = !blocking && scope.running && scope.sendsNow === true;
  const held = !blocking && scope.running && !intoTurn;
  // A blocking card is declined only where its provider declines (C33); an async one always (C32).
  const declinable = !blocking || scope.declines === true;
  // A card that settles takes its controls away, and hands the focus to its list (C39, C43).
  const actions = useSettledFocus();
  const rows = useRef<HTMLDivElement | null>(null);
  // Set by a move between questions: the next draw puts the focus on the new question (C6).
  const moved = useRef(false);
  const last = questions.length - 1;
  const at = Math.min(shown, last);
  const question = questions[at];
  // One chance to finish the first pass: leaving the last question or answering it consumes it.
  const autoSubmit = useRef(questions.length === 1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    rows.current?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true });
  }, [at]);

  const go = (to: number): void => {
    if (to < 0 || to > last || to === at) return;
    clearTimeout(timer.current);
    if (at === last) autoSubmit.current = false;
    if (to === last && !seen[last]) autoSubmit.current = questions.every((_, index) => index === last || boxOf(index) === 'answered');
    moved.current = true;
    setShown(to);
    setSeen((before) => before.map((was, index) => was || index === to));
  };

  /** What a question's box shows (C51): answered — an option picked or a text typed, a secret's by its field — seen, or not yet seen. */
  const boxOf = (index: number): 'answered' | 'seen' | 'unseen' => {
    const each = questions[index];
    const answered = each?.secret === true ? secretTyped[index] === true : (chosen[index]?.length ?? 0) > 0 || (texts[index] ?? '').trim() !== '';
    return answered ? 'answered' : seen[index] === true ? 'seen' : 'unseen';
  };
  // Submit waits for every question to have been shown once (C58), and no longer for the last to be the one shown.
  const allSeen = seen.every(Boolean);

  const choose = (index: number, place: number, multiple: boolean, advance = false): void => {
    const finish = index === last && autoSubmit.current && boxOf(index) !== 'answered';
    clearTimeout(timer.current);
    if (index === last) autoSubmit.current = false;
    // What a refused Submit said is about the answers as they were: a change to one takes it away.
    setProblem(null);
    setChosen((before) => before.map((places, which) => {
      if (which !== index) return places;
      if (!multiple) return [place];
      return places.includes(place) ? places.filter((other) => other !== place) : [...places, place].sort((a, b) => a - b);
    }));
    if (advance && !multiple) advanceSoon(index, finish);
  };

  /**
   * After a single choice is picked by a press or its number key (C60): a moment for the pick to be
   * seen, then the next question; on the last, Submit only for its first answer on its first visit,
   * with the earlier questions answered before arrival. A revision cancels the pending action.
   * A pick made otherwise — the arrows' or Space's — moves nothing, and nor does a pick of several.
   */
  const afterPick = useRef<(index: number, finish: boolean) => void>(() => undefined);
  const advanceSoon = (index: number, finish: boolean): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { afterPick.current(index, finish); }, ADVANCE_MS);
  };

  /** A number key (C12, C13, C15): the shown question's row of that number, picked, or its field focused. Whether it was this card's. */
  const pick = (key: number): boolean => {
    if (question === undefined || question.secret) return false;
    const place = key - 1;
    if (place < question.options.length) {
      choose(at, place, question.multiple, true);
      return true;
    }
    if (place === elseRow(question)) { rows.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); return true; }
    return false;
  };
  // The list passes its keys on to its current entry (C15): this card, by its item's id.
  const keys = useContext(CardKeysContext);
  const picker = useRef(pick);
  useLayoutEffect(() => { picker.current = pick; });
  useEffect(() => {
    if (keys === null) return undefined;
    const handler = (key: number): boolean => picker.current(key);
    keys.set(item.id, handler);
    return () => { if (keys.get(item.id) === handler) keys.delete(item.id); };
  }, [keys, item.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || isTextField(event.target)) return;
    if (/^[1-9]$/.test(event.key)) {
      if (pick(Number(event.key))) event.preventDefault();
      return;
    }
    // Enter on a row moves to the next question; on the last it does nothing (C16).
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      go(at + 1);
    }
  };

  const submit = (): void => {
    clearTimeout(timer.current);
    autoSubmit.current = false;
    if (sending || held || !allSeen) return;
    const entries: AnswerEntry[] = questions.map((each, index) => {
      const typed = each.secret ? secrets.current[index]?.value ?? '' : texts[index] ?? '';
      return { question: index, options: each.secret ? [] : [...(chosen[index] ?? [])], text: typed.trim() === '' ? null : typed };
    });
    // One question answered at least (C30): a blank one goes as "No answer", and none at all is Decline's.
    if (noneAnswered(placeAnswers(questions.length, entries) ?? [])) { setProblem(CARD_WORDS.nothing); return; }
    setProblem(null);
    setSending(true);
    invoke('chat:answer', { sessionId: scope.sessionId, itemId: item.id, answers: entries }).then(
      // Taken: the item's push brings the settled card. Refused: what was entered stays (C26).
      (answer) => {
        if (answer.status === 'refused') setProblem(answerRefusalText(answer.reason, scope.providerName));
        // Taken in the session's own chat: the keyboard goes on to its prompt (C61).
        else if (scope.asker === null) focusPrompt(scope.sessionId);
      },
      () => { setProblem(CARD_WORDS.failed); },
    ).finally(() => { setSending(false); });
  };

  const decline = (): void => {
    clearTimeout(timer.current);
    autoSubmit.current = false;
    if (sending) return;
    setProblem(null);
    setSending(true);
    invoke('chat:dismiss', { sessionId: scope.sessionId, itemId: item.id }).then(
      // A stale press says nothing by itself (C49): the item's push brings the card's state.
      (answer) => {
        if (answer.status === 'refused') { if (answer.reason !== 'not-open') setProblem(CARD_WORDS.dismissFailed); }
        else if (scope.asker === null) focusPrompt(scope.sessionId);
      },
      () => { setProblem(CARD_WORDS.dismissFailed); },
    ).finally(() => { setSending(false); });
  };

  // What a pick leads to, read when its moment is over: the card as it then stands (C60).
  useLayoutEffect(() => {
    afterPick.current = (index, finish) => {
      // The user went elsewhere meanwhile: nothing moves.
      if (index !== at) return;
      if (index < last) go(index + 1);
      else if (finish && questions.every((_, each) => boxOf(each) === 'answered')) submit();
    };
  });

  if (question === undefined) return null;
  const changedText = (index: number): void => {
    clearTimeout(timer.current);
    if (index === last) autoSubmit.current = false;
    setProblem(null);
  };
  const setTyped = (index: number, value: string): void => { changedText(index); setTexts((before) => before.map((text, which) => (which === index ? value : text))); };

  return (
    <div className={styles.qWaiting} onKeyDown={onKeyDown}>
      {/* Every question in one cell of the grid, the shown one alone seen and reached (C48): the card keeps its tallest question's height, and nothing under it moves as the questions change. */}
      <div className={styles.qStack}>
        {questions.map((each, index) => {
          const here = index === at;
          const extra = elseRow(each);
          const numbered = !each.secret && each.options.length > 0;
          const typed = texts[index] ?? '';
          return (
            <fieldset key={index} className={styles.qQuestion} data-card-question={index} data-shown={here ? '' : undefined} aria-hidden={here ? undefined : true} inert={!here}>
              <legend className={styles.qLegend}>
                <span className={styles.qText}>{each.text}</span>
                {/* Where several may be chosen, it says so (C49): its rows toggle, where a single choice's replace one another. */}
                {numbered && each.multiple && <span className={styles.qHint} data-card-hint="">{CARD_WORDS.several}</span>}
              </legend>
              {/* The heavy rules are the numbered rows' own (C43): a field alone, or a secret's, stands without them. */}
              <div className={numbered ? styles.qRows : styles.qFields} data-card-rows={numbered ? 'numbered' : 'fields'} ref={here ? rows : undefined}>
                {/* A secret draws no option (C44): its masked field is all there is of it. */}
                {!each.secret && each.options.map((option, place) => {
                  const picked = chosen[index]?.includes(place) === true;
                  return (
                    <label key={place} className={styles.qRow} data-picked={picked ? '' : undefined} data-card-row={place + 1}>
                      <input
                        className={styles.qInput}
                        type={each.multiple ? 'checkbox' : 'radio'}
                        name={`${name}-${index}`}
                        checked={picked}
                        tabIndex={stop}
                        aria-keyshortcuts={String(place + 1)}
                        // A label forwards a click to its input: handle the pick once, on the input.
                        // Already selected radios emit no change, but pressing one still cancels a pending submission.
                        onClick={(event) => { if (picked && !each.multiple) choose(index, place, false, event.detail > 0); }}
                        onChange={(event) => choose(index, place, each.multiple, event.nativeEvent instanceof MouseEvent && event.nativeEvent.detail > 0)}
                      />
                      <span className={styles.qNumber} aria-hidden="true">{place + 1}</span>
                      <span className={styles.qOption}>
                        {option.label}
                        {option.description !== null && <small className={styles.cardDescription}>{option.description}</small>}
                      </span>
                    </label>
                  );
                })}
                {each.secret ? (
                  <label className={styles.cardField}>
                    <span className={styles.cardFieldName}>{CARD_WORDS.secret}</span>
                    <input ref={(element) => { secrets.current[index] = element; }} type="password" className={styles.cardSecret} autoComplete="off" maxLength={MAX_ANSWER_TEXT} tabIndex={stop} onInput={(event) => { const typed = event.currentTarget.value !== ''; changedText(index); setSecretTyped((before) => before.map((was, which) => (which === index ? typed : was))); }} />
                  </label>
                ) : extra !== null ? (
                  // The last numbered row (C13): picked while its field holds text.
                  <div className={styles.qRow} data-picked={typed.trim() === '' ? undefined : ''} data-card-row={extra + 1} onClick={(event) => { if (!isTextField(event.target)) event.currentTarget.querySelector('textarea')?.focus(); }}>
                    <span className={styles.qNumber} aria-hidden="true">{extra + 1}</span>
                    <label className={styles.qElse}>
                      <span className={styles.cardFieldName}>{CARD_WORDS.somethingElse}</span>
                      <textarea className={`${styles.input} ${styles.cardInput}`} value={typed} maxLength={MAX_ANSWER_TEXT} tabIndex={stop} aria-keyshortcuts={String(extra + 1)} onChange={(event) => setTyped(index, event.target.value)} />
                    </label>
                  </div>
                ) : each.freeText && (
                  // A question with no options (C13): its field alone, unnumbered. One that refuses text is answered by its options alone (C78).
                  <label className={styles.cardField}>
                    <span className={styles.cardFieldName}>{CARD_WORDS.answer}</span>
                    <textarea className={`${styles.input} ${styles.cardInput}`} value={typed} maxLength={MAX_ANSWER_TEXT} tabIndex={stop} onChange={(event) => setTyped(index, event.target.value)} />
                  </label>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>
      {body.cut && <p className={styles.line} data-item-line="cut">{CARD_WORDS.cut}</p>}
      <div className={styles.qFoot} ref={actions}>
        {/* A press on its way makes neither button disabled, only said unavailable: a disabled button cannot hold the focus the card hands on when it settles. */}
        {declinable ? (
          <button type="button" className={styles.qDecline} data-card-decline="" aria-disabled={sending || undefined} tabIndex={stop} onClick={decline}>
            {CARD_WORDS.decline(questions.length)}
          </button>
        ) : <span aria-hidden="true" />}
        {/* Between them (C51), for a request of several questions alone: a box for each question, with Previous before them and Next after them, where there is one. */}
        {questions.length > 1 ? (
          <div className={styles.qStepper} role="group" aria-label={CARD_WORDS.placeName(at + 1, questions.length)} data-card-stepper="">
            {at > 0
              ? <button type="button" className={styles.qStep} tabIndex={stop} onClick={() => go(at - 1)}>{CARD_WORDS.previous}</button>
              : <span className={styles.qStepGap} aria-hidden="true" />}
            <span className={styles.qBoxes}>
              {questions.map((_, index) => {
                const box = boxOf(index);
                // A press shows its question (C52): out of the Tab order, which Previous and Next serve, and named for assistive technology by what it shows.
                return <button key={index} type="button" className={styles.qBox} tabIndex={-1} aria-label={CARD_WORDS.boxName(index + 1, box)} aria-current={index === at ? 'step' : undefined} data-box={box} data-current={index === at ? '' : undefined} onClick={() => go(index)} />;
              })}
            </span>
            {at < last
              ? <button type="button" className={styles.qStep} tabIndex={stop} onClick={() => go(at + 1)}>{CARD_WORDS.next}</button>
              : <span className={styles.qStepGap} aria-hidden="true" />}
          </div>
        ) : <span aria-hidden="true" />}
        {/* Disabled, and drawn lighter, until every question has been shown once; available from then, wherever the user goes (C58). */}
        <button type="button" className={styles.qSubmit} data-card-submit="" disabled={!allSeen || held} aria-disabled={sending || undefined} aria-describedby={held || intoTurn ? reasonId : undefined} tabIndex={stop} onClick={submit}>
          {CARD_WORDS.submit(questions.length)}
        </button>
      </div>
      {held && <p id={reasonId} className={styles.cardReason}>{runningWords(scope.providerName)}</p>}
      {intoTurn && <p id={reasonId} className={styles.cardReason}>{CARD_WORDS.intoTurn(scope.providerName)}</p>}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}

/**
 * A question the session asks, as a card (docs/planning/_archive/M21.md, Design 7; C37–C49, C68, C78, C79;
 * M100b): one entry of the list at the item's place, drawn from the item alone. Its header counts the
 * request's questions, on the attention colour while it waits and in the acknowledged pair once
 * settled; who asks, and the mode, are its accessible name, and the time — where times are shown —
 * the header's tooltip (M100b, C7). While it waits — a blocking question pending on this run, or an
 * async one that is open — it holds its questions one at a time, and Decline and Submit; once settled
 * its answers stay as text, folded under the header once answered. Its outcome stays in words,
 * never by colour alone and never as disabled controls that look answerable.
 *
 * The one component for the chat's list and a worker's tab (C42); what differs between them is its
 * `CardContext`, and a list with none draws every card inert.
 *
 * It draws a question's body alone (M22, C77): an approval's, which the same item kind holds, is
 * `ApprovalCard`'s, and the list tells the two apart by the body's kind.
 */
export const InteractionCard = memo(function InteractionCard({ item, modelName, id, current = false, times = null, carrier }: InteractionCardProps) {
  const scope = useContext(CardContext);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const body = questionOf(item);
  if (body === null) return null;
  const waiting = body.outcome === 'pending' || body.outcome === 'open';
  const answerable = waiting && scope !== null;
  const foldable = body.outcome === 'answered';
  const shown = !foldable || expanded;
  const head = headWords(scope?.asker ?? modelName, body.mode, body.outcome === 'pending');
  const unconfirmed = isUnconfirmed(item, body, scope, carrier);
  const words = outcomeWords(body, unconfirmed);
  const at = times === null ? null : item.time.receivedAt;
  return (
    <article id={id} className={styles.card} data-role="interaction" data-interaction="" data-kind="question" data-mode={body.mode} data-outcome={body.outcome} data-current={current ? '' : undefined} aria-label={head}>
      <p className={styles.qHeader} data-card-header="" data-waiting={answerable ? '' : undefined} data-foldable={foldable ? '' : undefined} data-folded={!shown && !unconfirmed ? '' : undefined} title={at === null ? undefined : formatDateTime(at)}>
        {foldable && (
          <button type="button" className={`${styles.disclosure} ${styles.qFold}`} aria-label={expanded ? CARD_WORDS.hideAnswers : CARD_WORDS.showAnswers} aria-expanded={expanded} aria-controls={detailsId} tabIndex={current ? 0 : -1} onClick={() => setExpanded((open) => !open)}>
            <span className={styles.chevronMark} data-open={expanded ? '' : undefined} aria-hidden="true" />
          </button>
        )}
        {answerable ? CARD_WORDS.count(body.questions.length) : CARD_WORDS.settled(body.questions.length, body.outcome)}
      </p>
      {answerable
        ? <Waiting item={item} body={body} scope={scope} stop={current ? 0 : -1} />
        : <div id={detailsId} hidden={!shown}>
            {shown && <Settled body={body} />}
            {shown && body.cut && <p className={styles.line} data-item-line="cut">{CARD_WORDS.cut}</p>}
          </div>}
      {words !== null && (shown || unconfirmed) && <p className={styles.cardOutcome} data-card-outcome="">{words}</p>}
    </article>
  );
});
