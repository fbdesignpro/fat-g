// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type MouseEvent, memo, useContext, useEffect, useId, useRef, useState } from 'react';
import { asideTitle } from '@shared/contracts/aside';
import { type Finding, findingExcerpt, REVIEW_BOUNDS, type ReviewMark, type ReviewRoundView, type ReviewView, type SetAside, TIERS } from '@shared/contracts/review';
import { openAside, openPlanAt } from '../artifacts/opener';
import { askRefusalText, EXPLAIN_BUTTONS_VISIBLE } from './aside-actions';
import { invoke } from '../ipc/client';
import { selectSession } from '../sessions/select';
import { BlockControlContext, TabStopContext } from '../markdown/inert';
import { MarkdownText } from '../markdown/MarkdownText';
import { CHROME_ATTRIBUTE, placeOf } from './drawn-text';
import { REVIEW_WORDS, reviewRefusalText } from './review-words';
import { applyMarks, setReviewProblem, useReviewProblem } from './reviews-store';
import { SOURCE_KIND } from './selection-report';
import styles from './Chat.module.css';

/** How long a note waits after its last keystroke before it is written (Design 2): typing never waits on the disk. */
export const NOTE_WRITE_MS = 300;

export interface FindingsListProps {
  readonly review: ReviewView;
  readonly round: ReviewRoundView;
  /** The reviewer's session: whose asides Explain opens. */
  readonly sessionId: string;
  readonly providerName: string;
  /** The plan's title, as the page holds it: what an anchor's tab is titled with. */
  readonly title: string;
  /** The findings its answer set aside and the round does not hold (the maintainer). */
  readonly leftOut: readonly SetAside[];
  /** The ids of those it set aside that stand as the round before had them. */
  readonly kept: readonly string[];
}

const CHROME = { [CHROME_ATTRIBUTE]: '' };
/** A finding's number within its tier: the 2 of `T3.2`. */
const numberOf = (id: string): number => Number(id.slice(id.indexOf('.') + 1));

/**
 * A round of a review, where its block was in the reviewer's answer (docs/planning/_archive/M22e.md, Design 5;
 * C7, C21, C28–C30, C33, C34): the appraisal, then each tier that has findings as a box of its own —
 * its header tinted in the tier's colour, with Accept all and Refuse all — and each finding a row of
 * two columns in dashed lines, drawn whole: its four controls stacked, the cell under them taking
 * what height is left; and beside them its id, its tag and its title, its example, description and
 * correction as Markdown under the session's opener, its anchor's link, and its note.
 *
 * Its controls are marked as chrome, so a selection, a copy and an aside's passage see the finding's
 * words alone. A click on a row accepts it, or returns an accepted one to undecided; Refuse refuses
 * it, and returns it; a click that ends with text selected marks nothing (0021). Each row is a stop
 * of the message's own, and Space on it is its click. Every mark is written, then drawn as main gave
 * it back. An earlier round is inert: its frozen marks, its notes as they were sent, and no control.
 */
