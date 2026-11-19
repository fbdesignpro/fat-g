// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { discoverExecutable } from './resolve-executable';
import { describe, expect, it, vi } from 'vitest';
import type { Resolution, ResolveRequest, VersionedInstallDirectory } from '@shared/provider-kit/process';
import { MAX_CANDIDATES, resolveExecutable } from './resolve-executable';
describe('filesystem-only executable resolution', () => {
  const windows = (files: string[], env = { PATH: 'C:\\early;C:\\late' }) => ({ platform: 'win32', env, isExecutableFile: (file: string) => Promise.resolve(files.some((f) => f.toLowerCase() === file.toLowerCase())) });
  const request = { override: null, names: ['agent'], knownDirs: ['C:\\known'], cwd: 'C:\\cwd' };
  it.each(['relative', '', 'C:\\missing.exe', 'C:\\agent.ps1'])('invalid override %s never falls back', async (override) => {
    expect(await resolveExecutable({ ...request, override }, windows(['C:\\early\\agent.exe']))).toMatchObject({ status: 'not-found', overrideInvalid: true });
  });
  it('prefers native anywhere in PATH over early shim, then PATH over known dirs', async () => {
    expect(await resolveExecutable(request, windows(['C:\\early\\agent.cmd', 'C:\\late\\agent.exe']))).toMatchObject({ executable: { path: 'C:\\late\\agent.exe' }, source: 'path' });
    expect(await resolveExecutable(request, windows(['C:\\early\\agent.cmd', 'C:\\known\\agent.exe']))).toMatchObject({ executable: { kind: 'cmd-shim' }, source: 'path' });
  });
  it('override ignores PATHEXT and may deliberately target cwd', async () => {
    expect(await resolveExecutable({ ...request, override: 'C:\\cwd\\AGENT.EXE' }, { ...windows(['C:\\cwd\\agent.exe']), env: { PATHEXT: '.CMD' } })).toMatchObject({ status: 'found', source: 'override' });
  });
  it('handles quoted Unicode paths, PATHEXT and explicit suffixes', async () => {
    expect(await resolveExecutable({ ...request, names: ['AGENT.EXE'] }, windows(['C:\\é space\\agent.exe'], { PATH: '"C:\\é space"' }))).toMatchObject({ status: 'found' });
    expect(await resolveExecutable(request, { ...windows(['C:\\early\\agent.exe']), env: { PATH: 'C:\\early', PATHEXT: '.PS1;.CMD' } })).toMatchObject({ status: 'not-found' });
  });
  it('excludes cwd, relative directories and unsafe descriptor names', async () => {
    expect(await resolveExecutable({ ...request, names: ['../agent', 'agent'] }, windows(['C:\\cwd\\agent.exe'], { PATH: '.;relative;C:\\cwd' }))).toMatchObject({ status: 'not-found' });
  });
  it.each(['linux', 'darwin'])('uses POSIX paths and executable access on %s', async (platform) => {
    const found = await resolveExecutable({ override: null, names: ['agent'], knownDirs: ['/known'], cwd: '/cwd' }, { platform, env: { PATH: '/cwd:/denied:/bin' }, isExecutableFile: (file) => file === '/denied/agent' ? Promise.reject(new Error('EACCES')) : Promise.resolve(file === '/bin/agent') });
    expect(found).toMatchObject({ source: 'path', executable: { path: '/bin/agent', kind: 'native' } });
  });
});

