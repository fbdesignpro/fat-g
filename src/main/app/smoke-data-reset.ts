// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { app, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppStateStore } from '../state/app-state-store';
import type { PreferencesStore } from '../prefs/store';
import type { createShutdown } from './shutdown';
import { DATA_RESET_FILE } from './data-reset';

/** Dedicated two-launch fixture scenario. It never shares normal/dev/full-smoke data. */
export async function checkDataReset(main: BrowserWindow, pet: BrowserWindow, store: AppStateStore, prefs: PreferencesStore, shutdown: ReturnType<typeof createShutdown>): Promise<void> {
  const stage = process.env['FATG_SMOKE_RESET_STAGE'];
  const folder = app.getPath('userData');
  if (path.basename(folder) !== 'fatg-smoke-data-reset') throw new Error('Reset scenario refused an unexpected data folder');
  const marker = path.join(folder, DATA_RESET_FILE);
  const old = path.join(folder, 'reset-smoke-old-data');
  const customAvatar = path.join(folder, 'avatars', 'reset-smoke-old-avatar');
  const customAudio = path.join(folder, 'audio', 'reset-smoke-old-sound.txt');
  const outside = path.join(process.env['FATG_SMOKE_PICK_FOLDER'] ?? '', 'reset-smoke-project.txt');
  const evaluate = (code: string): Promise<unknown> => main.webContents.executeJavaScript(code);
  const wait = async (code: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate(code) === true) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Reset scenario UI did not settle');
  };
  if (stage === 'next') {
    await wait(`(async () => (await window.fatg.invoke('state:getSnapshot', null)).value.providerDiscovery?.notice?.initial === true)()`);
    if ([marker, old, customAvatar, customAudio].some((file) => existsSync(file)) || !existsSync(outside)) throw new Error('Reset did not remove exactly the old application data');
    if (!prefs.getSnapshot().values.privacy.maskEmail || store.getSnapshot().records?.projects.length !== 0
      || store.getSnapshot().providerDiscovery?.notice?.initial !== true) throw new Error('Reset did not restore first-install defaults');
    if (store.getSnapshot().zoom !== 100) throw new Error('Reset retained the old browser zoom');
    const cleanup = await shutdown.cleanup();
    console.log(`[smoke-scenario] ${JSON.stringify({ scenario: 'data-reset', ok: cleanup.ok, stage })}`);
    app.exit(cleanup.ok ? 0 : 1);
    return;
  }
  if (stage !== 'first') throw new Error('Unknown reset scenario stage');
  mkdirSync(old, { recursive: true }); writeFileSync(path.join(old, 'saved-backup'), 'synthetic old data');
  mkdirSync(customAvatar, { recursive: true }); writeFileSync(path.join(customAvatar, 'custom.txt'), 'synthetic avatar');
  mkdirSync(path.dirname(customAudio), { recursive: true }); writeFileSync(customAudio, 'synthetic sound');
  writeFileSync(outside, 'synthetic project file');
  await evaluate(`window.fatg.invoke('prefs:patch', { privacy: { maskEmail: false } })`);
  await evaluate(`window.fatg.invoke('zoom:change', { to: 'in' })`);
  for (const channel of ['diagnostics:dataResetInfo', 'diagnostics:resetAllData']) {
    const result: unknown = await pet.webContents.executeJavaScript(`window.fatg.invoke('${channel}', null)`);
    if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== false) throw new Error('Mini window could access full reset');
  }
  await evaluate(`document.querySelector('[role="toolbar"] button[aria-label="Settings"]').click()`);
  await evaluate(`document.getElementById('settings-tab-diagnostics').click()`);
  await wait(`(() => { const button = [...document.querySelectorAll('button')].find((element) => element.textContent === 'Reset all data...'); return button && !button.disabled; })()`);
  const click = (label: string) => evaluate(`[...document.querySelectorAll('dialog[open] button, #settings-panel button')].find((element) => element.textContent === ${JSON.stringify(label)}).click()`);
  // A press returns before the page has answered it: each waits for the question it opens, its Cancel
  // focused, before a press inside it. Cancel closes the dialog at once, but the section hears of it
  // only from the dialog's close event, a task later: a press of Reset all data... before then would
  // ask a question already asked, and the late cancel would put it away. Each cancel waits for it to go.
  const shown = (title: string) => `document.activeElement?.textContent === 'Cancel' && [...document.querySelectorAll('dialog[open] h2')].some((element) => element.textContent === ${JSON.stringify(title)})`;
  const gone = (title: string) => `![...document.querySelectorAll('dialog h2')].some((element) => element.textContent === ${JSON.stringify(title)})`;
  const first = 'Reset all fat-g data?';
  const second = 'Permanently reset and quit?';
  await click('Reset all data...');
  await wait(shown(first));
  await click('Cancel'); await wait(gone(first));
  if (existsSync(marker)) throw new Error('First cancellation armed a reset');
  await click('Reset all data...'); await wait(shown(first)); await click('Continue');
  await wait(shown(second));
  await click('Cancel'); await wait(gone(second));
  if (existsSync(marker)) throw new Error('Second cancellation armed a reset');
  await click('Reset all data...'); await wait(shown(first)); await click('Continue');
  await wait(shown(second));
  let reported = false;
  app.on('before-quit', () => {
    if (reported) return;
    reported = true;
    const ok = existsSync(marker) && existsSync(old) && store.getSnapshot().quitQuestion !== true;
    console.log(`[smoke-scenario] ${JSON.stringify({ scenario: 'data-reset', ok, stage })}`);
    if (!ok) process.exitCode = 1;
  });
  await click('Reset on next start and quit');
  // The real reset handler owns quitting. Returning would let generic smoke cleanup mask a failure.
  await new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('Confirmed reset did not quit')), 20_000); });
}
