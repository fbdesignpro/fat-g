// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { userDataOverride } from '../src/main/app/identity.ts';
import { executeSetup, exitSetupWorker, parseSetupArgs, restoreSetup, saveSetup, setupEnvironment, setupName, setupPaths } from './lib/dev-setups.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fatg-dev-setups-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const paths = setupPaths(root, 'recording');
  mkdirSync(paths.dev);
  writeFileSync(path.join(paths.dev, 'preferences.json'), '{"presets":["demo"],"future":true}');
  writeFileSync(path.join(paths.dev, 'records.json'), '{"projects":["example"],"sessions":["first"]}');
  mkdirSync(path.join(paths.dev, 'plans/one'), { recursive: true });
  writeFileSync(path.join(paths.dev, 'plans/one/v1.md'), '# Sample plan');
  return { ...paths, root };
}

test('two commands, optional names, safe paths and the app agree', () => {
  assert.deepEqual(parseSetupArgs(['save']), { command: 'save', name: 'screenshots' });
  assert.deepEqual(parseSetupArgs(['run', 'overview']), { command: 'run', name: 'overview' });
  for (const args of [['restore'], ['run', 'demo', '--demo'], ['save', '../escape']]) assert.throws(() => parseSetupArgs(args));
  const base = { appData: path.resolve('app-data'), temp: os.tmpdir(), isPackaged: false, isSmokeRun: false };
  for (const name of ['a', 'recording-1', 'my_demo']) assert.equal(setupPaths(base.appData, name).run, userDataOverride({ ...base, devSetup: name }));
  for (const name of ['', '../escape', 'Uppercase', 'a/b', 'a\\b', 'nul', 'con', 'lpt1', 'a'.repeat(49)]) {
    assert.throws(() => setupName(name));
    assert.throws(() => userDataOverride({ ...base, devSetup: name }));
  }
  assert.equal(userDataOverride({ ...base, isPackaged: true, devSetup: 'demo' }), undefined);
  assert.equal(userDataOverride({ ...base, isSmokeRun: true, devSetup: 'demo' }), path.join(base.temp, 'fatg-smoke'));
  assert.equal(userDataOverride({ ...base, isStreamForm: true, devSetup: 'demo' }), path.join(base.temp, 'fatg-stream'));
  assert.deepEqual(setupEnvironment({ PATH: 'path', CODEX_HOME: 'keep', ELECTRON_RUN_AS_NODE: '1', FATG_DEMO_SESSIONS: 'stream', FATG_SMOKE: '1' }, 'demo'), { PATH: 'path', CODEX_HOME: 'keep', FATG_DEV_SETUP: 'demo' });
});

test('each take resets owned data, preserves the frozen copy and leaves everyday dev alone', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.dev, 'debug.log'), 'excluded');
  saveSetup(f.root, 'recording');
  assert.throws(() => saveSetup(f.root, 'recording'), /already frozen/);
  restoreSetup(f.root, 'recording');
  const original = readFileSync(path.join(f.dev, 'preferences.json'), 'utf8');
  writeFileSync(path.join(f.run, 'preferences.json'), 'edited during take');
  writeFileSync(path.join(f.run, 'plans/one/extra.md'), 'extra plan');
  writeFileSync(path.join(f.run, 'conversations.sqlite-shm'), 'stale');
  restoreSetup(f.root, 'recording');
  for (const dir of [f.dev, f.snapshot, f.run]) assert.equal(readFileSync(path.join(dir, 'preferences.json'), 'utf8'), original);
  assert.equal(readFileSync(path.join(f.run, 'plans/one/v1.md'), 'utf8'), '# Sample plan');
  for (const file of ['plans/one/extra.md', 'conversations.sqlite-shm', 'debug.log']) assert.equal(existsSync(path.join(f.run, file)), false);
  assert.throws(() => restoreSetup(f.root, 'missing'), /No saved setup/);
  assert.equal(readFileSync(path.join(f.run, 'preferences.json'), 'utf8'), original);
});

