// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { AsideSource } from '@shared/contracts/aside';
import { menuStyles, PointPopup } from '../ui/Popup';
import { focusOpened, followPointer, nextItem } from '../ui/useMenu';
import { explain, newSideQuestion } from './aside-actions';
import { useAsides } from './asides-store';
import { reportSelection } from './selection-report';

export const SELECTION_MENU = {
  label: 'Selection',
  copy: 'Copy',
  explain: 'Explain this in a side chat',
  sendToSideChat: 'Send to new side chat',
} as const;

interface Open {
  /** Whether the right button opened it: no item is marked then until the pointer is over one. */
  readonly byPointer: boolean;
  readonly at: { readonly x: number; readonly y: number };
  /** The selection's text, as it was when the menu opened: what Copy takes. */
  readonly text: string;
  /** Its report, where it lies in one source (C45); null where Explain is unavailable. */
  readonly report: AsideSource | null;
}

const ITEMS = '[role="menuitem"]';

/** Where a menu opened from the keyboard goes: the end of the selection. */
function selectionEnd(selection: Selection): { readonly x: number; readonly y: number } {
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const boxes = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
  const last = boxes.at(-1) ?? (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null);
  return last === null ? { x: 0, y: 0 } : { x: last.right, y: last.bottom };
}

/**
 * fat-g's own context menu on a selection (docs/planning/_archive/M20b.md, Design 7; C44, C45, C48): Copy, and
 * — where the selection lies inside one message, one activity's input or output or one file's view,
 * and the session can be asked beside — Explain this in a side chat. Send to new side chat opens
 * an editable draft with the selection in quotation marks. Drawn in the DOM with the tokens, a menu to
 * assistive technology, and nothing of Electron's: no round trip to main opens it.
 *
 * It opens on a selection, by the right button, by Shift+F10 and by the Menu key, and on nothing
 * else: with no selection a right button press does what it did, nothing. Escape, a choice and a
 * press elsewhere close it, and the focus goes back to where it was.
 */
export function SelectionMenu({ sessionId }: { readonly sessionId: string }) {
  const [open, setOpen] = useState<Open | null>(null);
  const offered = useAsides((state) => state.sessionId === sessionId && state.asking !== 'none');
  const menu = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(null);
    if (returnFocus) returnTo.current?.focus({ preventScroll: true });
    returnTo.current = null;
  }, []);

  useEffect(() => {
    /** Opens the menu on the selection there is, at a point; answers whether there was one. */
    const openAt = (point: { readonly x: number; readonly y: number } | null, target: EventTarget | null): boolean => {
      const selection = document.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false;
      const text = selection.toString();
      if (text.trim() === '') return false;
      // A field's own selection is the field's: its keys and its menu are as they were.
      if (target instanceof Element && target.closest('input, textarea') !== null) return false;
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen({ byPointer: point !== null, at: point ?? selectionEnd(selection), text, report: reportSelection(selection) });
      return true;
    };
    const onContextMenu = (event: MouseEvent): void => {
      // From the keyboard the event is no right button's, and its place is the focused element's: the menu goes to the selection's end.
      const pointer = event.button === 2;
      if (openAt(pointer ? { x: event.clientX, y: event.clientY } : null, event.target)) event.preventDefault();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      if (openAt(null, event.target)) event.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (open === null) return;
    focusOpened(menu.current, open.byPointer);
    const onPointerDown = (event: PointerEvent): void => {
      if (menu.current?.contains(event.target instanceof Node ? event.target : null) === true) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  if (open === null) return null;

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const to = nextItem([...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])], event.key);
    if (to !== undefined) {
      event.preventDefault();
      to.focus({ preventScroll: true });
      return;
    }
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); break;
      case 'Tab': close(false); break;
    }
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(open.text).catch(() => undefined);
    close(true);
  };
  const ask = (): void => {
    const { report } = open;
    // The tab opens, and neither the focus nor the place of what was being read moves (C41).
    close(true);
    if (report !== null) void explain(sessionId, report);
  };
  const draft = (): void => {
    const { text } = open;
    close(true);
    newSideQuestion(sessionId, `"${text}"`);
  };

  return (
    <PointPopup at={open.at}>
      {/* A press on the menu must not end the selection it was opened on: that is the mouse button's own doing, at its press. */}
      <div ref={menu} role="menu" tabIndex={-1} aria-label={SELECTION_MENU.label} className={menuStyles.menu} onKeyDown={onMenuKeyDown} onPointerMove={(event) => followPointer(menu.current, event.target)} onMouseDown={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={copy}>{SELECTION_MENU.copy}</button>
        {offered && open.report !== null && (
          <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={ask}>{SELECTION_MENU.explain}</button>
        )}
        {offered && (
          <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={draft}>{SELECTION_MENU.sendToSideChat}</button>
        )}
      </div>
    </PointPopup>
  );
}
