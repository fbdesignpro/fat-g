// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useLayoutEffect, type RefObject } from 'react';

/** Restore the CSS size, then reduce it to fit the requested rendered layout. */
export function useFittedTitle({ text, container, title, token, scaleContainer = false, layout = 'two-lines' }: {
  readonly text: string;
  readonly container: RefObject<HTMLElement | null>;
  readonly title: RefObject<HTMLElement | null>;
  readonly token: Token;
  readonly scaleContainer?: boolean;
  readonly layout?: Layout;
}) {
  useLayoutEffect(() => {
    const box = container.current;
    const label = title.current;
    if (box === null || label === null) return;
    return fitTitle(box, label, token, scaleContainer, layout);
  }, [text, container, title, token, scaleContainer, layout]);
}

type Token = '--text-120' | '--text-28';
type Layout = 'two-lines' | 'single-line-or-stacked';

/** The DOM work, outside the hook: it writes the title's style, which a hook's arguments may not be. */
function fitTitle(box: HTMLElement, label: HTMLElement, token: Token, scaleContainer: boolean, layout: Layout): () => void {
  const target = scaleContainer ? box : label;
  let active = true;
  let measuredWidth = -1;
  let measuredTextWidth = -1;
  let frame = 0;
  const range = document.createRange();
  range.selectNodeContents(label);
  const fits = (): boolean => {
    if (layout === 'single-line-or-stacked') {
      // A fixed-height slot keeps the separator still. Both the inline and
      // stacked arrangements must fit that same slot in width and height.
      const bounds = (box.parentElement ?? box).getBoundingClientRect();
      return box.getBoundingClientRect().bottom <= bounds.bottom + 0.25
        && Array.from(box.children).every((child) => {
        const item = child.getBoundingClientRect();
        return item.left >= bounds.left - 0.25 && item.right <= bounds.right + 0.25;
      });
    }
    // Count actual text lines: a line may contain several bidi fragments.
    // Unlike height / CSS line-height, this also respects zoom and text trimming.
    const tops: number[] = [];
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 || rect.height === 0) continue;
      if (!tops.some((top) => Math.abs(top - rect.top) < 0.5)) tops.push(rect.top);
      if (tops.length > 2) return false;
    }
    // The box's container may cap its height below two lines at the normal size:
    // the box must not run past it either. Without a cap it holds the box whole.
    const limit = (box.parentElement ?? box).getBoundingClientRect().bottom;
    return box.getBoundingClientRect().bottom <= limit + 0.25;
  };

  const fit = (): void => {
    if (!active || box.clientWidth === 0) return;
    measuredWidth = box.getBoundingClientRect().width;
    target.style.removeProperty(token);
    if (layout === 'single-line-or-stacked') delete box.dataset['stacked'];
    const normal = Number.parseFloat(getComputedStyle(label).fontSize);
    if (!Number.isFinite(normal) || normal <= 0) return;
    // Measure all the text, including anything hidden by the CSS fallback clamp.
    label.style.setProperty('line-clamp', 'none');
    label.style.webkitLineClamp = 'unset';
    // React may have replaced the text node since the previous measurement.
    range.selectNodeContents(label);
    if (!fits()) {
      // Preserve the full-size inline heading when it fits. Otherwise put the
      // suffix beneath the project and fit both rows into the reserved height.
      if (layout === 'single-line-or-stacked') box.dataset['stacked'] = 'true';
      let low = 1;
      let high = normal;
      for (let step = 0; step < 12; step += 1) {
        const size = (low + high) / 2;
        target.style.setProperty(token, `${size}px`);
        if (fits()) low = size;
        else high = size;
      }
      // Do not land exactly on a fractional-pixel wrap boundary.
      target.style.setProperty(token, `${Math.max(1, low - 0.25)}px`);
    }
    label.style.removeProperty('-webkit-line-clamp');
    label.style.removeProperty('line-clamp');
    measuredWidth = box.getBoundingClientRect().width;
    measuredTextWidth = label.getBoundingClientRect().width;
  };

  fit();
  const check = (): void => {
    if (!active) return;
    range.selectNodeContents(label);
    if (Math.abs(box.getBoundingClientRect().width - measuredWidth) > 0.5
      || Math.abs(label.getBoundingClientRect().width - measuredTextWidth) > 0.5
      || !fits()) fit();
  };
  // Recheck the final layout, including changes after sibling layout effects,
  // font loading, and scrollbar/flex layout. The text can change without its
  // outer container changing width. Queue outside ResizeObserver delivery.
  const scheduleCheck = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(check);
  };
  scheduleCheck();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleCheck);
  observer?.observe(box);
  observer?.observe(label);
  window.addEventListener('resize', fit);
  document.fonts?.addEventListener('loadingdone', fit);
  void document.fonts?.ready.then(fit);
  return () => {
    active = false;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', fit);
    document.fonts?.removeEventListener('loadingdone', fit);
  };
}
