// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type PointerEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_CHAT_SHARE, setShare, useSplit } from './split-store';
import styles from './Shell.module.css';

export const SPLIT_LABEL = 'Chat and pane widths';
/** How far an arrow key moves the gap: a twentieth of the two boxes' width. */
export const SPLIT_STEP = 0.05;

/** The share as the window's columns read it: each box's part of the width, as flex (Shell.module.css). */
export function writeShare(target: HTMLElement, share: number): void {
  target.style.setProperty('--chat-share', `${share}fr`);
  target.style.setProperty('--pane-share', `${1 - share}fr`);
}

interface Measure {
  readonly left: number;
  readonly gap: number;
  /** The two boxes' width together: the window's, less the gap. */
  readonly width: number;
  readonly chatMin: number;
  readonly paneMin: number;
}

function measure(target: HTMLElement): Measure {
  const style = getComputedStyle(target);
  const px = (name: string): number => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  };
  const rect = target.getBoundingClientRect();
  const gap = px('--gap-grid');
  return { left: rect.left, gap, width: rect.width - gap, chatMin: px('--split-chat-min'), paneMin: px('--split-pane-min') };
}

/** The shares the window can show: each box at its least width or more. The default is always among them. */
function limits({ width, chatMin, paneMin }: Measure): readonly [number, number] {
  if (width <= 0) return [0, 1];
  const low = Math.min(chatMin / width, DEFAULT_CHAT_SHARE);
  return [low, Math.max(low, 1 - paneMin / width, DEFAULT_CHAT_SHARE)];
}

const within = (share: number, [low, high]: readonly [number, number]): number => Math.round(Math.min(high, Math.max(low, share)) * 1000) / 1000;

/**
 * The gap between the chat window and the artifact pane, which resizes them (docs/planning/_archive/M100.md,
 * round 8; C80): dragged, or by the keyboard — Left and Right a step, Home and End to either box's
 * least width, Enter back to the default split, as a double-click is. A window splitter by its role, its
 * value the chat's share.
 *
 * While it is dragged it writes the window's columns itself, so nothing of the chat is drawn again
 * at each move; the share is kept in the page's store when it is let go, for the run (split-store).
 * Drawn only while the window is split; it takes its columns back as it goes.
 */
export function SplitHandle({ target, controls }: { readonly target: RefObject<HTMLElement | null>; readonly controls: string }) {
  const share = useSplit((state) => state.share);
  const [dragging, setDragging] = useState(false);
  // The share a drag has reached, and whether one runs: read by each move, before a render could say so.
  const drag = useRef<{ share: number } | null>(null);

  useLayoutEffect(() => {
    const element = target.current;
    if (element === null) return undefined;
    writeShare(element, share);
    return () => {
      element.style.removeProperty('--chat-share');
      element.style.removeProperty('--pane-share');
    };
  }, [target, share]);

  const end = (): void => {
    const reached = drag.current;
    drag.current = null;
    setDragging(false);
    if (reached !== null) setShare(reached.share);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      // The pointer is the handle's until it is let go, wherever it goes over the chat or the pane.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a convenience: the handle still hears the pointer while it is over it.
    }
    drag.current = { share };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const element = target.current;
    if (drag.current === null || element === null) return;
    const measured = measure(element);
    if (measured.width <= 0) return;
    const next = within((event.clientX - measured.left - measured.gap / 2) / measured.width, limits(measured));
    drag.current = { share: next };
    writeShare(element, next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = target.current;
    if (element === null) return;
    const range = limits(measure(element));
    const next = event.key === 'ArrowLeft' ? share - SPLIT_STEP
      : event.key === 'ArrowRight' ? share + SPLIT_STEP
        : event.key === 'Home' ? range[0]
          : event.key === 'End' ? range[1]
            : event.key === 'Enter' ? DEFAULT_CHAT_SHARE
              : null;
    if (next === null) return;
    event.preventDefault();
    setShare(within(next, range));
  };

  const percent = Math.round(share * 100);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={SPLIT_LABEL}
      aria-controls={controls}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`Chat ${percent}%, pane ${100 - percent}%`}
      tabIndex={0}
      className={styles.splitHandle}
      data-split-handle=""
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onLostPointerCapture={() => { if (drag.current !== null) end(); }}
      onDoubleClick={() => setShare(DEFAULT_CHAT_SHARE)}
      onKeyDown={onKeyDown}
    />
  );
}
