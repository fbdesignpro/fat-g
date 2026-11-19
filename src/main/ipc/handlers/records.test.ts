// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13 (docs/planning/_archive/M12.md, C54, C77, C79): failures driven through the real dispatcher, with the
// real stores, and one captured log shared by all three. Each filesystem error's message holds a
// path with a person's name in it, as a real one would; so do the refused request's values.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvokeChannel } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { createPreferencesStore, PREFERENCES_FILE } from '../../prefs/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../../records/format';
import { createRecordsStore } from '../../records/store';
import type { SetAsideIo } from '../../storage/set-aside';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { prefsHandlers } from './prefs';
import { projectHandlers } from './projects';
import { recordsHandlers } from './records';

const NAME = 'Jane Q. Private';
const PRIVATE_PATH = `C:\\Users\\${NAME}\\AppData\\Roaming\\fat-g`;
const ID = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const fsError = (code: string, verb: string, file: string) => Object.assign(new Error(`${code}: ${verb}, open '${PRIVATE_PATH}\\${file}'`), { code, path: `${PRIVATE_PATH}\\${file}` });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-logs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every store and channel failing at once, all logging into `log`. */
function failingApp(log: Pick<Console, 'info' | 'warn' | 'error'>) {
  const locked = fsError('EBUSY', 'resource busy or locked', 'x.json');
  const renameFails: SetAsideIo = { lstat: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), rename: () => Promise.reject(fsError('EPERM', 'operation not permitted', 'x.json')) };

  // A readable records file whose writes fail.
  const writable = path.join(dir, 'writable');
  const project = { id: ID, name: NAME, color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: `${PRIVATE_PATH}\\code`, trust: null }] };
  mkdirSync(writable);
  writeFileSync(path.join(writable, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project] }));
  const records = createRecordsStore({ dir: writable, providerIds: ['codex'], platform: 'win32', log, write: () => Promise.reject(fsError('EPERM', 'operation not permitted, rename', 'records.json.tmp')) });

  // Refused files: damaged, then locked when read again; and neither can be moved aside.
  const refused = path.join(dir, 'refused');
  mkdirSync(refused);
  writeFileSync(path.join(refused, RECORDS_FILE), '{');
  writeFileSync(path.join(refused, PREFERENCES_FILE), '{');
  // The first two reads (records, then preferences, at load) find a damaged file; later ones a locked one.
  let reads = 0;
  const readThenLock = (): string => {
    reads += 1;
    if (reads > 2) throw locked;
    return '{';
  };
  const refusedRecords = createRecordsStore({ dir: refused, providerIds: ['codex'], platform: 'win32', log, setAsideIo: renameFails, readFile: readThenLock });
  const prefs = createPreferencesStore({ dir: refused, providerIds: ['codex'], writeDelayMs: 10_000, log, setAsideIo: renameFails, readFile: readThenLock });

  const project$ = projectHandlers({ openFolder: () => Promise.resolve(''), showInFolder: () => undefined, records, lookups: { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('present') }, hasProvider: (id) => id === 'codex', pickFolder: () => Promise.resolve(null), checkRoots: () => undefined, platform: 'win32' });
  return {
    'projects:setHidden': [project$['projects:setHidden'], { id: ID, hidden: true }],
    'records:startFresh': [recordsHandlers(refusedRecords)['records:startFresh'], null],
    'records:retry': [recordsHandlers(refusedRecords)['records:retry'], null],
    'prefs:startFresh': [prefsHandlers(prefs)['prefs:startFresh'], null],
    'prefs:retry': [prefsHandlers(prefs)['prefs:retry'], null],
    // Refused before any handler: the values are the user's own text.
    'projects:add': [project$['projects:add'], { name: NAME.repeat(100), color: 'teal', roots: [{ path: PRIVATE_PATH, trust: 'trusted', [NAME]: true }], providers: ['codex'] }],
  } as unknown as Record<InvokeChannel, [Handler<unknown, unknown>, unknown]>;
}

async function drive(detail: DispatchDeps['detail']) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = failingApp(log);
  const deps: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail };
  const results: Record<string, unknown> = {};
  for (const [channel, [handler, request]] of Object.entries(app) as [InvokeChannel, [Handler<unknown, unknown>, unknown]][]) {
    results[channel] = await dispatchInvoke(channel, INVOKE_SPECS[channel] as never, handler, { windowKind: 'main', sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true }, request }, deps);
  }
  return { log, results };
}

describe('the log (V13)', () => {
  it('holds only channels and kinds in a packaged build', async () => {
    const { log, results } = await drive('kinds');
    expect(results).toEqual({
      'projects:setHidden': { ok: false, error: 'internal' },
      'records:startFresh': { ok: false, error: 'internal' },
      'records:retry': { ok: true, value: { status: 'refused', reason: 'still-refused' } },
      'prefs:startFresh': { ok: false, error: 'internal' },
      'prefs:retry': { ok: true, value: { status: 'refused', reason: 'still-refused' } },
      'projects:add': { ok: false, error: 'bad-request' },
    });
    const lines = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls];
    // One argument each: a line of text, never an error object or zod's issues.
    for (const call of lines) expect(call).toHaveLength(1);
    const text = JSON.stringify(lines);
    for (const secret of [NAME, 'Jane', 'Users', 'operation not permitted', 'resource busy', 'x.json', 'records.json.tmp', dir]) expect(text).not.toContain(secret.replaceAll('\\', '\\\\'));
    expect(log.error.mock.calls.flat()).toEqual(expect.arrayContaining([
      '[ipc] projects:setHidden handler failed (Error EPERM)',
      '[ipc] records:startFresh handler failed (Error EPERM)',
      '[ipc] prefs:startFresh handler failed (Error EPERM)',
    ]));
    expect(log.warn.mock.calls.flat()).toEqual(expect.arrayContaining([
      '[records] could not be read (EBUSY); the file is left as it is',
      expect.stringMatching(/^\[prefs\] preferences could not be read \(EBUSY\)/) as unknown,
      '[ipc] bad request on projects:add from the main window: too_big at name, unrecognized_keys at roots',
    ]));
  });

  it('logs the full error in a development run (C79)', async () => {
    const { log } = await drive('full');
    const failures = log.error.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('handler failed'));
    expect(failures).toHaveLength(3);
    for (const [, error] of failures) expect(String((error as Error).message)).toContain(NAME);
    const bad = log.warn.mock.calls.find(([line]) => typeof line === 'string' && line.startsWith('[ipc] bad request on projects:add'));
    expect(bad?.[1]).toEqual(expect.any(Array));
  });
});
