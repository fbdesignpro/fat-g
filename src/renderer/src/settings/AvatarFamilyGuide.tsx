// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useState } from 'react';
import { CloseIcon } from '../control-bar/icons';
import dialogStyles from '../ui/Dialog.module.css';
import { useSettingsDialog } from './settings-dialog';
import styles from './AvatarFamilyGuide.module.css';

const FOLDER_LAYOUT = `avatars/
└── My family/
    ├── family.json   ← automatically created on Rescan
    ├── Default/      ← required folder
    │   ├── portrait.png ← required per avatar
    │   └── small.png ← optional
    └── Nova/
        └── portrait.png`;

/** Folder and image reference shared by the family catalog and editor. */
export function AvatarFamilyGuide({ compact = false }: { readonly compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { dialog, onDialogClose } = useSettingsDialog(open, () => setOpen(false), 'h2');
  const close = (): void => { dialog.current?.close(); };

  return (
    <>
      <button type="button" className={compact ? styles.compactButton : styles.guideButton} title={compact ? 'Avatar families: folders, PNG specifications and image updates' : undefined} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className={styles.infoIcon} aria-hidden="true">i</span>
        {compact ? <span>Technical details</span> : <span className={styles.buttonText}>
          <strong>Create your own avatar family</strong>
          <span>Folder layout, PNG specifications and image updates</span>
        </span>}
      </button>
      <dialog ref={dialog} className={`${dialogStyles.dialog} ${styles.guideDialog}`} aria-labelledby={titleId} onClose={onDialogClose}>
        {open && <>
          <header className={dialogStyles.header}>
            <h2 id={titleId} className={styles.title} tabIndex={-1}>Avatar families</h2>
            <button type="button" className={dialogStyles.closeButton} aria-label="Close avatar family guide" onClick={close}><CloseIcon /></button>
          </header>
          <div className={styles.guideBody}>
            <div className={styles.steps}>
              <section className={`${styles.step} ${styles.folderStep}`} aria-labelledby={`${titleId}-folders`}>
                <h3 id={`${titleId}-folders`}>1. Folder layout</h3>
                <p>A family is a folder containing one folder per avatar. Folder names are the family and avatar names; <code>family.json</code> holds their order, model matches and display styles.</p>
                <pre className={styles.folderLayout}><code>{FOLDER_LAYOUT}</code></pre>
                <p><strong>Default</strong> is used when no model matches another avatar. Keep folder names unchanged once assigned.</p>
              </section>
              <section className={styles.step} aria-labelledby={`${titleId}-images`}>
                <h3 id={`${titleId}-images`}>2. PNG specifications</h3>
                <table className={styles.imageTable}>
                  <caption>Recommended PNG sizes</caption>
                  <thead><tr><th scope="col">File</th><th scope="col">Size</th></tr></thead>
                  <tbody>
                    <tr><th scope="row"><code>portrait.png</code></th><td>512 × 512 px</td></tr>
                    <tr><th scope="row"><code>small.png</code></th><td>64 × 64 px</td></tr>
                  </tbody>
                </table>
                <p>Square, still PNGs. Maximum <strong>5 MiB</strong> and <strong>8,000 pixels per side</strong>. Without <code>small.png</code>, the portrait scales down.</p>
              </section>
              <section className={styles.step} aria-labelledby={`${titleId}-edit`}>
                <h3 id={`${titleId}-edit`}>3. Updating images</h3>
                <ul>
                  <li>In the family editor, drop an image below the avatar list to add an avatar, or onto an existing image to replace it. <strong>Browse</strong> works too.</li>
                  <li>A main image creates both PNG sizes automatically; replacing the small version changes only that image.</li>
                  <li>Image changes are saved immediately. Use <strong>Rescan</strong> after changing files outside fat-g.</li>
                </ul>
              </section>
            </div>
          </div>
          <footer className={dialogStyles.footer}>
            <button type="button" className={dialogStyles.button} onClick={close}>Got it</button>
          </footer>
        </>}
      </dialog>
    </>
  );
}
