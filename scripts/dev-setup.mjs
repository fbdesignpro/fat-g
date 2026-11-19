// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSetupArgs, setupEnvironment, setupErrorMessage } from './lib/dev-setups.mjs';

function child(executable, args, options) {
  return new Promise((resolve, reject) => {
    const launched = spawn(executable, args, { stdio: 'inherit', ...options });
    launched.once('error', reject);
    launched.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const { command, name } = parseSetupArgs(args);
  if (command === 'help') {
    console.info('Configure dev and quit it, then:\n  do-dev-setup.bat save [name]   Freeze projects, sessions and presets\n  do-dev-setup.bat run [name]    Start dev with a fresh copy for each take\n\nSave asks which window to capture when a screenshot copy exists.\nThe default name is screenshots. Close the chosen window before saving.\nYour everyday dev data stays untouched. See docs/dev-setups.md.');
    return 0;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = setupEnvironment(process.env, name);
  const electron = createRequire(import.meta.url)('electron');
  const code = await child(electron, [path.join(root, 'scripts/dev-setup-worker.mjs'), ...args], { cwd: root, env });
  if (code !== 0 || command !== 'run') return code;
  return child(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--', '--window-size=1920x1080'], { cwd: root, env });
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`[dev-setup] ${setupErrorMessage(error)}`);
  process.exitCode = 1;
});
