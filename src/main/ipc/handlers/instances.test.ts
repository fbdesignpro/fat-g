// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, V8, V14 and V23 (C14, C15, C21, C23, C49, C69): the account channels, through the real
// contract, the real dispatcher, the real preferences store and the real guard.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceRef } from '@shared/contracts/instances';
import { defaultPreferences } from '@shared/contracts/prefs';
import { INVOKE_CHANNELS } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { SandboxFacet } from '@shared/provider-kit/sessions';
import { resolveTrustedOrigins } from '../../app/origins';
import { createInstanceGuard } from '../../instances/admission';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from '../../prefs/store';
import type { Lookups } from '../../records/lookup';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';
import { instanceHandlers, type InstanceHandlerDeps } from './instances';

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const A = uuid(1);
const support: InstanceSupport = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };
const work = (extra: Record<string, unknown> = {}) => ({ id: A, label: 'Work', folder: 'D:\\accounts\\work', enabled: true, ...extra });

let dir: string;
let prefs: PreferencesStore;
const log = { warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-instances-ipc-'));
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  prefs.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  /** The `codex` entry of the preferences file; a string places that text as the whole file. */
  readonly entry?: Record<string, unknown> | string;
  readonly pick?: () => Promise<string | null>;
  readonly projects?: { id: string; roots: string[] }[];
  readonly sessionRunning?: (ref: InstanceRef) => boolean;
  /** Whether the registry confirms an ended runtime's tree gone. */
  readonly confirmed?: boolean;
  readonly lookups?: Partial<Lookups>;
  /** Whether a terminal can be started. */
  readonly terminal?: boolean;
  readonly platform?: string;
  /** The CLI file an account's runtime found off PATH. */
  readonly offPath?: (ref: InstanceRef) => string | null;
  /** An account's sandbox setup (M22), whether a turn or an aside of it runs, and the counts of what was asked. */
  readonly sandbox?: (ref: InstanceRef) => SandboxFacet | undefined;
  readonly accountBusy?: (ref: InstanceRef) => boolean;
  readonly setups?: KindCounts;
}

function setup(options: Setup = {}) {
  const file = path.join(dir, PREFERENCES_FILE);
  writeFileSync(file, typeof options.entry === 'string' ? options.entry : JSON.stringify({ ...defaultPreferences(), providers: { codex: options.entry ?? {} } }), 'utf8');
  let made = 100;
  prefs = createPreferencesStore({ dir, providerIds: ['codex', 'plain'], log, platform: options.platform ?? 'win32', writeDelayMs: 10_000, newId: () => uuid(made += 1) });
  const asked: string[] = [];
  const lookups: Lookups = {
    realpath: (target) => { asked.push(`realpath ${target}`); return options.lookups?.realpath?.(target) ?? Promise.resolve(null); },
    folder: (target) => { asked.push(`folder ${target}`); return options.lookups?.folder?.(target) ?? Promise.resolve('present'); },
  };
  const guard = createInstanceGuard({
    platform: 'win32', lookups, env: {}, home: 'C:\\Users\\me', dataFolder: 'C:\\Users\\me\\AppData\\Roaming\\fat-g',
    support: (providerId) => (providerId === 'codex' ? support : undefined),
    instances: (providerId) => prefs.getSnapshot().instances[providerId]?.added ?? [],
    projects: () => options.projects ?? [],
  });
  const registry = {
    has: vi.fn((providerId: string) => providerId === 'codex' || providerId === 'plain'),
    // The registry has a slot for every entry of a declaring provider, usable or not.
    hasInstance: vi.fn((ref: InstanceRef) => ref.providerId === 'codex' && (prefs.getSnapshot().instances['codex']?.added.some((entry) => entry.key === ref.instanceId) ?? false)),
    end: vi.fn(() => Promise.resolve({ confirmed: options.confirmed ?? true })),
  };
  const pickFolder = vi.fn(options.pick ?? (() => Promise.resolve(null)));
  const openTerminal = vi.fn((_providerId: string, _command: string, _note: string) => Promise.resolve(options.terminal ?? true));
  const deps: InstanceHandlerDeps = {
    prefs, registry, guard, pickFolder, openTerminal, platform: options.platform ?? 'win32',
    supports: (providerId) => providerId === 'codex',
    sessionRunning: options.sessionRunning ?? (() => false),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.accountBusy === undefined ? {} : { accountBusy: options.accountBusy }),
    ...(options.setups === undefined ? {} : { setups: options.setups }),
    ...(options.offPath === undefined ? {} : { executableOffPath: options.offPath }),
    // `codex` declares a variable; `plain` runs as one account.
    loginOf: (providerId) => (providerId === 'codex' ? { command: 'vendor login', variable: 'VENDOR_HOME' } : providerId === 'plain' ? { command: 'plain login', variable: null } : undefined),
  };
  const handlers = instanceHandlers(deps);
  const stored = (): unknown[] => {
    prefs.flushSync();
    const text = readFileSync(file, 'utf8');
    return ((JSON.parse(text) as { providers?: { codex?: { instances?: unknown[] } } }).providers?.codex?.instances) ?? [];
  };
  return { handlers, registry, pickFolder, openTerminal, asked, stored, file };
}
const main = { windowKind: 'main' } as const;

