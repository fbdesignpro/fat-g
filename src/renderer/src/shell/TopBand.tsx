// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { ARROW_WIDTH } from '../control-bar/strip-scroll';
import { UsageStrip } from '../control-bar/UsageStrip';
import { isUsageVisible } from '../control-bar/usage-visibility';
import { useNewChatScreen } from '../new-session/useNewChatLifecycle';
import { useAppState } from '../state/store';
import { SessionNameArea } from './SessionNameArea';
import styles from './Shell.module.css';

export const USAGE_NOTE = 'Usage remaining';

/**
 * The top band's work cell (docs/planning/_archive/M100.md, Design 4; C14, C17, C54, C92): at the left, written
 * directly on the grid, the session's names, at the band's top, level with the usage box's own top
 * (the maintainer); at the right the usage box — sized for up to three enabled accounts,
 * capped at 60% of the work column shared by the chat and artifacts, or its full width on the
 * new-chat screen, whose heading stands below the band — holding the usage
 * strip at a fixed height, with "Usage remaining" outside it, above its top-right corner. Everything
 * in the band stands on its foot, and the band is as tall as the names and that line ask, never less
 * than the box.
 *
 * Done is no longer here (the maintainer): it stands inside the session window, at its
 * top-left corner (SessionWindow.tsx). The band's height no longer follows it, so a name of one or
 * two lines leaves the window's top where it is when the session goes — which is what marking a
 * session Done now does (M14's C33, as amended).
 */
export function TopBand() {
  const starting = useNewChatScreen() !== null;
  const accountCount = useAppState((state) => state.snapshot?.providers.filter(isUsageVisible).length ?? 0);
  const band = useRef<HTMLDivElement>(null);
  const usage = useRef<HTMLElement>(null);
  const [slots, setSlots] = useState(3);
  const visibleAccounts = Math.max(1, Math.min(slots, accountCount));

  useLayoutEffect(() => {
    const element = band.current;
    const box = usage.current;
    if (element === null || box === null) return;
    const measure = (): void => {
      const block = box.querySelector<HTMLElement>('[data-usage-block]');
      if (block === null || block.parentElement === null) return;
      const style = getComputedStyle(box);
      const frame = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
        .reduce((sum, value) => sum + Number.parseFloat(value), 0);
      const gap = Number.parseFloat(getComputedStyle(block.parentElement).columnGap);
      const available = element.getBoundingClientRect().width * (starting ? 1 : 0.6) - frame;
      for (let count = Math.min(3, accountCount); count >= 1; count -= 1) {
        const width = count * block.offsetWidth + (count - 1) * gap + (accountCount > count ? 2 * ARROW_WIDTH : 0);
        if (width <= available || count === 1) {
          setSlots(count);
          break;
        }
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [accountCount, starting]);

  return (
    <div ref={band} className={styles.band} data-new-chat={starting || undefined} style={{
      '--usage-account-count': visibleAccounts,
      '--usage-arrow-space': accountCount > visibleAccounts ? `${2 * ARROW_WIDTH}px` : '0px',
    } as CSSProperties}>
      <div className={styles.bandStart}>
        <SessionNameArea />
      </div>
      <section ref={usage} className={styles.usage} aria-label="Usage">
        <p className={styles.usageNote}>{USAGE_NOTE}</p>
        <UsageStrip />
      </section>
    </div>
  );
}
