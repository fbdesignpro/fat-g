// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ExecutableHelp as Help } from '@shared/contracts/provider';
import styles from './ExecutableHelp.module.css';

/** A question mark in a circle, drawn rather than typed: a font's glyph sits off centre at some sizes. */
function HelpMark() {
  return (
    <svg className={styles.mark} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 5.85a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.3v.45" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.35" r=".95" fill="currentColor" />
    </svg>
  );
}

/** A persistent disclosure: instructions can be selected/copied and read with the keyboard. */
export function ExecutableHelp({ help, platform }: { readonly help: Help | undefined; readonly platform: string }) {
  const windows = platform === 'win32';
  const supported = windows || platform === 'darwin' || platform === 'linux';
  const locations = supported ? help?.locations[platform] : undefined;
  const lookup = help === undefined || !supported ? null : `${windows ? 'where.exe' : 'command -v'} ${help.command}`;
  return (
    <div className={styles.help}>
      <p className={styles.hint}>Automatic detection is recommended. If it does not work, select Manual override.</p>
      <details>
        <summary><HelpMark /> How to find the CLI executable</summary>
        <div className={styles.content}>
          <p>
            You must find the command-line program (CLI).
            {' '}The desktop app’s launcher or downloaded installer will not work here.
          </p>
          {help !== undefined && supported && (
            <p>
              <strong>Example {windows ? 'filenames' : 'filename'}:</strong>{' '}
              {windows ? <><code>{help.command}.exe</code> (native CLI) or <code>{help.command}.cmd</code> (npm launcher). Enable file-name extensions in File Explorer if the ending is hidden.</> : <><code>{help.command}</code> (no file extension).</>}
              {' '}Use the CLI folders below to distinguish it from a desktop launcher with the same name.
            </p>
          )}
          {lookup !== null && <p>In {windows ? 'PowerShell or Command Prompt' : 'Terminal'}, run <code>{lookup}</code>. If it prints a full file path, use that path. No result means the command is not on your terminal’s PATH; a desktop copy may still exist.</p>}
          {locations !== undefined && locations.folders.length > 0 && (
            <>
              <p>{windows ? 'Paste one of these folders into File Explorer’s address bar, then look for the CLI file:' : platform === 'darwin' ? 'In Finder, press Shift+Command+G and paste one of these folders:' : 'Look for the CLI file in these common folders:'}</p>
              <ul>{locations.folders.map((folder) => <li key={folder}><code>{folder}</code></li>)}</ul>
              {locations.note !== undefined && <p>{locations.note}</p>}
            </>
          )}
          <p>If automatic detection does not work, select <strong>Manual override</strong>, then <strong>Browse…</strong> to choose the file. To type a path instead, use its full absolute path without quotes, commands, <code>~</code> or <code>%VARIABLE%</code>, then press <strong>Save path</strong>.</p>
          <p>A desktop app may not have downloaded its coding CLI yet. If you cannot find it, use the provider’s installation guide to install the CLI.</p>
          <p>A manual path into a version folder can stop working after an update. Select <strong>Automatic detection</strong> to clear that override, then use <strong>Redetect / reconnect</strong> after running sessions finish. Finding a file does not sign you in; follow any sign-in guidance shown for the account.</p>
        </div>
      </details>
    </div>
  );
}
