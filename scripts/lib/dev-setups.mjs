// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Small developer-only copier. Electron's data-directory lock is held by the caller.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { retrying } from './mutation-files.mjs';

const ENTRIES = ['preferences.json', 'records.json', 'catalog.json', 'conversations.sqlite', 'conversations.sqlite-wal', 'conversations.sqlite-journal', 'plans', 'attachments', 'avatars', 'audio'];
export class SetupError extends Error {}

export function setupName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name ?? '') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) throw new SetupError('Use a short lowercase setup name with letters, digits, - or _; Windows device names are reserved.');
  return name;
}

export function setupPaths(appData, name) {
  const root = path.join(appData, 'fat-g-dev-setups');
  return { root, dev: path.join(appData, 'fat-g-dev'), snapshot: path.join(root, 'snapshots', setupName(name)), run: path.join(root, 'runs', name) };
}

export function parseSetupArgs(args) {
  const [command = 'help', name = 'screenshots', ...extra] = args;
  if (!['help', 'save', 'run'].includes(command) || extra.length || (command === 'help' && args.length > 1)) throw new SetupError('Use: do-dev-setup.bat save [name] or run [name].');
  return { command, name: setupName(name) };
}

export function setupEnvironment(env, name) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (/^(FATG_SMOKE|FATG_DEMO|FATG_DEV_SETUP|FATG_TRACE_LIFECYCLE|FATG_RELEASE_BUILD|FATG_PACKAGE_STAGING|ELECTRON_RENDERER_URL|ELECTRON_RUN_AS_NODE)/.test(key)) delete result[key];
  if (name) result.FATG_DEV_SETUP = setupName(name);
  return result;
}

/** No project/provider paths, links or junctions are followed. */
export function assertLocalPath(base, target) {
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new SetupError('Setup path is outside its data folder.');
  let current = base;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new SetupError('Setup data must not contain links or junctions.');
  }
}

function copyData(source, target) {
  for (const required of ['preferences.json', 'records.json']) if (!existsSync(path.join(source, required))) throw new SetupError('No saved setup found. Configure dev, quit it, then use save.');
  mkdirSync(target, { recursive: true });
  for (const entry of ENTRIES) {
    const file = path.join(source, entry);
    assertLocalPath(source, file);
    if (existsSync(file)) cpSync(file, path.join(target, entry), { recursive: true, filter: file => {
      if (lstatSync(file).isSymbolicLink()) throw new SetupError('Setup data must not contain links or junctions.');
      return true;
    } });
  }
}

function removeOwned(root, target) {
  assertLocalPath(root, target);
  if (target === root) throw new SetupError('Cannot remove the setup root.');
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function saveSetup(appData, name, replace = false, from = 'dev') {
  const paths = setupPaths(appData, name);
  if (from !== 'dev' && from !== 'run') throw new SetupError('Choose the screenshot window or everyday dev.');
  const source = paths[from];
  assertLocalPath(appData, source);
  assertLocalPath(appData, paths.snapshot);
  if (existsSync(paths.snapshot) && !replace) throw new SetupError('That setup is already frozen. Save with a new name.');
  mkdirSync(path.dirname(paths.snapshot), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(path.join(path.dirname(paths.snapshot), '.saving-'));
  try {
    copyData(source, stage);
    if (replace) removeOwned(paths.root, paths.snapshot);
    // Windows scanners can briefly hold the freshly copied directory open.
    retrying(() => renameSync(stage, paths.snapshot));
  }
  finally { removeOwned(paths.root, stage); }
  return paths.snapshot;
}

export function restoreSetup(appData, name) {
  const paths = setupPaths(appData, name);
  assertLocalPath(appData, paths.snapshot);
  assertLocalPath(appData, paths.run);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(path.join(paths.root, '.restoring-'));
  try {
    copyData(paths.snapshot, stage);
    mkdirSync(paths.run, { recursive: true });
    // Leave the directory itself and Electron's lock files in place.
    for (const entry of [...ENTRIES, 'conversations.sqlite-shm']) removeOwned(paths.root, path.join(paths.run, entry));
    copyData(stage, paths.run);
  } finally { removeOwned(paths.root, stage); }
  return paths.run;
}

export function executeSetup(app, args, print = console.info, chooseSave = () => null) {
  const { command, name } = parseSetupArgs(args);
  if (command === 'help') return;
  const appData = app.getPath('appData');
  const paths = setupPaths(appData, name);
  const replace = command === 'save' && existsSync(paths.snapshot);
  let from = 'dev';
  if (command === 'save') {
    assertLocalPath(appData, paths.run);
    const hasRun = ['preferences.json', 'records.json'].every(file => existsSync(path.join(paths.run, file)));
    if (replace || hasRun) {
      from = chooseSave({ name, replace, hasRun });
      if (from === null) { print('Save cancelled. The saved setup is unchanged.'); return; }
      if (from !== 'dev' && !(from === 'run' && hasRun)) throw new SetupError('Choose the screenshot window or everyday dev.');
    }
  }
  const directory = command === 'save' ? paths[from] : paths.run;
  assertLocalPath(appData, directory);
  app.setPath('userData', directory);
  if (!app.requestSingleInstanceLock()) throw new SetupError('Close this setup’s fat-g window and wait for it to exit, then retry.');
  print(command === 'save' ? `Saved: ${saveSetup(appData, name, replace, from)} (from ${from === 'run' ? 'screenshot window' : 'everyday dev'})` : `Starting fresh: ${restoreSetup(appData, name)}`);
}

export function setupErrorMessage(error) {
  return error instanceof SetupError ? error.message : `Setup failed (${typeof error?.code === 'string' ? error.code : 'invalid-data'}).`;
}

/** Let the current ready/lock callback return before Electron tears down its native singleton. */
export function exitSetupWorker(app, code) {
  setImmediate(() => app.exit(code));
}
