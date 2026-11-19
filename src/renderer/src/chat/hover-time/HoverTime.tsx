// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef } from 'react';
import { usePrefs } from '../../state/prefs-store';
import { formatTimeOfDay } from '../../ui/format';
import { placeTime } from './geometry';
import { HoverTimeHostContext } from './sources';
import styles from './HoverTime.module.css';

const MESSAGE = '[data-hover-time-at]';
const SOURCE = '[data-time-source]';

/** Read the same CSS reveal state that drives Copy and the paragraph controls. */
function revealedSource(host: HTMLElement): { message: HTMLElement; source: HTMLElement } | null {
  const candidates = [
    host.querySelector<HTMLElement>(`${MESSAGE}:hover`),
    host.querySelector<HTMLElement>(`${MESSAGE}:focus-within`),
    host.querySelector<HTMLElement>(`[data-chat-list]:focus-visible ${MESSAGE}[data-current]`),
  ];
  for (const message of new Set(candidates)) {
    if (message === null) continue;
    const sources = [...message.querySelectorAll<HTMLElement>(SOURCE)];
    // A keyboard-focused message may reveal all its markers. Prefer the actual hovered block.
    const hovered = sources.find((source) => source.parentElement?.matches('[data-md-control]:hover, [data-md-control]:has(+ :hover)'));
    for (const source of hovered === undefined ? sources : [hovered, ...sources]) {
      if (getComputedStyle(source).getPropertyValue('--hover-time-visible').trim() === '1' && source.getClientRects().length > 0) return { message, source };
    }
  }
  return null;
}

/**
 * Hosts chrome outside the scrolling text column. Sources are declarative DOM registrations;
 * events only request a geometry refresh, never maintain a second hover/focus state.
 */
export function HoverTimeHost({ children }: { readonly children: ReactNode }) {
  const enabled = usePrefs((state) => state.snapshot?.values.chat.hoverMessageTimes !== false);
  const layer = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    const surface = layer.current;
    const alignment = row.current;
    const time = label.current;
    const host = surface?.parentElement;
    if (!enabled || surface === null || alignment === null || time === null || host == null) return;
    let frame: number | null = null;
    const watched = new Set<Element>();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const watch = (elements: Element[]): void => {
      for (const old of watched) if (!elements.includes(old)) { resize?.unobserve(old); watched.delete(old); }
      for (const element of elements) if (!watched.has(element)) { resize?.observe(element); watched.add(element); }
    };
    const refresh = (): void => {
      frame = null;
      time.hidden = true;
      const active = revealedSource(host);
      const viewport = active?.message.closest<HTMLElement>('[data-chat-list]');
      const toolbar = host.querySelector<HTMLElement>('[data-session-rail]');
      watch([host, ...(viewport == null ? [] : [viewport]), ...(toolbar === null ? [] : [toolbar]), ...(active === null ? [] : [active.message])]);
      if (active === null || viewport == null) return;
      const at = Number(active.message.dataset.hoverTimeAt);
      if (!Number.isFinite(at)) return;
      const text = formatTimeOfDay(at);
      if (time.textContent !== text) time.textContent = text;
      time.dateTime = new Date(at).toISOString();
      time.setAttribute('aria-label', active.message.title);
      const messageSource = active.source.dataset.timeSource === 'message';
      const block = active.source.parentElement?.nextElementSibling ?? active.source;
      const typography = getComputedStyle(block);
      alignment.style.fontFamily = typography.fontFamily;
      alignment.style.fontSize = typography.fontSize;
      alignment.style.fontWeight = typography.fontWeight;
      alignment.style.fontStyle = typography.fontStyle;
      alignment.style.lineHeight = typography.lineHeight;
      time.hidden = false;
      const size = alignment.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(surface).getPropertyValue('--space-2'));
      const anchor = messageSource ? block : active.source;
      const position = placeTime({ host: surface.getBoundingClientRect(), viewport: viewport.getBoundingClientRect(), messageLeft: active.message.getBoundingClientRect().left, sourceTop: anchor.getBoundingClientRect().top, width: size.width, height: size.height, gap, toolbar: toolbar?.getBoundingClientRect() ?? null });
      if (position === null) { time.hidden = true; return; }
      alignment.style.left = `${position.left}px`;
      alignment.style.top = `${position.top}px`;
      surface.style.clipPath = `inset(${position.clipTop}px 0 ${position.clipBottom}px 0)`;
    };
    const schedule = (): void => { frame ??= requestAnimationFrame(refresh); };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !surface.contains(record.target))) schedule();
    });
    mutations.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-current', 'data-hover-time-at', 'title', 'open', 'class', 'style'] });
    const events = ['pointerover', 'pointerout', 'focusin', 'focusout', 'keydown', 'scroll'] as const;
    for (const event of events) host.addEventListener(event, schedule, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      for (const event of events) host.removeEventListener(event, schedule, true);
      window.removeEventListener('resize', schedule);
      time.hidden = true;
    };
  }, [enabled]);
  return (
    <HoverTimeHostContext value={enabled}>
      {children}
      {enabled && <div ref={layer} className={styles.layer} data-hover-time-layer="">
        <div ref={row} className={styles.row} data-hover-time-row="">
          <time ref={label} className={styles.label} hidden />
          <span className={styles.baseline} aria-hidden="true">M</span>
        </div>
      </div>}
    </HoverTimeHostContext>
  );
}
