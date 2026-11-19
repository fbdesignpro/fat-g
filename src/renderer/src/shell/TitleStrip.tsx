// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { ControlBar } from '../control-bar/ControlBar';
import styles from './Shell.module.css';

/**
 * The title strip: the app's name, in the row the OS draws the window buttons over (decision 0008,
 * src/main/windows/chrome.ts), and after it the menu and the gear (M100, C19). Dragging the strip
 * moves the window; the two buttons are outside its drag region, as the Pet's own button is, and
 * inside the part of the row the window buttons leave free.
 */
export function TitleStrip() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = (): void => setFocused(document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return (
    <header className={styles.titleStrip} data-focused={focused}>
      <div className={styles.titleArea}>
        <h1 className={styles.appName}>fat-g</h1>
        <ControlBar className={styles.controls} />
      </div>
    </header>
  );
}
