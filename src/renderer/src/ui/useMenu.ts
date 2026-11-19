// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useRef, useState } from 'react';

/** A menu's items: plain ones, the ones of a menu of choices, which mark the one in force (M14, C60, C61), and the ones that are set or not, each on its own. */
const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * A menu marks one item, the one that has the focus, and the style sheet marks nothing else: no item
 * for the pointer being over it. The pointer over an item gives it the focus, as an arrow key does,
 * so the two never mark an item each. This is the pointer's half.
 */
export function followPointer(menu: HTMLElement | null, target: EventTarget | null): void {
  const item = target instanceof Element ? target.closest<HTMLElement>(ITEMS) : null;
  if (item === null || menu?.contains(item) !== true || item === document.activeElement) return;
  item.focus({ preventScroll: true });
}

/**
 * Where the focus goes as a menu opens. Opened by the keyboard: its choice in force, or its first item
 * — a set checkbox is not a choice in force.
 * Opened by the pointer: the menu itself, so that no item is marked before the pointer is over one,
 * and the arrow keys still go from there.
 */
export function focusOpened(menu: HTMLElement | null, byPointer: boolean): void {
  if (byPointer) menu?.focus({ preventScroll: true });
  else (menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu?.querySelector<HTMLElement>(ITEMS))?.focus({ preventScroll: true });
}

/** The item an arrow key, Home or End goes to, from the one that has the focus — or from none, where the menu itself has it. */
export function nextItem(items: readonly HTMLElement[], key: string): HTMLElement | undefined {
  const at = items.findIndex((item) => item === document.activeElement);
  switch (key) {
    case 'ArrowDown': return items[(at + 1) % items.length];
    case 'ArrowUp': return items[at <= 0 ? items.length - 1 : at - 1];
    case 'Home': return items[0];
    case 'End': return items[items.length - 1];
    default: return undefined;
  }
}

/**
 * A menu button's behaviour, shared by the application menu, each project's and each capsule's `…`
 * menu, and the effort menu (M11, C31–C33; M12, C44; M14, C60, C91). Opening by the keyboard moves
 * the focus to the item in force, or to the first one; opening by the pointer moves it to the menu,
 * with no item marked; the arrow keys, Home and End move between items, and so does the pointer, the
 * item under it taking the focus; Escape closes the menu and hands the focus back to its button; Tab
 * closes it and lets the focus go on; a pointer press anywhere else closes it.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  /** Whether the press that opens it is the pointer's: said by the button's press, and read once as the menu opens. */
  const byPointer = useRef(false);

  useEffect(() => {
    if (!open) return;
    focusOpened(menu.current, byPointer.current);
    byPointer.current = false;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (menu.current?.contains(target) === true || button.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const to = nextItem([...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])], event.key);
    if (to !== undefined) {
      event.preventDefault();
      to.focus();
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  /** Spread on the menu's button. */
  const buttonProps = {
    ref: button,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    // A press of the keyboard's — Enter, Space — is a click with no count; the pointer's has one.
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      byPointer.current = event.detail > 0;
      setOpen((current) => !current);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    },
  };

  /** Spread on the element holding the items. */
  const menuProps = {
    ref: menu, id: menuId, role: 'menu' as const, tabIndex: -1, onKeyDown: onMenuKeyDown,
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => followPointer(menu.current, event.target),
  };

  return { open, setOpen, close, button, menu, buttonProps, menuProps };
}
