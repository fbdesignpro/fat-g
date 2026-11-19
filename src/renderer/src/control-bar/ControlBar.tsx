// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import { openSettings } from '../settings/settings-store';
import { AppMenu } from './AppMenu';
import styles from './ControlBar.module.css';
import { GearIcon } from './icons';
import { PetButton } from './PetButton';
import { ZoomButton } from './ZoomButton';

/**
 * The menu and the gear (M11 Design 5; M100, C19): a toolbar of icon buttons, which the title strip
 * holds after the app's name — the menu, the gear and the Pet window's toggle (decision 0010) — and
 * after them the zoom while it is not 100%. The usage blocks
 * are the top band's (src/renderer/src/shell/TopBand.tsx). The shell decides where it sits
 * (`className`); this decides what is in it.
 */
export function ControlBar({ className }: { readonly className?: string }) {
  const settings = useRef<HTMLButtonElement>(null);
  return (
    <div role="toolbar" aria-label="Controls" className={className === undefined ? styles.controlBar : `${styles.controlBar} ${className}`}>
      <AppMenu />
      <button ref={settings} type="button" className={styles.iconButton} aria-label="Settings" onClick={() => openSettings()}>
        <GearIcon />
      </button>
      <PetButton />
      <ZoomButton settings={settings} />
    </div>
  );
}
