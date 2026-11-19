// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences } from '@shared/contracts/prefs';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from '../../prefs/store';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { prefsHandlers } from './prefs';

let dir: string;
let store: PreferencesStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-prefs-ipc-'));
  store = createPreferencesStore({ dir, writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
});
afterEach(() => {
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const deps: DispatchDeps = {
  origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }),
  log: { warn: vi.fn(), error: vi.fn() },
  detail: 'kinds',
};
const from = (kind: 'main' | 'pet', request: unknown) => ({
  windowKind: kind,
  sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true },
  request,
});

describe('prefs handlers', () => {
  it('answers prefs:get with the current snapshot', async () => {
    expect(await prefsHandlers(store)['prefs:get'](null, { windowKind: 'main' })).toEqual({
      rev: 0,
      values: defaultPreferences(),
      status: { kind: 'ok' },
      providerIssues: {},
      instances: {},
    });
  });

  it('applies prefs:patch and answers with the result', async () => {
    const snapshot = await prefsHandlers(store)['prefs:patch']({ privacy: { maskEmail: false } }, { windowKind: 'main' });
    expect(snapshot.rev).toBe(1);
    expect(snapshot.values.privacy.maskEmail).toBe(false);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  // M103 (V2; C8): an avatar's assignment ends no runtime, so it is saved whatever runs.
  it('saves an avatar’s assignment while a session of the provider runs, and its clear', async () => {
    const prefs = createPreferencesStore({ dir, providerIds: ['claude'], writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
    try {
      const reaches = vi.fn(() => true);
      const ref = { origin: 'built-in', family: 'Orange', avatar: 'Op' } as const;
      const set = await prefsHandlers(prefs, reaches)['prefs:patch']({ avatars: { assignments: { claude: { opus: ref } } } }, { windowKind: 'main' });
      expect(set.refused).toBeUndefined();
      expect(set.values.avatars.assignments).toEqual({ claude: { opus: ref } });
      const cleared = await prefsHandlers(prefs, reaches)['prefs:patch']({ avatars: { assignments: { claude: { opus: null } } } }, { windowKind: 'main' });
      expect([cleared.refused, cleared.values.avatars.assignments]).toEqual([undefined, {}]);
      expect(reaches).not.toHaveBeenCalled();
    } finally {
      prefs.dispose();
    }
  });

  // M104 (V3; C24): a family's result is several entries of one provider, and ends no runtime either.
  it('saves several models’ avatars in one write while a session of the provider runs', async () => {
    const prefs = createPreferencesStore({ dir, providerIds: ['claude'], writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
    try {
      const reaches = vi.fn(() => true);
      const op = { origin: 'built-in', family: 'Orange', avatar: 'Op' } as const;
      const fa = { origin: 'built-in', family: 'Orange', avatar: 'Fa' } as const;
      const set = await prefsHandlers(prefs, reaches)['prefs:patch']({ avatars: { assignments: { claude: { opus: op, fable: fa } } } }, { windowKind: 'main' });
      expect([set.refused, set.rev, set.values.avatars.assignments]).toEqual([undefined, 1, { claude: { opus: op, fable: fa } }]);
      expect(reaches).not.toHaveBeenCalled();
    } finally {
      prefs.dispose();
    }
  });
});

// The contract, the sender policy and the handler together — the first channels in the app that
// only one kind of window may use.
describe('through the real contract', () => {
  it.each(['prefs:get', 'prefs:patch'] as const)('lets the Main window call %s', async (channel) => {
    const handler = prefsHandlers(store)[channel];
    const request = channel === 'prefs:get' ? null : { privacy: { maskEmail: false } };
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel], handler as never, from('main', request), deps);
    expect(result.ok).toBe(true);
  });

  it.each(['prefs:get', 'prefs:patch'] as const)('refuses the Pet window %s', async (channel) => {
    const handler = vi.fn();
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel], handler, from('pet', null), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a patch it does not recognise, without touching the file', async () => {
    const handler = vi.fn();
    const result = await dispatchInvoke(
      'prefs:patch',
      INVOKE_SPECS['prefs:patch'],
      handler,
      from('main', { privacy: { maskEmails: false } }),
      deps,
    );
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['two providers’ avatars', { claude: { opus: null }, codex: { 'gpt-6-sol': null } }],
    ['no model at all', { claude: {} }],
  ])('refuses a patch of %s whole, without touching the file (M104, C24)', async (_name, assignments) => {
    const handler = vi.fn();
    const result = await dispatchInvoke('prefs:patch', INVOKE_SPECS['prefs:patch'], handler, from('main', { avatars: { assignments } }), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a patch that tries to set the schema version', async () => {
    const result = await dispatchInvoke('prefs:patch', INVOKE_SPECS['prefs:patch'], vi.fn(), from('main', { schemaVersion: 2 }), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('a read-only file', () => {
  it('leaves a patch as a no-op that the window can see', async () => {
    writeFileSync(path.join(dir, PREFERENCES_FILE), JSON.stringify({ schemaVersion: 99, minReaderVersion: 99 }), 'utf8');
    const readOnly = createPreferencesStore({ dir, log: { warn: vi.fn(), error: vi.fn() } });
    try {
      const snapshot = await prefsHandlers(readOnly)['prefs:patch']({ audio: { muted: true } }, { windowKind: 'main' });
      expect(snapshot.rev).toBe(0);
      expect(snapshot.values.audio.muted).toBe(false);
      expect(snapshot.status).toMatchObject({ kind: 'read-only', reason: 'incompatible' });
    } finally {
      readOnly.dispose();
    }
  });
});
