// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1, the two Electron legs: a main process that runs the check once Electron is ready, writes its
// report and exits. It opens no window, and keeps Electron's own data in the scratch folder it is
// given, so nothing of it reaches the user's fat-g data folder.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { storeCheck } from '../lib/store-check.mjs';

const out = process.env['FATG_SPIKE_OUT'];
const dir = process.env['FATG_SPIKE_DIR'];
if (!out || !dir) app.exit(2);
else {
  app.setPath('userData', path.join(dir, 'user-data'));
  void app.whenReady().then(async () => {
    let report;
    try {
      report = await storeCheck(path.join(dir, 'store'));
    } catch (error) {
      report = { ok: false, error: String(error) };
    }
    report.packaged = app.isPackaged;
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.ok ? 0 : 1);
  });
}
