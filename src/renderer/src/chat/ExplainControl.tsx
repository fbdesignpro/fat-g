// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createContext, type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import type { AsideMarker } from '@shared/contracts/aside';
import { openAside } from '../artifacts/opener';
import { type BlockInfo, CONTROL_ATTRIBUTE, useTabStop } from '../markdown/inert';
import { menuStyles, Popup } from '../ui/Popup';
import { NameTip, useNameTip } from '../ui/Tooltip';
import { useMenu } from '../ui/useMenu';
import { asideAt, OVER_ATTRIBUTE, paintAsides, unpaintAsides } from './aside-highlights';
import { explain, EXPLAIN_BUTTONS_VISIBLE } from './aside-actions';
import { useAsides } from './asides-store';
import { CHROME_ATTRIBUTE } from './drawn-text';
import { reportBlock, type SourceOf } from './selection-report';
import styles from './Chat.module.css';

export const EXPLAIN_WORDS = {
  /** The control beside a block (C46). */
  explain: 'Explain this',
  /** A marker of one aside: its title, which says what it opens — "Explained: …". */
  open: (title: string): string => title,
  /** A marker of several: its button, and the list it opens. */
  several: (count: number): string => `${count} side questions about this`,
  list: 'Side questions about this',
} as const;

/**
 * Whose text the messages drawn under it are (M20b, C45, C47): the session they belong to, and the
 * worker whose tab they are drawn in, if one. With none a message is no source — in an aside's own
 * tab (C40), and in a chat without a session (C72): it marks nothing, draws no control and no
 * marker, and paints no passage.
 */
export interface AsideSourceScope {
  readonly sessionId: string;
  readonly workerId: string | null;
}
export const AsideSourceContext = createContext<AsideSourceScope | null>(null);

// The control's one glyph is a question mark in a ring, drawn by the style sheet alone: the button
// holds no element and no text of its own, so the chat's list holds nothing a text could not become
// (M19, C31–C33), and nothing of the control is in what a selection or a copy takes. Filled with the
// highlight's colour, it marks a block that has an aside. Its name shows beside it at once, in place
// of a `title`, whose tooltip waits (the maintainer).

/**
 * The arrow keys among the controls beside a text's blocks (C46): a message's are one stop for Tab,
 * its first, and Up, Down, Home and End go from one to another — so that Tab leaves a long answer's
 * blocks at one press, and does not stop at each. At the first, Up stays; at the last, Down does.
 */
export function roveBlockControls(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  // Each stands in an element of its own, directly before its block: the text's own element holds them all.
  const text = event.currentTarget.closest(`[${CONTROL_ATTRIBUTE}]`)?.parentElement ?? null;
  if (text === null) return;
  const all = [...text.querySelectorAll<HTMLElement>(`:scope > [${CONTROL_ATTRIBUTE}] > button`)];
  const at = all.indexOf(event.currentTarget);
  if (at === -1) return;
  event.preventDefault();
  const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : all.length - 1;
  all[Math.max(0, Math.min(all.length - 1, to))]?.focus();
}

/**
 * The marker of the asides one thing has (C74): filled, and there at all times. Its press reopens
 * the one aside, or opens a list of them by title where there are several. The keyboard's way, and
 * assistive technology's, to what a highlighted passage gives the pointer.
 *
 * Beside a block its arrow keys are the blocks' own, given as `onKeyDown`: its list then opens by a
 * press alone. In a head row, with none given, the arrow keys open its list as a menu's button does.
 */
export function AsideMarkerButton({ sessionId, markers, tabIndex, onKeyDown }: { readonly sessionId: string; readonly markers: readonly AsideMarker[]; readonly tabIndex?: number; readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void }) {
  const { open, close, button, buttonProps, menuProps } = useMenu();
  const tip = useNameTip();
  const [only] = markers;
  if (only === undefined) return null;
  const stop = tabIndex === undefined ? {} : { tabIndex };
  if (markers.length === 1) {
    return (
      <>
        <button ref={button} type="button" className={styles.explain} data-aside-marker="" {...{ [CHROME_ATTRIBUTE]: '' }} aria-label={EXPLAIN_WORDS.open(only.title)} {...tip.targetProps} {...stop} onKeyDown={onKeyDown} onClick={() => { openAside(sessionId, only.id, only.title); }} />
        <NameTip open={tip.open} anchor={button} side="right">{EXPLAIN_WORDS.open(only.title)}</NameTip>
      </>
    );
  }
  return (
    <>
      <button {...buttonProps} type="button" className={styles.explain} data-aside-marker="" {...{ [CHROME_ATTRIBUTE]: '' }} aria-label={EXPLAIN_WORDS.several(markers.length)} {...tip.targetProps} {...stop} onKeyDown={onKeyDown ?? buttonProps.onKeyDown} />
      <NameTip open={tip.open && !open} anchor={button} side="right">{EXPLAIN_WORDS.several(markers.length)}</NameTip>
      {open && (
        <Popup anchor={button}>
          <div {...menuProps} aria-label={EXPLAIN_WORDS.list} className={`${menuStyles.menu} ${styles.asideMenu}`}>
            {markers.map((marker) => (
              <button key={marker.id} type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={() => { close(true); openAside(sessionId, marker.id, marker.title); }}>
                {marker.title}
              </button>
            ))}
          </div>
        </Popup>
      )}
    </>
  );
}

