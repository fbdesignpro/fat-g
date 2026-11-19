// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Windowless Electron supplies the native data path and the same lock as the app.
import { app, dialog } from 'electron';
import path from 'node:path';
import { assertLocalPath, executeSetup, exitSetupWorker, setupErrorMessage } from './lib/dev-setups.mjs';

app.setName('fat-g');
app.disableHardwareAcceleration();
app.enableSandbox();
async function main() {
  const appData = app.getPath('appData');
  const workerData = path.join(appData, 'fat-g-dev-setups', '.worker');
  assertLocalPath(appData, workerData);
  app.setPath('userData', workerData);
  await app.whenReady();
  executeSetup(app, process.argv.slice(2), console.info, ({ name, replace, hasRun }) => {
    const sources = hasRun ? ['run', 'dev'] : ['dev'];
    const buttons = hasRun ? ['Screenshot window', 'Everyday dev', 'Cancel'] : ['Replace from everyday dev', 'Cancel'];
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      title: replace ? 'Replace screenshot setup?' : 'Save screenshot setup',
      message: `${replace ? 'Replace' : 'Save'} "${name}" with data from which window?`,
      detail: hasRun
        ? 'Screenshot window: opened by do-dev-screenshot-run.bat.\nEveryday dev: opened by do-run-dev.bat.\nChoose the window you edited, after closing it.'
        : 'Your everyday dev data will replace this saved starting point.',
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    return sources[choice] ?? null;
  });
}

main().then(() => exitSetupWorker(app, 0)).catch(error => {
  console.error(`[dev-setup] ${setupErrorMessage(error)}`);
  exitSetupWorker(app, 1);
});
