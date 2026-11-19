// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './Popup.module.css';

/** Distance from the button above, and the least distance kept from the window's edges. */
const GAP = 2;
const MARGIN = 8;

/**
 * Where an open menu goes: portalled to the page, below its button and inside the window, measured
 * before paint so it never shows in the wrong place. It exists only while open, like the usage panel.
 * A project's `…` menu, a capsule's, and the effort menu of the avatar column all open in
 * one (M12, C44; M14, C60, C61, C91): the regions they belong to clip, and the project column scrolls.
 *
 * `align` says which edge of the button the popup's same edge meets: a button at the right of its
 * column opens leftwards (`end`), one at the left of the window rightwards (`start`).
 *
 * `inPlace` leaves the popup where it is written instead of portalling it: a button inside a modal
 * dialog needs that, since the page behind a modal dialog is inert and drawn under it (M14b, C34: an
 * account's `…` menu in Settings). It is placed the same way, fixed in the window.
 *
 * Its place is written to the element itself, in the layout effect that measures it, and not kept
 * as state (M20b; found by the smoke run). It is in place and shown when that effect ends, so the
 * menu that opened it can give an item the focus in the effect that follows (`useMenu`): an element
 * that is still hidden takes no focus, and a menu that has none cannot be used from the keyboard.
 */
export function Popup({ anchor, align = 'end', inPlace = false, children }: {
  readonly anchor: RefObject<HTMLElement | null>;
  readonly align?: 'start' | 'end';
  readonly inPlace?: boolean;
  readonly children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = anchor.current;
    const element = popup.current;
    if (target === null || element === null) return;
    const rect = target.getBoundingClientRect();
    const wanted = align === 'end' ? rect.right - element.offsetWidth : rect.left;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - element.offsetWidth - MARGIN));
    // Below the button; above it when the window ends first.
    const below = rect.bottom + GAP;
    const top = below + element.offsetHeight > window.innerHeight - MARGIN && rect.top - GAP - element.offsetHeight >= MARGIN ? rect.top - GAP - element.offsetHeight : below;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = '';
  }, [anchor, align]);
  const element = (
    // Hidden until it is placed, which is before it is ever painted.
    <div ref={popup} className={styles.popup} style={{ visibility: 'hidden' }}>
      {children}
    </div>
  );
  return inPlace ? element : createPortal(element, document.body);
}

/**
 * A popup at a point of the window, and not below a button (M20b, C44): where a context menu opens,
 * at the pointer or at the end of the selection. Portalled to the page and kept inside the window,
 * measured before paint.
 *
 * Its place is written to the element itself, in the layout effect that measures it, and not kept
 * as state: it is in place and shown when that effect ends, so whoever opened it can give one of
 * its items the focus in the effect that follows. An element that is hidden takes no focus, and a
 * menu opened from the keyboard is used from the keyboard.
 */
export function PointPopup({ at, children }: { readonly at: { readonly x: number; readonly y: number }; readonly children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = popup.current;
    if (element === null) return;
    const left = Math.max(MARGIN, Math.min(at.x, window.innerWidth - element.offsetWidth - MARGIN));
    // Below the point; above it when the window ends first.
    const top = at.y + element.offsetHeight > window.innerHeight - MARGIN && at.y - element.offsetHeight >= MARGIN ? at.y - element.offsetHeight : Math.max(MARGIN, at.y);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = '';
  }, [at.x, at.y]);
  return createPortal(
    // Hidden until it is placed, which is before it is ever painted.
    <div ref={popup} className={styles.popup} style={{ visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

/** The classes of a menu and its items, for whatever opens one in a `Popup`. */
export const menuStyles = { menu: styles.menu, item: styles.menuItem, note: styles.itemNote, menuNote: styles.menuNote, rule: styles.menuRule } as const;