export interface BlockExplainProps {
  readonly sessionId: string;
  /** The message's own text: a block's report is its source, by its lines. */
  readonly text: string;
  readonly block: BlockInfo;
  /** The message's asides. */
  readonly markers: readonly AsideMarker[];
}

/**
 * What stands beside a top-level block of an assistant's message (C46, C74). Explain this for that
 * block: in the DOM at all times, shown while the pointer is over its message or the focus is in
 * it, when standalone Explain buttons are enabled. Where the block already has an aside, its
 * marker stands in the control's place even while Explain buttons are hidden.
 *
 * To the keyboard a message's are one stop, and only while the message is current: the first block's,
 * from which the arrow keys go to the others (`roveBlockControls`).
 */
export function BlockExplain({ sessionId, text, block, markers }: BlockExplainProps): ReactNode {
  const current = useTabStop();
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  const offered = useAsides((state) => state.sessionId === sessionId && state.asking !== 'none');
  // A selection across blocks is the first block's: its marker stands where the passage begins.
  const own = markers.filter((marker) => marker.source?.lines != null && marker.source.lines.first >= block.firstLine && marker.source.lines.first <= block.lastLine);
  // With Explain hidden, the first remaining marker is the message's one keyboard stop.
  const first = EXPLAIN_BUTTONS_VISIBLE ? block.first : own.length > 0 && !markers.some((marker) => marker.source?.lines != null && marker.source.lines.first < block.firstLine);
  const stop = first ? current : -1;
  if (own.length > 0) return <AsideMarkerButton sessionId={sessionId} markers={own} tabIndex={stop} onKeyDown={roveBlockControls} />;
  if (!offered || !EXPLAIN_BUTTONS_VISIBLE) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.explain}
        data-explain=""
        {...{ [CHROME_ATTRIBUTE]: '' }}
        aria-label={EXPLAIN_WORDS.explain}
        {...tip.targetProps}
        tabIndex={stop}
        onKeyDown={roveBlockControls}
        onClick={(event) => {
          // The block is the element after the one that holds this control (markdown/MarkdownText.tsx).
          const element = event.currentTarget.closest(`[${CONTROL_ATTRIBUTE}]`)?.nextElementSibling ?? null;
          const report = element === null ? null : reportBlock(element, text);
          if (report !== null) void explain(sessionId, report);
        }}
      />
      <NameTip open={tip.open} anchor={anchor} side="right">{EXPLAIN_WORDS.explain}</NameTip>
    </>
  );
}

/**
 * A source's asides, painted where they were selected, and a press on a painted passage (C74, C75).
 * Run after each drawing of the source — `drawn` is whatever says the drawing changed. A source
 * with no aside costs nothing: nothing is painted, and nothing listens.
 *
 * A press inside a painted passage reopens its aside, as a link would be followed; one on a control
 * inside the passage is the control's own, and a press that ends a selection is the selection's.
 */
export function useAsidePassages(ref: RefObject<HTMLElement | null>, sessionId: string | null, source: SourceOf | null, markers: readonly AsideMarker[], drawn: unknown): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || sessionId === null || source === null || markers.length === 0) return;
    paintAsides(element, markers);
    const pressed = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button, a, input, textarea') != null) return;
      if (element.ownerDocument.getSelection()?.isCollapsed === false) return;
      const asideId = asideAt(element, event.clientX, event.clientY);
      const marker = asideId === null ? undefined : markers.find((candidate) => candidate.id === asideId);
      if (marker !== undefined) openAside(sessionId, marker.id, marker.title);
    };
    const moved = (event: PointerEvent): void => {
      const over = asideAt(element, event.clientX, event.clientY) !== null;
      if (over !== element.hasAttribute(OVER_ATTRIBUTE)) element.toggleAttribute(OVER_ATTRIBUTE, over);
    };
    const left = (): void => { element.removeAttribute(OVER_ATTRIBUTE); };
    element.addEventListener('click', pressed);
    element.addEventListener('pointermove', moved);
    element.addEventListener('pointerleave', left);
    return () => {
      unpaintAsides(element);
      element.removeEventListener('click', pressed);
      element.removeEventListener('pointermove', moved);
      element.removeEventListener('pointerleave', left);
      left();
    };
  }, [ref, sessionId, source, markers, drawn]);
}
