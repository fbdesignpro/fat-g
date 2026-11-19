// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_PLAN_READ, PLAN_WHOLE_DRAW, type PlanVersionView } from '@shared/contracts/plans';
import { PLAN_PAGE_WORDS } from '../../chat/plan-words';
import { MISSING, readPlanInfo, usePlanInfo } from '../../chat/plans-store';
import { REVIEW_WORDS, reviewPhrase } from '../../chat/review-words';
import { usePlanReviews } from '../../chat/reviews-store';
import { planSource, sourceAttributes } from '../../chat/selection-report';
import { invoke, subscribe } from '../../ipc/client';
import { selectSession } from '../../sessions/select';
import { OpenerContext } from '../../markdown/inert';
import { MarkdownText } from '../../markdown/MarkdownText';
import { BLOCK_ATTRIBUTE, blockLines, linePart } from '../../markdown/selection';
import { useAppState } from '../../state/store';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { formatDateTime } from '../../ui/format';
import { createOpener } from '../opener';
import { ARTIFACT_WORDS, ArtifactAction, ArtifactBar, ArtifactIcon, ArtifactInformation } from '../ArtifactBar';
import barStyles from '../ArtifactBar.module.css';
import type { TabBodyProps } from '../tab-kind';
import { PLAN_TAB_WORDS } from './words';
import styles from './Plan.module.css';

/**
 * What the pane keeps for a plan's tab between showings: the version named last, with a number that
 * changes at each naming — and, for a finding's anchor (M22e, C33, C41), the line of the passage to
 * mark and come to, or that it was not found; `seen`, the naming the view last came to. `pinned`: the
 * user chose the version in the tab's chooser, so a newer one does not move the tab to it (decision
 * 0029); a tab opened by the chat, its panel or a finding follows the plan's newest version.
 */
export interface PlanViewState {
  readonly version?: number;
  readonly pinned?: boolean;
  readonly serial?: number;
  readonly line?: number;
  readonly missing?: boolean;
  readonly seen?: number;
}

/** The attribute the marked passage carries, as a file's (M19b, C40). */
const LINE_MARK = 'data-line-mark';
/** How far under the text's top a passage that is come to stands, so that what is above it shows. */
const ABOVE_PX = 32;
/** What a long plan's section is known by, for the passage it holds to be marked in it. */
const SECTION_ATTRIBUTE = 'data-plan-section';

/** Marks the block, or the hard-break passage, that holds a line of a drawn Markdown text, counted from its own start, and answers it. */
function markPassage(container: Element, line: number): HTMLElement | null {
  for (const marked of container.ownerDocument.querySelectorAll(`[${LINE_MARK}]`)) marked.removeAttribute(LINE_MARK);
  const blocks = [...(container.querySelector(`[${BLOCK_ATTRIBUTE}]`)?.parentElement?.children ?? [])]
    .flatMap((element) => { const held = blockLines(element); return held === null ? [] : [{ element, ...held }]; });
  const found = blocks.findLast((block) => block.first <= line)?.element;
  if (found === undefined) return null;
  const part = linePart(found, line);
  part.setAttribute(LINE_MARK, '');
  return part as HTMLElement;
}

/** The section of a long text that holds a line, and the line counted from that section's start (C60; M22e, C33). */
export function sectionOfLine(sections: readonly string[], line: number): { readonly index: number; readonly line: number } {
  let start = 1;
  for (let index = 0; index < sections.length; index += 1) {
    const lines = (sections[index] ?? '').split('\n').length - 1;
    if (line < start + lines || index === sections.length - 1) return { index, line: line - start + 1 };
    start += lines;
  }
  return { index: 0, line };
}

/** The version a tab shows by itself: the latest complete one, else the latest. */
function latestOf(versions: readonly PlanVersionView[]): number | null {
  return ([...versions].reverse().find((version) => version.state === 'complete') ?? versions.at(-1))?.version ?? null;
}

/** About how many units a section of a long plan holds (C60): cut at the blank line nearest after it. */
const SECTION_UNITS = 32 * 1024;

