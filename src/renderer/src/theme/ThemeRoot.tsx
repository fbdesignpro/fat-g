// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useLayoutEffect } from 'react';
import { DEFAULT_ATTENTION_FLASH, FLASH_CYCLE_MS, flashCount, type FlashSeconds, type FlashSpeed } from '@shared/contracts/appearance';
import { useAppState } from '../state/store';

/**
 * Keeps the root element's `data-theme` equal to the theme in the app state, in both windows. The
 * page's first frame got its theme from the URL (public/theme-boot.js); until the first snapshot
 * arrives that attribute stands. tokens.css makes `color-scheme` follow the attribute. Sets the
 * attention flash's timing there too. Renders nothing.
 */
export function ThemeRoot() {
  const theme = useAppState((state) => state.snapshot?.appearance.theme);
  // Before paint, so a change never shows a frame with the old colours and the new window chrome.
  useLayoutEffect(() => {
    if (theme !== undefined) document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  // The attention flash's speed and duration (Settings → Appearance), which a capsule's status bar
  // animates by (Sessions.module.css); whether it flashes at all is the bar's own to read.
  const speed: FlashSpeed = useAppState((state) => state.snapshot?.appearance.flash?.speed) ?? DEFAULT_ATTENTION_FLASH.speed;
  const seconds: FlashSeconds = useAppState((state) => state.snapshot?.appearance.flash?.seconds) ?? DEFAULT_ATTENTION_FLASH.seconds;
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--attention-flash-cycle', `${FLASH_CYCLE_MS[speed]}ms`);
    root.setProperty('--attention-flash-count', String(flashCount({ speed, seconds })));
    root.setProperty('--attention-flash-duration', `${seconds}s`);
  }, [speed, seconds]);
  return null;
}
