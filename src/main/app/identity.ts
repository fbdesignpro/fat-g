// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's identity as the operating system sees it. Pure, so it is unit-tested; electron-builder.yml
// repeats APP_ID and PRODUCT_NAME and a test keeps them equal. Changing either later breaks Windows
// taskbar pins and the macOS bundle identity, or silently moves every user's preferences.
import path from 'node:path';

/** Windows AppUserModelID of the installed app, and its macOS bundle ID. */
export const APP_ID = 'io.github.fbdesignpro.fatg';
/** Also the userData folder name (`%APPDATA%\fat-g`), documented in the README. */
export const PRODUCT_NAME = 'fat-g';
/** Unpackaged runs keep their own userData — and so their own single-instance lock. */
export const DEV_DATA_SUFFIX = '-dev';

/** The stream form's data folder, under the system's temporary folder (M19, C69). */
export const STREAM_DATA_FOLDER = 'fatg-stream';

/** Development builds must not group with, or take over, the installed app's taskbar button. */
export function appUserModelId(isPackaged: boolean): string {
  return isPackaged ? APP_ID : `${APP_ID}.dev`;
}

/**
 * Where userData goes when it must not be the default. A smoke run writes to a throwaway directory
 * (it changes preferences and moves windows); an unpackaged run writes beside the installed app, so
 * a development build can neither migrate nor lock the real preferences. The installed app keeps
 * Electron's default, `<appData>/fat-g`.
 *
 * The stream form (M19, C69) writes to a throwaway directory of its own, packaged or not: a packaged
 * build with the hooks that is no smoke run would otherwise open the installed app's own folder,
 * and the fixture has no business there or in the development folder.
 */
export function userDataOverride(run: { readonly isPackaged: boolean; readonly isSmokeRun: boolean; readonly isStreamForm?: boolean; readonly smokeScenario?: string | undefined; readonly devSetup?: string | undefined; readonly appData: string; readonly temp: string }): string | undefined {
  if (run.isSmokeRun) return path.join(run.temp, run.smokeScenario === 'new-chat' || run.smokeScenario === 'session-search' || run.smokeScenario === 'avatar-family' || run.smokeScenario === 'data-reset' ? `fatg-smoke-${run.smokeScenario}` : 'fatg-smoke');
  if (run.isStreamForm === true) return path.join(run.temp, STREAM_DATA_FOLDER);
  if (!run.isPackaged) {
    if (run.devSetup !== undefined) {
      // Kept in step with scripts/lib/dev-setups.mjs by its tooling tests. No arbitrary data path.
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(run.devSetup) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(run.devSetup)) throw new Error('Invalid development setup name');
      return path.join(run.appData, 'fat-g-dev-setups', 'runs', run.devSetup);
    }
    return path.join(run.appData, `${PRODUCT_NAME}${DEV_DATA_SUFFIX}`);
  }
  return undefined;
}