test('SQLite committed WAL data survives the copy', t => {
  const f = fixture(t);
  const source = path.join(f.root, 'database-source');
  mkdirSync(source);
  const db = new DatabaseSync(path.join(source, 'conversations.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('saved answer');");
  for (const file of ['conversations.sqlite', 'conversations.sqlite-wal']) copyFileSync(path.join(source, file), path.join(f.dev, file));
  db.close();
  saveSetup(f.root, 'recording');
  restoreSetup(f.root, 'recording');
  const restored = new DatabaseSync(path.join(f.run, 'conversations.sqlite'));
  try { assert.equal(restored.prepare('SELECT text FROM messages').get().text, 'saved answer'); } finally { restored.close(); }
});

test('saving an existing setup prompts; cancel keeps it and replace captures current dev', t => {
  const f = fixture(t);
  saveSetup(f.root, 'recording');
  const original = readFileSync(path.join(f.snapshot, 'preferences.json'), 'utf8');
  writeFileSync(path.join(f.dev, 'preferences.json'), '{"presets":["updated"]}');
  rmSync(path.join(f.dev, 'plans'), { recursive: true });
  const app = { getPath: () => f.root, setPath: () => {}, requestSingleInstanceLock: () => true };
  const messages = [];
  let prompts = 0;
  executeSetup(app, ['save', 'recording'], message => messages.push(message), request => {
    assert.deepEqual(request, { name: 'recording', replace: true, hasRun: false });
    prompts += 1;
    return null;
  });
  assert.equal(prompts, 1);
  assert.match(messages[0], /cancelled/);
  assert.equal(readFileSync(path.join(f.snapshot, 'preferences.json'), 'utf8'), original);
  executeSetup(app, ['save', 'recording'], message => messages.push(message), () => 'dev');
  assert.match(messages[1], /Saved:/);
  assert.equal(readFileSync(path.join(f.snapshot, 'preferences.json'), 'utf8'), '{"presets":["updated"]}');
  assert.equal(existsSync(path.join(f.snapshot, 'plans')), false);
  // A failed source copy must not remove the previous snapshot.
  rmSync(path.join(f.dev, 'records.json'));
  assert.throws(() => saveSetup(f.root, 'recording', true), /No saved setup/);
  assert.equal(readFileSync(path.join(f.snapshot, 'preferences.json'), 'utf8'), '{"presets":["updated"]}');
});

test('saving screenshot edits and running again keeps them without changing everyday dev', t => {
  const f = fixture(t);
  saveSetup(f.root, 'recording');
  restoreSetup(f.root, 'recording');
  const original = readFileSync(path.join(f.dev, 'preferences.json'), 'utf8');
  writeFileSync(path.join(f.run, 'preferences.json'), '{"presets":["new screenshot preset"]}');
  writeFileSync(path.join(f.run, 'records.json'), '{"projects":["new screenshot project"],"sessions":["new session"]}');
  let locked;
  const app = { getPath: () => f.root, setPath: (_key, directory) => { locked = directory; }, requestSingleInstanceLock: () => true };
  executeSetup(app, ['save', 'recording'], () => {}, request => {
    assert.deepEqual(request, { name: 'recording', replace: true, hasRun: true });
    return 'run';
  });
  assert.equal(locked, f.run);
  restoreSetup(f.root, 'recording');
  assert.equal(readFileSync(path.join(f.run, 'preferences.json'), 'utf8'), '{"presets":["new screenshot preset"]}');
  assert.equal(readFileSync(path.join(f.run, 'records.json'), 'utf8'), '{"projects":["new screenshot project"],"sessions":["new session"]}');
  assert.equal(readFileSync(path.join(f.dev, 'preferences.json'), 'utf8'), original);
  executeSetup(app, ['save', 'recording'], () => {}, () => 'dev');
  assert.equal(locked, f.dev);
  restoreSetup(f.root, 'recording');
  assert.equal(readFileSync(path.join(f.run, 'preferences.json'), 'utf8'), original);
});

test('links and a running app are refused before reading or replacing data', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'private'), 'leave alone');
  symlinkSync(outside, path.join(f.dev, 'avatars'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => saveSetup(f.root, 'recording'), /links|junctions/);
  assert.equal(existsSync(f.snapshot), false);
  assert.equal(readFileSync(path.join(outside, 'private'), 'utf8'), 'leave alone');
  const app = { getPath: () => f.root, setPath: () => {}, requestSingleInstanceLock: () => false };
  for (const command of ['save', 'run']) assert.throws(() => executeSetup(app, [command], () => {}), /Close/);
});

test('worker exits after its lifecycle callback returns, preserving the requested status', async () => {
  let inCallback = true;
  const exits = [];
  exitSetupWorker({ exit: code => { assert.equal(inCallback, false); exits.push(code); } }, 1);
  assert.deepEqual(exits, []);
  inCallback = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
});

test('windowless Electron worker respects a real running-app lock', { timeout: 30000, skip: process.platform === 'linux' && !process.env.DISPLAY }, async t => {
  const f = fixture(t);
  const electron = createRequire(import.meta.url)('electron');
  const command = new URL('./lib/dev-setups.mjs', import.meta.url).href;
  const harness = path.join(f.root, 'worker.mjs');
  writeFileSync(harness, `import { app } from 'electron';
import { existsSync } from 'node:fs';
import { executeSetup, exitSetupWorker } from ${JSON.stringify(command)};
app.setName('fat-g'); app.disableHardwareAcceleration(); app.enableSandbox();
app.setPath('appData', ${JSON.stringify(f.root)});
if (process.argv[2] === 'hold') {
  app.setPath('userData', ${JSON.stringify(f.run)});
  if (!app.requestSingleInstanceLock()) exitSetupWorker(app, 2);
  setInterval(() => { if (existsSync(${JSON.stringify(path.join(f.root, 'stop'))})) exitSetupWorker(app, 0); }, 25);
  app.whenReady().then(() => console.log('LOCKED'));
} else {
  app.whenReady().then(() => {
    try { executeSetup(app, process.argv.slice(2), console.info, () => 'run'); exitSetupWorker(app, 0); }
    catch (error) { console.error(error.message); exitSetupWorker(app, 1); }
  });
}`);
  const env = setupEnvironment(process.env);
  const invoke = args => spawnSync(electron, [harness, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  for (const args of [['save', 'recording'], ['run', 'recording']]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const holder = spawn(electron, [harness, 'hold'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(holder, 'exit');
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      holder.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED')) resolve(); });
      holder.once('exit', code => reject(Error(`Lock holder exited: ${code}`)));
      holder.once('error', reject);
    });
    for (const command of ['run', 'save']) {
      const result = invoke([command, 'recording']);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Close/);
    }
  } finally {
    writeFileSync(path.join(f.root, 'stop'), 'stop');
    await closed;
  }
  const result = invoke(['run', 'recording']);
  assert.equal(result.status, 0, result.stderr);
});
