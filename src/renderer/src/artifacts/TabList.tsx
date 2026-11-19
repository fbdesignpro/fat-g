// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import type { Tab } from './tabs-store';
import styles from './ArtifactPane.module.css';

/** The tab list's name: what a test and a probe find it by. */
export const TABS_LABEL = 'Open items';
export const closeLabel = (title: string): string => `Close ${title}`;

export interface TabListProps {
  readonly tabs: readonly Tab[];
  readonly selected: string;
  /** The id of the body the tabs control. */
  readonly panelId: string;
  /** The id a tab's own element carries. */
  readonly domId: (tab: Tab) => string;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
}

/**
 * The rows of buttons that act as tabs (docs/planning/_archive/M19b.md, Design 3; C9–C12): a tab list whose
 * buttons fill a row and go on to the next, three rows at most, scrolling within itself past that.
 *
 * A tab shows `//` and its title on the grid, underlined on hover and when selected; the selected
 * tab also uses the text colour. Its title stays on one line, cut past 280 px (or the row's width) and whole in its
 * tooltip. Its × appears on hover or focus within, without changing its width. It also closes
 * by a middle click and by Delete while it holds the keyboard, and
 * closing asks nothing; each kind handles any cleanup before its tab is removed. A tab its kind keeps open
 * has no ×, and neither the middle click nor Delete closes it (docs/planning/_archive/M106.md, Design 6; C2).
 *
 * By the keyboard the list is one stop (C11): Left and Right, Home and End move among the tabs,
 * across rows, and none of them selects — selecting a file's tab reads the file — so a tab is
 * selected by Enter or Space. Tab goes on into the body. The × is no stop of its own.
 *
 * A tab is a `div` with the tab's role, not a `button`, so that the × is no control inside another.
 * The selected tab is brought into view by the list's own scroll position, never by a call that
 * could scroll something outside it (C12).
 */
export function TabList({ tabs, selected, panelId, domId, onSelect, onClose }: TabListProps) {
  const list = useRef<HTMLDivElement>(null);
  // The tab that last held the keyboard: the list's one stop. The selected one until then.
  const [held, setHeld] = useState<string | null>(null);
  const stop = held !== null && tabs.some((tab) => tab.id === held) ? held : selected;
  // After a Delete: the tab that took the closed one's place takes the keyboard.
  const focusNext = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = list.current;
    const shown = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (element === null || shown === null || shown === undefined) return;
    const top = shown.offsetTop;
    const bottom = top + shown.offsetHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
  }, [selected, tabs.length]);

  useLayoutEffect(() => {
    const wanted = focusNext.current;
    if (wanted === null) return;
    focusNext.current = null;
    const tab = tabs.find((candidate) => candidate.id === wanted);
    if (tab !== undefined) document.getElementById(domId(tab))?.focus();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Only from a tab itself, and with no modifier: the × keeps its own keys.
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = tabs.findIndex((tab) => domId(tab) === target.id);
    const current = tabs[at];
    if (current === undefined) return;
    const move = event.key === 'ArrowLeft' ? Math.max(0, at - 1) : event.key === 'ArrowRight' ? Math.min(tabs.length - 1, at + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (move !== -1) {
      event.preventDefault();
      const next = tabs[move];
      if (next !== undefined) document.getElementById(domId(next))?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(current.id);
    } else if (event.key === 'Delete' && current.closable) {
      event.preventDefault();
      focusNext.current = (tabs[at + 1] ?? tabs[at - 1])?.id ?? null;
      onClose(current.id);
    }
  };

  return (
    <div ref={list} className={styles.rows} role="tablist" aria-label={TABS_LABEL} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={domId(tab)}
          className={styles.tab}
          role="tab"
          aria-selected={tab.id === selected}
          aria-controls={panelId}
          tabIndex={tab.id === stop ? 0 : -1}
          title={tab.title}
          onFocus={() => setHeld(tab.id)}
          onClick={() => onSelect(tab.id)}
          // A middle click closes, and starts no scrolling of the page's own.
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => { if (event.button === 1 && tab.closable) onClose(tab.id); }}
        >
          <span className={styles.tabTitle}><span aria-hidden="true">{'// '}</span><span data-tab-title>{tab.title}</span></span>
          {tab.closable && (
            <button type="button" className={styles.close} tabIndex={-1} aria-label={closeLabel(tab.title)} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