function dispatchDeps(detail: 'kinds' | 'full' = 'kinds') {
  const captured = { warn: vi.fn<(...parts: unknown[]) => void>(), error: vi.fn<(...parts: unknown[]) => void>() };
  const deps: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: captured, detail };
  return { deps, captured };
}
const from = (windowKind: 'main' | 'pet', request: unknown) => ({ windowKind, sender: { frameUrl: `app://fatg/${windowKind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });
const CHANNELS = ['instances:pickFolder', 'instances:add', 'instances:remove', 'instances:openLoginTerminal', 'instances:setupSandbox'] as const;

describe('the account channels (C21, C80)', () => {
  it('are the channels M14b adds, and M22’s sandbox setup, the Main window’s only', () => {
    setup();
    expect(INVOKE_CHANNELS.filter((channel) => channel.startsWith('instances:'))).toEqual([...CHANNELS]);
    for (const channel of CHANNELS) expect(INVOKE_SPECS[channel].from).toEqual(['main']);
  });

  it.each(CHANNELS)('%s is refused to the Pet, before its handler runs', async (channel) => {
    const h = setup();
    const handler = vi.fn();
    const request = { providerId: 'codex', label: 'Work', folder: 'D:\\accounts\\work', key: A };
    expect(await dispatchInvoke(channel, INVOKE_SPECS[channel], handler as never, from('pet', request), dispatchDeps().deps)).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
    expect(h.pickFolder).not.toHaveBeenCalled();
  });

  it.each([
    ['instances:pickFolder', { providerId: 'codex', folder: 'D:\\accounts\\work' }],
    ['instances:pickFolder', {}],
    ['instances:add', { providerId: 'codex', label: 'Work', folder: 'D:\\accounts\\work', enabled: false }],
    ['instances:add', { providerId: 'codex', label: 'Work', folder: 'D:\\accounts\\work', id: A }],
    ['instances:add', { providerId: 'codex', label: 'Work' }],
    ['instances:add', { providerId: 'codex', label: 7, folder: 'D:\\accounts\\work' }],
    ['instances:remove', { providerId: 'codex', key: A, folder: 'D:\\accounts\\work' }],
    ['instances:remove', { providerId: 'codex', key: 'default' }],
    ['instances:remove', { providerId: 'codex' }],
    // The page names the account and nothing else: never a command, a folder or a shell.
    ['instances:openLoginTerminal', { providerId: 'codex', instanceId: A, command: 'calc.exe' }],
    ['instances:openLoginTerminal', { providerId: 'codex', instanceId: A, folder: 'D:\\accounts\\work' }],
    ['instances:openLoginTerminal', { providerId: 'codex', instanceId: 'work' }],
    ['instances:openLoginTerminal', { providerId: 'codex' }],
  ] as const)('%s refuses %j as a bad request', async (channel, request) => {
    const h = setup({ entry: { instances: [work()] } });
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel], h.handlers[channel] as never, from('main', request), dispatchDeps().deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(h.stored()).toEqual([work()]);
  });

  it.each(CHANNELS)('%s refuses a provider that is not registered as a bad request', async (channel) => {
    const h = setup();
    const request = { 'instances:pickFolder': { providerId: 'gemini' }, 'instances:add': { providerId: 'gemini', label: 'Work', folder: 'D:\\accounts\\work' }, 'instances:remove': { providerId: 'gemini', key: A }, 'instances:openLoginTerminal': { providerId: 'gemini', instanceId: 'default' }, 'instances:setupSandbox': { providerId: 'gemini', instanceId: 'default', action: 'start' } }[channel];
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel], h.handlers[channel] as never, from('main', request), dispatchDeps().deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(h.pickFolder).not.toHaveBeenCalled();
    expect(h.openTerminal).not.toHaveBeenCalled();
  });
});

describe('picking a folder (C14, C15)', () => {
  it('answers the folder as it would be stored, and stores and starts nothing', async () => {
    const h = setup({ pick: () => Promise.resolve('D:/accounts/work/') });
    expect(await h.handlers['instances:pickFolder']({ providerId: 'codex' }, main)).toEqual({ status: 'picked', path: 'D:\\accounts\\work', refusal: null });
    expect(h.pickFolder).toHaveBeenCalledExactlyOnceWith('codex');
    expect(prefs.getSnapshot().rev).toBe(0);
    expect(h.stored()).toEqual([]);
  });

  it.each([
    ['another account’s folder', 'D:\\accounts\\WORK', { rule: 'other-instance', key: A }],
    ['the provider’s default folder', 'C:\\Users\\me\\.vendor', { rule: 'default-folder' }],
    // V22, from the account's side: a project's root, a folder inside it and one around it.
    ['a project’s root', 'D:\\code\\APP', { rule: 'project', projectId: 'p1', relation: 'same' }],
    ['a folder inside a project', 'D:\\code\\app\\.account', { rule: 'project', projectId: 'p1', relation: 'inside' }],
    ['a folder around a project', 'D:\\code', { rule: 'project', projectId: 'p1', relation: 'around' }],
    ['a folder inside the data folder', 'C:\\Users\\me\\AppData\\Roaming\\fat-g\\accounts', { rule: 'data-folder', relation: 'inside' }],
  ])('says at once that %s is refused, with its rule, and still stores nothing', async (_name, folder, refusal) => {
    const h = setup({ entry: { instances: [work()] }, pick: () => Promise.resolve(folder), projects: [{ id: 'p1', roots: ['D:\\code\\app'] }] });
    expect(await h.handlers['instances:pickFolder']({ providerId: 'codex' }, main)).toEqual({ status: 'picked', path: folder, refusal });
    expect(h.stored()).toEqual([work()]);
  });

  it('answers cancelled, busy while a picker is open, and refuses a path that is not absolute', async () => {
    let finish: (value: string | null) => void = () => undefined;
    const h = setup({ pick: () => new Promise<string | null>((resolve) => { finish = resolve; }) });
    const first = h.handlers['instances:pickFolder']({ providerId: 'codex' }, main);
    await Promise.resolve();
    expect(await h.handlers['instances:pickFolder']({ providerId: 'codex' }, main)).toEqual({ status: 'refused', reason: 'busy' });
    finish(null);
    expect(await first).toEqual({ status: 'cancelled' });
    const second = h.handlers['instances:pickFolder']({ providerId: 'codex' }, main);
    await Promise.resolve();
    finish('accounts\\work');
    expect(await second).toEqual({ status: 'refused', reason: 'unsupported-path' });
    expect(h.asked).toEqual([]);
  });

  it('opens no picker for a module that declares no instances, or while the preferences are refused', async () => {
    const h = setup({ pick: () => Promise.resolve('D:\\accounts\\work') });
    expect(await h.handlers['instances:pickFolder']({ providerId: 'plain' }, main)).toEqual({ status: 'refused', reason: 'not-supported' });
    prefs.dispose();
    const refused = setup({ entry: '{', pick: () => Promise.resolve('D:\\accounts\\work') });
    expect(await refused.handlers['instances:pickFolder']({ providerId: 'codex' }, main)).toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(h.pickFolder).not.toHaveBeenCalled();
    expect(refused.pickFolder).not.toHaveBeenCalled();
  });
});

describe('adding an account (C10, C13, C14, C15, C22)', () => {
  const picked = async (h: ReturnType<typeof setup>) => {
    const answer = await h.handlers['instances:pickFolder']({ providerId: 'codex' }, main);
    if (answer.status !== 'picked') throw new Error('not picked');
    return answer.path;
  };

  it('stores a picked folder under a cleaned label, with a fresh id', async () => {
    const h = setup({ pick: () => Promise.resolve('D:\\accounts\\work\\') });
    const folder = await picked(h);
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: '  My   work ', folder }, main)).toEqual({ status: 'saved', id: uuid(101) });
    expect(h.stored()).toEqual([{ id: uuid(101), label: 'My work', folder: 'D:\\accounts\\work', enabled: true }]);
  });

  it('refuses a folder its picker did not return in this run, before any lookup', async () => {
    const h = setup({ entry: { instances: [work()] }, pick: () => Promise.resolve('D:\\accounts\\picked') });
    // Never picked, another account's stored folder, and one in another spelling than the picker gave.
    await picked(h);
    h.asked.length = 0;
    for (const folder of ['D:\\accounts\\made-up', 'D:\\accounts\\work', 'd:\\ACCOUNTS\\picked', 'D:\\accounts\\picked\\']) {
      expect(await h.handlers['instances:add']({ providerId: 'codex', label: 'New', folder }, main)).toEqual({ status: 'refused', reason: 'folder-not-picked' });
    }
    expect(h.asked).toEqual([]);
    expect(h.stored()).toEqual([work()]);
  });

  it('checks the label and the cap again at Save, before the folder', async () => {
    const h = setup({ entry: { instances: [work()] }, pick: () => Promise.resolve('D:\\accounts\\new') });
    const folder = await picked(h);
    h.asked.length = 0;
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: ' \n ', folder }, main)).toEqual({ status: 'refused', reason: 'label-empty' });
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: 'WORK', folder }, main)).toEqual({ status: 'refused', reason: 'label-taken' });
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: 'default', folder }, main)).toEqual({ status: 'refused', reason: 'label-taken' });
    expect(h.asked).toEqual([]);
    for (let n = 2; n <= 7; n += 1) prefs.addInstance('codex', { label: `Account ${n}`, folder: `D:\\accounts\\${n}` });
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: 'Ninth', folder }, main)).toEqual({ status: 'refused', reason: 'limit' });
    expect(h.asked).toEqual([]);
  });

  it('checks the folder’s rules again at Save: a project added since the pick refuses it', async () => {
    const projects: { id: string; roots: string[] }[] = [];
    const h = setup({ pick: () => Promise.resolve('D:\\code\\app\\.account'), projects });
    const folder = await picked(h);
    projects.push({ id: 'p1', roots: ['D:\\code\\app'] });
    expect(await h.handlers['instances:add']({ providerId: 'codex', label: 'Work', folder }, main)).toEqual({ status: 'refused', reason: 'folder-refused', refusal: { rule: 'project', projectId: 'p1', relation: 'inside' } });
    expect(h.stored()).toEqual([]);
  });

  it('refuses a module that declares no instances, and refused preferences', async () => {
    const h = setup({ pick: () => Promise.resolve('D:\\accounts\\work') });
    const folder = await picked(h);
    expect(await h.handlers['instances:add']({ providerId: 'plain', label: 'Work', folder }, main)).toEqual({ status: 'refused', reason: 'not-supported' });
    prefs.dispose();
    const refused = setup({ entry: JSON.stringify({ schemaVersion: 3, minReaderVersion: 3 }) });
    expect(await refused.handlers['instances:add']({ providerId: 'codex', label: 'Work', folder }, main)).toEqual({ status: 'refused', reason: 'preferences-blocked' });
  });

  it('keeps a folder picked for an account apart from anything else main picked: only this picker’s folders count', async () => {
    const first = setup({ pick: () => Promise.resolve('D:\\accounts\\work') });
    const folder = await picked(first);
    // Another set of handlers, as after a restart: the pick is gone with the run.
    const again = instanceHandlers({ prefs, registry: first.registry, guard: { checkPicked: () => Promise.resolve(null) }, pickFolder: () => Promise.resolve(null), supports: () => true, sessionRunning: () => false, loginOf: () => undefined, openTerminal: () => Promise.resolve(false), platform: 'win32' });
    expect(await again['instances:add']({ providerId: 'codex', label: 'Work', folder }, main)).toEqual({ status: 'refused', reason: 'folder-not-picked' });
  });
});

describe('removing an account (C23, C66, C69)', () => {
  it('ends the instance’s runtime first, then deletes its entry and nothing else', async () => {
    const h = setup({ entry: { enabled: true, executablePath: null, label: 'Personal', instances: [work(), { id: uuid(2), label: 'Side', folder: 'D:\\accounts\\side', enabled: true }] } });
    h.registry.end.mockImplementation(() => {
      // Still stored while its runtime ends.
      expect(prefs.getSnapshot().instances['codex']?.added).toHaveLength(2);
      return Promise.resolve({ confirmed: true });
    });
    expect(await h.handlers['instances:remove']({ providerId: 'codex', key: A }, main)).toEqual({ status: 'removed' });
    expect(h.registry.end).toHaveBeenCalledExactlyOnceWith({ providerId: 'codex', instanceId: A });
    expect(h.stored()).toEqual([{ id: uuid(2), label: 'Side', folder: 'D:\\accounts\\side', enabled: true }]);
    // Nothing of the folder was asked: Remove leaves it as it is.
    expect(h.asked).toEqual([]);
  });

  it('is refused, with the entry kept, when the runtime’s end cannot be confirmed (C69)', async () => {
    const h = setup({ entry: { instances: [work()] }, confirmed: false });
    expect(await h.handlers['instances:remove']({ providerId: 'codex', key: A }, main)).toEqual({ status: 'refused', reason: 'cleanup-failed' });
    expect(h.stored()).toEqual([work()]);
    expect(prefs.getSnapshot().rev).toBe(0);
  });

  it('is refused while a session of the instance runs, and ends nothing', async () => {
    const running = vi.fn((ref: InstanceRef) => ref.instanceId === A);
    const h = setup({ entry: { instances: [work()] }, sessionRunning: running });
    expect(await h.handlers['instances:remove']({ providerId: 'codex', key: A }, main)).toEqual({ status: 'refused', reason: 'session-running' });
    expect(running).toHaveBeenCalledWith({ providerId: 'codex', instanceId: A });
    expect(h.registry.end).not.toHaveBeenCalled();
    expect(h.stored()).toEqual([work()]);
  });

  it('removes an entry that cannot be used by the key made for the run (C66)', async () => {
    const broken = { label: 'No id', folder: 'relative', enabled: true };
    const h = setup({ entry: { instances: [broken, work()] } });
    const key = prefs.getSnapshot().instances['codex']?.added[0]?.key ?? '';
    expect(await h.handlers['instances:remove']({ providerId: 'codex', key }, main)).toEqual({ status: 'removed' });
    expect(h.stored()).toEqual([work()]);
  });

  it('refuses a key it does not know, and refused preferences', async () => {
    const h = setup({ entry: { instances: [work()] } });
    expect(await h.handlers['instances:remove']({ providerId: 'codex', key: uuid(9) }, main)).toEqual({ status: 'refused', reason: 'unknown-instance' });
    expect(await h.handlers['instances:remove']({ providerId: 'plain', key: A }, main)).toEqual({ status: 'refused', reason: 'unknown-instance' });
    expect(h.registry.end).not.toHaveBeenCalled();
    prefs.dispose();
    const refused = setup({ entry: '{' });
    expect(await refused.handlers['instances:remove']({ providerId: 'codex', key: A }, main)).toEqual({ status: 'refused', reason: 'preferences-blocked' });
  });
});

// Round 6, V28 (C80): the user's own terminal, opened with the command the row shows.
describe('opening a terminal to sign in (C80)', () => {
  const NOTE = 'fat-g opened this window so you can sign in. It reads nothing from it; close it when you are done.';

  it('opens one with the first account’s command: the CLI’s own, with nothing set', async () => {
    const h = setup();
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId: 'default' }, main)).toEqual({ status: 'opened' });
    expect(h.openTerminal.mock.calls).toEqual([['codex', 'vendor login', NOTE]]);
  });

  it.each([
    ['PowerShell on Windows', 'win32', 'D:\\accounts\\it\'s work', "$env:VENDOR_HOME = 'D:\\accounts\\it''s work'; vendor login"],
    ['a POSIX shell elsewhere', 'linux', '/home/me/it\'s work', "VENDOR_HOME='/home/me/it'\\''s work' vendor login"],
  ])('opens one with an added account’s command, the variable set to its stored folder, for %s', async (_name, platform, folder, command) => {
    const h = setup({ entry: { instances: [work({ folder })] }, platform });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId: A }, main)).toEqual({ status: 'opened' });
    // The command the row shows, built by main from what the preferences hold.
    expect(h.openTerminal.mock.calls).toEqual([['codex', command, NOTE]]);
  });

  it.each([
    ['win32', 'default', "& 'C:\\Users\\me\\AppData\\Local\\Vendor\\1.0.0\\it''s\\vendor.exe' login"],
    ['win32', A, "$env:VENDOR_HOME = 'D:\\accounts\\work'; & 'C:\\Users\\me\\AppData\\Local\\Vendor\\1.0.0\\it''s\\vendor.exe' login"],
    ['linux', 'default', "'/opt/vendor/it'\\''s/vendor' login"],
  ])('runs a CLI found off PATH by its full path (%s, %s)', async (platform, instanceId, command) => {
    const file = platform === 'win32' ? 'C:\\Users\\me\\AppData\\Local\\Vendor\\1.0.0\\it\'s\\vendor.exe' : '/opt/vendor/it\'s/vendor';
    const offPath = vi.fn((_ref: InstanceRef) => file);
    const h = setup({ entry: { instances: [work({ folder: platform === 'win32' ? 'D:\\accounts\\work' : '/home/me/work' })] }, platform, offPath });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId }, main)).toEqual({ status: 'opened' });
    expect(h.openTerminal.mock.calls).toEqual([['codex', command, NOTE]]);
    expect(offPath).toHaveBeenCalledWith({ providerId: 'codex', instanceId });
  });

  it('opens one for an account that is switched off: signing in does not need it running', async () => {
    const h = setup({ entry: { instances: [work({ enabled: false })] } });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId: A }, main)).toEqual({ status: 'opened' });
  });

  it('opens one for a provider that runs as one account', async () => {
    const h = setup();
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'plain', instanceId: 'default' }, main)).toEqual({ status: 'opened' });
    expect(h.openTerminal.mock.calls[0]?.slice(0, 2)).toEqual(['plain', 'plain login']);
  });

  it('says so when no terminal could be started', async () => {
    const h = setup({ terminal: false });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId: 'default' }, main)).toEqual({ status: 'refused', reason: 'no-terminal' });
  });

  it.each([
    ['an account the preferences do not hold', {}, uuid(2), 'unknown-instance'],
    ['an entry that cannot be used', { instances: [work({ label: '' })] }, A, 'unavailable'],
  ] as const)('opens nothing for %s', async (_name, entry, instanceId, reason) => {
    const h = setup({ entry });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId }, main)).toEqual({ status: 'refused', reason });
    expect(h.openTerminal).not.toHaveBeenCalled();
  });

  it('opens nothing for an added account of a provider that declares no variable', async () => {
    const h = setup();
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'plain', instanceId: A }, main)).toMatchObject({ status: 'refused' });
    expect(h.openTerminal).not.toHaveBeenCalled();
  });

  it('opens nothing while the preferences cannot be read', async () => {
    const h = setup({ entry: '{ broken' });
    expect(await h.handlers['instances:openLoginTerminal']({ providerId: 'codex', instanceId: 'default' }, main)).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(h.openTerminal).not.toHaveBeenCalled();
  });

  it('logs neither the command nor the folder: a refused request and an opened one alike, as a packaged build', async () => {
    const h = setup({ entry: { instances: [work({ folder: 'D:\\Private\\account' })] } });
    const { deps, captured } = dispatchDeps();
    const dispatch = (request: unknown) => dispatchInvoke('instances:openLoginTerminal', INVOKE_SPECS['instances:openLoginTerminal'] as never, h.handlers['instances:openLoginTerminal'] as never, from('main', request), deps);
    expect(await dispatch({ providerId: 'codex', instanceId: A })).toEqual({ ok: true, value: { status: 'opened' } });
    expect(await dispatch({ providerId: 'codex', instanceId: A, command: 'D:\\Private\\run.exe' })).toEqual({ ok: false, error: 'bad-request' });
    expect(JSON.stringify([captured.warn.mock.calls, captured.error.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toMatch(/Private|VENDOR_HOME|vendor login/);
  });
});

describe('the log (V14, C49)', () => {
  it('holds kinds only for an add, a remove and a bad request, as a packaged build logs them: no label, folder or instance id', async () => {
    const h = setup({ entry: { instances: [work()] }, pick: () => Promise.resolve('D:\\accounts\\secret-folder') });
    const { deps, captured } = dispatchDeps('kinds');
    const run = (channel: (typeof CHANNELS)[number], request: unknown) => dispatchInvoke(channel, INVOKE_SPECS[channel], h.handlers[channel] as never, from('main', request), deps);
    const pickedAnswer = await run('instances:pickFolder', { providerId: 'codex' });
    expect(pickedAnswer).toMatchObject({ ok: true, value: { status: 'picked' } });
    expect(await run('instances:add', { providerId: 'codex', label: 'Secret label', folder: 'D:\\accounts\\secret-folder' })).toMatchObject({ ok: true, value: { status: 'saved' } });
    expect(await run('instances:add', { providerId: 'codex', label: 'Secret label', folder: 'D:\\accounts\\secret-folder', extra: true })).toEqual({ ok: false, error: 'bad-request' });
    expect(await run('instances:remove', { providerId: 'codex', key: A })).toEqual({ ok: true, value: { status: 'removed' } });
    expect(await run('instances:remove', { providerId: 'codex', key: 'Secret label' })).toEqual({ ok: false, error: 'bad-request' });
    const lines = JSON.stringify([...captured.warn.mock.calls, ...captured.error.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(lines).not.toMatch(/Secret|secret-folder|accounts|Work|0000-4000/);
  });
});

// ── The sandbox setup (docs/planning/_archive/M22.md; V7, V18; C60, C62, C72, C88) ──────────────────────
describe('the sandbox setup channel (M22: V7, V18; C60, C62, C72, C88)', () => {
  /** An account's setup, in the test's hands: what was asked of it, and what it answers. */
  function sandbox(answer: ReturnType<SandboxFacet['act']> = 'started') {
    const acts: string[] = [];
    const facet: SandboxFacet = { state: () => ({ state: 'idle', error: null, readiness: 'not-configured' }), act: (action) => { acts.push(action); return answer; } };
    return { facet, acts };
  }
  const first = { providerId: 'codex', instanceId: 'default' } as const;

  it('reaches the account’s own setup at the press, with the action and nothing else, and answers what it did', () => {
    const made = sandbox();
    const asked: InstanceRef[] = [];
    const h = setup({ sandbox: (ref) => { asked.push(ref); return made.facet; } });
    expect(h.handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'started' });
    expect(made.acts).toEqual(['start']);
    expect(asked).toEqual([first]);
    // Stop waiting lets go of one under way: what the setup answers is what is said.
    const waiting = sandbox('stopping');
    expect(setup({ sandbox: () => waiting.facet }).handlers['instances:setupSandbox']({ ...first, action: 'stop-waiting' }, main)).toEqual({ status: 'stopping' });
    expect(waiting.acts).toEqual(['stop-waiting']);
  });

  it('sends nothing where the provider has no setup, one is under way already, or the account is not set up', () => {
    expect(setup().handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'refused', reason: 'no-setup' });
    expect(setup({ sandbox: () => undefined }).handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'refused', reason: 'no-setup' });
    for (const answer of ['running', 'no-setup'] as const) {
      const made = sandbox(answer);
      expect(setup({ sandbox: () => made.facet }).handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'refused', reason: answer });
    }
    // An account the preferences do not hold has no setup to ask for.
    const made = sandbox();
    expect(setup({ sandbox: () => made.facet }).handlers['instances:setupSandbox']({ providerId: 'codex', instanceId: A, action: 'start' }, main)).toEqual({ status: 'refused', reason: 'unknown-instance' });
    expect(made.acts).toEqual([]);
  });

  it('starts none while a turn or an aside of the account runs, and still lets go of one that waits (C62)', async () => {
    const made = sandbox();
    const h = setup({ sandbox: () => made.facet, accountBusy: () => true });
    expect(h.handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'refused', reason: 'busy' });
    expect(made.acts).toEqual([]);
    await h.handlers['instances:setupSandbox']({ ...first, action: 'stop-waiting' }, main);
    expect(made.acts).toEqual(['stop-waiting']);
    // Without the runtime's word, the session service's is asked.
    const other = sandbox();
    expect(setup({ sandbox: () => other.facet, sessionRunning: () => true }).handlers['instances:setupSandbox']({ ...first, action: 'start' }, main)).toEqual({ status: 'refused', reason: 'busy' });
  });

  it.each([
    [{ providerId: 'codex', instanceId: 'default' }],
    [{ providerId: 'codex', instanceId: 'default', action: 'retry' }],
    // Nothing of how the CLI sets it up is the page's to say.
    [{ providerId: 'codex', instanceId: 'default', action: 'start', mode: 'unelevated' }],
    [{ providerId: 'codex', instanceId: 'default', action: 'start', cwd: 'D:\\Code' }],
    [{ providerId: 'codex', instanceId: 'not an id', action: 'start' }],
  ])('refuses %j as a bad request, before any setup is asked', async (request) => {
    const made = sandbox();
    const h = setup({ sandbox: () => made.facet });
    expect(await dispatchInvoke('instances:setupSandbox', INVOKE_SPECS['instances:setupSandbox'] as never, h.handlers['instances:setupSandbox'] as never, from('main', request), dispatchDeps().deps)).toEqual({ ok: false, error: 'bad-request' });
    expect(made.acts).toEqual([]);
  });

  it('counts what was asked and what was answered by kind, and says no more of a setup than that', async () => {
    const counts = createKindCounts();
    const made = sandbox();
    const h = setup({ sandbox: () => made.facet, setups: counts });
    await h.handlers['instances:setupSandbox']({ ...first, action: 'start' }, main);
    await h.handlers['instances:setupSandbox']({ providerId: 'codex', instanceId: A, action: 'start' }, main);
    expect(counts.snapshot()).toEqual({ 'start:started': 1, 'start:refused:unknown-instance': 1 });
    expect(JSON.stringify(counts.snapshot())).not.toMatch(/codex|default|0000-4000/);
  });
});
