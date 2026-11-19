// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type FileReadAnswer, lastPart, MARKDOWN_UNITS_BOUND } from '@shared/contracts/files';
import { showPassage } from '../../chat/aside-highlights';
import { useSourceMarkers } from '../../chat/asides-store';
import { useAsidePassages } from '../../chat/ExplainControl';
import { fileSource, sourceAttributes } from '../../chat/selection-report';
import { invoke } from '../../ipc/client';
import { REFERENCE_SAID_MS, REFERENCE_WORDS } from '../../markdown/controls';
import { OpenerContext } from '../../markdown/inert';
import { MarkdownText } from '../../markdown/MarkdownText';
import { BLOCK_ATTRIBUTE, blockLines, linePart } from '../../markdown/selection';
import announcer from '../../ui/Announcer.module.css';
import { formatTime } from '../../ui/format';
import { createOpener, FILE_KIND, openAside, openImageFile } from '../opener';
import { ARTIFACT_WORDS, ArtifactAction, ArtifactBar } from '../ArtifactBar';
import type { TabBodyProps } from '../tab-kind';
import { tabId, takeHanded, useTabs } from '../tabs-store';
import { LINES_HOLDER, PlainTextView } from './PlainTextView';
import { contentsLabel, FILE_WORDS, UNSHOWN_WORDS } from './words';
import { FileRefreshStatus } from '../FileRefreshStatus';
import { useFileRefresh } from './useFileRefresh';
import styles from './File.module.css';

/** What the pane keeps for a file's tab between showings (C5, C40): the line a reference named, and the text's place. */
export interface FileViewState {
  /** The line the last reference named, with a number that changes at each naming: the same line named again is come to again. */
  readonly line?: number | null;
  readonly column?: number | null;
  readonly serial?: number;
  /** The naming the view last came to. */
  readonly seen?: number;
  /** Where the text was scrolled to when its tab was last left. */
  readonly top?: number;
  readonly left?: number;
  /** The last automatic text update, kept only for this open tab's lifetime. */
  readonly autoUpdatedAt?: number;
  /** Whether the most recent update was an explicit reload. */
  readonly manuallyReloaded?: boolean;
}

/** The attribute the marked line, passage or block carries. */
export const LINE_MARK = 'data-line-mark';
/** How far under the text's top a line that is come to stands, so that what is above it shows. */
const ABOVE_PX = 32;

type Shown = FileReadAnswer | { readonly outcome: 'failed' };

/** Marks the element a line is in, and answers it: `end` for a line past the text's end, null where nothing can be marked. */
function markLine(scroller: HTMLElement, line: number): HTMLElement | 'end' | null {
  for (const marked of scroller.querySelectorAll(`[${LINE_MARK}]`)) marked.removeAttribute(LINE_MARK);
  let found: Element | undefined;
  const lines = scroller.querySelector(`[${LINES_HOLDER}]`);
  if (lines !== null) {
    // Plain text: an element a line.
    if (line > lines.children.length) return 'end';
    found = lines.children[line - 1];
  } else {
    // Markdown: the block that holds the line, or the last block before it (C40).
    const blocks = [...(scroller.querySelector(`[${BLOCK_ATTRIBUTE}]`)?.parentElement?.children ?? [])]
      .flatMap((element) => { const held = blockLines(element); return held === null ? [] : [{ element, ...held }]; });
    const last = blocks.at(-1);
    if (last === undefined) return null;
    if (line > last.last) return 'end';
    found = blocks.findLast((block) => block.first <= line)?.element;
    if (found !== undefined) found = linePart(found, line);
  }
  if (found === undefined) return null;
  found.setAttribute(LINE_MARK, '');
  return found as HTMLElement;
}

/**
 * A file's tab (docs/planning/_archive/M19b.md, Design 8; C31–C33, C36–C38, C40, C42, C53, C54): one line
 * above the text — its kind, Reload, Show in folder with the full path in its tooltip, and Copy — and then
 * the text, which alone scrolls.
 *
 * It reads when first shown, shown again, at Reload, and on visible-file polling; main checks
 * everything again at each read: a root no longer trusted, and a file gone or changed, are found at
 * the next showing. The answer that opened the tab is taken from the store, so an opening reads
 * once. The text is this body's state: held for the shown tab and for no other, and gone when
 * another tab is shown (C33). An answer for a tab no longer shown is dropped.
 *
 * A Markdown file is drawn by the chat's own component, under its rules, with an opener bound to
 * this file, so a relative reference resolves against its folder (C37); past its bound it is plain
 * text, with a line that says so (C38). A text file on the lists is plain text (C53). Where the
 * target named a line, the view comes to it and marks it, and a later reference moves the mark
 * (C40). A file that shows no text says which state it is in, in fat-g's words (C42).
 *
 * The text is a source (M20b, C45, C74): a selection in it has Explain this in fat-g's menu, with
 * the file's real path and its lines. The asides asked about this file are listed under the line
 * above the text, each a control titled as its tab that comes to its passage, which is painted in
 * the text where it still reads as it was selected — and opens the aside's tab where it does not.
 */