describe('executable discovery', () => {
  it.each(['win32', 'darwin', 'linux'])('reports inaccessible paths as inconclusive on %s', async (platform) => {
    const windows = platform === 'win32';
    const request = { override: windows ? 'C:/agent.exe' : '/agent', names: ['agent'], knownDirs: [], cwd: windows ? 'C:/cwd' : '/cwd' };
    const options = { platform, env: {}, isExecutableFile: () => Promise.reject(Object.assign(new Error(), { code: 'EACCES' })) };
    expect(await discoverExecutable(request, options)).toMatchObject({ kind: 'unknown' });
  });
  it('does not silently fall back from a missing override', async () => {
    const seen: string[] = [];
    const result = await discoverExecutable({ override: '/missing', names: ['agent'], knownDirs: ['/bin'], cwd: '/cwd' }, {
      platform: 'linux', env: { PATH: '/bin' }, isExecutableFile(file) { seen.push(file); return Promise.reject(Object.assign(new Error(), { code: 'ENOENT' })); },
    });
    expect(result).toEqual({ kind: 'missing', overrideInvalid: true });
    expect(seen).toEqual(['/missing']);
  });
});

describe('versioned desktop runtime fallback', () => {
  const directory: VersionedInstallDirectory = { root: 'C:\\desktop\\bin', children: 'hash', suffix: [], includeRoot: true };
  const request: ResolveRequest = { override: null, names: ['agent'], knownDirs: ['C:\\known', directory], cwd: 'C:\\probe' };
  const harness = (files: string[]) => ({
    platform: 'win32', env: { PATH: 'C:\\path' },
    isExecutableFile: vi.fn((file: string) => Promise.resolve(files.includes(file))),
    readInstallChildren: vi.fn(() => Promise.resolve([
      { name: 'aaaaaaaa', modifiedAt: 10 }, { name: 'bbbbbbbb', modifiedAt: 20 },
      { name: 'cccccccc', modifiedAt: 30 }, // Incomplete update: no executable yet.
      { name: '..', modifiedAt: 100 }, { name: 'logs', modifiedAt: 100 },
    ])),
  });
  it.each([
    ['C:\\manual.exe', 'override'], ['C:\\path\\agent.cmd', 'path'], ['C:\\known\\agent.cmd', 'known-dir'],
  ])('uses %s before enumerating runtime versions', async (file, source) => {
    const h = harness([file, 'C:\\desktop\\bin\\bbbbbbbb\\agent.exe']);
    expect(await resolveExecutable({ ...request, override: source === 'override' ? file : null }, h)).toMatchObject({ source, executable: { path: file } });
    expect(h.readInstallChildren).not.toHaveBeenCalled();
  });
  // The Codex app updates into its build folders and leaves the root's copy behind (the
  // root 0.130, the newest build 0.167): the root's copy is used only when no build holds one.
  it('prefers the newest build to the root’s own copy, which it uses when no build holds one', async () => {
    const stale = 'C:\\desktop\\bin\\agent.exe';
    const files = [stale, 'C:\\desktop\\bin\\bbbbbbbb\\agent.exe'];
    const h = harness(files);
    expect(await resolveExecutable(request, h)).toMatchObject({ source: 'known-dir', executable: { path: 'C:\\desktop\\bin\\bbbbbbbb\\agent.exe' } });
    files.splice(1, 1);
    expect(await resolveExecutable(request, h)).toMatchObject({ source: 'known-dir', executable: { path: stale } });
    // And when the build folders cannot be read.
    h.readInstallChildren.mockRejectedValue(Object.assign(new Error(), { code: 'EACCES' }));
    expect(await resolveExecutable(request, h)).toMatchObject({ executable: { path: stale } });
  });
  it('names every CLI found when asked, in its order and each once, eight at most; the first alone otherwise', async () => {
    const files = ['C:\\path\\agent.cmd', 'C:\\known\\agent.exe', 'C:\\desktop\\bin\\aaaaaaaa\\agent.exe', 'C:\\desktop\\bin\\bbbbbbbb\\agent.exe', 'C:\\desktop\\bin\\agent.exe'];
    const h = harness(files);
    const listed = (result: Resolution) => (result.status === 'found' ? [[result.executable.path, result.source], ...(result.others ?? []).map((other) => [other.executable.path, other.source])] : []);
    // PATH, then the fixed folders, then the newest build first, then the root's own copy.
    expect(listed(await resolveExecutable({ ...request, every: true }, h))).toEqual([
      ['C:\\path\\agent.cmd', 'path'], ['C:\\known\\agent.exe', 'known-dir'],
      ['C:\\desktop\\bin\\bbbbbbbb\\agent.exe', 'known-dir'], ['C:\\desktop\\bin\\aaaaaaaa\\agent.exe', 'known-dir'], ['C:\\desktop\\bin\\agent.exe', 'known-dir'],
    ]);
    // Without it, the first alone, and no build folder read: what discovery asks.
    h.readInstallChildren.mockClear();
    expect(await resolveExecutable(request, h)).toEqual({ status: 'found', executable: { path: 'C:\\path\\agent.cmd', kind: 'cmd-shim' }, source: 'path' });
    expect(h.readInstallChildren).not.toHaveBeenCalled();
    // A folder named twice, in either spelling, is one CLI.
    expect(listed(await resolveExecutable({ ...request, knownDirs: ['C:\\PATH', 'C:\\known'], every: true }, h))).toEqual([['C:\\path\\agent.cmd', 'path'], ['C:\\known\\agent.exe', 'known-dir']]);
    // The bound: each is launched for its version.
    const many = Array.from({ length: 10 }, (_, index) => `C:\\many${index}`);
    const crowded = { ...harness(many.map((dir) => `${dir}\\agent.exe`)), env: { PATH: many.join(';') } };
    expect(listed(await resolveExecutable({ ...request, every: true }, crowded))).toHaveLength(MAX_CANDIDATES);
    // An override is the user's choice, alone.
    expect(await resolveExecutable({ ...request, override: 'C:\\known\\agent.exe', every: true }, h)).toEqual({ status: 'found', executable: { path: 'C:\\known\\agent.exe', kind: 'native' }, source: 'override' });
  });
  it('does not enumerate versions for an invalid override or fixture-only empty names', async () => {
    const h = harness(['C:\\desktop\\bin\\bbbbbbbb\\agent.exe']);
    expect(await discoverExecutable({ ...request, override: 'C:\\missing.exe' }, h)).toEqual({ kind: 'missing', overrideInvalid: true });
    expect(await discoverExecutable({ ...request, names: [] }, h)).toEqual({ kind: 'missing', overrideInvalid: false });
    expect(h.readInstallChildren).not.toHaveBeenCalled();
  });
  it('finds the newest complete hash, ignores unrelated children, and re-enumerates after an update', async () => {
    const files = ['C:\\desktop\\bin\\aaaaaaaa\\agent.exe', 'C:\\desktop\\bin\\bbbbbbbb\\agent.exe'];
    const h = harness(files);
    expect(await resolveExecutable(request, h)).toMatchObject({ executable: { path: files[1] }, source: 'known-dir' });
    files.push('C:\\desktop\\bin\\cccccccc\\agent.exe');
    files.splice(0, 2);
    expect(await resolveExecutable(request, h)).toMatchObject({ executable: { path: files[0] } });
    expect(await discoverExecutable(request, h)).toEqual({ kind: 'present', overrideInvalid: false });
    expect(h.readInstallChildren).toHaveBeenCalledTimes(3);
    expect(h.readInstallChildren).toHaveBeenCalledWith(directory.root, 'hash');
    expect(h.isExecutableFile.mock.calls.some(([file]) => file.includes('logs') || file.includes('..'))).toBe(false);
  });
  it.each(['win32', 'darwin', 'linux'])('orders numeric versions and retains the exact suffix on %s', async (platform) => {
    const windows = platform === 'win32';
    const root = windows ? 'C:\\desktop' : '/desktop';
    const chosen = windows ? `${root}\\2.1.100\\runtime\\agent.exe` : `${root}/2.1.100/runtime/agent`;
    const h = { ...harness([chosen]), platform, env: {}, readInstallChildren: vi.fn(() => Promise.resolve([
      { name: '2.1.99', modifiedAt: 1000 }, { name: '2.1.100', modifiedAt: 1 }, { name: '999.0.0.tmp', modifiedAt: 9999 },
    ])) };
    expect(await resolveExecutable({ ...request, knownDirs: [{ root, children: 'version', suffix: ['runtime'] }] }, h)).toMatchObject({ executable: { path: chosen } });
  });
  it('reads one build level inside each version, newest first, and reads an older version only when needed', async () => {
    const root = 'C:\\desktop';
    const listing: Record<string, { name: string; modifiedAt: number }[]> = {
      [root]: [{ name: '2.1.99', modifiedAt: 1 }, { name: '2.1.100', modifiedAt: 1 }, { name: '2.1.101', modifiedAt: 1 }, { name: 'logs', modifiedAt: 9 }],
      [`${root}\\2.1.101`]: [{ name: 'eeeeeeee', modifiedAt: 1 }], // Incomplete update: no executable yet.
      [`${root}\\2.1.100`]: [{ name: 'aaaaaaaa', modifiedAt: 1 }, { name: 'bbbbbbbb', modifiedAt: 2 }, { name: 'runtime', modifiedAt: 3 }],
    };
    const chosen = `${root}\\2.1.100\\bbbbbbbb\\agent.exe`;
    const h = { ...harness([chosen, `${root}\\2.1.100\\aaaaaaaa\\agent.exe`, `${root}\\2.1.99\\cccccccc\\agent.exe`]), env: {},
      readInstallChildren: vi.fn((folder: string) => Promise.resolve(listing[folder] ?? [])) };
    const nested: VersionedInstallDirectory = { root, children: 'version', nested: 'hash', suffix: [] };
    expect(await resolveExecutable({ ...request, knownDirs: [nested] }, h)).toMatchObject({ source: 'known-dir', executable: { path: chosen } });
    expect(h.readInstallChildren.mock.calls).toEqual([[root, 'version'], [`${root}\\2.1.101`, 'hash'], [`${root}\\2.1.100`, 'hash']]);
    // A version folder an update removed, or one that cannot be read, passes to the next one.
    h.readInstallChildren.mockImplementation((folder: string) => folder.endsWith('2.1.100') ? Promise.reject(Object.assign(new Error(), { code: 'EACCES' })) : Promise.resolve(listing[folder] ?? []));
    listing[`${root}\\2.1.99`] = [{ name: 'cccccccc', modifiedAt: 1 }];
    expect(await resolveExecutable({ ...request, knownDirs: [nested] }, h)).toMatchObject({ executable: { path: `${root}\\2.1.99\\cccccccc\\agent.exe` } });
    expect(await resolveExecutable({ ...request, knownDirs: [{ ...nested, nested: 'logs' as 'hash' }] }, h)).toMatchObject({ status: 'not-found' });
  });
  it.each(['EACCES', 'EPERM', 'installation-directory-limit'])('treats %s as inconclusive, with missing paths still missing', async (code) => {
    const h = harness([]);
    h.readInstallChildren.mockRejectedValue(Object.assign(new Error(), { code }));
    expect(await discoverExecutable(request, h)).toMatchObject({ kind: 'unknown' });
    h.readInstallChildren.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    expect(await discoverExecutable(request, h)).toMatchObject({ kind: 'missing' });
  });
  it('does not enumerate a relative root, cwd, or an escaping suffix', async () => {
    const h = harness([]);
    for (const entry of [{ ...directory, root: 'relative' }, { ...directory, root: request.cwd }, { ...directory, suffix: ['..'] }, { ...directory, suffix: ['C:\\outside'] }]) {
      expect(await resolveExecutable({ ...request, knownDirs: [entry] }, h)).toMatchObject({ status: 'not-found' });
    }
    expect(h.readInstallChildren).not.toHaveBeenCalled();
  });
});
