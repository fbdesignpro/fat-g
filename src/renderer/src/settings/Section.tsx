// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ReactNode } from 'react';
import styles from './Settings.module.css';
import { SETTINGS_PANEL_ID, type SettingsSection, settingsTabId } from './settings-store';

/**
 * One section of the Settings dialog, as the panel of its tab (docs/planning/_archive/M101-spec-sheet.md; C5,
 * C6, C14): labelled by its tab, with no heading of its own, and scrolling alone under the row. Only
 * the shown tab's is mounted, so they share the one id the tabs control. It is a stop of its own, so
 * that a panel with no control can still be scrolled by the keyboard.
 */
export function Section({ section, children }: { readonly section: SettingsSection; readonly children: ReactNode }) {
  return (
    <div id={SETTINGS_PANEL_ID} className={styles.panel} role="tabpanel" aria-labelledby={settingsTabId(section)} tabIndex={0}>
      {children}
    </div>
  );
}
