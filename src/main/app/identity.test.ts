// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, appUserModelId, DEV_DATA_SUFFIX, PRODUCT_NAME, STREAM_DATA_FOLDER, userDataOverride } from './identity';

const run = { appData: path.join('C:', 'Users', 'u', 'AppData', 'Roaming'), temp: path.join('C:', 'Temp') };

describe('app identity', () => {
  it('is a stable reverse-DNS ID and the package name', () => {
    expect(APP_ID).toBe('io.github.fbdesignpro.fatg');
    // The userData folder is named after the product; the README documents %APPDATA%\fat-g.
    expect(PRODUCT_NAME).toBe((JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { name: string }).name);
  });

  it('matches what electron-builder.yml gives the installer and the packaged executable', () => {
    const config = readFileSync(path.resolve('electron-builder.yml'), 'utf8');
    expect(/^appId:\s*(\S+)\s*$/m.exec(config)?.[1]).toBe(APP_ID);
    expect(/^productName:\s*(\S+)\s*$/m.exec(config)?.[1]).toBe(PRODUCT_NAME);
  });

  it('gives development runs their own taskbar identity', () => {
    expect(appUserModelId(true)).toBe(APP_ID);
    expect(appUserModelId(false)).toBe(`${APP_ID}.dev`);
  });

  it('confines named smoke scenarios to their own temporary folders, only in smoke mode', () => {
    for (const smokeScenario of ['new-chat', 'session-search', 'avatar-family', 'data-reset']) {
      expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: true, smokeScenario })).toBe(path.join(run.temp, `fatg-smoke-${smokeScenario}`));
      expect(userDataOverride({ ...run, isPackaged: true, isSmokeRun: false, smokeScenario })).toBeUndefined();
    }
    expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: true, smokeScenario: '../escape' })).toBe(path.join(run.temp, 'fatg-smoke'));
  });

  it('keeps the installed app on the default userData, and moves dev and smoke runs elsewhere', () => {
    expect(userDataOverride({ ...run, isPackaged: true, isSmokeRun: false })).toBeUndefined();
    expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: false })).toBe(path.join(run.appData, `fat-g${DEV_DATA_SUFFIX}`));
    // Smoke wins over both, packaged (the smoke flavor) or not.
    expect(userDataOverride({ ...run, isPackaged: true, isSmokeRun: true })).toBe(path.join(run.temp, 'fatg-smoke'));
    expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: true })).toBe(path.join(run.temp, 'fatg-smoke'));
  });

  // M19 (V29; C69): the stream form runs apart from the user's data, in both builds.
  it('gives the stream form a throwaway folder of its own under the temporary folder, packaged or not', () => {
    expect(STREAM_DATA_FOLDER).toBe('fatg-stream');
    const stream = path.join(run.temp, 'fatg-stream');
    // A packaged build with the hooks that is no smoke run would otherwise open the installed app's own folder.
    expect(userDataOverride({ ...run, isPackaged: true, isSmokeRun: false, isStreamForm: true })).toBe(stream);
    expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: false, isStreamForm: true })).toBe(stream);
    // Neither data folder is ever the stream form's.
    for (const isPackaged of [true, false]) {
      const folder = userDataOverride({ ...run, isPackaged, isSmokeRun: false, isStreamForm: true }) ?? '';
      expect(folder.startsWith(run.appData)).toBe(false);
    }
    // Left out, or false, nothing changes for any other run.
    expect(userDataOverride({ ...run, isPackaged: true, isSmokeRun: false, isStreamForm: false })).toBeUndefined();
    expect(userDataOverride({ ...run, isPackaged: false, isSmokeRun: false, isStreamForm: false })).toBe(path.join(run.appData, `fat-g${DEV_DATA_SUFFIX}`));
  });
});
