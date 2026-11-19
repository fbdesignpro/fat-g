// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method */
// V18 (docs/planning/_archive/M15.md, Design 10; C18, C99): Settings' actions that end a runtime are refused
// while a session they reach is running.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceRef } from '@shared/contracts/instances';
import type { PreferencesPatch, PreferencesSnapshot } from '@shared/contracts/prefs';
import { createPreferencesStore, type PreferencesStore } from '../../prefs/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../../records/format';
import { createRecordsStore } from '../../records/store';
import type { ProviderRegistry, RegistryAction } from '../../services/provider-registry';
import { patchActions, patchReachesRunning, type ReachesRunning } from './guards';
import { prefsHandlers } from './prefs';
import { projectHandlers } from './projects';
import { providerHandlers } from './providers';

const ADDED = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const OTHER = '7c1d9e2a-3b4c-4d5e-8f6a-1b2c3d4e5f60';
const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const main = { windowKind: 'main' } as const;
const first = (providerId: string): InstanceRef => ({ providerId, instanceId: 'default' });

/** The preferences as held: Codex on with no override, one added account that is on. */
const held = {
  values: { providers: { codex: { enabled: true, executablePath: null }, claude: { enabled: false, executablePath: 'C:\\tools\\claude.exe' } } },
  instances: { codex: { firstLabel: null, added: [{ id: ADDED, label: 'Work', folder: 'D:\\accounts\\work', enabled: true, issue: null }] } },
} as unknown as Pick<PreferencesSnapshot, 'values' | 'instances'>;

describe('what a patch would do to a runtime', () => {
  it.each<[string, PreferencesPatch, { action: RegistryAction; ref: InstanceRef }[]]>([
    ['the provider’s switch', { providers: { codex: { enabled: false } } }, [{ action: 'provider-switch', ref: first('codex') }]],
    ['its executable', { providers: { codex: { executablePath: 'C:\\tools\\codex.exe' } } }, [{ action: 'provider-executable', ref: first('codex') }]],
    ['its executable cleared', { providers: { claude: { executablePath: null } } }, [{ action: 'provider-executable', ref: first('claude') }]],
    ['an instance’s switch', { providers: { codex: { instances: { [ADDED]: { enabled: false } } } } }, [{ action: 'instance-switch', ref: { providerId: 'codex', instanceId: ADDED } }]],
    ['an instance’s switch, its id in another case', { providers: { codex: { instances: { [ADDED.toUpperCase()]: { enabled: false } } } } }, [{ action: 'instance-switch', ref: { providerId: 'codex', instanceId: ADDED } }]],
    ['several at once', { providers: { codex: { enabled: false, executablePath: 'C:\\x.exe' }, claude: { enabled: true } } },
      [{ action: 'provider-switch', ref: first('codex') }, { action: 'provider-executable', ref: first('codex') }, { action: 'provider-switch', ref: first('claude') }]],
  ])('names %s', (_name, patch, expected) => {
    expect(patchActions(patch, held)).toEqual(expected);
  });

  it.each<[string, PreferencesPatch]>([
    ['a switch already where it is', { providers: { codex: { enabled: true } } }],
    ['the executable already held', { providers: { claude: { executablePath: 'C:\\tools\\claude.exe' } } }],
    ['no executable where none is held', { providers: { codex: { executablePath: null } } }],
    ['an instance’s switch already where it is', { providers: { codex: { instances: { [ADDED]: { enabled: true } } } } }],
    ['a rename', { providers: { codex: { label: 'Home', instances: { [ADDED]: { label: 'Office' } } } } }],
    ['a part that is no provider’s', { privacy: { maskEmail: false }, usage: { pollIntervalSec: 120 }, windows: { pet: { visible: false } } }],
    // M103 (C8): an avatar's assignment ends no runtime.
    ['an avatar’s assignment', { avatars: { assignments: { codex: { 'gpt-6-sol': { origin: 'built-in', family: 'Blue', avatar: 'Default' } } } } }],
    ['nothing', {}],
  ])('names nothing for %s', (_name, patch) => {
    expect(patchActions(patch, held)).toEqual([]);
  });

  it('asks about each action until one reaches a running session', () => {
    const reaches = vi.fn<ReachesRunning>((action) => action === 'provider-executable');
    expect(patchReachesRunning({ providers: { codex: { enabled: false, executablePath: 'C:\\x.exe' } } }, held, reaches)).toBe(true);
    expect(reaches.mock.calls.map(([action]) => action)).toEqual(['provider-switch', 'provider-executable']);
    expect(patchReachesRunning({ providers: { codex: { enabled: false } } }, held, reaches)).toBe(false);
    reaches.mockClear();
    expect(patchReachesRunning({ privacy: { maskEmail: false } }, held, reaches)).toBe(false);
    expect(reaches).not.toHaveBeenCalled();
  });
});