export const FindingsList = memo(function FindingsList({ review, round, sessionId, providerName, title, leftOut, kept }: FindingsListProps) {
  const current = useContext(TabStopContext);
  const live = round.live;
  const problem = useReviewProblem(review.reviewId);
  // Within its tier by number, whatever order the block gave: a finding moved in from another tier takes the next number, and stands last.
  const tiers = TIERS.map((tier) => ({ tier, findings: round.findings.filter((finding) => finding.tier === tier).toSorted((one, other) => numberOf(one.id) - numberOf(other.id)) })).filter((group) => group.findings.length > 0);
  const latest = review.rounds.at(-1)?.turnId === round.turnId;
  const sent = review.integrations.find((one) => one.state === 'sent');

  const mark = (request: { readonly findingId: string } | { readonly tier: number }, to: ReviewMark): void => {
    setReviewProblem(review.reviewId, null);
    invoke('reviews:mark', { reviewId: review.reviewId, ...request, mark: to }).then(
      (answer) => {
        if (answer.status === 'saved') applyMarks(sessionId, review.reviewId, answer.marks);
        else setReviewProblem(review.reviewId, reviewRefusalText(answer.reason, providerName));
      },
      () => { setReviewProblem(review.reviewId, REVIEW_WORDS.writeFailed); },
    );
  };

  return (
    // No Explain this beside a finding's paragraphs: Explain is on the finding itself (C34).
    <BlockControlContext value={null}>
      <section className={styles.findings} aria-label={REVIEW_WORDS.list} data-findings={round.turnId} data-live={live ? '' : undefined}>
        {latest && (sent !== undefined || review.staleBy !== null) && (
          <p className={styles.findingsHead} {...CHROME}>
            {review.staleBy !== null ? <span data-findings-stale="">{REVIEW_WORDS.staleList(review.staleBy)}</span>
              : sent !== undefined ? (
                // The chat it went to, as a button that selects it (C8).
                <button type="button" className={styles.inlineButton} tabIndex={current ? 0 : -1} disabled={sent.chat === null} data-findings-integrating="" onClick={() => { void selectSession(sent.sessionId).catch(() => undefined); }}>
                  {REVIEW_WORDS.integratingIn(sent.chat)}
                </button>
              ) : null}
          </p>
        )}
        {round.appraisal !== '' && <p className={styles.appraisal}>{round.appraisal}</p>}
        {/* What its answer set aside, in fat-g's words: the rest of the round stands (the maintainer). */}
        {kept.length > 0 && <p className={styles.setAside} data-findings-kept="" {...CHROME}>{REVIEW_WORDS.keptAsBefore(kept)}</p>}
        {leftOut.length > 0 && <p className={styles.setAside} data-findings-left-out="" {...CHROME}>{REVIEW_WORDS.leftOut(leftOut)}</p>}
        {tiers.map(({ tier, findings }) => (
          <section key={tier} className={styles.tier} data-tier={tier} aria-label={REVIEW_WORDS.tier(tier)}>
            <div className={styles.tierHead}>
              <h3 className={styles.tierName}>{REVIEW_WORDS.tier(tier)}</h3>
              {live && (
                <span className={styles.tierActions} {...CHROME}>
                  <button type="button" className={styles.tierButton} tabIndex={current ? 0 : -1} aria-label={REVIEW_WORDS.acceptAllLabel(tier)} onClick={() => mark({ tier }, 'accepted')}>{REVIEW_WORDS.acceptAll}</button>
                  <button type="button" className={styles.tierButton} tabIndex={current ? 0 : -1} aria-label={REVIEW_WORDS.refuseAllLabel(tier)} onClick={() => mark({ tier }, 'rejected')}>{REVIEW_WORDS.refuseAll}</button>
                </span>
              )}
            </div>
            <ul className={styles.findingRows}>
              {findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  mark={round.marks[finding.id] ?? 'open'}
                  note={round.notes[finding.id] ?? ''}
                  revised={round.revised.includes(finding.id)}
                  live={live}
                  current={current}
                  review={review}
                  sessionId={sessionId}
                  providerName={providerName}
                  title={title}
                  onMark={(to) => mark({ findingId: finding.id }, to)}
                />
              ))}
            </ul>
          </section>
        ))}
        {problem !== null && <p className={styles.problem} role="status" {...CHROME}>{problem}</p>}
      </section>
    </BlockControlContext>
  );
});

interface RowProps {
  readonly finding: Finding;
  readonly mark: ReviewMark;
  readonly note: string;
  readonly revised: boolean;
  readonly live: boolean;
  readonly current: boolean;
  readonly review: ReviewView;
  readonly sessionId: string;
  readonly providerName: string;
  readonly title: string;
  readonly onMark: (to: ReviewMark) => void;
}

