// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { NameTip, useNameTip } from '../ui/Tooltip';
import styles from './ControlBar.module.css';
import { PetIcon } from './icons';

/**
 * The Pet window — the "mini window" in everything the user sees; the code keeps `pet` —
 * shown or hidden, after the gear (decision 0010): a toggle whose name never changes,
 * pressed while the Pet is wanted. It changes the preference Settings' checkbox changes, which main
 * follows (src/main/windows/window-manager.ts); the Pet's own × turns it off too. Disabled until the
 * preferences are read, and while their file refuses writes, as that checkbox is.
 */
export function PetButton() {
  const snapshot = usePrefs((state) => state.snapshot);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  const visible = snapshot?.values.windows.pet.visible ?? false;
  const disabled = snapshot === null || snapshot.status.kind === 'read-only';
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.iconButton}
        aria-label="Mini window"
        aria-pressed={visible}
        disabled={disabled}
        data-pet-button=""
        onClick={() => void patchPrefs({ windows: { pet: { visible: !visible } } })}
        {...tip.targetProps}
      >
        <PetIcon />
      </button>
      <NameTip open={tip.open} anchor={button}>Mini window</NameTip>
    </>
  );
}
