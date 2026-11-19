// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

const GAP = 4;
const ABOVE_GAP = 12;
const MARGIN = 8;

/**
 * When a tooltip shows, as the usage panel does (M11, C45, C57): while the pointer is over its
 * target or the target holds the focus, until Escape. Spread `targetProps` on the target; it is
 * described by the tooltip, so a screen reader hears the reason with the control (M14, C54).
 *
 * A press of the pointer closes it, as a native tooltip does, and the focus that press gives the
 * target does not hold it open after the pointer has gone (the maintainer): it shows
 * again when the pointer comes back, or when the focus comes by the keyboard.
 */
export function useTooltip() {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const pressing = useRef(false);
  const open = (hovered || focused) && !dismissed;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const targetProps = {
    'aria-describedby': id,
    onPointerEnter: () => {
      setHovered(true);
      setDismissed(false);
    },
    onPointerLeave: () => {
      setHovered(false);
      pressing.current = false;
    },
    onPointerDown: () => {
      pressing.current = true;
      setFocused(false);
      setDismissed(true);
    },
    onPointerUp: () => {
      pressing.current = false;
    },
    onFocus: () => {
      if (pressing.current) {
        pressing.current = false;
        return;
      }
      setFocused(true);
      setDismissed(false);
    },
    onBlur: () => setFocused(false),
  };
  return { id, open, targetProps };
}

/**
 * Which side of its target a tooltip stands on: below it, or to its right, level with its middle —
 * for a control in the chat's margin, where a name below would cover the control under it (the
 * maintainer).
 */
// Above centers horizontally over the target, clamped to the window's margins.
export type TipSide = 'below' | 'right' | 'above';

/**
 * Above only: what else near its target a tooltip stands above, so as not to cover it — the chat's
 * status bar over its toolbar (the maintainer). Keep it one function, not made anew each
 * render.
 */
export type TipClear = (target: HTMLElement) => Element | null;

/**
 * Where an open tooltip stands, fixed and inside the window: below its target, its right edge at the
 * target's; or to its right, and at its left where the window has no room at its right. `tip` goes on
 * the tooltip.
 */
function usePlace(anchor: RefObject<HTMLElement | null>, open: boolean, side: TipSide = 'below', clear?: TipClear) {
  const tip = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);
  useLayoutEffect(() => {
    const target = anchor.current;
    const element = tip.current;
    if (!open || target === null || element === null) return;
    const rect = target.getBoundingClientRect();
    if (side === 'above') {
      const left = Math.max(MARGIN, Math.min(rect.left + (rect.width - element.offsetWidth) / 2, window.innerWidth - element.offsetWidth - MARGIN));
      const top = Math.min(rect.top, clear?.(target)?.getBoundingClientRect().top ?? rect.top);
      setPosition({ left, top: Math.max(MARGIN, top - ABOVE_GAP - element.offsetHeight) });
      return;
    }
    if (side === 'right') {
      const after = rect.right + GAP;
      const left = after + element.offsetWidth <= window.innerWidth - MARGIN ? after : Math.max(MARGIN, rect.left - GAP - element.offsetWidth);
      const top = Math.max(MARGIN, Math.min(rect.top + (rect.height - element.offsetHeight) / 2, window.innerHeight - element.offsetHeight - MARGIN));
      setPosition({ left, top });
      return;
    }
    const left = Math.max(MARGIN, Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - MARGIN));
    setPosition({ left, top: rect.bottom + GAP });
  }, [anchor, open, side, clear]);
  return { tip, position: open && position !== null ? position : undefined };
}

/**
 * A short reason beside a control (M14, C54). Portalled to the page and fixed below its target,
 * inside the window; it holds no control and lets the pointer through. While closed its text stays
 * in the page, hidden from sight, so the target's description is always there to be read.
 */
export function Tooltip({ id, open, anchor, side, clear, className, children }: {
  readonly id: string;
  readonly open: boolean;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly side?: TipSide;
  readonly clear?: TipClear;
  /** Added to the tooltip's own class: one that holds more than a few lines, such as the context meter's table, sets its own width. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { tip, position } = usePlace(anchor, open, side, clear);
  return createPortal(
    <div ref={tip} id={id} role="tooltip" className={className === undefined ? styles.tooltip : `${styles.tooltip} ${className}`} data-open={open || undefined} style={position}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * When a control's name shows (the maintainer): at once, as a tooltip does, in place of
 * a `title`, whose tooltip waits. The control's label already says it, so the target is described by
 * nothing. Spread `targetProps` on the target.
 */
export function useNameTip() {
  const { open, targetProps } = useTooltip();
  const { 'aria-describedby': _describedBy, ...props } = targetProps;
  return { open, targetProps: props };
}

/**
 * A control's name, shown beside it while `useNameTip` says, where it stands as a tooltip does. It
 * repeats the label, so assistive technology is not given it again; and it is drawn only while it
 * shows, so a list of many controls — a control beside each block of an answer — holds none of it.
 * Left out, `side` is below.
 */
export function NameTip({ open, anchor, side, children }: { readonly open: boolean; readonly anchor: RefObject<HTMLElement | null>; readonly side?: TipSide; readonly children: ReactNode }) {
  const { tip, position } = usePlace(anchor, open, side);
  if (!open) return null;
  return createPortal(
    <div ref={tip} className={styles.tooltip} data-open="" data-name-tip="" aria-hidden="true" style={position}>
      {children}
    </div>,
    document.body,
  );
}