function FindingRow({ finding, mark, note, revised, live, current, review, sessionId, providerName, title, onMark }: RowProps) {
  const row = useRef<HTMLLIElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const fieldId = useId();
  const stop = current ? 0 : -1;
  const anchor = review.anchors[finding.id];

  /** A click on the row marks it (C28): not one on a control, nor one that ends with text selected (0021). */
  const press = (event: MouseEvent<HTMLLIElement> | KeyboardEvent<HTMLLIElement>): void => {
    if (!live) return;
    const target = event.target as HTMLElement;
    if (target.closest(`[${CHROME_ATTRIBUTE}], a, button, textarea, details`) !== null && target !== row.current) return;
    if (row.current?.ownerDocument.getSelection()?.isCollapsed === false) return;
    onMark(mark === 'accepted' ? 'open' : 'accepted');
  };

  const explain = (): void => {
    const element = words.current;
    const root = element?.closest(`[${SOURCE_KIND}]`) ?? null;
    if (element === null || root === null) return;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const place = placeOf(root, range);
    if (place === null) return;
    setReviewProblem(review.reviewId, null);
    invoke('reviews:explain', { reviewId: review.reviewId, findingId: finding.id, place }).then(
      (answer) => {
        if (answer.status === 'accepted') openAside(sessionId, answer.asideId, asideTitle({ excerpt: findingExcerpt(finding) }, ''));
        else setReviewProblem(review.reviewId, answer.reason === 'unknown-review' || answer.reason === 'unknown-finding' ? reviewRefusalText(answer.reason, providerName) : askRefusalText(answer.reason, providerName));
      },
      () => { setReviewProblem(review.reviewId, REVIEW_WORDS.writeFailed); },
    );
  };

  return (
    <li
      ref={row}
      className={styles.findingRow}
      data-finding={finding.id}
      data-mark={mark}
      tabIndex={live ? stop : undefined}
      onClick={press}
      onKeyDown={(event) => {
        // Space on the row itself is its click (C28); a control inside it keeps its keys.
        if (event.key !== ' ' || event.target !== event.currentTarget) return;
        event.preventDefault();
        press(event);
      }}
    >
      {live && (
        <span className={styles.findingControls} {...CHROME}>
          <button type="button" className={styles.findingControl} tabIndex={stop} aria-label={REVIEW_WORDS.accept(finding.id)} aria-pressed={mark === 'accepted'} data-finding-accept="" onClick={() => onMark(mark === 'accepted' ? 'open' : 'accepted')}>✓</button>
          <button type="button" className={styles.findingControl} tabIndex={stop} aria-label={REVIEW_WORDS.refuse(finding.id)} aria-pressed={mark === 'rejected'} data-finding-refuse="" onClick={() => onMark(mark === 'rejected' ? 'open' : 'rejected')}>✗</button>
          {EXPLAIN_BUTTONS_VISIBLE && <button type="button" className={styles.findingControl} tabIndex={stop} aria-label={REVIEW_WORDS.explain(finding.id)} data-finding-explain="" onClick={explain}>?</button>}
          <button type="button" className={styles.findingControl} tabIndex={stop} aria-label={REVIEW_WORDS.note(finding.id)} aria-expanded={editing} aria-controls={editing ? fieldId : undefined} data-finding-note="" onClick={() => setEditing((was) => !was)}>✎</button>
          {/* The column's last cell: whatever height the finding leaves under the four. */}
          <span className={styles.findingControlsRest} aria-hidden="true" />
        </span>
      )}
      <div className={styles.findingBody}>
        <div ref={words} className={styles.findingWords}>
          <p className={styles.findingHead}>
            <span className={styles.findingId}>{finding.id}</span>
            <span className={styles.findingTag}>{finding.category}</span>
            <strong className={styles.findingTitle}>{finding.title}</strong>
            {revised && <span className={styles.findingRevised} {...CHROME}>{REVIEW_WORDS.revised}</span>}
          </p>
          <div className={styles.findingField} data-field="example"><MarkdownText text={finding.example} /></div>
          <div className={styles.findingField} data-field="description"><MarkdownText text={finding.description} /></div>
          <div className={styles.findingField} data-field="correction"><MarkdownText text={finding.correction} /></div>
        </div>
        {finding.anchor !== undefined && (
          <p className={styles.findingAnchor} {...CHROME}>
            <button
              type="button"
              className={styles.inlineButton}
              tabIndex={stop}
              data-finding-anchor=""
              onClick={() => { openPlanAt(sessionId, review.planId, title, review.version, anchor?.line ?? null); }}
            >
              {REVIEW_WORDS.anchor(finding.anchor.heading, finding.anchor.quote)}
            </button>
          </p>
        )}
        {live && editing ? (
          <NoteField id={fieldId} reviewId={review.reviewId} findingId={finding.id} note={note} providerName={providerName} onDone={() => setEditing(false)} />
        ) : note !== '' && <p className={styles.findingNote} data-finding-note-text="">{note}</p>}
      </div>
    </li>
  );
}

/**
 * A finding's note (C30): written at most every 300 ms while it is typed, and at blur, so typing
 * never waits on the disk. A failed write keeps the field's text and says so.
 */
function NoteField({ id, reviewId, findingId, note, providerName, onDone }: { readonly id: string; readonly reviewId: string; readonly findingId: string; readonly note: string; readonly providerName: string; readonly onDone: () => void }) {
  const [text, setText] = useState(note);
  const timer = useRef<number | undefined>(undefined);
  const written = useRef(note);
  const field = useRef<HTMLTextAreaElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => () => { window.clearTimeout(timer.current); }, []);

  const write = (value: string): void => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (value === written.current) return;
    written.current = value;
    invoke('reviews:note', { reviewId, findingId, note: value }).then(
      (answer) => {
        if (answer.status === 'saved') { setFailed(null); return; }
        written.current = '\u0000';
        setFailed(reviewRefusalText(answer.reason, providerName));
      },
      () => { written.current = '\u0000'; setFailed(REVIEW_WORDS.writeFailed); },
    );
  };

  return (
    <div className={styles.noteBox} {...CHROME}>
      <label className={styles.noteLabel} htmlFor={id}>{REVIEW_WORDS.noteField(findingId)}</label>
      <textarea
        ref={field}
        id={id}
        className={styles.noteField}
        value={text}
        maxLength={REVIEW_BOUNDS.note}
        data-note-field={findingId}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => { write(value); }, NOTE_WRITE_MS);
        }}
        onBlur={() => { write(text); onDone(); }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); write(text); onDone(); } }}
      />
      {failed !== null && <p className={styles.problem} role="status">{failed}</p>}
    </div>
  );
}