/** A long text's sections, each ending at a blank line where one is near: what is drawn near the view alone (C60). */
export function sectionsOf(text: string): readonly string[] {
  const sections: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + SECTION_UNITS);
    if (end < text.length) {
      const blank = text.indexOf('\n\n', end);
      end = blank === -1 || blank - end > SECTION_UNITS ? end : blank + 2;
    }
    sections.push(text.slice(at, end));
    at = end;
  }
  return sections;
}

/**
 * One section of a long plan (C60): its Markdown while it is near the view, and in its place,
 * otherwise, a block as tall as it was when last drawn — or as tall as its lines would be.
 */
const Section = memo(function Section({ text, root, index, forced }: { readonly text: string; readonly root: HTMLElement | null; readonly index: number; readonly forced: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  // Near the view, or — away from it — as tall as it was when it left, which the observer measured.
  // One that holds a passage to come to is drawn first, whatever its place (M22e, C33).
  const [seen, setView] = useState<{ readonly near: boolean; readonly height: number | null }>({ near: typeof IntersectionObserver === 'undefined', height: null });
  const view = forced ? { near: true, height: seen.height } : seen;
  useEffect(() => {
    const element = holder.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last !== undefined) setView((held) => (last.isIntersecting === held.near ? held : { near: last.isIntersecting, height: last.isIntersecting ? held.height : last.boundingClientRect.height }));
    }, { root, rootMargin: '100% 0px' });
    watch.observe(element);
    return () => watch.disconnect();
  }, [root]);
  const lines = text.split('\n').length;
  return (
    <div ref={holder} className={styles.section} {...{ [SECTION_ATTRIBUTE]: String(index) }} style={view.near ? undefined : { minHeight: view.height ?? `${lines * 1.5}em` }}>
      {view.near ? <MarkdownText text={text} /> : null}
    </div>
  );
});

type Shown = { readonly version: number; readonly text: string; readonly length: number } | { readonly version: number; readonly failed: true } | null;

/** A naming of a version in the tab, by the chooser or by the line that says a decision waits: each one new. */
let namings = 0;
const named = (version: number): PlanViewState => ({ version, serial: (namings += 1) });

/**
 * A plan's tab (docs/planning/_archive/M22b.md, Design 7; C25, C26, C60, C73): a head line naming the version
 * shown — unfinished, or still being written, said so — when it came, who made it, in which chat, a
 * chooser of its versions, Copy and a confirmed Remove; metadata in the information tooltip;
 * then its text, drawn as Markdown with the
 * session's opener and marked as an aside's source, so Explain this works on it.
 *
 * The text is read range by range, a mebibyte at most a read (C60), and held while the tab is shown:
 * drawn whole up to 256 KiB, and past that in sections, those near the view alone. While a version
 * is being written its text grows by the plans' push, which says how long it was before each part.
 * Where the plan's decisions stand on another version than the one shown, the head says so, with a
 * button that shows it. Remove asks first, saying how many chats take part in the plan, whose
 * decisions main settles first.
 */
