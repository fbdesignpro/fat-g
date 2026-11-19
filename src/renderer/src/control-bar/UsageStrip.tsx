// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type FocusEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { instanceKey, shownLabel } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { useAppState } from '../state/store';
import { ChevronIcon } from './icons';
import { measureStrip, revealBlock, revealNext, revealPrevious, sameLayout, type StripLayout, stripView } from './strip-scroll';
import { UsageBlock } from './UsageBlock';
import { isUsageVisible } from './usage-visibility';
import styles from './UsageStrip.module.css';

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];

/**
 * One usage block per account that is switched on, in the app state's order: a provider's first
 * account, then the ones added to it (C34; M14b, C39). One that is switched off has none, and stays
 * in Settings (C40). When the blocks do not fit, arrows slide them (C56).
 *
 * Each block's colour and mark come from its provider's catalog entry (M13, C21): an account has no
 * colour of its own (M14b, C43). A block shows its account's label only when its provider has more
 * than one account configured (M14b, C40).
 *
 * `measure` is how the strip learns its geometry; tests replace it, since jsdom computes no layout.
 */
export function UsageStrip({ measure = measureStrip }: { readonly measure?: (outer: HTMLElement, track: HTMLElement) => StripLayout }) {
  const providers = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  // The snapshot's own object, so the selector answers the same reference until the catalog changes.
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const shown = useMemo(() => providers.filter(isUsageVisible), [providers]);
  const outer = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<StripLayout | null>(null);
  const [scroll, setScroll] = useState(0);

  const remeasure = useCallback(() => {
    if (outer.current === null || track.current === null) return;
    const next = measure(outer.current, track.current);
    setLayout((current) => (sameLayout(current, next) ? current : next));
  }, [measure]);

  // Which blocks there are decides the geometry; their contents never change a block's width.
  const blockKey = shown.map(instanceKey).join('\n');
  useLayoutEffect(() => {
    remeasure();
  }, [remeasure, blockKey]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(remeasure);
    for (const element of [outer.current, track.current]) if (element !== null) observer.observe(element);
    return () => observer.disconnect();
  }, [remeasure]);

  const view = layout === null ? null : stripView(layout, scroll);
  const slide = (reveal: (layout: StripLayout, scroll: number) => number): void => {
    if (layout !== null) setScroll(reveal(layout, view?.scroll ?? 0));
  };

  // Tabbing to a hidden block brings it into view. The browser may also try to scroll the clipped
  // viewport to it; the row is moved by transform only, so that scroll is put back.
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (viewport.current !== null) viewport.current.scrollLeft = 0;
    const index = [...(track.current?.children ?? [])].findIndex((child) => child.contains(event.target));
    if (index >= 0) slide((current, at) => revealBlock(current, at, index));
  };

  return (
    <div ref={outer} className={styles.strip}>
      {view?.overflowing === true &&
        (view.hiddenBefore ? (
          <button type="button" className={styles.arrow} aria-label="Show the providers on the left" onClick={() => slide(revealPrevious)}>
            <ChevronIcon direction="left" />
          </button>
        ) : (
          <span className={styles.arrowSpace} />
        ))}
      <div ref={viewport} className={styles.viewport} onScroll={(event) => { event.currentTarget.scrollLeft = 0; }}>
        <div ref={track} className={styles.track} style={{ transform: `translateX(${view?.scroll ?? 0}px)` }} onFocus={onFocus}>
          {shown.map((provider) => (
            <UsageBlock
              key={instanceKey(provider)}
              provider={provider}
              presentation={catalog?.providers.find((entry) => entry.id === provider.id)?.presentation}
              label={shownLabel(providers, { providerId: provider.id, instanceId: provider.instanceId })}
            />
          ))}
        </div>
      </div>
      {view?.overflowing === true &&
        (view.hiddenAfter ? (
          <button type="button" className={styles.arrow} aria-label="Show the providers on the right" onClick={() => slide(revealNext)}>
            <ChevronIcon direction="right" />
          </button>
        ) : (
          <span className={styles.arrowSpace} />
        ))}
    </div>
  );
}
