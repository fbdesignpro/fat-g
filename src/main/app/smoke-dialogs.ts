// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The native dialogs' stand-ins for smoke runs (M12, C55; M13, C71; M14, Design 7): a smoke run never
// opens a real dialog, nor the file manager.
// Loaded only behind `__FATG_SMOKE_HOOKS__` (src/main/index.ts), so a release build has neither
// this module nor the variable it reads (decision 0007; the package audit checks both).
import path from 'node:path';

/**
 * The folder picker: answers `FATG_SMOKE_PICK_FOLDER` (scripts/smoke.mjs sets it to a folder in the
 * temp directory), or cancels when it is unset or not absolute.
 */
export function smokePickFolder(env: NodeJS.ProcessEnv): () => Promise<string | null> {
  const folder = env['FATG_SMOKE_PICK_FOLDER'];
  const answer = folder !== undefined && path.isAbsolute(folder) ? folder : null;
  return () => Promise.resolve(answer);
}

/**
 * The account's folder picker (M14b, C14): answers `FATG_SMOKE_PICK_ACCOUNT_FOLDER`, or cancels when
 * it is unset or not absolute.
 */
export function smokePickAccountFolder(env: NodeJS.ProcessEnv): () => Promise<string | null> {
  const folder = env['FATG_SMOKE_PICK_ACCOUNT_FOLDER'];
  const answer = folder !== undefined && path.isAbsolute(folder) ? folder : null;
  return () => Promise.resolve(answer);
}

/**
 * The avatar image chooser (decision 0036): answers `FATG_SMOKE_PICK_IMAGE` (scripts/smoke.mjs may set
 * it to an image in the temp directory), or cancels when it is unset or not absolute.
 */
export function smokePickImage(env: NodeJS.ProcessEnv): (folder: string | undefined) => Promise<string | null> {
  const image = env['FATG_SMOKE_PICK_IMAGE'];
  const answer = image !== undefined && path.isAbsolute(image) ? image : null;
  return () => Promise.resolve(answer);
}

/** How many requests to open a login terminal reached the stand-in below (M14b, C80). */
export const terminalRequests = { count: 0 };

/**
 * The login terminal's stand-in (M14b, C80): counts the request and answers that one was opened,
 * opening nothing. A smoke run must never start a login.
 */
export function smokeOpenTerminal(): () => Promise<boolean> {
  return () => {
    terminalRequests.count += 1;
    return Promise.resolve(true);
  };
}

/** How many `shell:showDataFolder` requests reached the stand-in below, for the smoke check (M13, V25). */
export const dataFolderRequests = { count: 0 };

/**
 * The file manager's stand-in (M13, C71): counts the request and answers as `shell.openPath` does on
 * success, opening nothing.
 */
export function smokeShowDataFolder(): () => Promise<string> {
  return () => {
    dataFolderRequests.count += 1;
    return Promise.resolve('');
  };
}

/** How many addresses reached the stand-in below, for the smoke check (M19b, V15): each is one `shell:openAddress` main let through. */
export const externalRequests = { count: 0 };

/**
 * The system browser's stand-in (M19b, C44): counts the address handed over and opens nothing. A
 * smoke run must never open a browser.
 */
export function smokeOpenExternal(): () => Promise<void> {
  return () => {
    externalRequests.count += 1;
    return Promise.resolve();
  };
}

/** How many files the stand-in below was asked to show, for the smoke check (M19b, V15). */
export const showInFolderRequests = { count: 0 };

/** The file manager's stand-in for Show in folder (M19b, C43): counts the request and shows nothing. */
export function smokeShowInFolder(): () => void {
  return () => {
    showInFolderRequests.count += 1;
  };
}

/** How many folders the stand-in below was asked to open, for the smoke check. */
export const openFolderRequests = { count: 0 };

/** The file manager's stand-in for a folder a reference names: counts the request and answers as `shell.openPath` does on success, opening nothing. */
export function smokeOpenFolder(): () => Promise<string> {
  return () => {
    openFolderRequests.count += 1;
    return Promise.resolve('');
  };
}

/** How many times the quit question reached the stand-in below: a smoke run answers it in the page (M14, C68). */
export const quitBoxRequests = { count: 0 };

/**
 * The native quit question's stand-in (M14, C103): counts the request and answers Cancel, opening
 * nothing. A smoke run ends through the page's own question, so this must never be asked.
 */
export function smokeQuitBox(): () => Promise<boolean> {
  return () => {
    quitBoxRequests.count += 1;
    return Promise.resolve(false);
  };
}