describe('the guards, in the handlers', () => {
  let dir: string;
  let prefs: PreferencesStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-guards-'));
    prefs = createPreferencesStore({ dir, providerIds: ['codex'], writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
  });
  afterEach(() => {
    prefs.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  function registry(): ProviderRegistry {
    return {
      start: vi.fn(), stop: vi.fn(), has: vi.fn((id) => id === 'codex'), hasInstance: vi.fn((ref: InstanceRef) => ref.providerId === 'codex'),
      refresh: vi.fn(() => ({ status: 'accepted' } as const)), redetect: vi.fn(() => ({ status: 'accepted' } as const)),
      reachOf: vi.fn((_action: RegistryAction, ref: InstanceRef) => [ref]), end: vi.fn(() => Promise.resolve({ confirmed: true })),
      hasRuntime: vi.fn(() => true), facet: vi.fn(() => undefined), executableOffPath: vi.fn(() => null), onRuntimeChanged: vi.fn(() => () => undefined), quiesce: vi.fn(), dispose: vi.fn(() => Promise.resolve()),
    };
  }

  describe('prefs:patch', () => {
    it('refuses the whole patch, its other parts included, and says why', async () => {
      const before = prefs.getSnapshot();
      const enabled = before.values.providers['codex']?.enabled ?? true;
      const reaches = vi.fn<ReachesRunning>(() => true);
      const answer = await prefsHandlers(prefs, reaches)['prefs:patch']({ providers: { codex: { enabled: !enabled } }, privacy: { maskEmail: !before.values.privacy.maskEmail } }, main);
      expect(answer.refused).toBe('session-running');
      expect(answer.rev).toBe(before.rev);
      expect(prefs.getSnapshot()).toBe(before);
      expect(reaches).toHaveBeenCalledExactlyOnceWith('provider-switch', first('codex'));
    });

    it('applies a patch that reaches no running session, and one that ends no runtime whatever runs', async () => {
      const before = prefs.getSnapshot();
      const enabled = before.values.providers['codex']?.enabled ?? true;
      const idle = await prefsHandlers(prefs, () => false)['prefs:patch']({ providers: { codex: { enabled: !enabled } } }, main);
      expect(idle.refused).toBeUndefined();
      expect(idle.values.providers['codex']?.enabled).toBe(!enabled);

      const reaches = vi.fn<ReachesRunning>(() => true);
      const other = await prefsHandlers(prefs, reaches)['prefs:patch']({ privacy: { maskEmail: !before.values.privacy.maskEmail }, providers: { codex: { enabled: !enabled } } }, main);
      expect(other.refused).toBeUndefined();
      expect(other.values.privacy.maskEmail).toBe(!before.values.privacy.maskEmail);
      expect(reaches).not.toHaveBeenCalled();
    });
  });

  describe('providers:redetect and providers:refresh', () => {
    it('refuses a Redetect while a session of that instance runs, and never a Refresh', async () => {
      const providers = registry();
      const reaches = vi.fn<ReachesRunning>((_action, ref) => ref.instanceId === ADDED);
      const handlers = providerHandlers({ registry: providers, prefs, pickExecutable: vi.fn(), platform: 'win32', reachesRunning: reaches });
      expect(await handlers['providers:redetect']({ providerId: 'codex', instanceId: ADDED }, main)).toEqual({ status: 'refused', reason: 'session-running' });
      expect(providers.redetect).not.toHaveBeenCalled();
      expect(reaches).toHaveBeenCalledWith('redetect', { providerId: 'codex', instanceId: ADDED });
      // Another instance of the same provider is not reached.
      expect(await handlers['providers:redetect'](first('codex'), main)).toEqual({ status: 'accepted' });
      expect(providers.redetect).toHaveBeenCalledExactlyOnceWith(first('codex'));
      // Refresh reaches no runtime.
      expect(await handlers['providers:refresh']({ providerId: 'codex', instanceId: ADDED }, main)).toEqual({ status: 'accepted' });
      expect(providers.refresh).toHaveBeenCalledOnce();
    });
  });

  describe('providers:pickExecutable', () => {
    it('opens no picker while a session of the provider runs', async () => {
      const pick = vi.fn(() => Promise.resolve('C:\\tools\\codex.exe'));
      const reaches = vi.fn<ReachesRunning>(() => true);
      const handlers = providerHandlers({ registry: registry(), prefs, pickExecutable: pick, platform: 'win32', reachesRunning: reaches });
      expect(await handlers['providers:pickExecutable']({ providerId: 'codex' }, main)).toEqual({ status: 'refused', reason: 'session-running' });
      expect(pick).not.toHaveBeenCalled();
      expect(reaches).toHaveBeenCalledExactlyOnceWith('provider-executable', first('codex'));
    });

    it('saves nothing when a turn began while the picker was open', async () => {
      let running = false;
      let finish!: (value: string | null) => void;
      const handlers = providerHandlers({
        registry: registry(), prefs, platform: 'win32', reachesRunning: () => running,
        pickExecutable: () => new Promise<string | null>((resolve) => { finish = resolve; }),
      });
      const pending = handlers['providers:pickExecutable']({ providerId: 'codex' }, main);
      await Promise.resolve();
      running = true;
      finish('C:\\tools\\codex.exe');
      await expect(pending).resolves.toEqual({ status: 'refused', reason: 'session-running' });
      expect(prefs.getSnapshot().values.providers['codex']?.executablePath ?? null).toBeNull();
    });

    it('saves as before when nothing runs', async () => {
      const handlers = providerHandlers({ registry: registry(), prefs, pickExecutable: () => Promise.resolve('C:\\tools\\codex.exe'), platform: 'win32', reachesRunning: () => false });
      expect(await handlers['providers:pickExecutable']({ providerId: 'codex' }, main)).toEqual({ status: 'selected' });
      expect(prefs.getSnapshot().values.providers['codex']?.executablePath).toBe('C:\\tools\\codex.exe');
    });
  });

  // C109: a project's removal marks its sessions as leaving for as long as it is written.
  describe('projects:remove', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const place = () => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({
      schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION,
      projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: 'D:\\Code\\fat-g' }] }, { id: OTHER, name: 'other', color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: 'D:\\Code\\other' }] }],
    }), 'utf8');
    const handlers = (removing: NonNullable<Parameters<typeof projectHandlers>[0]['removing']>) => {
      const records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', log });
      return { records, handlers: projectHandlers({ openFolder: () => Promise.resolve(''), showInFolder: () => undefined, records, lookups: { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('present') }, hasProvider: () => true, pickFolder: () => Promise.resolve(null), checkRoots: vi.fn(), platform: 'win32', removing }) };
    };

    it('writes the removal through the marks, and refuses it when a session of the project runs', async () => {
      place();
      const asked: string[] = [];
      const made = handlers((projectId, write) => { asked.push(projectId); return projectId === OTHER ? null : write(); });
      expect(await made.handlers['projects:remove']({ key: OTHER }, main)).toEqual({ status: 'refused', reason: 'session-running' });
      expect(made.records.getProject(OTHER)).toBeDefined();
      expect(await made.handlers['projects:remove']({ key: PROJECT }, main)).toMatchObject({ status: 'saved' });
      expect(made.records.getProject(PROJECT)).toBeUndefined();
      expect(asked).toEqual([OTHER, PROJECT]);
    });
  });
});