export function PlanBody({ sessionId, reference: planId, viewState, setViewState, setTitle }: TabBodyProps<string, PlanViewState>) {
  const info = usePlanInfo(planId);
  const providers = useAppState((state) => state.snapshot?.providers);
  const versions = info === undefined || info === MISSING ? [] : info.versions;
  const chosen = viewState?.version ?? latestOf(versions);
  const [held, setShown] = useState<Shown>(null);
  const [reread, setReread] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const opener = useMemo(() => createOpener(sessionId), [sessionId]);
  const version = versions.find((entry) => entry.version === chosen);
  const title = info === undefined || info === MISSING ? null : info.title;

  // The tab names it as the chat does: "Plan: <title>" (M22e).
  useEffect(() => { if (title !== null) setTitle(PLAN_PAGE_WORDS.named(title)); }, [title, setTitle]);

  // The version's whole text, range by range (C60).
  useEffect(() => {
    if (chosen === null) return;
    let live = true;
    void (async () => {
      let text = '';
      let length = Number.POSITIVE_INFINITY;
      while (text.length < length) {
        const answer = await invoke('plans:read', { planId, version: chosen, start: text.length, length: MAX_PLAN_READ }).catch(() => null);
        if (!live) return;
        if (answer === null || answer.status !== 'read') { setShown({ version: chosen, failed: true }); return; }
        text += answer.text;
        length = answer.length;
        if (answer.text === '') break;
      }
      setShown({ version: chosen, text, length: text.length });
    })();
    return () => { live = false; };
  }, [planId, chosen, reread]);

  // A version being written grows by the push (C25, C60): a part that does not follow what is held reads it again.
  useEffect(() => subscribe('plans:changed', (push) => {
    if (push.planId !== planId) return;
    if (push.partial === undefined || push.version !== chosen) { if (push.version === chosen) setReread((count) => count + 1); return; }
    const { before, append } = push.partial;
    setShown((current) => {
      if (current === null || !('text' in current) || current.version !== push.version) return current;
      if (current.text.length !== before) { setReread((count) => count + 1); return current; }
      return { ...current, text: current.text + append, length: current.text.length + append.length };
    });
  }), [planId, chosen]);

  const remove = (): void => {
    setBusy(true);
    setProblem(null);
    invoke('plans:remove', { planId }).then(
      (answer) => {
        if (answer.status !== 'removed') setProblem(answer.reason === 'writing' ? PLAN_TAB_WORDS.removeWriting : PLAN_TAB_WORDS.removeFailed);
        readPlanInfo(planId);
      },
      () => { setProblem(PLAN_TAB_WORDS.removeFailed); },
    ).finally(() => { setBusy(false); setRemoving(false); });
  };

  // A finding's passage (M22e, C33, C41): marked and come to once the version it names is drawn, its section first past 256 KiB.
  const shownText = held !== null && held.version === chosen && 'text' in held ? held.text : null;
  // The line the view state names stays drawn while it names it; it is marked and come to once a naming.
  const lineNamed = viewState?.line !== undefined && viewState.version === chosen ? viewState.line : null;
  const passage = lineNamed !== null && viewState?.seen !== viewState?.serial ? lineNamed : null;
  const sections = useMemo(() => (shownText !== null && shownText.length > PLAN_WHOLE_DRAW ? sectionsOf(shownText) : null), [shownText]);
  const target = useMemo(() => (lineNamed === null || sections === null ? null : sectionOfLine(sections, lineNamed)), [lineNamed, sections]);
  const textBox = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const box = textBox.current;
    if (box === null || shownText === null || passage === null) return;
    const container = target === null ? box : box.querySelector(`[${SECTION_ATTRIBUTE}="${target.index}"]`);
    const marked = container === null ? null : markPassage(container, target === null ? passage : target.line);
    if (marked !== null) box.scrollTop += marked.getBoundingClientRect().top - box.getBoundingClientRect().top - ABOVE_PX;
    setViewState({ ...viewState, seen: viewState?.serial ?? 0 });
  }, [scroller, shownText, passage, target, viewState, setViewState]);
  const reviews = usePlanReviews(planId);

  if (info === MISSING) return <div className={styles.plan}><ArtifactBar label={PLAN_TAB_WORDS.head} /><p className={styles.note}>{PLAN_TAB_WORDS.removed}</p></div>;
  // Where the plan's chats decide now (decision 0029): its workflow's version, while it is ready.
  const taking = info?.workflow.participants ?? [];
  const current = info?.workflow.state === 'ready' ? info.workflow.version : null;
  const other = current !== null && current !== chosen ? { version: current } : undefined;
  const provider = version === undefined ? null : providers?.find((candidate) => candidate.id === version.providerId)?.displayName ?? version.providerId;
  // What is held of another version than the one chosen is not shown: the chosen one is being read.
  const shown = held !== null && held.version === chosen ? held : null;
  const text = shown !== null && 'text' in shown ? shown.text : null;
  return (
    <div className={styles.plan} data-plan-tab={planId} data-plan-version={chosen ?? undefined}>
      <ArtifactBar label={PLAN_TAB_WORDS.head}>
        <select className={barStyles.select} aria-label={PLAN_TAB_WORDS.versions} disabled={versions.length <= 1} value={chosen ?? ''} onChange={(event) => setViewState({ ...named(Number(event.target.value)), pinned: true })}>
          {versions.length === 0 && <option value="">—</option>}
          {versions.map((entry) => <option key={entry.version} value={entry.version}>{PLAN_TAB_WORDS.version(entry.version)}</option>)}
        </select>
        <ArtifactInformation label={PLAN_TAB_WORDS.information} disabled={version === undefined}>
          {version !== undefined && <div>
            <p className={barStyles.metadata}>{PLAN_TAB_WORDS.version(version.version)} · <time dateTime={new Date(version.at).toISOString()}>{formatDateTime(version.at)}</time></p>
            <p className={barStyles.metadata}>{PLAN_TAB_WORDS.madeBy(provider ?? version.providerId, version.model)}</p>
            <p className={barStyles.metadata}>{PLAN_TAB_WORDS.chat(version.chat)}</p>
          </div>}
        </ArtifactInformation>
        <ArtifactAction key={`copy-${chosen}`} kind="copy" label={ARTIFACT_WORDS.copy} disabled={text === null} action={() => navigator.clipboard.writeText(text ?? '')} />
        <button type="button" className={barStyles.button} aria-label={PLAN_TAB_WORDS.remove} title={PLAN_TAB_WORDS.remove} data-plan-remove="" disabled={info === undefined || busy} onClick={() => setRemoving(true)}><ArtifactIcon kind="trash" /></button>
      </ArtifactBar>
      {version?.state === 'unfinished' && <p className={styles.note} data-plan-unfinished="">{PLAN_TAB_WORDS.unfinished}</p>}
      {version?.state === 'drafting' && <p className={styles.note}>{PLAN_TAB_WORDS.drafting}</p>}
      {other !== undefined && (
        <p className={styles.waits} role="note">
          {PLAN_TAB_WORDS.waitsOn(other.version)}
          <button type="button" className={styles.button} onClick={() => setViewState(named(other.version))}>{PLAN_TAB_WORDS.showWaiting(other.version)}</button>
        </p>
      )}
      {/* The shown version's reviews (M22e, C12): each one's state, and its reviewer's chat, which a press selects. */}
      {(reviews ?? []).filter((review) => review.version === chosen).map((review) => (
        <p key={review.reviewId} className={styles.waits} data-plan-tab-review={review.reviewId}>
          <span>{reviewPhrase(review)}</span>
          {review.reviewer.chat === null ? <span>{REVIEW_WORDS.sessionRemoved}</span> : (
            <button type="button" className={styles.button} onClick={() => { void selectSession(review.reviewer.sessionId).catch(() => undefined); }}>
              {review.reviewer.chat === '' ? PLAN_TAB_WORDS.chat('') : review.reviewer.chat}
            </button>
          )}
        </p>
      ))}
      {viewState?.missing === true && viewState.version === chosen && <p className={styles.note} role="status" data-plan-passage-missing="">{REVIEW_WORDS.notFound(chosen)}</p>}
      {problem !== null && <p className={styles.note} role="status">{problem}</p>}
      <div ref={(element) => { textBox.current = element; setScroller(element); }} className={styles.text}>
        {shown === null && <p className={styles.note}>{PLAN_TAB_WORDS.reading}</p>}
        {shown !== null && 'failed' in shown && <p className={styles.note}>{PLAN_TAB_WORDS.failed}</p>}
        {text !== null && chosen !== null && (
          <OpenerContext value={opener}>
            {/* An aside's source (C26): this version of the plan. */}
            <div {...sourceAttributes(planSource(planId, chosen))}>
              {sections === null ? <MarkdownText text={text} /> : sections.map((section, index) => <Section key={index} index={index} text={section} root={scroller} forced={target?.index === index} />)}
            </div>
          </OpenerContext>
        )}
      </div>
      <ConfirmDialog open={removing} title={PLAN_TAB_WORDS.removeTitle(title ?? PLAN_TAB_WORDS.title)} confirmLabel="Remove" busy={busy} onConfirm={remove} onCancel={() => setRemoving(false)}>
        <p>{PLAN_TAB_WORDS.removeText}</p>
        {taking.length > 0 && <p>{PLAN_TAB_WORDS.removeWaiting(taking.length)}</p>}
      </ConfirmDialog>
    </div>
  );
}
