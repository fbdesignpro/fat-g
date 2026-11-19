// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { KeyboardEvent } from 'react';
import styles from './Settings.module.css';
import { SETTINGS_PANEL_ID, SETTINGS_SECTION_TITLES, SETTINGS_SECTIONS, type SettingsSection, settingsTabId } from './settings-store';

/** The tab list's name: what a test and a probe find it by. */
export const SETTINGS_TABS_LABEL = 'Settings sections';

/**
 * The row of tabs under Settings' header (docs/planning/_archive/M101-spec-sheet.md; C1, C9, C10): one button
 * with the tab role per section, the shown one controlling the one panel, which is labelled by it.
 *
 * By the keyboard the row is one stop, the shown tab (C9). Left and Right, Home and End move among the
 * tabs and select at once, stopping at each end; Tab goes on into the panel. The artifact pane's tabs
 * select by Enter or Space alone, since selecting one there reads a file (M19b, C11); here selecting
 * costs nothing.
 */
export function SettingsTabs({ selected, onSelect }: { readonly selected: SettingsSection; readonly onSelect: (section: SettingsSection) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = SETTINGS_SECTIONS.indexOf(selected);
    const last = SETTINGS_SECTIONS.length - 1;
    const move = event.key === 'ArrowLeft' ? Math.max(0, at - 1) : event.key === 'ArrowRight' ? Math.min(last, at + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    const next = SETTINGS_SECTIONS[move];
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(settingsTabId(next))?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label={SETTINGS_TABS_LABEL} onKeyDown={onKeyDown}>
      {SETTINGS_SECTIONS.map((section) => (
        <button
          key={section}
          type="button"
          id={settingsTabId(section)}
          className={styles.tab}
          role="tab"
          aria-selected={section === selected}
          aria-controls={SETTINGS_PANEL_ID}
          tabIndex={section === selected ? 0 : -1}
          onClick={() => onSelect(section)}
        >
          {section === 'avatars' && <span className={styles.avatarTabDot} aria-hidden="true" />}
          {SETTINGS_SECTION_TITLES[section]}
        </button>
      ))}
    </div>
  );
}