export function FileBody({ sessionId, reference, viewState, setViewState }: TabBodyProps<string, FileViewState>) {
  const id = tabId(FILE_KIND, reference);
  const handed = useTabs((state) => state.sessions[sessionId]?.tabs.find((tab) => tab.id === id)?.handed) as FileReadAnswer | undefined;
  const [shown, setShown] = useState<Shown | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const [announcedAt, setAnnouncedAt] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The reads asked so far: an answer to any but the last is dropped. */
  const generation = useRef(0);
  const alive = useRef(false);
  const started = useRef(false);
  const restored = useRef(false);
  const place = useRef({ top: viewState?.top ?? 0, left: viewState?.left ?? 0 });
  const latest = useRef(viewState);
  const timer = useRef<number | undefined>(undefined);
  const { failed: refreshFailed, replace: refreshBaseline } = useFileRefresh(sessionId, reference, scroller, (answer) => {
    if (scroller.current !== null) place.current = { top: scroller.current.scrollTop, left: scroller.current.scrollLeft };
    restored.current = false;
    setShown(answer);
    const at = Date.now();
    setAnnouncedAt(at);
    setViewState({ ...latest.current, autoUpdatedAt: at, manuallyReloaded: false });
  });

  // What was read on the way to opening the tab, or to pointing at another of its lines: shown in
  // place of a read, at once.
  if (handed !== undefined && handed !== shown) setShown(handed);

  const read = useCallback((manual = false): void => {
    refreshBaseline(null);
    generation.current += 1;
    const mine = generation.current;
    const take = (answer: Shown): void => {
      if (!alive.current || generation.current !== mine) return;
      setShown(answer);
      refreshBaseline(answer.outcome === 'text' ? answer : null);
      if (manual && answer.outcome === 'text') setViewState({ ...latest.current, autoUpdatedAt: Date.now(), manuallyReloaded: true });
      // A file that reads as an image now (decision 0022, item 15): its own tab draws it.
      if (answer.outcome === 'image') openImageFile(sessionId, answer);
    };
    invoke('files:read', { sessionId, target: reference }).then(take, () => take({ outcome: 'failed' }));
  }, [sessionId, reference, refreshBaseline, setViewState]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (handed !== undefined) {
      // It is the page's now, and newer than any read still on its way.
      generation.current += 1;
      started.current = true;
      refreshBaseline(handed.outcome === 'text' ? handed : null);
      takeHanded(sessionId, id);
    } else if (!started.current) {
      started.current = true;
      read();
    }
  }, [handed, id, read, sessionId, refreshBaseline]);

  useEffect(() => { latest.current = viewState; }, [viewState]);
  // Its place is kept for the next showing, as it leaves.
  useLayoutEffect(() => () => { setViewState({ ...latest.current, ...place.current }); }, [setViewState]);

  const text = shown?.outcome === 'text' ? shown.text : null;
  // Past its bound a Markdown file is plain text: a showing stays one task of a third of a second (C38).
  const pastBound = shown?.outcome === 'text' && shown.view === 'markdown' && shown.text.length > MARKDOWN_UNITS_BOUND;
  const asMarkdown = shown?.outcome === 'text' && shown.view === 'markdown' && !pastBound;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || text === null) return;
    const line = viewState?.line ?? null;
    const named = viewState?.serial ?? 0;
    if (line !== null && viewState?.seen !== named) {
      // A line a reference named and the view has not come to yet: marked, and come to (C40).
      const marked = markLine(element, line);
      if (marked === 'end') element.scrollTop = element.scrollHeight;
      else if (marked !== null) element.scrollTop += marked.getBoundingClientRect().top - element.getBoundingClientRect().top - ABOVE_PX;
      place.current = { top: element.scrollTop, left: element.scrollLeft };
      restored.current = true;
      setViewState({ ...viewState, seen: named });
      return;
    }
    // The text is there again, or was read again: its line keeps its mark, and its place is put back once.
    if (line !== null) markLine(element, line);
    if (!restored.current) {
      restored.current = true;
      element.scrollTop = place.current.top;
      element.scrollLeft = place.current.left;
    }
  }, [text, asMarkdown, viewState, setViewState]);

  // The opener of a text this file holds: bound to the file, so a relative reference resolves against its folder (C37).
  const opener = useMemo(() => createOpener(sessionId, reference), [sessionId, reference]);
  // What a selection in the text came from, and the asides that were asked about this file (M20b, C45, C74).
  const source = useMemo(() => fileSource(reference), [reference]);
  const asides = useSourceMarkers(sessionId, source);
  useAsidePassages(scroller, sessionId, source, asides, `${asMarkdown ? 'm' : 'p'}${text ?? ''}`);
  /** Comes to an aside's passage, where it is painted; the aside's own tab where it is not. */
  const comeToAside = (asideId: string, title: string): void => {
    if (scroller.current === null || !showPassage(scroller.current, asideId)) openAside(sessionId, asideId, title);
  };

  const showInFolder = async (): Promise<void> => {
    let failed = false;
    try {
      await invoke('files:showInFolder', { sessionId, path: reference });
    } catch {
      failed = true;
    }
    if (!alive.current) return;
    setShowFailed(failed);
    window.clearTimeout(timer.current);
    if (failed) timer.current = window.setTimeout(() => setShowFailed(false), REFERENCE_SAID_MS);
  };

  const name = lastPart(reference);
  const found = shown !== null && shown.outcome !== 'refused' && shown.outcome !== 'failed' ? shown : null;
  const state = shown === null || shown.outcome === 'text' ? null : shown.outcome === 'unshown' ? UNSHOWN_WORDS[shown.why] : shown.outcome === 'refused' ? REFERENCE_WORDS[shown.why] : shown.outcome === 'image' ? FILE_WORDS.image : FILE_WORDS.failed;

  return (
    <div className={styles.file} data-file-outcome={shown?.outcome} data-file-view={shown?.outcome === 'text' ? (asMarkdown ? 'markdown' : 'plain') : undefined}>
      <ArtifactBar label={shown?.outcome === 'text' ? (shown.view === 'markdown' ? 'Markdown' : 'Text file') : 'File'} metadata={<FileRefreshStatus failed={refreshFailed} updatedAt={viewState?.autoUpdatedAt ?? null} failedTip={FILE_WORDS.refreshFailedTip} manuallyReloaded={viewState?.manuallyReloaded === true} />}>
        <ArtifactAction kind="reload" label={FILE_WORDS.reload} action={() => read(true)} />
        <ArtifactAction kind="folder" label={FILE_WORDS.showInFolder} action={showInFolder} tooltip={<><span className={styles.tooltipPath}>{found?.path ?? reference}</span><small className={styles.tooltipHint}>Click to open in folder</small></>} />
        <ArtifactAction kind="copy" label={ARTIFACT_WORDS.copy} disabled={text === null} action={() => navigator.clipboard.writeText(text ?? '')} />
      </ArtifactBar>
      <span className={announcer.announcer} role="status">{announcedAt !== null && `${FILE_WORDS.refreshed} ${formatTime(announcedAt)}.`}</span>
      {asides.length > 0 && text !== null && (
        <div className={styles.asides} role="group" aria-label={FILE_WORDS.asides}>
          {asides.map((aside) => (
            <button key={aside.id} type="button" className={styles.aside} title={aside.title} data-file-aside={aside.id} onClick={() => comeToAside(aside.id, aside.title)}>{aside.title}</button>
          ))}
        </div>
      )}
      {showFailed && <p className={styles.note} aria-hidden="true">{FILE_WORDS.showFailed}</p>}
      <span className={announcer.announcer} role="status">{showFailed && FILE_WORDS.showFailed}</span>
      {pastBound && <p className={styles.note}>{FILE_WORDS.pastBound}</p>}
      {state !== null && <p className={styles.state}>{state}</p>}
      {text !== null && (
        <div
          ref={scroller}
          className={styles.text}
          tabIndex={0}
          aria-label={contentsLabel(name)}
          {...sourceAttributes(source)}
          onScroll={(event) => { place.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }; }}
        >
          {asMarkdown ? (
            <OpenerContext value={opener}>
              <MarkdownText text={text} />
            </OpenerContext>
          ) : (
            <PlainTextView text={text} />
          )}
        </div>
      )}
    </div>
  );
}
